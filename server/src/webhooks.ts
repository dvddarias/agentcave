import { createHmac } from "node:crypto";
import type { Cycle, WebhookDelivery, WebhookPayload } from "@agentcave/client";
import { all, type DB, nowIso, run } from "./db.js";
import { newId } from "./ids.js";
import { log } from "./log.js";
import type { SettingsService } from "./settings.js";

interface DeliveryRow {
  id: string;
  cycle_id: string;
  event: string;
  url: string;
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Delay before retry n (after attempt n failed). 1 try + 5 retries. */
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000];

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class WebhookService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly settings: SettingsService,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly backoffMs: number[] = BACKOFF_MS,
  ) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(cycle: Cycle, event: WebhookPayload["event"]): void {
    if (!cycle.webhookUrl) return;
    const payload: WebhookPayload = { event, turn: cycle.turn, sentAt: nowIso(), cycle };
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO webhook_deliveries (id, cycle_id, event, url, payload, status, attempts, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      newId("whk"),
      cycle.id,
      event,
      cycle.webhookUrl,
      JSON.stringify(payload),
      now,
      now,
      now,
    );
    queueMicrotask(() => void this.tick());
  }

  list(cycleId: string): WebhookDelivery[] {
    return all<DeliveryRow>(
      this.db,
      "SELECT * FROM webhook_deliveries WHERE cycle_id = ? ORDER BY created_at",
      cycleId,
    ).map((r) => ({
      id: r.id,
      event: r.event,
      url: r.url,
      status: r.status,
      attempts: r.attempts,
      lastStatusCode: r.last_status_code,
      lastError: r.last_error,
      nextRetryAt: r.status === "pending" ? r.next_retry_at : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async tick(): Promise<void> {
    const due = all<DeliveryRow>(
      this.db,
      "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_retry_at <= ? ORDER BY next_retry_at LIMIT 20",
      nowIso(),
    ).filter((r) => !this.inflight.has(r.id));
    await Promise.all(due.map((r) => this.deliver(r)));
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    this.inflight.add(row.id);
    const attempt = row.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "AgentCave-Webhook/1",
        "x-agentcave-event": row.event,
        "x-agentcave-delivery": row.id,
      };
      const secret = this.settings.get().webhookSecret;
      if (secret) headers["x-agentcave-signature"] = signPayload(secret, row.payload);
      const res = await this.fetchImpl(row.url, {
        method: "POST",
        headers,
        body: row.payload,
        signal: AbortSignal.timeout(15_000),
      });
      statusCode = res.status;
      await res.body?.cancel().catch(() => {});
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const now = Date.now();
    if (!error) {
      run(
        this.db,
        "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, next_retry_at = NULL, updated_at = ? WHERE id = ?",
        attempt,
        statusCode,
        new Date(now).toISOString(),
        row.id,
      );
    } else {
      const delay = this.backoffMs[attempt - 1];
      const failed = delay === undefined;
      run(
        this.db,
        "UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?",
        failed ? "failed" : "pending",
        attempt,
        statusCode,
        error,
        failed ? null : new Date(now + delay).toISOString(),
        new Date(now).toISOString(),
        row.id,
      );
      if (failed) log.warn("Webhook delivery failed for good", { cycle: row.cycle_id, url: row.url, error });
    }
    this.inflight.delete(row.id);
  }
}
