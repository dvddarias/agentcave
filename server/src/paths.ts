import { badRequest } from "./errors.js";

/**
 * Normalises a caller-supplied relative file path (`src/app.ts`).
 * Rejects absolute paths outside /workspace, `..`, NUL bytes and empty names.
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== "string") throw badRequest("File path must be a string");
  let p = input.replace(/\\/g, "/").trim();
  if (p.includes("\0")) throw badRequest(`Invalid file path: ${JSON.stringify(input)}`);
  if (p.startsWith("/workspace/")) p = p.slice("/workspace/".length);
  if (p.startsWith("/")) throw badRequest(`File path must be relative: ${input}`);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw badRequest(`File path may not contain '..': ${input}`);
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out) throw badRequest(`Empty file path: ${JSON.stringify(input)}`);
  if (out.length > 1024) throw badRequest(`File path too long: ${input.slice(0, 80)}…`);
  return out;
}

export function decodeFileContent(content: string, encoding: "utf8" | "base64" | undefined): Buffer {
  if (encoding === "base64") return Buffer.from(content, "base64");
  return Buffer.from(content, "utf8");
}
