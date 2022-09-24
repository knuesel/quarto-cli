/*
* serve.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { info, warning } from "log/mod.ts";
import { existsSync } from "fs/mod.ts";
import { basename, dirname, join, relative } from "path/mod.ts";
import * as colors from "fmt/colors.ts";
import { MuxAsyncIterator } from "async/mod.ts";
import { iterateReader } from "streams/mod.ts";

import * as ld from "../../core/lodash.ts";

import { DOMParser, initDenoDom } from "../../core/deno-dom.ts";

import { openUrl } from "../../core/shell.ts";
import { contentType, isHtmlContent, isPdfContent } from "../../core/mime.ts";
import { isModifiedAfter } from "../../core/path.ts";
import { logError } from "../../core/log.ts";

import {
  kProject404File,
  kProjectType,
  ProjectContext,
  resolvePreviewOptions,
} from "../../project/types.ts";
import {
  isProjectInputFile,
  projectExcludeDirs,
  projectOutputDir,
} from "../../project/project-shared.ts";
import { projectContext } from "../../project/project-context.ts";
import { partitionedMarkdownForInput } from "../../project/project-config.ts";

import {
  clearProjectIndex,
  inputFileForOutputFile,
  resolveInputTarget,
} from "../../project/project-index.ts";

import { websitePath } from "../../project/types/website/website-config.ts";

import { renderProject } from "../../command/render/project.ts";
import {
  renderResultFinalOutput,
  renderResultUrlPath,
} from "../../command/render/render.ts";

import {
  httpContentResponse,
  httpFileRequestHandler,
  HttpFileRequestOptions,
} from "../../core/http.ts";
import { ProjectWatcher, ServeOptions } from "./types.ts";
import { watchProject } from "./watch.ts";
import {
  isPreviewRenderRequest,
  isPreviewTerminateRequest,
  previewRenderRequest,
  previewRenderRequestIsCompatible,
} from "../../command/preview/preview.ts";
import {
  previewUnableToRenderResponse,
  previewURL,
  printBrowsePreviewMessage,
  printWatchingForChangesMessage,
  render,
  renderServices,
} from "../../command/render/render-shared.ts";
import { renderProgress } from "../../command/render/render-info.ts";
import { resourceFilesFromFile } from "../../command/render/resources.ts";
import { projectType } from "../../project/types/project-types.ts";
import { htmlResourceResolverPostprocessor } from "../../project/types/website/website-resources.ts";
import { inputFilesDir } from "../../core/render.ts";
import { kResources } from "../../config/constants.ts";
import { resourcesFromMetadata } from "../../command/render/resources.ts";
import {
  RenderFlags,
  RenderResult,
  RenderServices,
} from "../../command/render/types.ts";
import {
  kPdfJsInitialPath,
  pdfJsBaseDir,
  pdfJsFileHandler,
} from "../../core/pdfjs.ts";
import { isPdfOutput } from "../../config/format.ts";
import { bookOutputStem } from "../../project/types/book/book-config.ts";
import { removePandocToArg } from "../../command/render/flags.ts";
import {
  isJupyterHubServer,
  isRStudioServer,
  isRStudioWorkbench,
} from "../../core/platform.ts";
import { ServeRenderManager } from "./render.ts";
import { projectScratchPath } from "../project-scratch.ts";
import { monitorPreviewTerminationConditions } from "../../core/quarto.ts";
import { exitWithCleanup, onCleanup } from "../../core/cleanup.ts";
import { projectExtensionDirs } from "../../extension/extension.ts";
import { kLocalhost } from "../../core/port.ts";
import { ProjectPreviewServe } from "../../resources/types/schema-types.ts";

export const kRenderNone = "none";
export const kRenderDefault = "default";

export async function serveProject(
  target: string | ProjectContext,
  services: RenderServices,
  flags: RenderFlags,
  pandocArgs: string[],
  options: ServeOptions,
  noServe: boolean,
) {
  let project: ProjectContext | undefined;
  if (typeof (target) === "string") {
    if (target === ".") {
      target = Deno.cwd();
    }
    project = await projectContext(target, flags, true);
    if (!project || !project?.config) {
      throw new Error(`${target} is not a website or book project`);
    }
  } else {
    project = target;
  }

  // acquire the preview lock
  acquirePreviewLock(project);

  // monitor the src dir
  monitorPreviewTerminationConditions();

  // clear the project index
  clearProjectIndex(project.dir);

  // set QUARTO_PROJECT_DIR
  Deno.env.set("QUARTO_PROJECT_DIR", project.dir);

  // resolve options
  options = {
    ...options,
    ...(await resolvePreviewOptions(options, project)),
  };

  // are we rendering?
  const renderBefore = options.render !== kRenderNone;
  if (renderBefore) {
    renderProgress("Rendering:");
  } else {
    renderProgress("Preparing to preview");
  }

  // get 'to' from --render
  flags = {
    ...flags,
    ...(renderBefore && options.render !== kRenderDefault)
      ? { to: options.render }
      : {},
  };

  // if there is no flags 'to' then set 'to' to the default format
  if (flags.to === undefined) {
    flags.to = kRenderDefault;
  }

  // are we targeting pdf output?
  const pdfOutput = isPdfOutput(flags.to || "");

  // determines files to render and resourceFiles to monitor
  // if we are in render 'none' mode then only render files whose output
  // isn't up to date. for those files we aren't rendering, compute their
  // resource files so we can watch them for changes
  let files: string[] | undefined;
  let resourceFiles: string[] = [];
  if (!renderBefore) {
    // if this is pdf output then we need to render all of the files
    // so that the latex compiler can build the entire book
    if (pdfOutput) {
      files = project.files.input;
    } else {
      const srvFiles = await serveFiles(project);
      files = srvFiles.files;
      resourceFiles = srvFiles.resourceFiles;
    }
  }

  const renderResult = await renderProject(
    project,
    {
      services,
      progress: true,
      useFreezer: !renderBefore,
      flags,
      pandocArgs,
      previewServer: true,
    },
    files,
  );

  // exit if there was an error
  if (renderResult.error) {
    throw renderResult.error;
  }

  // append resource files from render results
  resourceFiles.push(...ld.uniq(
    renderResult.files.flatMap((file) => file.resourceFiles),
  ) as string[]);

  // scan for extension dirs
  const extensionDirs = projectExtensionDirs(project);

  // render manager for tracking need to re-render outputs
  // (record any files we just rendered)
  const renderManager = new ServeRenderManager();
  renderManager.onRenderResult(
    renderResult,
    extensionDirs,
    resourceFiles,
    project,
  );

  // stop server function (will be reset if there is a serve action)
  let stopServer = () => {};

  // create project watcher. later we'll figure out if it should provide renderOutput
  const watcher = await watchProject(
    project,
    extensionDirs,
    resourceFiles,
    flags,
    pandocArgs,
    options,
    !pdfOutput, // we don't render on reload for pdf output
    renderManager,
    stopServer,
  );

  // print status
  printWatchingForChangesMessage();

  // are we serving? are we using a custom serve command?
  const serve = noServe
    ? false
    : project.config?.project?.preview?.serve || true;
  const previewServer = serve === false
    ? await noPreviewServer()
    : serve === true
    ? await internalPreviewServer(
      project,
      renderResult,
      renderManager,
      pdfOutput,
      watcher,
      extensionDirs,
      resourceFiles,
      flags,
      pandocArgs,
      options,
    )
    : await externalPreviewServer(project, serve, options);

  // set stopServer hook
  stopServer = previewServer.stop;

  // start server (launch browser if a path is returned)
  const path = await previewServer.start();

  // delay opening the browser

  if (path !== undefined) {
    printBrowsePreviewMessage(
      options.host!,
      options.port!,
      path,
    );

    if (
      options.browser &&
      !isRStudioServer() &&
      !isRStudioWorkbench() &&
      !isJupyterHubServer()
    ) {
      await openUrl(previewURL(options.host!, options.port!, path));
    }
  }

  // run the server
  await previewServer.serve();
}

interface PreviewServer {
  // returns path to browse to
  start: () => Promise<string | undefined>;
  serve: () => Promise<void>;
  stop: () => Promise<void>;
}

function noPreviewServer(): Promise<PreviewServer> {
  return Promise.resolve({
    start: () => Promise.resolve(undefined),
    serve: () => {
      return new Promise(() => {
      });
    },
    stop: () => {
      return Promise.resolve();
    },
  });
}

function externalPreviewServer(
  project: ProjectContext,
  serve: ProjectPreviewServe,
  options: ServeOptions,
): Promise<PreviewServer> {
  // parse command line args and interpolate host and port
  const cmd = serve.cmd.split(/[\t ]/).map((arg) => {
    if (arg === "{host}") {
      return options.host || kLocalhost;
    } else if (arg === "{port}") {
      return String(options.port);
    } else {
      return arg;
    }
  });
  // add custom args
  if (serve.args) {
    cmd.push(...serve.args);
  }

  // start the process
  const process = Deno.run({
    cmd,
    cwd: projectOutputDir(project),
    stdout: "piped",
    stderr: "piped",
  });

  // merge and stream stdout and stderr
  const readyPattern = new RegExp(serve.ready);
  const multiplexIterator = new MuxAsyncIterator<
    Uint8Array
  >();
  multiplexIterator.add(iterateReader(process.stdout));
  multiplexIterator.add(iterateReader(process.stderr));

  // wait for ready and then return from 'start'
  const decoder = new TextDecoder();
  return Promise.resolve({
    start: async () => {
      for await (const chunk of multiplexIterator) {
        const text = decoder.decode(chunk);
        if (readyPattern.test(text)) {
          break;
        }
        Deno.stderr.writeSync(chunk);
      }
      return "";
    },
    serve: async () => {
      for await (const chunk of multiplexIterator) {
        Deno.stderr.writeSync(chunk);
      }
      await process.status();
    },
    stop: () => {
      process.kill("SIGTERM");
      process.close();
      return Promise.resolve();
    },
  });
}

async function internalPreviewServer(
  project: ProjectContext,
  renderResult: RenderResult,
  renderManager: ServeRenderManager,
  pdfOutput: boolean,
  watcher: ProjectWatcher,
  extensionDirs: string[],
  resourceFiles: string[],
  flags: RenderFlags,
  pandocArgs: string[],
  options: ServeOptions,
): Promise<PreviewServer> {
  const projType = projectType(project?.config?.project?.[kProjectType]);

  const outputDir = projectOutputDir(project);

  const finalOutput = renderResultFinalOutput(renderResult);

  // function that can return the current target pdf output file
  const pdfOutputFile = (finalOutput && pdfOutput)
    ? (): string => {
      const project = watcher.project();
      return join(
        dirname(finalOutput),
        bookOutputStem(project.dir, project.config) + ".pdf",
      );
    }
    : undefined;

  const handlerOptions: HttpFileRequestOptions = {
    //  base dir
    baseDir: outputDir,

    // print all urls
    printUrls: "all",

    // handle websocket upgrade and render requests
    onRequest: async (req: Request) => {
      if (watcher.handle(req)) {
        return await watcher.connect(req);
      } else if (isPreviewTerminateRequest(req)) {
        exitWithCleanup(0);
      } else if (isPreviewRenderRequest(req)) {
        const prevReq = previewRenderRequest(
          req,
          watcher.hasClients(),
          project!.dir,
        );
        if (
          prevReq &&
          (await previewRenderRequestIsCompatible(prevReq, flags, project))
        ) {
          if (isProjectInputFile(prevReq.path, project!)) {
            const services = renderServices();
            // if there is no specific format requested then 'all' needs
            // to become 'html' so we don't render all formats
            const to = flags.to === "all"
              ? (prevReq.format || "html")
              : flags.to;
            render(prevReq.path, {
              services,
              flags: { ...flags, to },
              pandocArgs,
              previewServer: true,
            }).then((result) => {
              if (result.error) {
                if (result.error?.message) {
                  logError(result.error);
                }
              } else {
                // print output created
                const finalOutput = renderResultFinalOutput(
                  result,
                  project!.dir,
                );
                if (!finalOutput) {
                  throw new Error(
                    "No output created by quarto render " +
                      basename(prevReq.path),
                  );
                }

                renderManager.onRenderResult(
                  result,
                  extensionDirs,
                  resourceFiles,
                  watcher.project(),
                );

                info("Output created: " + finalOutput + "\n");

                watcher.reloadClients(
                  true,
                  !isPdfContent(finalOutput)
                    ? join(project!.dir, finalOutput)
                    : undefined,
                );
              }
            }).finally(() => {
              services.cleanup();
            });
            return httpContentResponse("rendered");
          } else {
            return previewUnableToRenderResponse();
          }
        } else {
          return previewUnableToRenderResponse();
        }
      } else {
        return undefined;
      }
    },

    // handle html file requests w/ re-renders
    onFile: async (file: string, req: Request) => {
      // if this is an html file or a pdf then re-render (using the freezer)
      if (isHtmlContent(file) || isPdfContent(file)) {
        // find the input file associated with this output and render it
        // if we can't find an input file for this .html file it may have
        // been an input added after the server started running, to catch
        // this case run a refresh on the watcher then try again
        const serveDir = projectOutputDir(watcher.project());
        const filePathRelative = relative(serveDir, file);
        let inputFile = await inputFileForOutputFile(
          watcher.project(),
          filePathRelative,
        );
        if (!inputFile || !existsSync(inputFile)) {
          inputFile = await inputFileForOutputFile(
            await watcher.refreshProject(),
            filePathRelative,
          );
        }
        let result: RenderResult | undefined;
        let renderError: Error | undefined;
        if (inputFile) {
          // render the file if we haven't already done a render for the current input state
          if (
            renderManager.fileRequiresReRender(
              file,
              inputFile,
              extensionDirs,
              resourceFiles,
              watcher.project(),
            )
          ) {
            const renderFlags = { ...flags, quiet: true };
            // remove 'to' argument to allow the file to be rendered in it's default format
            // (only if we are in a project type e.g. websites that allows multiple formats)
            const renderPandocArgs = projType.projectFormatsOnly
              ? pandocArgs
              : removePandocToArg(pandocArgs);
            if (!projType.projectFormatsOnly) {
              delete renderFlags?.to;
            }
            // if to is 'all' then choose html
            if (renderFlags?.to == "all") {
              renderFlags.to = isHtmlContent(file) ? "html" : "pdf";
            }
            const services = renderServices();
            try {
              result = await renderManager.renderQueue().enqueue(() =>
                renderProject(
                  watcher.project(),
                  {
                    services,
                    useFreezer: true,
                    devServerReload: true,
                    flags: renderFlags,
                    pandocArgs: renderPandocArgs,
                  },
                  [inputFile!],
                )
              );
              if (result.error) {
                logError(result.error);
                renderError = result.error;
              } else {
                renderManager.onRenderResult(
                  result,
                  extensionDirs,
                  resourceFiles,
                  project!,
                );
              }
            } catch (e) {
              logError(e);
              renderError = e;
            } finally {
              services.cleanup();
            }
          }
        }

        // read the output file
        const fileContents = renderError
          ? renderErrorPage(renderError)
          : Deno.readFileSync(file);

        // inject watcher client for html
        if (isHtmlContent(file) && inputFile) {
          const projInputFile = join(
            project!.dir,
            relative(watcher.project().dir, inputFile),
          );
          return watcher.injectClient(
            req,
            fileContents,
            projInputFile,
          );
        } else {
          return { contentType: contentType(file), body: fileContents };
        }
      } else {
        return undefined;
      }
    },

    // handle 404 by returing site custom 404 page
    on404: (url: string, req: Request) => {
      const print = !basename(url).startsWith("jupyter-");
      let body = new TextEncoder().encode("Not Found");
      const custom404 = join(outputDir, kProject404File);
      if (existsSync(custom404)) {
        let content404 = Deno.readTextFileSync(custom404);
        // replace site-path references with / so they work in dev server mode
        const sitePath = websitePath(project?.config);
        if (sitePath !== "/" || isRStudioServer()) {
          // if we are in rstudio server port proxied mode then replace
          // including the port proxy
          let replacePath = "/";
          const referer = req.headers.get("referer");
          if (isRStudioServer() && referer) {
            const match = referer.match(/\/p\/.*?\//);
            if (match) {
              replacePath = match[0];
            }
          }

          content404 = content404.replaceAll(
            new RegExp('((?:content|ref|src)=")(' + sitePath + ")", "g"),
            "$1" + replacePath,
          );
        }
        body = new TextEncoder().encode(content404);
      }
      return {
        print,
        response: watcher.injectClient(req, body),
      };
    },
  };

  // if this is a pdf then we tweak the options to correctly handle pdfjs
  if (finalOutput && pdfOutput) {
    // change the baseDir to the pdfjs directory
    handlerOptions.baseDir = pdfJsBaseDir();

    // install custom handler for pdfjs
    handlerOptions.onFile = pdfJsFileHandler(
      pdfOutputFile!,
      async (file: string, req: Request) => {
        // inject watcher client for html
        if (isHtmlContent(file)) {
          const fileContents = await Deno.readFile(file);
          return watcher.injectClient(req, fileContents);
        } else {
          return undefined;
        }
      },
    );
  }

  // create the handler
  const handler = httpFileRequestHandler(handlerOptions);

  // if we are passed a browser path, resolve the output file if its an input
  let browserPath = options.browserPath
    ? options.browserPath.replace(/^\//, "")
    : undefined;
  if (browserPath) {
    const browserPathTarget = await resolveInputTarget(
      project,
      browserPath,
      false,
    );
    if (browserPathTarget) {
      browserPath = browserPathTarget.outputHref;
    }
  }

  // compute browse url
  const targetPath = browserPath
    ? browserPath
    : pdfOutput
    ? kPdfJsInitialPath
    : renderResultUrlPath(renderResult);

  // print browse url and open browser if requested
  const path = (targetPath && targetPath !== "index.html") ? targetPath : "";

  // start listening
  const listener = Deno.listen({ port: options.port!, hostname: options.host });

  return {
    start: () => Promise.resolve(path),
    serve: async () => {
      // serve project
      for await (const conn of listener) {
        (async () => {
          try {
            for await (const { request, respondWith } of Deno.serveHttp(conn)) {
              await respondWith(handler(request));
            }
          } catch (err) {
            warning(err.message);
            try {
              conn.close();
            } catch {
              //
            }
          }
        })();
      }
    },
    stop: () => {
      listener.close();
      return Promise.resolve();
    },
  };
}

// https://deno.com/blog/v1.23#remove-unstable-denosleepsync-api
function sleepSync(timeout: number) {
  const sab = new SharedArrayBuffer(1024);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, timeout);
}

function acquirePreviewLock(project: ProjectContext) {
  // get lockfile
  const lockfile = previewLockFile(project);

  // if there is a lockfile send a kill signal to the pid therin
  if (existsSync(lockfile)) {
    const pid = parseInt(Deno.readTextFileSync(lockfile)) || undefined;
    if (pid) {
      info(
        colors.bold(colors.blue("Terminating existing preview server....")),
        { newline: false },
      );
      try {
        Deno.kill(pid, "SIGTERM");
        sleepSync(3000);
      } catch {
        //
      } finally {
        info(colors.bold(colors.blue("DONE\n")));
      }
    }
  }

  // write our pid to the lockfile
  Deno.writeTextFileSync(lockfile, String(Deno.pid));

  // rmeove the lockfile when we exit
  onCleanup(() => releasePreviewLock(project));
}

function releasePreviewLock(project: ProjectContext) {
  try {
    Deno.removeSync(previewLockFile(project));
  } catch {
    //
  }
}

function previewLockFile(project: ProjectContext) {
  return projectScratchPath(project.dir, join("preview", "lock"));
}

function renderErrorPage(e: Error) {
  const content = `
<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<title>Quarto Render Error</title>
<script id="quarto-render-error" type="text/plain">${e.message}</script>
</head>
<body>
</body>
</html>
`;
  return new TextEncoder().encode(content);
}

async function serveFiles(
  project: ProjectContext,
): Promise<{ files: string[]; resourceFiles: string[] }> {
  // one time denoDom init
  await initDenoDom();

  const files: string[] = [];
  const resourceFiles: string[] = [];
  for (let i = 0; i < project.files.input.length; i++) {
    const inputFile = project.files.input[i];
    const projRelative = relative(project.dir, inputFile);
    const target = await resolveInputTarget(project, projRelative, false);
    if (target) {
      const outputFile = join(projectOutputDir(project), target?.outputHref);
      if (isModifiedAfter(inputFile, outputFile)) {
        // render this file
        files.push(inputFile);
      } else {
        // we aren't rendering this file, so we need to compute it's resource files
        // for monitoring during serve

        // resource files referenced in html
        const files: string[] = [];
        if (isHtmlContent(outputFile)) {
          const htmlInput = Deno.readTextFileSync(outputFile);
          const doc = new DOMParser().parseFromString(htmlInput, "text/html")!;
          const resolver = htmlResourceResolverPostprocessor(
            inputFile,
            project,
          );
          files.push(...(await resolver(doc)).resources);
        }

        // partition markdown and read globs
        const partitioned = await partitionedMarkdownForInput(
          project.dir,
          projRelative,
        );
        const globs: string[] = [];
        if (partitioned?.yaml) {
          const metadata = partitioned.yaml;
          globs.push(...resourcesFromMetadata(metadata[kResources]));
        }

        // compute resource refs and add them
        resourceFiles.push(
          ...(await resourceFilesFromFile(
            project.dir,
            projectExcludeDirs(project),
            projRelative,
            { files, globs },
            false, // selfContained,
            [join(dirname(projRelative), inputFilesDir(projRelative))],
            partitioned,
          )),
        );
      }
    } else {
      warning("Unabled to resolve output target for " + inputFile);
    }
  }

  return { files, resourceFiles: ld.uniq(resourceFiles) as string[] };
}
