import type { AgentService } from "./agents.js";
import type { BlobStore } from "./blobs.js";
import type { CycleStore } from "./cycle-store.js";
import type { DB } from "./db.js";
import type { EventHub } from "./events.js";
import type { ModelCatalog } from "./models.js";
import type { ModelFactory } from "./openrouter.js";
import type { SettingsService } from "./settings.js";
import type { WebhookService } from "./webhooks.js";

/** Tracks the AbortController of every running cycle (top-level and sub-agent). */
export class RunRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(id: string): AbortController {
    const c = new AbortController();
    this.controllers.set(id, c);
    return c;
  }

  /** A controller that is also aborted (with the same reason) when any of `parents` aborts. */
  registerChild(id: string, parents: (AbortSignal | undefined)[]): AbortController {
    const c = this.register(id);
    for (const p of parents) {
      if (!p) continue;
      if (p.aborted) c.abort(p.reason);
      else p.addEventListener("abort", () => c.abort(p.reason), { once: true });
    }
    return c;
  }

  get(id: string): AbortController | undefined {
    return this.controllers.get(id);
  }

  delete(id: string): void {
    this.controllers.delete(id);
  }

  abortAll(reason: unknown): void {
    for (const c of this.controllers.values()) c.abort(reason);
  }
}

export interface Ctx {
  db: DB;
  dataDir: string;
  settings: SettingsService;
  blobs: BlobStore;
  agents: AgentService;
  models: ModelCatalog;
  events: EventHub;
  cycles: CycleStore;
  webhooks: WebhookService;
  modelFactory: ModelFactory & { requiresToken?: boolean };
  registry: RunRegistry;
}
