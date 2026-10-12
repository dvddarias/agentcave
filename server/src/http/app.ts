import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getPath } from "hono/utils/url";
import { ApiError } from "../errors.js";
import { log } from "../log.js";
import { injectBasePath, normalizeBasePath, stripBasePath } from "./base-path.js";
import { agentRoutes } from "./routes-agents.js";
import { cycleRoutes } from "./routes-cycles.js";
import { systemRoutes } from "./routes-system.js";
import type { HttpDeps } from "./util.js";

export function createHttpApp(deps: HttpDeps): Hono {
  const base = deps.basePath;
  // Routes, middleware and static files all see the path without the prefix, whether or not the
  // proxy in front stripped it.
  const app = new Hono({ getPath: (req) => stripBasePath(getPath(req), base) });

  // A proxy that publishes AgentCave under a prefix says so. If BASE_PATH disagrees, the UI loads
  // its assets and API from the wrong place, so warn (once).
  let warnedPrefix = false;
  app.use("*", async (c, next) => {
    const forwarded = c.req.header("x-forwarded-prefix");
    if (forwarded !== undefined && !warnedPrefix) {
      let prefix: string | null = null;
      try {
        prefix = normalizeBasePath(forwarded);
      } catch {
        // not a usable path: nothing to compare
      }
      if (prefix !== null && prefix !== base) {
        warnedPrefix = true;
        log.warn(
          `The proxy publishes AgentCave under X-Forwarded-Prefix "${forwarded}" but BASE_PATH is "${base}": set BASE_PATH=${prefix || "/"}`,
        );
      }
    }
    await next();
  });

  app.use("/api/*", cors({ origin: "*", exposeHeaders: ["content-disposition"] }));
  app.use("/api/*", async (c, next) => {
    const max = deps.ctx.settings.get().maxRequestMb * 1024 * 1024;
    return bodyLimit({
      maxSize: max,
      onError: (ctx) =>
        ctx.json(
          {
            error: {
              code: "too_large",
              message: `Request body is larger than ${deps.ctx.settings.get().maxRequestMb} MB`,
            },
          },
          413,
        ),
    })(c, next);
  });
  app.use("/api/*", async (c, next) => {
    const start = Date.now();
    await next();
    if (!c.req.path.endsWith("/events") || c.req.query("format") === "json") {
      log.debug(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
    }
  });

  const api = new Hono();
  api.route("/agents", agentRoutes(deps));
  api.route("/cycles", cycleRoutes(deps));
  api.route("/", systemRoutes(deps));
  app.route("/api/v1", api);

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
        err.status as ContentfulStatusCode,
      );
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    log.error("Unhandled API error", { method: c.req.method, path: c.req.path, err });
    return c.json(
      { error: { code: "internal", message: err instanceof Error ? err.message : String(err) } },
      500,
    );
  });

  // Web UI (built React app) with SPA fallback.
  const webDist = deps.webDist;
  const indexFile = webDist ? path.join(webDist, "index.html") : null;
  // Read on every request (it is tiny) so a rebuilt UI is picked up without a restart.
  const readIndex = () =>
    indexFile && existsSync(indexFile) ? injectBasePath(readFileSync(indexFile, "utf8"), base) : null;
  if (webDist && readIndex()) {
    // Never the raw file (it has no base in it): the fallback below serves it with the base.
    app.get("/index.html", (c) => c.notFound());
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), webDist) || "." }));
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDist) || ".", index: "__none__" }));
  }

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: `No route ${c.req.method} ${c.req.path}` } }, 404);
    }
    const indexHtml = c.req.method === "GET" ? readIndex() : null;
    // no-cache: the page carries the runtime base path.
    if (indexHtml) return c.html(indexHtml, 200, { "cache-control": "no-cache" });
    return c.text(
      "AgentCave API is running. The web UI is not built (run `npm run build -w @agentcave/web`). API: /api/v1",
      404,
    );
  });

  return app;
}
