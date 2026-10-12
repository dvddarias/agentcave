import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "./blobs.js";
import type { Ctx } from "./context.js";
import { all, run } from "./db.js";
import { log } from "./log.js";

/** Deletes a cycle with all its sub-agent cycles, events, turns and workspaces. */
export async function deleteCycleTree(ctx: Ctx, cycleId: string): Promise<void> {
  const ids = [cycleId, ...ctx.cycles.descendantIds(cycleId)];
  run(ctx.db, "DELETE FROM cycles WHERE id = ?", cycleId); // cascades to children, turns, events, deliveries
  for (const id of ids) {
    await fs.rm(path.join(ctx.dataDir, "cycles", id), { recursive: true, force: true }).catch(() => {});
    ctx.events.touch(id, true);
  }
}

/** Hourly job: deletes finished cycles older than `retentionDays` and unreferenced blobs. */
export class RetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: Ctx) {}

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.timer) return;
    setTimeout(() => void this.runOnce(), 30_000).unref?.();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ deletedCycles: number; deletedBlobs: number }> {
    let deletedCycles = 0;
    try {
      const days = this.ctx.settings.get().retentionDays;
      if (days > 0) {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const old = all<{ id: string }>(
          this.ctx.db,
          `SELECT id FROM cycles WHERE parent_id IS NULL AND status IN ('completed', 'failed', 'stopped')
           AND COALESCE(finished_at, updated_at) < ?`,
          cutoff,
        );
        for (const { id } of old) {
          await deleteCycleTree(this.ctx, id);
          deletedCycles++;
        }
      }
      const deletedBlobs = await this.ctx.blobs.gc(this.referencedBlobs());
      if (deletedCycles || deletedBlobs) log.info("Retention cleanup", { deletedCycles, deletedBlobs });
      return { deletedCycles, deletedBlobs };
    } catch (err) {
      log.error("Retention cleanup failed", { err });
      return { deletedCycles, deletedBlobs: 0 };
    }
  }

  private referencedBlobs(): Set<string> {
    const refs = new Set<string>();
    for (const r of all<{ sha256: string }>(this.ctx.db, "SELECT DISTINCT sha256 FROM agent_version_files")) {
      refs.add(r.sha256);
    }
    const turns = all<{ a: string; b: string | null; c: string | null }>(
      this.ctx.db,
      "SELECT input_manifest AS a, start_snapshot AS b, end_snapshot AS c FROM turns",
    );
    for (const t of turns) {
      for (const json of [t.a, t.b, t.c]) {
        if (!json) continue;
        try {
          for (const e of Object.values(JSON.parse(json) as Manifest)) refs.add(e.sha256);
        } catch {
          // ignore
        }
      }
    }
    return refs;
  }
}
