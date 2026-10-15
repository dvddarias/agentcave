import type {
  ContinueRequest,
  CycleEvent,
  CycleStatus,
  FollowUpRequest,
  RerunRequest,
  StartCycleRequest,
} from "@agentcave/client";
import { Hono } from "hono";
import { stream as honoStream, streamSSE } from "hono/streaming";
import { FINAL } from "../cycle-store.js";
import { badRequest, conflict } from "../errors.js";
import { continueSchema, followUpSchema, rerunSchema, startCycleSchema } from "../schemas.js";
import { contentDisposition, type HttpDeps, intParam, pathAfter, readJson } from "./util.js";

const STATUSES: CycleStatus[] = ["queued", "running", "completed", "failed", "stopped"];
const HEARTBEAT_MS = 15_000;

export function cycleRoutes(deps: HttpDeps): Hono {
  const { ctx, cycles: service } = deps;
  const app = new Hono();

  app.post("/", async (c) => {
    const req = (await readJson(c, startCycleSchema)) as StartCycleRequest;
    return c.json(await service.start(req), 202);
  });

  app.get("/", (c) => {
    const q = c.req.query();
    const status = q.status
      ? q.status.split(",").map((s) => {
          if (!STATUSES.includes(s as CycleStatus)) throw badRequest(`Unknown status '${s}'`);
          return s as CycleStatus;
        })
      : undefined;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(q)) if (k.startsWith("label.")) labels[k.slice(6)] = v;
    return c.json(
      ctx.cycles.list({
        agent: q.agent,
        status,
        labels,
        parent: q.parent,
        rootOnly: q.rootOnly !== "false",
        q: q.q,
        limit: q.limit ? intParam(q.limit, "limit") : undefined,
        cursor: q.cursor,
      }),
    );
  });

  app.get("/:id", (c) => c.json(ctx.cycles.get(c.req.param("id"), { withSystemPrompt: true })));

  app.get("/:id/answer", (c) => {
    const cycle = ctx.cycles.get(c.req.param("id"));
    if (!FINAL.includes(cycle.status))
      throw conflict(`The cycle is ${cycle.status}; no answer yet`, "not_finished");
    return c.json({ status: cycle.status, answer: cycle.answer, files: cycle.files, error: cycle.error });
  });

  app.get("/:id/turns", (c) => c.json({ turns: ctx.cycles.turns(c.req.param("id")) }));

  app.get("/:id/children", (c) => {
    ctx.cycles.getRow(c.req.param("id"));
    return c.json({ cycles: ctx.cycles.children(c.req.param("id")) });
  });

  app.get("/:id/webhooks", (c) => {
    ctx.cycles.getRow(c.req.param("id"));
    return c.json({ deliveries: ctx.webhooks.list(c.req.param("id")) });
  });

  app.post("/:id/stop", (c) => c.json(service.stop(c.req.param("id"))));

  app.post("/:id/messages", async (c) => {
    const req = (await readJson(c, followUpSchema)) as FollowUpRequest;
    return c.json(await service.followUp(c.req.param("id"), req), 202);
  });

  app.post("/:id/continue", async (c) => {
    const req = (await readJson(c, continueSchema)) as ContinueRequest;
    return c.json(service.continue(c.req.param("id"), req), 202);
  });

  app.post("/:id/rerun", async (c) => {
    const req = (await readJson(c, rerunSchema)) as RerunRequest;
    return c.json(await service.rerun(c.req.param("id"), req), 202);
  });

  app.delete("/:id", async (c) => {
    await service.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/:id/files", async (c) => {
    const turn = c.req.query("turn");
    return c.json({
      files: await service.files(c.req.param("id"), {
        changed: c.req.query("changed") === "true",
        turn: turn !== undefined ? intParam(turn, "turn") : undefined,
      }),
    });
  });

  app.get("/:id/files.zip", async (c) => {
    const id = c.req.param("id");
    const changed = c.req.query("changed") === "true";
    const body = await service.zip(id, changed);
    c.header("content-type", "application/zip");
    c.header("content-disposition", contentDisposition(`${id}${changed ? "-changed" : ""}.zip`));
    return honoStream(c, async (s) => {
      await s.pipe(body);
    });
  });

  app.get("/:id/files/*", async (c) => {
    const filePath = pathAfter(c, "/files/");
    const file = await service.openFile(c.req.param("id"), filePath);
    const name = filePath.split("/").pop() ?? "file";
    return c.body(file.stream, 200, {
      "content-type": file.type,
      "content-length": String(file.size),
      "content-disposition": contentDisposition(name, c.req.query("download") !== "true"),
    });
  });

  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    ctx.cycles.getRow(id);
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0;
    if (c.req.query("format") === "json") {
      const limit = Math.min(Number(c.req.query("limit") ?? 1000) || 1000, 5000);
      return c.json({ events: ctx.events.list(id, after, limit) });
    }
    const follow = c.req.query("follow") === "true";
    return streamSSE(c, async (stream) => {
      let last = after;
      let closed = false;
      let wake: (() => void) | null = null;
      const queue: CycleEvent[] = [];
      const unsubscribe = ctx.events.subscribe(id, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const write = (e: CycleEvent) => stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
      // The runner always emits the final `cycle.status` as the last event of a turn.
      const isEnd = (e: CycleEvent) => !follow && e.type === "cycle.status" && FINAL.includes(e.data.status);

      try {
        // 1) Replay stored events. Live events arriving meanwhile wait in `queue` (deduped by seq).
        for (;;) {
          const batch = ctx.events.list(id, last, 1000);
          for (const e of batch) {
            await write(e);
            last = e.seq;
          }
          if (batch.length < 1000) break;
        }
        // 2) Already finished and nothing newer pending: done.
        const row = ctx.cycles.findRow(id);
        if (!follow && (!row || FINAL.includes(row.status)) && !queue.some((e) => e.seq > last)) return;
        // 3) Live.
        while (!closed) {
          while (queue.length && !closed) {
            const e = queue.shift()!;
            if (e.seq <= last) continue;
            await write(e);
            last = e.seq;
            if (isEnd(e)) closed = true;
          }
          if (closed) break;
          const timedOut = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(true), HEARTBEAT_MS);
            wake = () => {
              clearTimeout(t);
              resolve(false);
            };
          });
          wake = null;
          if (timedOut && !closed) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
