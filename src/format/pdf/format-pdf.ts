/*
* format-pdf.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { basename, extname, join } from "path/mod.ts";

import { mergeConfigs } from "../../core/config.ts";
import { texSafeFilename } from "../../core/tex.ts";

import {
  kCiteMethod,
  kClassOption,
  kDocumentClass,
  kEcho,
  kFigDpi,
  kFigFormat,
  kFigHeight,
  kFigWidth,
  kKeepTex,
  kNumberSections,
  kPaperSize,
  kReferenceLocation,
  kShiftHeadingLevelBy,
  kTopLevelDivision,
  kWarning,
} from "../../config/constants.ts";
import { Format, FormatExtras, PandocFlags } from "../../config/types.ts";

import { createFormat } from "../formats-shared.ts";

import { RenderedFile } from "../../command/render/types.ts";
import { ProjectContext } from "../../project/types.ts";
import { BookExtension } from "../../project/types/book/book-shared.ts";

import { readLines } from "io/bufio.ts";
import { sessionTempFile } from "../../core/temp.ts";

export function pdfFormat(): Format {
  return mergeConfigs(
    createPdfFormat(),
    {
      extensions: {
        book: pdfBookExtension,
      },
    },
  );
}

export function beamerFormat(): Format {
  return createFormat(
    "pdf",
    createPdfFormat(false, false),
    {
      execute: {
        [kFigWidth]: 10,
        [kFigHeight]: 7,
        [kEcho]: false,
        [kWarning]: false,
      },
    },
  );
}

export function latexFormat(): Format {
  return createFormat(
    "tex",
    createPdfFormat(),
  );
}

function createPdfFormat(autoShiftHeadings = true, koma = true): Format {
  return createFormat(
    "pdf",
    {
      execute: {
        [kFigWidth]: 6.5,
        [kFigHeight]: 4.5,
        [kFigFormat]: "pdf",
        [kFigDpi]: 300,
      },
      pandoc: {
        standalone: true,
        variables: {
          graphics: true,
          tables: true,
        },
      },
      formatExtras: (_input: string, flags: PandocFlags, format: Format) => {
        const extras: FormatExtras = {};

        // Post processed for dealing with latex output
        extras.postprocessors = [pdfLatexPostProcessor(flags, format)];

        // default to KOMA article class. we do this here rather than
        // above so that projectExtras can override us
        if (koma) {
          extras.metadata = {
            [kDocumentClass]: "scrartcl",
            [kClassOption]: ["DIV=11"],
            [kPaperSize]: "letter",
          };
        }

        // pdfs with no other heading level oriented options get their heading level shifted by -1
        if (
          autoShiftHeadings &&
          (flags?.[kNumberSections] === true ||
            format.pandoc[kNumberSections] === true) &&
          flags?.[kTopLevelDivision] === undefined &&
          format.pandoc?.[kTopLevelDivision] === undefined &&
          flags?.[kShiftHeadingLevelBy] === undefined &&
          format.pandoc?.[kShiftHeadingLevelBy] === undefined
        ) {
          extras.pandoc = {
            [kShiftHeadingLevelBy]: -1,
          };
        }

        return extras;
      },
    },
  );
}

const pdfBookExtension: BookExtension = {
  onSingleFilePostRender: (
    project: ProjectContext,
    renderedFile: RenderedFile,
  ) => {
    // if we have keep-tex then rename the input tex file to match the final output
    // file (but make sure it has a tex-friendly filename)
    if (renderedFile.format.render[kKeepTex]) {
      const finalOutputFile = renderedFile.file!;
      const texOutputFile =
        texSafeFilename(basename(finalOutputFile, extname(finalOutputFile))) +
        ".tex";
      Deno.renameSync(
        join(project.dir, "index.tex"),
        join(project.dir, texOutputFile),
      );
    }
  },
};
type LineProcessor = (line: string) => string | undefined;

function pdfLatexPostProcessor(flags: PandocFlags, format: Format) {
  return async (output: string) => {
    const lineProcessors: LineProcessor[] = [
      sidecaptionLineProcessor(),
    ];

    const renderedCites = {};
    // If enabled, switch to sidenote footnotes
    if (marginRefs(flags, format)) {
      // Replace notes with side notes
      lineProcessors.push(sideNoteLineProcessor());

      // Based upon the cite method, post process the file to
      // process unresolved citations
      if (format.pandoc[kCiteMethod] === "biblatex") {
        lineProcessors.push(suppressBibLatexBibliographyLineProcessor());
        lineProcessors.push(bibLatexCiteLineProcessor());
      } else if (format.pandoc[kCiteMethod] === "natbib") {
        lineProcessors.push(suppressNatbibBibliographyLineProcessor());
        lineProcessors.push(natbibCiteLineProcessor());
      } else {
        // If this is using the pandoc default citeproc, we need to
        // do a more complex processing, since it is generating raw latex
        // for the citations (not running a tool in the pdf chain to
        // generate the bibliography). As a result, we first read the
        // rendered bibliography, indexing the entring and removing it
        // from the latex, then we run a second pass where we use that index
        // to replace cites with the rendered versions.
        lineProcessors.push(
          indexAndSuppressPandocBibliography(renderedCites),
        );
      }
    }

    await processLines(output, lineProcessors);
    if (Object.keys(renderedCites).length > 0) {
      await processLines(output, [
        placePandocBibliographyEntries(renderedCites),
      ]);
    }
  };
}

function marginRefs(flags: PandocFlags, format: Format) {
  return format.pandoc[kReferenceLocation] === "margin" ||
    flags[kReferenceLocation] === "margin";
}

// Processes the lines of an input file, processing each line
// and replacing the input file with the processed output file
async function processLines(
  inputFile: string,
  lineProcessors: LineProcessor[],
) {
  // The temp file we generate into
  const outputFile = sessionTempFile({ suffix: ".tex" });
  const file = await Deno.open(inputFile);
  try {
    for await (const line of readLines(file)) {
      let processedLine: string | undefined = line;
      // Give each processor a shot at the line
      for (const processor of lineProcessors) {
        if (processedLine !== undefined) {
          processedLine = processor(processedLine);
        }
      }

      // skip lines that a processor has 'eaten'
      if (processedLine !== undefined) {
        Deno.writeTextFileSync(outputFile, processedLine + "\n", {
          append: true,
        });
      }
    }
  } finally {
    file.close();

    // Always overwrite the input file with an incompletely processed file
    // which should make debugging the error easier (I hope)
    Deno.copyFileSync(outputFile, inputFile);
  }
}

const kBeginScanRegex = /^%quartopost-sidecaption-206BE349/;
const kEndScanRegex = /^%\/quartopost-sidecaption-206BE349/;

const sidecaptionLineProcessor = () => {
  let state: "scanning" | "replacing" = "scanning";
  return (line: string): string | undefined => {
    switch (state) {
      case "scanning":
        if (line.match(kBeginScanRegex)) {
          state = "replacing";
          return kbeginLongTablesideCap;
        } else {
          return line;
        }

      case "replacing":
        if (line.match(kEndScanRegex)) {
          state = "scanning";
          return kEndLongTableSideCap;
        } else {
          return line;
        }
    }
  };
};

// Removes the biblatex \printbibiliography command
const suppressBibLatexBibliographyLineProcessor = () => {
  return (line: string): string | undefined => {
    if (line.match(/^\\printbibliography$/)) {
      return "";
    }
    return line;
  };
};

// Replaces the natbib bibligography declaration with a version
// that will not be printed in the PDF
const suppressNatbibBibliographyLineProcessor = () => {
  return (line: string): string | undefined => {
    return line.replace(/^\s*\\bibliography{(.*)}$/, (_match, bib) => {
      return `\\newsavebox\\mytempbib
\\savebox\\mytempbib{\\parbox{\\textwidth}{\\bibliography{${bib}}}}`;
    });
  };
};

// {?quarto-cite:(id)}
const kQuartoCiteRegex = /{\?quarto-cite:(.*?)}/g;

const bibLatexCiteLineProcessor = () => {
  return (line: string): string | undefined => {
    return line.replaceAll(kQuartoCiteRegex, (_match, citeKey) => {
      return `\\fullcite{${citeKey}}`;
    });
  };
};

const natbibCiteLineProcessor = () => {
  return (line: string): string | undefined => {
    return line.replaceAll(kQuartoCiteRegex, (_match, citeKey) => {
      return `\\bibentry{${citeKey}}`;
    });
  };
};

const sideNoteLineProcessor = () => {
  return (line: string): string | undefined => {
    return line.replaceAll(/\\footnote{/g, "\\sidenote{\\footnotesize ");
  };
};

const indexAndSuppressPandocBibliography = (
  renderedCites: Record<string, string[]>,
) => {
  let consuming = false;
  let currentCiteKey: string | undefined = undefined;

  return (line: string): string | undefined => {
    if (!consuming && line.match(/^\\hypertarget{refs}{}$/)) {
      consuming = true;
      return undefined;
    } else if (consuming && line.match(/^\\end{CSLReferences}$/)) {
      consuming = false;
      return undefined;
    } else if (consuming) {
      const matches = line.match(/pre{\\hypertarget{ref\-(.*?)}{}}\%/);
      if (matches && matches[1]) {
        currentCiteKey = matches[1];

        // protect the hypertarget command and the save this line
        // protect is useful if the reference appears in a caption
        renderedCites[currentCiteKey] = [
          line.replace(
            "pre{\\hypertarget{ref",
            "pre{\\protect\\hypertarget{ref",
          ),
        ];
      } else if (line.length === 0) {
        currentCiteKey = undefined;
      } else if (currentCiteKey) {
        renderedCites[currentCiteKey].push(line);
      }
    }

    if (consuming) {
      return undefined;
    } else {
      return line;
    }
  };
};

const placePandocBibliographyEntries = (
  renderedCites: Record<string, string[]>,
) => {
  return (line: string): string | undefined => {
    return line.replaceAll(kQuartoCiteRegex, (_match, citeKey) => {
      const citeLines = renderedCites[citeKey];
      if (citeLines) {
        return citeLines.join("\n");
      } else {
        return citeKey;
      }
    });
  };
};

const kbeginLongTablesideCap = `{
\\makeatletter
\\def\\LT@makecaption#1#2#3{%
  \\noalign{\\smash{\\hbox{\\kern\\textwidth\\rlap{\\kern\\marginparsep
  \\parbox[t]{\\marginparwidth}{%
    \\footnotesize{%
      \\vspace{(1.1\\baselineskip)}
    #1{#2: }\\ignorespaces #3}}}}}}%
    }
\\makeatother`;

const kEndLongTableSideCap = "}";
