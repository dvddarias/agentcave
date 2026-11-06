import type { JsonSchema } from "@agentcave/client";

/**
 * How an HTTP command's input schema turns into flags, for display. It follows the server's rules
 * (`server/src/engine/http-commands.ts`), so the usage line here is the one the agent sees.
 */

export type ParamKind = "string" | "number" | "integer" | "boolean" | "array" | "complex";

export interface CommandParam {
  name: string;
  kind: ParamKind;
  /** The item type of an `array` flag. */
  item: "string" | "number" | "integer" | "boolean" | null;
  /** "string", "integer", "true/false", "list of string", "object"… */
  type: string;
  required: boolean;
  description: string | null;
  /** Allowed values (`enum`), if any. */
  values: unknown[] | null;
  hasDefault: boolean;
  default: unknown;
  examples: unknown[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function kindOf(s: unknown): Exclude<ParamKind, never> {
  if (s === true || s === undefined) return "string";
  if (!isObj(s)) return "complex";
  const raw = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : null;
  if (raw) {
    let types = raw.filter((t) => t !== "null");
    if (types.length > 1 && types.every((t) => t === "number" || t === "integer")) types = ["number"];
    if (types.length !== 1) return "complex";
    const t = types[0];
    return t === "string" || t === "number" || t === "integer" || t === "boolean" || t === "array"
      ? t
      : "complex";
  }
  const values = Array.isArray(s.enum) ? s.enum : "const" in s ? [s.const] : null;
  if (values?.length) {
    if (values.every((v) => typeof v === "string")) return "string";
    if (values.every((v) => typeof v === "boolean")) return "boolean";
    if (values.every((v) => typeof v === "number"))
      return values.every(Number.isInteger) ? "integer" : "number";
    return "complex";
  }
  const shaped = ["properties", "items", "anyOf", "oneOf", "allOf", "not", "if", "$ref"];
  return shaped.some((k) => k in s) ? "complex" : "string";
}

function enumOf(s: Obj): unknown[] | null {
  return Array.isArray(s.enum) && s.enum.length ? s.enum : null;
}

export function commandParams(schema: JsonSchema): CommandParam[] {
  const props = isObj(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(props).map(([name, raw]) => {
    const s = isObj(raw) ? raw : {};
    let kind = kindOf(raw);
    let item: CommandParam["item"] = null;
    if (kind === "array") {
      const k = Array.isArray(s.items) ? "complex" : kindOf(s.items);
      if (k === "array" || k === "complex") kind = "complex";
      else item = k;
    }
    const typeOf = (k: string) => (k === "boolean" ? "true/false" : k);
    const type =
      kind === "array"
        ? `list of ${typeOf(item ?? "string")}`
        : kind === "complex"
          ? s.type === "object"
            ? "object"
            : s.type === "array"
              ? "list"
              : "complex"
          : typeOf(kind);
    const values = enumOf(kind === "array" && isObj(s.items) ? s.items : s);
    return {
      name,
      kind,
      item,
      type,
      required: required.has(name),
      description: typeof s.description === "string" ? s.description : null,
      values,
      hasDefault: "default" in s,
      default: s.default,
      examples: Array.isArray(s.examples) ? s.examples : [],
    };
  });
}

function valueLabel(p: CommandParam): string {
  if (p.values && p.values.length <= 8) {
    const joined = p.values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("|");
    if (joined.length <= 48) return `<${joined}>`;
  }
  return `<${p.kind === "array" ? p.item : p.kind}>`;
}

/** The one-line usage the agent sees, e.g. `get_order_status --orderId <string> [--verbose]`. */
export function commandUsage(name: string, schema: JsonSchema): string {
  const params = commandParams(schema);
  if (params.some((p) => p.required && p.kind === "complex")) return `${name} --json '<object>'`;
  const parts = [name];
  for (const p of params) {
    if (p.kind === "complex") continue;
    const token = p.kind === "boolean" ? `--${p.name}` : `--${p.name} ${valueLabel(p)}`;
    const shown = p.required ? token : `[${token}]`;
    parts.push(p.kind === "array" ? `${shown}...` : shown);
  }
  return parts.join(" ");
}

export function showValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
