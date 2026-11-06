/**
 * View scopes: a trusted proxy limits what a request sees by naming label pairs
 * (`X-AgentCave-Scope: userId=5; app=checkincopilot`). A cycle is in the scope when its root cycle's
 * labels include every pair (sub-agent cycles have no labels of their own: they belong to their root).
 */
import type { Param } from "./db.js";
import { ApiError } from "./errors.js";

/** Label pairs a cycle's root must all carry. Never empty. */
export type Scope = Record<string, string>;

const invalid = (message: string) =>
  new ApiError(400, "invalid_scope", `Invalid X-AgentCave-Scope header: ${message}`);

function decode(part: string): string {
  try {
    return decodeURIComponent(part.trim());
  } catch {
    throw invalid(`bad percent-encoding in "${part.trim()}"`);
  }
}

/**
 * `"userId=5; app=checkincopilot"` → `{ userId: "5", app: "checkincopilot" }`; no header → null.
 * Pairs are separated by `;` or `,` (so a header sent twice narrows the scope, never widens it); keys
 * and values are trimmed and percent-decoded. A header that is present but names no usable pair is an
 * error, never "no scope": a broken proxy must not open the full view.
 */
export function parseScope(header: string | undefined | null): Scope | null {
  if (header === undefined || header === null) return null;
  const pairs = new Map<string, string>();
  for (const part of header.split(/[;,]/)) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq === -1) throw invalid(`"${part.trim()}" is not key=value`);
    const key = decode(part.slice(0, eq));
    const value = decode(part.slice(eq + 1));
    if (!key || !value) throw invalid(`"${part.trim()}" needs a key and a value`);
    const had = pairs.get(key);
    if (had !== undefined && had !== value) throw invalid(`two values for "${key}"`);
    pairs.set(key, value);
  }
  if (pairs.size === 0) throw invalid("no key=value pair");
  return Object.fromEntries(pairs);
}

/** SQL condition: the labels JSON object in `column` has every pair of the scope. */
export function scopeSql(column: string, scope: Scope): { sql: string; params: Param[] } {
  const entries = Object.entries(scope);
  return {
    sql: entries
      .map(() => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE key = ? AND value = ?)`)
      .join(" AND "),
    params: entries.flat(),
  };
}

/** Whether `labels` has every pair of the scope. */
export function inScope(labels: Record<string, string>, scope: Scope): boolean {
  return Object.entries(scope).every(([k, v]) => Object.hasOwn(labels, k) && labels[k] === v);
}
