import type { CycleCommand, HttpCommand, JsonSchema } from "@agentcave/client";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  Bash,
  type Command,
  decodeBytesToUtf8,
  defineCommand,
  type ExecResult,
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
  textOutput,
} from "just-bash";
import { badRequest } from "../errors.js";
import { newId } from "../ids.js";
import { signPayload } from "../webhooks.js";
import { currentToolCallId } from "./sandbox.js";

/**
 * HTTP commands: commands a caller gives a cycle. Inside the sandbox each one is a real just-bash
 * command (trusted, so it runs in the server process): it turns its flags into a JSON input, checks
 * it against the command's schema, and POSTs it to the caller's URL with headers the sandbox never
 * sees. The response body is its stdout.
 */

/** At most this many commands per cycle (`MAX_HTTP_COMMANDS` in the client types). */
export const MAX_COMMANDS = 32;
/** A command's `timeoutSec` (`HTTP_COMMAND_TIMEOUT_SEC` in the client types). */
export const COMMAND_TIMEOUT_SEC = { default: 20, max: 120 } as const;
/** A bigger response fails the command: it is held in memory. Send big data to a file the agent can fetch. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** How much of a response the `http.call` event and HTTP error messages keep. */
const PREVIEW_CHARS = 2048;
const MASK = "••••";

/** A checked command as stored on the cycle: headers included (secret), defaults filled in. */
export interface StoredCommand {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  url: string;
  headers: Record<string, string>;
  timeoutSec: number;
}

/** One call, as the `http.call` event reports it (the runner adds the step). */
export interface HttpCallRecord {
  toolCallId: string | null;
  callId: string;
  command: string;
  input: Record<string, unknown>;
  status: number | null;
  ms: number;
  bytes: number;
  preview: string;
  error: string | null;
}

export interface CommandRuntime {
  cycleId: string;
  turn: number;
  labels: Record<string, string>;
  /** The webhook signing secret: when set, calls carry `X-AgentCave-Signature`. */
  secret: string | null;
  /** The turn's signal (Stop, limits, shutdown). */
  signal: AbortSignal;
  fetch: typeof fetch;
  onCall: (call: HttpCallRecord) => void;
}

// ---------------------------------------------------------------------------
// Checking (when a cycle starts or a follow-up replaces the commands)

let reserved: Promise<Set<string>> | null = null;

/** Every just-bash command (whatever the agent's switches) and every shell builtin and keyword. */
export function reservedNames(): Promise<Set<string>> {
  reserved ??= (async () => {
    const bash = new Bash();
    const list = async (cmd: string) =>
      (await bash.exec(cmd)).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    return new Set([
      ...getCommandNames(),
      ...getNetworkCommandNames(),
      ...getPythonCommandNames(),
      ...getJavaScriptCommandNames(),
      ...(await list("compgen -A builtin")),
      ...(await list("compgen -k")),
    ]);
  })();
  return reserved;
}

/** Property names that can be typed as `--name`; `json` and `help` are taken. */
const FLAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** Checks what the request schema can't (400 otherwise) and fills in the defaults. */
export async function checkCommands(commands: HttpCommand[]): Promise<StoredCommand[]> {
  const taken = await reservedNames();
  const seen = new Set<string>();
  return commands.map((c, i) => {
    const at = `commands[${i}] (${c.name})`;
    if (seen.has(c.name)) throw badRequest(`${at}: the name '${c.name}' is used twice`);
    seen.add(c.name);
    if (taken.has(c.name)) {
      throw badRequest(
        `${at}: '${c.name}' is already a command or shell builtin in the sandbox; pick another name`,
      );
    }
    try {
      new Headers(c.headers);
    } catch {
      // Never echo the value: it is secret.
      throw badRequest(`${at}: a header value has characters HTTP headers can't carry`);
    }
    const schema = c.inputSchema;
    if (schema.type !== "object") {
      throw badRequest(`${at}: inputSchema must be an object schema ("type": "object")`);
    }
    try {
      compile(schema);
    } catch (err) {
      throw badRequest(
        `${at}: inputSchema is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const prop of Object.keys(properties(schema))) {
      if (!FLAG_NAME.test(prop) || prop === "json" || prop === "help") {
        throw badRequest(
          `${at}: the property '${prop}' can't be a flag. Use letters, digits, _ . and - (not 'json' or 'help')`,
        );
      }
    }
    return {
      name: c.name,
      description: c.description,
      inputSchema: schema,
      url: c.url,
      headers: c.headers ?? {},
      timeoutSec: c.timeoutSec ?? COMMAND_TIMEOUT_SEC.default,
    };
  });
}

/** What the API shows: header values masked. */
export function maskCommands(commands: StoredCommand[]): CycleCommand[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    inputSchema: c.inputSchema,
    url: c.url,
    headers: Object.fromEntries(Object.keys(c.headers).map((k) => [k, MASK])),
    timeoutSec: c.timeoutSec,
  }));
}

/** The line a follow-up's user message gets when it adds or removes commands, or null. */
export function commandsChangeNotice(before: StoredCommand[], after: StoredCommand[]): string | null {
  const old = new Set(before.map((c) => c.name));
  const now = new Set(after.map((c) => c.name));
  const added = [...now].filter((n) => !old.has(n)).map((n) => `\`${n}\``);
  const removed = [...old].filter((n) => !now.has(n)).map((n) => `\`${n}\``);
  if (!added.length && !removed.length) return null;
  const parts = [
    ...(added.length ? [`added ${added.join(", ")}`] : []),
    ...(removed.length ? [`removed ${removed.join(", ")} (it no longer exists)`] : []),
  ];
  return `Note: the commands for this task changed: ${parts.join("; ")}. The list in the system prompt is up to date.`;
}

/** A validator for `schema`. A fresh Ajv each time: schemas with an `$id` can't be added twice to one. */
function compile(schema: JsonSchema): ValidateFunction {
  const draft = typeof schema.$schema === "string" ? schema.$schema : "";
  const opts = { allErrors: true, strict: false, validateFormats: false } as const;
  const ajv = draft.includes("2020-12")
    ? new Ajv2020(opts)
    : draft.includes("2019-09")
      ? new Ajv2019(opts)
      : new Ajv(opts);
  return ajv.compile(schema);
}

// ---------------------------------------------------------------------------
// Flags

type Scalar = "string" | "number" | "integer" | "boolean";

interface Flag {
  name: string;
  /** A scalar, a repeated scalar (`array`), or only through `--json` (`complex`). */
  kind: Scalar | "array" | "complex";
  /** The item type of an `array` flag. */
  item: Scalar | null;
  required: boolean;
  schema: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function properties(schema: JsonSchema): Record<string, unknown> {
  return isObj(schema.properties) ? schema.properties : {};
}

function kindOf(s: unknown): Scalar | "array" | "complex" {
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

function flagsOf(schema: JsonSchema): Flag[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties(schema)).map(([name, raw]) => {
    const s = isObj(raw) ? raw : {};
    let kind = kindOf(raw);
    let item: Scalar | null = null;
    if (kind === "array") {
      const k = Array.isArray(s.items) ? "complex" : kindOf(s.items);
      if (k === "array" || k === "complex") kind = "complex";
      else item = k;
    }
    return { name, kind, item, required: required.has(name), schema: s };
  });
}

class UsageError extends Error {}

/** Turns the arguments into the command's input (not yet checked against the schema). */
function parseArgs(flags: Flag[], args: string[], readStdin: () => string): Obj {
  const byName = new Map(flags.map((f) => [f.name, f]));
  const input: Obj = {};
  let json: string | null = null;
  const set = (f: Flag, v: unknown) => {
    if (f.kind === "array") {
      input[f.name] = [...((input[f.name] as unknown[] | undefined) ?? []), v];
      return;
    }
    if (f.name in input) throw new UsageError(`--${f.name} is given more than once`);
    input[f.name] = v;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") || arg === "--") {
      throw new UsageError(
        arg.startsWith("-")
          ? `unknown option ${arg}`
          : `unexpected argument '${arg}' (every value needs its flag, e.g. --name value)`,
      );
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === "json") {
      if (json !== null) throw new UsageError("--json is given more than once");
      if (value === undefined) value = args[++i];
      if (value === undefined) throw new UsageError("--json needs a JSON object, or - to read it from stdin");
      json = value;
      continue;
    }
    const flag = byName.get(name);
    if (!flag) {
      const negated = name.startsWith("no-") ? byName.get(name.slice(3)) : undefined;
      if (negated?.kind === "boolean") {
        if (value !== undefined) throw new UsageError(`--${name} takes no value`);
        set(negated, false);
        continue;
      }
      throw new UsageError(`unknown flag --${name}`);
    }
    if (flag.kind === "complex") {
      throw new UsageError(
        `--${name} takes ${describeKind(flag)}: pass the whole input as JSON with --json instead`,
      );
    }
    if (flag.kind === "boolean") {
      if (value === undefined && (args[i + 1] === "true" || args[i + 1] === "false")) value = args[++i];
      set(flag, value === undefined ? true : toScalar("boolean", value, name));
      continue;
    }
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    set(flag, toScalar(flag.kind === "array" ? (flag.item ?? "string") : flag.kind, value, name));
  }

  if (json === null) return input;
  if (Object.keys(input).length > 0) throw new UsageError("--json can't be combined with other flags");
  const text = json === "-" ? readStdin() : json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`--json${json === "-" ? " - (stdin)" : ""} is not valid JSON`);
  }
  if (!isObj(parsed)) throw new UsageError("--json needs a JSON object ({ … })");
  return parsed;
}

function toScalar(kind: Scalar, value: string, flag: string): unknown {
  if (kind === "string") return value;
  if (kind === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new UsageError(`--${flag} needs true or false, got '${value}'`);
  }
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${flag} needs a number, got '${value}'`);
  if (kind === "integer" && !Number.isInteger(n))
    throw new UsageError(`--${flag} needs a whole number, got '${value}'`);
  return n;
}

function describeKind(f: Flag): string {
  const t = f.schema.type;
  return t === "object" ? "an object" : t === "array" ? "a list of objects or lists" : "a complex value";
}

function enumOf(s: Obj): unknown[] | null {
  return Array.isArray(s.enum) && s.enum.length ? s.enum : null;
}

function valueLabel(f: Flag): string {
  const s = f.kind === "array" && isObj(f.schema.items) ? f.schema.items : f.schema;
  const values = enumOf(s);
  if (values && values.length <= 8) {
    const joined = values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("|");
    if (joined.length <= 48) return `<${joined}>`;
  }
  return `<${f.kind === "array" ? f.item : f.kind}>`;
}

/** One-line usage, e.g. `get_order_status --orderId <string> [--verbose]`. */
export function usageLine(cmd: { name: string; inputSchema: JsonSchema }): string {
  const flags = flagsOf(cmd.inputSchema);
  if (flags.some((f) => f.required && f.kind === "complex")) return `${cmd.name} --json '<object>'`;
  const parts = [cmd.name];
  for (const f of flags) {
    if (f.kind === "complex") continue;
    const token = f.kind === "boolean" ? `--${f.name}` : `--${f.name} ${valueLabel(f)}`;
    const shown = f.required ? token : `[${token}]`;
    parts.push(f.kind === "array" ? `${shown}...` : shown);
  }
  return parts.join(" ");
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_\-.,/:@%+=]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

function exampleValue(s: Obj, kind: Flag["kind"], item: Scalar | null): unknown {
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if ("default" in s) return s.default;
  if (enumOf(s)) return enumOf(s)?.[0];
  if ("const" in s) return s.const;
  switch (kind) {
    case "string":
      return "value";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [exampleValue(isObj(s.items) ? s.items : {}, item ?? "string", null)];
    default:
      return s.type === "array" ? [] : {};
  }
}

function exampleLine(name: string, flags: Flag[]): string {
  const required = flags.filter((f) => f.required);
  const chosen = required.length ? required : flags.slice(0, 1);
  const input = Object.fromEntries(chosen.map((f) => [f.name, exampleValue(f.schema, f.kind, f.item)]));
  if (chosen.some((f) => f.kind === "complex")) return `${name} --json ${shellQuote(JSON.stringify(input))}`;
  const parts = [name];
  for (const f of chosen) {
    const v = input[f.name];
    if (f.kind === "boolean") parts.push(v === false ? `--no-${f.name}` : `--${f.name}`);
    else for (const x of Array.isArray(v) ? v : [v]) parts.push(`--${f.name}`, shellQuote(String(x)));
  }
  return parts.join(" ");
}

/** The `--help` text: description, usage, every flag, one example and the exit codes. */
export function helpText(cmd: { name: string; description: string; inputSchema: JsonSchema }): string {
  const flags = flagsOf(cmd.inputSchema);
  const rows = flags.map((f) => {
    const left =
      f.kind === "boolean" || f.kind === "complex" ? `--${f.name}` : `--${f.name} ${valueLabel(f)}`;
    const notes: string[] = [f.required ? "Required." : "Optional."];
    if (f.kind === "array") notes.push("Repeat it for more than one value.");
    if (f.kind === "boolean")
      notes.push(`--${f.name} for true, --no-${f.name} (or --${f.name}=false) for false.`);
    if (f.kind === "complex")
      notes.push(`${describeKind(f).replace(/^./, (c) => c.toUpperCase())}: only through --json.`);
    if (typeof f.schema.description === "string") notes.push(f.schema.description.trim());
    const values = enumOf(f.kind === "array" && isObj(f.schema.items) ? f.schema.items : f.schema);
    if (values)
      notes.push(`One of: ${values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}.`);
    if ("default" in f.schema) notes.push(`Default: ${JSON.stringify(f.schema.default)}.`);
    return { left, right: notes.join(" ") };
  });
  const width = Math.min(30, Math.max(0, ...rows.map((r) => r.left.length)));
  const lines = [
    `${cmd.name}: ${cmd.description.trim()}`,
    "",
    "Usage:",
    `  ${usageLine(cmd)}`,
    `  ${cmd.name} --json '<object>'   (the whole input as one JSON object; --json - reads it from stdin)`,
  ];
  if (rows.length) {
    lines.push("", "Flags:");
    for (const r of rows) {
      lines.push(
        r.left.length > width
          ? `  ${r.left}\n  ${" ".repeat(width)}  ${r.right}`
          : `  ${r.left.padEnd(width)}  ${r.right}`,
      );
    }
  }
  lines.push(
    "",
    "Example:",
    `  ${exampleLine(cmd.name, flags)}`,
    "",
    "Prints the endpoint's response on stdout. Exit codes: 0 = success; 1 = the call failed (HTTP error, timeout or network; the reason is on stderr); 2 = bad arguments (nothing was sent).",
  );
  return `${lines.join("\n")}\n`;
}

function inputErrors(errors: ErrorObject[] | null | undefined): string {
  const out = new Set<string>();
  for (const e of errors ?? []) {
    const segs = e.instancePath.split("/").slice(1);
    const where = segs.length === 1 ? `--${segs[0]}` : segs.length ? `input.${segs.join(".")}` : "input";
    if (e.keyword === "required" && segs.length === 0)
      out.add(`missing required flag --${String(e.params.missingProperty)}`);
    else if (e.keyword === "additionalProperties" && segs.length === 0)
      out.add(`unknown property '${String(e.params.additionalProperty)}'`);
    else out.add(`${where} ${e.message ?? "is invalid"}`);
  }
  return [...out].slice(0, 10).join("; ") || "invalid input";
}

// ---------------------------------------------------------------------------
// Running

/** The just-bash commands for one turn. */
export function createHttpCommands(commands: StoredCommand[], rt: CommandRuntime): Command[] {
  return commands.map((cmd) => {
    const flags = flagsOf(cmd.inputSchema);
    const validate = compile(cmd.inputSchema);
    const usage = (message: string): ExecResult => ({
      stdout: "",
      stderr: `${cmd.name}: ${message}\nusage: ${usageLine(cmd)}\nRun \`${cmd.name} --help\` for details.\n`,
      exitCode: 2,
    });
    return defineCommand(cmd.name, async (args, ctx) => {
      if (args.includes("--help") || args.includes("-h"))
        return { ...textOutput(helpText(cmd)), stderr: "", exitCode: 0 };
      let input: Obj;
      try {
        input = parseArgs(flags, args, () => decodeBytesToUtf8(ctx.stdin));
      } catch (err) {
        if (err instanceof UsageError) return usage(err.message);
        throw err;
      }
      if (!validate(input)) return usage(inputErrors(validate.errors));
      return call(cmd, input, ctx.signal, rt);
    });
  });
}

async function call(
  cmd: StoredCommand,
  input: Obj,
  execSignal: AbortSignal | undefined,
  rt: CommandRuntime,
): Promise<ExecResult> {
  const callId = newId("call");
  const toolCallId = currentToolCallId();
  const body = JSON.stringify({
    command: cmd.name,
    input,
    cycleId: rt.cycleId,
    turn: rt.turn,
    callId,
    labels: rt.labels,
  });
  const headers = new Headers(cmd.headers);
  headers.set("content-type", "application/json");
  if (!headers.has("user-agent")) headers.set("user-agent", "AgentCave-Command/1");
  if (rt.secret) headers.set("x-agentcave-signature", signPayload(rt.secret, body));
  // Stop, the turn's limits, the command line's time limit (and `timeout`), and this call's own timeout.
  const timeout = AbortSignal.timeout(cmd.timeoutSec * 1000);
  const stoppers = [rt.signal, ...(execSignal ? [execSignal] : [])];
  const signal = AbortSignal.any([...stoppers, timeout]);

  const started = Date.now();
  let status: number | null = null;
  let text = "";
  let bytes = 0;
  let error: string | null = null;
  try {
    const res = await rt.fetch(cmd.url, { method: "POST", headers, body, signal, redirect: "manual" });
    status = res.status;
    const read = await readBody(res, MAX_RESPONSE_BYTES);
    text = read.text;
    bytes = read.bytes;
    if (read.tooLarge) error = `the response is over ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`;
    else if (status < 200 || status > 299) error = `HTTP ${status}`;
  } catch (err) {
    error = stoppers.some((s) => s.aborted)
      ? "aborted"
      : timeout.aborted
        ? `timed out after ${cmd.timeoutSec}s`
        : networkError(err);
  }
  rt.onCall({
    toolCallId,
    callId,
    command: cmd.name,
    input,
    status,
    ms: Date.now() - started,
    bytes,
    preview: text.slice(0, PREVIEW_CHARS),
    error,
  });

  if (!error) {
    return { ...textOutput(text && !text.endsWith("\n") ? `${text}\n` : text), stderr: "", exitCode: 0 };
  }
  const detail = error.startsWith("HTTP ") && text ? `: ${text.slice(0, PREVIEW_CHARS).trimEnd()}` : "";
  return { stdout: "", stderr: `${cmd.name}: ${error}${detail}\n`, exitCode: 1 };
}

async function readBody(
  res: Response,
  max: number,
): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
  if (!res.body) return { text: "", bytes: 0, tooLarge: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => {});
      return { text: Buffer.concat(chunks).toString("utf8"), bytes, tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, tooLarge: false };
}

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "host not found",
  ETIMEDOUT: "connection timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  UND_ERR_SOCKET: "connection closed",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
};

/** A short reason without the URL (fetch errors name the host). */
function networkError(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : (err as { code?: unknown })?.code;
  if (typeof code === "string") {
    if (NETWORK_ERRORS[code]) return NETWORK_ERRORS[code];
    if (/CERT|TLS|SSL/.test(code)) return `TLS error (${code})`;
    return `request failed (${code})`;
  }
  return "request failed";
}
