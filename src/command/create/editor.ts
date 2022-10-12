/*
* cmd.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { join } from "path/mod.ts";
import { existsSync } from "fs/mod.ts";
import { which } from "../../core/path.ts";
import { basename, dirname } from "path/win32.ts";
import { execProcess } from "../../core/process.ts";

export interface Editor {
  // A short, command line friendly id
  id: string;

  // A display name
  name: string;

  // Function that can be called to open the matched
  // artifact in the editor
  open: () => Promise<unknown>;
}

export const kEditorInfos: EditorInfo[] = [
  vscodeEditorInfo(),
  rstudioEditorInfo(),
];

export async function scanForEditors(
  editorInfos: EditorInfo[],
  artifactPath: string,
) {
  const editors: Editor[] = [];
  for (const editorInfo of editorInfos) {
    const editorPath = await findEditorPath(editorInfo.actions);
    if (editorPath) {
      editors.push({
        id: editorInfo.id,
        name: editorInfo.name,
        open: editorInfo.open(editorPath, artifactPath),
      });
    }
  }
  return editors;
}

interface EditorInfo {
  // The identifier for this editor
  id: string;

  // The name of this editor
  name: string;

  // Actions that are used to scan for this editor
  actions: ScanAction[];

  // Uses a path and artifact path to provide a function
  // that can be used to open this editor to the given artifact
  open: (path: string, artifactPath: string) => () => Promise<unknown>;
}

interface ScanAction {
  action: "path" | "which";
  arg: string;
}

function vscodeEditorInfo(): EditorInfo {
  const editorInfo: EditorInfo = {
    id: "vscode",
    name: "Visual Studio Code",
    open: (path: string, artifactPath: string) => {
      const cwd = Deno.statSync(artifactPath).isDirectory
        ? artifactPath
        : dirname(artifactPath);

      return () => {
        return execProcess({
          cmd: [path, artifactPath],
          cwd,
        });
      };
    },
    actions: [],
  };

  if (Deno.build.os === "windows") {
    editorInfo.actions.push({
      action: "which",
      arg: "code.exe",
    });
    const pathActions = windowsAppPaths("Microsoft VS Code", "code.exe").map(
      (path) => {
        return {
          action: "path",
          arg: path,
        } as ScanAction;
      },
    );
    editorInfo.actions.push(...pathActions);
  } else if (Deno.build.os === "darwin") {
    editorInfo.actions.push({
      action: "which",
      arg: "code",
    });

    const pathActions = macosAppPaths(
      "Visual Studio Code.app/Contents/Resources/app/bin/code",
    ).map((path) => {
      return {
        action: "path",
        arg: path,
      } as ScanAction;
    });
    editorInfo.actions.push(...pathActions);
  } else {
    editorInfo.actions.push({
      action: "which",
      arg: "code",
    });
    editorInfo.actions.push({
      action: "path",
      arg: "/snap/bin/code",
    });
  }
  return editorInfo;
}

function rstudioEditorInfo(): EditorInfo {
  const editorInfo: EditorInfo = {
    id: "rstudio",
    name: "RStudio",
    open: (path: string, artifactPath: string) => {
      return () => {
        // The directory that the artifact is in
        const cwd = Deno.statSync(artifactPath).isDirectory
          ? artifactPath
          : dirname(artifactPath);

        // Write an rproj file for RStudio and open that
        const artifactName = basename(artifactPath);
        const rProjPath = join(cwd, `${artifactName}.rproj`);
        Deno.writeTextFileSync(rProjPath, kRProjContents);

        const cmd = path.endsWith(".app") && Deno.build.os === "darwin"
          ? ["open", "-na", path, "--args", rProjPath]
          : [path];

        return execProcess({
          cmd: cmd,
          cwd,
        });
      };
    },
    actions: [],
  };

  if (Deno.build.os === "windows") {
    const paths = windowsAppPaths("RStudio", "rstudio.exe").map((path) => {
      return {
        action: "path",
        arg: path,
      } as ScanAction;
    });
    editorInfo.actions.push(...paths);
  } else if (Deno.build.os === "darwin") {
    const paths = macosAppPaths("RStudio.app").map((path) => {
      return {
        action: "path",
        arg: path,
      } as ScanAction;
    });
    editorInfo.actions.push(...paths);
  } else {
    editorInfo.actions.push({
      action: "path",
      arg: "/usr/lib/rstudio/bin",
    });
    editorInfo.actions.push({
      action: "which",
      arg: "RStudio",
    });
  }
  return editorInfo;
}

// Write an rproj file to the cwd and open that
const kRProjContents = `Version: 1.0

RestoreWorkspace: Default
SaveWorkspace: Default
AlwaysSaveHistory: Default

EnableCodeIndexing: Yes
UseSpacesForTab: Yes
NumSpacesForTab: 2
Encoding: UTF-8

RnwWeave: Knitr
LaTeX: pdfLaTeX`;

async function findEditorPath(
  actions: ScanAction[],
): Promise<string | undefined> {
  for (const action of actions) {
    switch (action.action) {
      case "which": {
        const path = await which(action.arg);
        if (path) {
          return path;
        }
        break;
      }
      case "path":
        if (existsSync(action.arg)) {
          return action.arg;
        }
        break;
    }
  }
  // Couldn't find it, give up
  return undefined;
}

function windowsAppPaths(folderName: string, command: string) {
  const paths: string[] = [];
  // Scan local app folder
  const localAppData = Deno.env.get("LOCALAPPDATA");
  if (localAppData) {
    paths.push(join(localAppData, "Programs", folderName, command));
  }

  // Scan program files folder
  const programFiles = Deno.env.get("PROGRAMFILES");
  if (programFiles) {
    paths.push(programFiles, folderName, command);
  }

  // Scan program files x86
  const programFilesx86 = Deno.env.get("PROGRAMFILES(X86)");
  if (programFilesx86) {
    paths.push(programFilesx86, folderName, command);
  }
  return paths;
}

function macosAppPaths(appName: string) {
  const paths: string[] = [];
  paths.push(join("/Applications", appName));
  const home = Deno.env.get("HOME");
  if (home) {
    paths.push(join(home, "Applications", appName));
  }
  return paths;
}
