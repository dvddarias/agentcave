import type { Context } from "hono";
import type { z } from "zod";
import type { Ctx } from "../context.js";
import type { CycleService } from "../cycles.js";
import type { Scheduler } from "../engine/scheduler.js";
import { ApiError, badRequest } from "../errors.js";
import type { RetentionService } from "../retention.js";

export interface HttpDeps {
  ctx: Ctx;
  cycles: CycleService;
  scheduler: Scheduler;
  retention: RetentionService;
  version: string;
  startedAt: number;
  webDist: string | null;
  fetchImpl: typeof fetch;
}

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    const text = await c.req.text();
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw badRequest("The request body must be valid JSON");
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid request: ${r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** The part of the URL path after `marker` (e.g. the file path after `/files/`), decoded. */
export function pathAfter(c: Context, marker: string): string {
  const p = c.req.path;
  const i = p.indexOf(marker);
  if (i === -1) throw badRequest("Missing path");
  return p
    .slice(i + marker.length)
    .split("/")
    .map((s) => decodeURIComponent(s))
    .join("/");
}

export function intParam(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${name} must be a non-negative integer`);
  return n;
}

export function contentDisposition(filename: string, inline = false): string {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
