import type { Context, MiddlewareHandler } from "hono";
import { ApiError, notFound } from "../errors.js";
import { parseScope, type Scope } from "../scope.js";
import type { HttpDeps } from "./util.js";

/** Set (or stripped) by the trusted proxy in front of AgentCave; see `parseScope` for the format. */
export const SCOPE_HEADER = "x-agentcave-scope";

/** The request's view scope, or null for full access. */
export function scopeOf(c: Context): Scope | null {
  return parseScope(c.req.header(SCOPE_HEADER));
}

/** What a scoped request may read (paths below /api/v1). Everything else answers 403. */
const SCOPED_READS = [
  /^\/session$/,
  /^\/health$/,
  /^\/stats$/,
  /^\/events$/,
  /^\/cycles$/,
  /^\/cycles\/[^/]+(\/.*)?$/,
];

const forbidden = (message: string) => new ApiError(403, "forbidden", message);

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Applies the view scope to every API request (mounted on /api/*). A scoped request is read-only
 * (every other method answers 403), reaches only the cycle, usage and status reads (403 for agents,
 * settings, models…), and a cycle outside its scope answers 404 as if it didn't exist. Lists, the
 * global feed, usage and queue counts filter themselves with the same scope.
 */
export function scopeGuard(deps: HttpDeps): MiddlewareHandler {
  return async (c, next) => {
    const scope = scopeOf(c);
    if (!scope) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      throw forbidden("This view is read-only");
    }
    const rest = c.req.path.startsWith("/api/v1/") ? c.req.path.slice("/api/v1".length) : c.req.path;
    if (!SCOPED_READS.some((r) => r.test(rest))) throw forbidden("Not available in this view");
    const cycle = /^\/cycles\/([^/]+)/.exec(rest);
    if (cycle) {
      const id = decodeId(cycle[1]);
      if (!deps.ctx.cycles.inScope(id, scope)) throw notFound(`Cycle '${id}'`);
    }
    return next();
  };
}
