import type { Ctx } from "../context.js";
import { type CycleRow, FINAL } from "../cycle-store.js";
import { all } from "../db.js";
import { log } from "../log.js";
import { RunAbort } from "./budget.js";
import type { Runner } from "./runner.js";

/**
 * Runs queued top-level cycles, at most `maxParallel` at a time. Sub-agent cycles run inside
 * their parent's slot (they never wait in the queue, which would deadlock).
 */
export class Scheduler {
  private readonly running = new Map<string, Promise<void>>();
  private stopping = false;
  private ticking = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly runner: Runner,
  ) {}

  start(): void {
    this.recover();
    this.ctx.settings.onChange(() => this.tick());
    this.tick();
  }

  /** After a crash/redeploy: restart interrupted top-level cycles, fail orphaned sub-agent cycles. */
  recover(): void {
    const { cycles, events } = this.ctx;
    const subs = all<CycleRow>(
      this.ctx.db,
      "SELECT * FROM cycles WHERE parent_id IS NOT NULL AND status IN ('running', 'queued')",
    );
    for (const sub of subs) {
      const turn = cycles.latestTurn(sub.id);
      const error = {
        code: "interrupted",
        message: "Interrupted by a container restart; the parent re-runs its turn.",
      };
      cycles.finishTurn(turn.id, { status: "failed", answer: null, changes: null, endSnapshot: null, error });
      cycles.finishCycle(sub.id, "failed", error);
      events.append(sub.id, turn.idx, sub.attempts, {
        type: "cycle.status",
        data: { status: "failed", error },
      });
    }
    const tops = all<CycleRow>(
      this.ctx.db,
      "SELECT * FROM cycles WHERE parent_id IS NULL AND status = 'running'",
    );
    for (const top of tops) {
      const turn = cycles.latestTurn(top.id);
      cycles.resetTurnForRetry(turn.id);
      const row = cycles.requeueAfterRestart(top.id);
      events.append(top.id, turn.idx, row.attempts, {
        type: "restart",
        data: { attempt: row.attempts, reason: "AgentCave restarted while this cycle was running" },
      });
      events.append(top.id, turn.idx, row.attempts, {
        type: "cycle.status",
        data: { status: "queued", error: null },
      });
      log.info("Re-queued interrupted cycle", { cycle: top.id, attempt: row.attempts });
    }
  }

  /** Starts queued cycles while there are free slots. */
  tick(): void {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      const max = this.ctx.settings.get().maxParallel;
      const free = max - this.running.size;
      if (free <= 0) return;
      for (const row of this.ctx.cycles.nextQueued(new Set(this.running.keys()), free)) this.launch(row);
    } finally {
      this.ticking = false;
    }
  }

  private launch(row: CycleRow): void {
    const controller = this.ctx.registry.register(row.id);
    const p = this.runner
      .runTurn(row.id, { signal: controller.signal })
      .catch((err) => log.error("Runner crashed", { cycle: row.id, err }))
      .then(() => {
        this.ctx.registry.delete(row.id);
        this.running.delete(row.id);
        this.tick();
      });
    this.running.set(row.id, p);
  }

  /** Stops a running or queued cycle. Returns false if it was already finished. */
  stop(cycleId: string): boolean {
    const row = this.ctx.cycles.getRow(cycleId);
    if (FINAL.includes(row.status)) return false;
    const controller = this.ctx.registry.get(cycleId);
    if (controller) {
      controller.abort(new RunAbort("stopped", "Stopped by user"));
      return true;
    }
    if (row.status === "queued") {
      const turn = this.ctx.cycles.latestTurn(cycleId);
      const error = { code: "stopped", message: "Stopped by user before it started" };
      this.ctx.cycles.finishTurn(turn.id, {
        status: "stopped",
        answer: null,
        changes: null,
        endSnapshot: null,
        error,
      });
      this.ctx.cycles.finishCycle(cycleId, "stopped", error);
      this.ctx.events.append(cycleId, turn.idx, row.attempts, {
        type: "cycle.status",
        data: { status: "stopped", error },
      });
      this.ctx.webhooks.enqueue(this.ctx.cycles.get(cycleId), "cycle.stopped");
      return true;
    }
    return false;
  }

  isRunning(cycleId: string): boolean {
    return !!this.ctx.registry.get(cycleId);
  }

  counts(): { running: number; queued: number; maxParallel: number } {
    const c = this.ctx.cycles.counts();
    return { running: this.running.size, queued: c.queued, maxParallel: this.ctx.settings.get().maxParallel };
  }

  /** Graceful shutdown: abort running turns but leave them `running`, so the next boot restarts them. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    this.ctx.registry.abortAll(new RunAbort("shutdown", "AgentCave is shutting down"));
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
  }

  /** Waits until nothing is running or queued (tests). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running.size === 0 && this.ctx.cycles.counts().queued === 0) return;
      await Promise.allSettled([...this.running.values()]);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
