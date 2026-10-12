import fs from "node:fs";
import path from "node:path";
import { AgentService } from "./agents.js";
import { BlobStore } from "./blobs.js";
import { type Ctx, RunRegistry } from "./context.js";
import { CycleStore } from "./cycle-store.js";
import { CycleService } from "./cycles.js";
import { openDb } from "./db.js";
import { Runner } from "./engine/runner.js";
import { Scheduler } from "./engine/scheduler.js";
import { EventHub } from "./events.js";
import { createHttpApp } from "./http/app.js";
import { normalizeBasePath } from "./http/base-path.js";
import { ModelCatalog } from "./models.js";
import { type ModelFactory, openRouterModelFactory } from "./openrouter.js";
import { RetentionService } from "./retention.js";
import { SettingsService } from "./settings.js";
import { WebhookService } from "./webhooks.js";

/** Set by the Docker build (git tag, or `main-<sha>`); falls back to the package version in development. */
export const VERSION = process.env.AGENTCAVE_VERSION || "0.2.0-dev";

export interface AgentCaveOptions {
  dataDir: string;
  /** Directory with the built web UI (index.html). */
  webDist?: string | null;
  /** Path prefix a reverse proxy publishes AgentCave under (`BASE_PATH`, e.g. `/cave`). Default: the root. */
  basePath?: string;
  modelFactory?: ModelFactory & { requiresToken?: boolean };
  fetchImpl?: typeof fetch;
  webhookBackoffMs?: number[];
}

/** Wires every service together. Call `start()` to begin running cycles. */
export async function createAgentCave(opts: AgentCaveOptions) {
  const dataDir = path.resolve(opts.dataDir);
  fs.mkdirSync(path.join(dataDir, "cycles"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "agents"), { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;

  const db = openDb(path.join(dataDir, "agentcave.db"));
  const blobs = new BlobStore(path.join(dataDir, "blobs"));
  await blobs.init();
  const settings = new SettingsService(db);
  const events = new EventHub(db);

  const ctx: Ctx = {
    db,
    dataDir,
    settings,
    blobs,
    events,
    agents: new AgentService(db, blobs, path.join(dataDir, "agents")),
    models: new ModelCatalog(db, fetchImpl),
    cycles: new CycleStore(db, events),
    webhooks: new WebhookService(db, settings, fetchImpl, opts.webhookBackoffMs),
    modelFactory: opts.modelFactory ?? openRouterModelFactory,
    registry: new RunRegistry(),
  };

  const runner = new Runner(ctx);
  const scheduler = new Scheduler(ctx, runner);
  const cycles = new CycleService(ctx, scheduler, runner);
  const retention = new RetentionService(ctx);
  const app = createHttpApp({
    ctx,
    cycles,
    scheduler,
    retention,
    version: VERSION,
    startedAt: Date.now(),
    webDist: opts.webDist ?? null,
    basePath: normalizeBasePath(opts.basePath),
    fetchImpl,
  });

  let started = false;
  return {
    ctx,
    app,
    runner,
    scheduler,
    cycles,
    retention,
    start() {
      if (started) return;
      started = true;
      scheduler.start();
      ctx.webhooks.start();
      retention.start();
    },
    async close() {
      await scheduler.shutdown();
      ctx.webhooks.stop();
      retention.stop();
      db.close();
    },
  };
}

export type AgentCave = Awaited<ReturnType<typeof createAgentCave>>;
