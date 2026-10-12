import type { Answer, JsonSchema } from "@agentcave/client";
import { Ajv, type ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

export const DEFAULT_ANSWER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Your final answer for the user, in Markdown.",
    },
  },
  required: ["answer"],
  additionalProperties: false,
};

export interface PreparedAnswerSchema {
  /** JSON Schema used as the `submit_answer` tool input. Always an object schema. */
  toolSchema: JsonSchema;
  validate: (value: unknown) => { ok: true; answer: Answer } | { ok: false; message: string };
}

/** Throws a 400 if the schema is not a valid JSON Schema. */
export function assertValidSchema(schema: JsonSchema, label = "outputSchema"): void {
  try {
    ajv.compile(schema);
  } catch (err) {
    throw badRequest(
      `${label} is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === "object" || (schema.type === undefined && typeof schema.properties === "object");
}

/**
 * Builds the `submit_answer` input schema. Tool inputs must be objects, so non-object
 * schemas are wrapped as `{ result: <schema> }` and unwrapped again after validation.
 */
export function prepareAnswerSchema(schema: JsonSchema | null): PreparedAnswerSchema {
  if (!schema) {
    const validate = ajv.compile(DEFAULT_ANSWER_SCHEMA);
    return {
      toolSchema: DEFAULT_ANSWER_SCHEMA,
      validate: (value) =>
        validate(value)
          ? { ok: true, answer: { format: "markdown", text: (value as { answer: string }).answer } }
          : { ok: false, message: errorsText(validate) },
    };
  }
  const wrap = !isObjectSchema(schema);
  const toolSchema: JsonSchema = wrap
    ? { type: "object", properties: { result: schema }, required: ["result"], additionalProperties: false }
    : schema;
  const validate = ajv.compile(toolSchema);
  return {
    toolSchema,
    validate: (value) =>
      validate(value)
        ? { ok: true, answer: { format: "json", data: wrap ? (value as { result: unknown }).result : value } }
        : { ok: false, message: errorsText(validate) },
  };
}

function errorsText(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { dataVar: "input" });
}
