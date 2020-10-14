import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "path/mod.ts";

import { Command } from "cliffy/command/mod.ts";

import { mergeConfigs } from "../../config/config.ts";

import { consoleWriteLine } from "../../core/console.ts";
import type { ProcessResult } from "../../core/process.ts";
import { readYAML } from "../../core/yaml.ts";

import { formatForInputFile } from "../../config/format.ts";
import { postProcess as postprocess, runComputations } from "./computation.ts";
import { runPandoc } from "./pandoc.ts";
import {
  fixupPandocArgs,
  parseRenderFlags,
  RenderFlags,
  replacePandocArg,
} from "./flags.ts";
import { cleanup } from "./cleanup.ts";

// TODO: test to see whether any artifacts are left around by rendering to/from varoius dirs
// TODO: correct relative path for "Output created:" so the IDE will always be able to preview it

// TODO: add --self-contained to documented render flags

// TODO: output system:
//   - coloring
//   - progress
//   - error reporting

// TODO: new config system
// TODO: fill out all the pandoc formats

// TODO: shiny_prerendered  (quarto run)

// TODO: keep_tex
// TODO: Run citeproc / crossref
// TODO: LaTeX w/ TinyTex

export interface RenderOptions {
  input: string;
  flags: RenderFlags;
  pandocArgs?: string[];
}

export async function render(options: RenderOptions): Promise<ProcessResult> {
  // alias quiet
  const quiet = options.flags.quiet;

  // derive format options (looks in file and at project level _quarto.yml)
  const format = await formatForInputFile(
    options.input,
    options.flags.to,
  );

  // derive the output file
  const inputDir = dirname(options.input);
  const inputStem = basename(options.input, extname(options.input));
  const computationOutput = join(inputDir, inputStem + ".quarto.md");

  // resolve parameters (if any)
  const params = resolveParams(options.flags.params);

  // run computations (if any)
  const computations = await runComputations({
    input: options.input,
    output: computationOutput,
    format,
    params,
    quiet,
  });

  // resolve output and args
  const { output, args } = resolveOutput(
    inputDir,
    inputStem,
    format.output?.ext,
    options.flags.output,
    options.pandocArgs,
  );

  // run pandoc conversion
  const result = await runPandoc({
    input: computationOutput,
    format: mergeConfigs(format.pandoc || {}, computations.pandoc),
    args,
    quiet,
  });

  // run post processor
  let finalOutput = output;
  if (computations.postprocess) {
    finalOutput = await postprocess({
      input: options.input,
      format,
      output,
      data: computations.postprocess,
      quiet,
    });
  }

  // cleanup as necessary
  cleanup(options.flags, format, computations, finalOutput);

  // report
  if (result.success && !options.flags.quiet) {
    reportOutput(finalOutput);
  }

  // return result
  return result;
}

// resolve parameters (if any)
function resolveParams(params?: string) {
  if (!params || params === "ask") {
    return params;
  } else {
    return readYAML(params) as { [key: string]: unknown };
  }
}

// resole output file and --output argument based on input, target ext, and any provided args
function resolveOutput(
  inputDir: string,
  inputStem: string,
  ext?: string,
  output?: string,
  pandocArgs?: string[],
) {
  ext = ext || "html";
  let args = pandocArgs || [];
  // no output on the command line: insert our derived output file path
  if (!output) {
    output = join(inputStem + "." + ext);
    args.unshift("--output", output);
    // relatve output file on the command line: make it relative to the input dir
  } else if (!isAbsolute(output)) {
    output = relative(inputDir, output);
    args = replacePandocArg(args, "--output", output);
  }

  // return
  return {
    output,
    args,
  };
}

function reportOutput(output: string) {
  if (output !== "-") {
    consoleWriteLine("Output created: " + output + "\n");
  }
}

export const renderCommand = new Command()
  .name("render")
  .stopEarly()
  .arguments("<input:string> [...pandoc-args:string]")
  .description(
    "Render a file using the supplied target format and pandoc command line arguments.\n" +
      "See pandoc --help for documentation on all available options.",
  )
  .option(
    "-t, --to [to:string]",
    "Specify output format (defaults to html).",
  )
  .option(
    "-o, --output [output:string]",
    "Write output to FILE (use '--output -' for stdout).",
  )
  .option(
    "--params [params:string]",
    "YAML file with parameter values (or 'ask' to prompt)",
  )
  .option(
    "--keep-all [keep-all:boolean]",
    "Keep all intermediate files (e.g. markdown, tex, plots, etc.) ",
  )
  .option(
    "--quiet [quiet:boolean]",
    "Suppress warning and other messages.",
  )
  .option(
    "[...pandoc-args:string]",
    "Additional pandoc command line arguments.",
  )
  .example(
    "Render R Markdown",
    "quarto render notebook.Rmd\n" +
      "quarto render notebook.Rmd --to html\n" +
      "quarto render notebook.Rmd --to pdf --toc",
  )
  .example(
    "Render Jupyter Notebook",
    "quarto render notebook.ipynb\n" +
      "quarto render notebook.ipynb --to docx\n" +
      "quarto render notebook.ipynb --to docx --highlight-style=espresso\n",
  )
  .example(
    "Render to Standard Output",
    "quarto render notebook.Rmd --output -",
  )
  // deno-lint-ignore no-explicit-any
  .action(async (options: any, input: string, pandocArgs: string[]) => {
    try {
      // extract pandoc flags we know/care about (they will still go to pandoc)
      const flags = parseRenderFlags(pandocArgs);

      // fixup args as necessary
      pandocArgs = fixupPandocArgs(pandocArgs, flags);

      // run render
      const result = await render({ input, flags, pandocArgs });

      if (!result.success) {
        // error diagnostics already written to stderr
        Deno.exit(result.code);
      }
    } catch (error) {
      if (error) {
        consoleWriteLine(error.toString());
      }
      Deno.exit(1);
    }
  });
