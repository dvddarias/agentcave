import { EventEmitter } from "node:events";
import type { CycleEvent, CycleEventPayload } from "@agentcave/client";
import { all, type DB, nowIso } from "./db.js";

interface EventRow {
  seq: number;
  cycle_id: string;
  turn: number;
  attempt: number;
  type: string;
  data: string;
  ts: string;
}

function toEvent(r: EventRow): CycleEvent {
  return {
    seq: r.seq,
    cycleId: r.cycle_id,
    turn: r.turn,
    attempt: r.attempt,
    ts: r.ts,
    type: r.type,
    data: JSON.parse(r.data),
  } as CycleEvent;
}

/**
 * Stores cycle events (paragraph-level, never single tokens) and pushes them live to listeners.
 * Also carries the "a cycle changed" signal used by the global feed.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  private readonly insert;

  constructor(private readonly db: DB) {
    this.emitter.setMaxListeners(0);
    this.insert = db.prepare(
      "INSERT INTO events (cycle_id, turn, attempt, type, data, ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
    );
  }

  append(cycleId: string, turn: number, attempt: number, payload: CycleEventPayload): CycleEvent {
    const ts = nowIso();
    const row = this.insert.get(cycleId, turn, attempt, payload.type, JSON.stringify(payload.data), ts) as {
      seq: number;
    };
    const event = { ...payload, seq: row.seq, cycleId, turn, attempt, ts } as CycleEvent;
    this.emitter.emit(`cycle:${cycleId}`, event);
    return event;
  }

  list(cycleId: string, after = 0, limit = 1000): CycleEvent[] {
    return all<EventRow>(
      this.db,
      "SELECT * FROM events WHERE cycle_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      cycleId,
      after,
      limit,
    ).map(toEvent);
  }

  subscribe(cycleId: string, fn: (e: CycleEvent) => void): () => void {
    const key = `cycle:${cycleId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }

  /** Signals that a cycle's summary (status, usage, activity…) changed. */
  touch(cycleId: string, deleted = false): void {
    this.emitter.emit("cycle-changed", cycleId, deleted);
  }

  onCycleChanged(fn: (cycleId: string, deleted: boolean) => void): () => void {
    this.emitter.on("cycle-changed", fn);
    return () => this.emitter.off("cycle-changed", fn);
  }
}
