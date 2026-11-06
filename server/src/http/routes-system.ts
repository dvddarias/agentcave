import type { CycleUpdate, Health, Session, SettingsUpdate } from "@agentcave/client";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ApiError, badRequest } from "../errors.js";
import { checkOpenRouterToken } from "../openrouter.js";
import { settingsUpdateSchema, testTokenSchema } from "../schemas.js";
import { inScope } from "../scope.js";
import { computeStats } from "../stats.js";
import { buildOpenApi } from "./openapi.js";
import { scopeOf } from "./scope.js";
import { type HttpDeps, readJson } from "./util.js";

export function systemRoutes(deps: HttpDeps): Hono {
  const { ctx } = deps;
  const app = new Hono();

  app.get("/health", (c) => {
    const scope = scopeOf(c);
    const body: Health = {
      ok: true,
      version: deps.version,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      queue: scope
        ? { ...ctx.cycles.counts(scope), maxParallel: ctx.settings.get().maxParallel }
        : deps.scheduler.counts(),
      tokenSet: !!ctx.settings.get().openrouterToken,
    };
    return c.json(body);
  });

  app.get("/session", (c) => {
    const body: Session = { scope: scopeOf(c) };
    return c.json(body);
  });

  app.get("/settings", (c) => c.json(ctx.settings.toDTO()));

  app.put("/settings", async (c) => {
    const update = (await readJson(c, settingsUpdateSchema)) as SettingsUpdate;
    return c.json(ctx.settings.toDTO(ctx.settings.update(update)));
  });

  app.post("/settings/test-token", async (c) => {
    const { token } = await readJson(c, testTokenSchema);
    const value = token?.trim() || ctx.settings.get().openrouterToken;
    if (!value) throw badRequest("No token given and none saved");
    return c.json(await checkOpenRouterToken(value, deps.fetchImpl));
  });

  app.get("/models", async (c) => {
    const list = await ctx.models.list({ refresh: c.req.query("refresh") === "true" });
    if (list.models.length === 0) {
      throw new ApiError(502, "models_unavailable", "Could not load the model list from OpenRouter");
    }
    return c.json(list);
  });

  app.get("/stats", (c) => {
    try {
      return c.json(computeStats(ctx.db, c.req.query("from"), c.req.query("to"), scopeOf(c)));
    } catch {
      throw badRequest("from/to must be ISO dates");
    }
  });

  app.post("/maintenance/cleanup", async (c) => c.json(await deps.retention.runOnce()));

  app.get("/openapi.json", (c) => c.json(buildOpenApi(deps.version, deps.basePath)));

  // Global feed: one event per changed cycle, batched every 500 ms. A scoped request only hears of
  // the cycles in its scope.
  app.get("/events", (c) => {
    const scope = scopeOf(c);
    return streamSSE(c, async (stream) => {
      const pending = new Map<string, boolean>();
      let closed = false;
      const unsubscribe = ctx.events.onCycleChanged((id, deleted) => {
        if (deleted && scope && !inScope(deleted.rootLabels, scope)) return;
        pending.set(id, !!deleted || pending.get(id) === true);
      });
      stream.onAbort(() => {
        closed = true;
      });
      let sinceBeat = 0;
      try {
        while (!closed) {
          await new Promise((r) => setTimeout(r, 500));
          sinceBeat += 500;
          for (const [id, deleted] of [...pending]) {
            pending.delete(id);
            const row = deleted ? undefined : ctx.cycles.findRow(id);
            // Scoped: a cycle in the scope, or a deletion whose labels were checked above. A cycle that
            // is gone without such a deletion may have been anyone's.
            if (scope && (row ? !ctx.cycles.inScope(id, scope) : !deleted)) continue;
            const update: CycleUpdate = row
              ? { type: "cycle.updated", id, cycle: ctx.cycles.get(id) }
              : { type: "cycle.deleted", id, cycle: null };
            await stream.writeSSE({ data: JSON.stringify(update) });
            sinceBeat = 0;
          }
          if (sinceBeat >= 15_000) {
            await stream.write(": ping\n\n");
            sinceBeat = 0;
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
