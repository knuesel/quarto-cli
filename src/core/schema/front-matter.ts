/*
* front-matter.ts
*
* JSON Schema for Quarto's YAML frontmatter
*
* Copyright (C) 2021 by RStudio, PBC
*
*/

import {
  allOfSchema as allOfS,
  enumSchema as enumS,
  completeSchema,
  describeSchema,
  idSchema as withId,
  NullSchema as nullS,
  objectSchema as objectS,
  oneOfSchema as oneOfS,
  regexSchema as regexS,
  refSchema
} from "./common.ts";

import { getFormatExecuteOptionsSchema } from "./execute.ts";

import { schemaPath } from "./utils.ts";

import { objectRefSchemaFromGlob, SchemaField } from "./from-yaml.ts";

import { normalizeSchema, Schema } from "../lib/schema.ts";

import { getFormatSchema } from "./format-schemas.ts";
import { pandocOutputFormats } from "./pandoc-output-formats.ts";

import { defineCached } from "./definitions.ts";

export async function makeFrontMatterFormatSchema(nonStrict = false) {
  const formatSchemaDescriptorList =
    pandocOutputFormats.map(({ name, hidden }) => {
      return {
        regex: `^${name}(\\+.+)?$`,
        schema: getFormatSchema(name),
        name,
        hidden
      };
    });
  const formatSchemas = formatSchemaDescriptorList.map(
    ({ regex, schema }) => [regex, schema],
  );
  const plusFormatStringSchemas = formatSchemaDescriptorList.map(
    ({ regex, name, hidden }) => {
      const schema = regexS(regex, `be '${name}'`);
      if (hidden) {
        return schema;
      } 
      return completeSchema(schema, {
        type: "value",
        display: "",
        suggest_on_accept: true,
        value: name,
        description: "",
      });
    });
  const completionsObject = Object.fromEntries(
    formatSchemaDescriptorList
      .filter( ({ hidden }) => !hidden)
      .map(({ name }) => [name, ""])
  );

  return oneOfS(
    describeSchema(
      oneOfS(...plusFormatStringSchemas),
      "the name of a pandoc-supported output format",
    ),
    regexS("^hugo(\\+.+)?$", "be 'hugo'"),
    allOfS(
      objectS({
        patternProperties: Object.fromEntries(formatSchemas),
        completions: completionsObject,
        additionalProperties: nonStrict,
      }),
    ),
  );
}

export const getFrontMatterFormatSchema = defineCached(
  () => makeFrontMatterFormatSchema(),
  "front-matter-format");

export const getNonStrictFrontMatterFormatSchema = defineCached(
  () => makeFrontMatterFormatSchema(true),
  "front-matter-format-nonstrict");

export const getFrontMatterSchema = defineCached(
  async () => {
    const executeObjSchema = await getFormatExecuteOptionsSchema();
    return oneOfS(
      nullS,
      allOfS(
        objectS({
          properties: {
            execute: executeObjSchema,
            format: (await getFrontMatterFormatSchema()),
          },
          description: "be a Quarto YAML front matter object",
        }),
        objectRefSchemaFromGlob(
          schemaPath("new/document-*.yml"),
          (field: SchemaField) => field.name !== "format",
        ),
        executeObjSchema,
      ),
    );
  }, "front-matter");

