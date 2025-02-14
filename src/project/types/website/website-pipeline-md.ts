/*
* website-pipeline-md.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/
import { Document, Element } from "deno_dom/deno-dom-wasm-noinit.ts";

export interface MarkdownPipelineHandler {
  getUnrendered: () => Record<string, string> | undefined;
  processRendered: (rendered: Record<string, Element>, doc: Document) => void;
}

export interface MarkdownPipeline {
  markdownAfterBody(): string;
  processRenderedMarkdown(doc: Document): void;
}

export const createMarkdownPipeline = (
  envelopeId: string,
  handlers: MarkdownPipelineHandler[],
): MarkdownPipeline => {
  return {
    markdownAfterBody() {
      const markdownRecords: Record<string, string> = {};
      handlers.forEach((handler) => {
        const handlerRecords = handler.getUnrendered();
        if (handlerRecords) {
          Object.keys(handlerRecords).forEach((key) => {
            markdownRecords[key] = handlerRecords[key];
          });
        }
      });
      return createMarkdownRenderEnvelope(envelopeId, markdownRecords);
    },
    processRenderedMarkdown(doc: Document) {
      processMarkdownRenderEnvelope(
        doc,
        envelopeId,
        handlers.map((handler) => {
          return handler.processRendered;
        }),
      );
    },
  };
};

export function createMarkdownRenderEnvelope(
  envelopeId: string,
  records: Record<string, string>,
) {
  const envelope = markdownEnvelopeWriter(envelopeId);
  Object.keys(records).forEach((key) => {
    envelope.add(key, records[key]);
  });
  return envelope.toMarkdown();
}

export function processMarkdownRenderEnvelope(
  doc: Document,
  envelopeId: string,
  processors: Array<
    (renderedMarkdown: Record<string, Element>, doc: Document) => void
  >,
) {
  const renderedMarkdown = readEnvelope(doc, envelopeId);
  processors.forEach((processor) => {
    processor(renderedMarkdown, doc);
  });
}

const markdownEnvelopeWriter = (envelopeId: string) => {
  const renderList: string[] = [];
  const hiddenSpan = (id: string, contents: string) => {
    return `[${contents}]{.hidden render-id="${id}"}`;
  };

  return {
    add: (id: string, value: string) => {
      renderList.push(hiddenSpan(id, value));
    },
    toMarkdown: () => {
      const contents = renderList.join("\n");
      return `\n:::{#${envelopeId} .hidden}\n${contents}\n:::\n`;
    },
  };
};

const readEnvelope = (doc: Document, envelopeId: string) => {
  const envelope = doc.getElementById(envelopeId);
  const contents: Record<string, Element> = {};
  if (envelope) {
    const nodes = envelope.querySelectorAll("span[data-render-id]");
    nodes.forEach((node) => {
      const el = node as Element;
      const id = el.getAttribute("data-render-id");
      if (id) {
        contents[id] = el;
      }
    });
    envelope.remove();
  }
  return contents;
};
