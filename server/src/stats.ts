import type { Stats, StatsRow } from "@agentcave/client";
import { all, type DB, one } from "./db.js";

interface Agg {
  key: string;
  label: string;
  cycles: number;
  input: number | null;
  output: number | null;
  cost: number | null;
}

const toRow = (r: Agg): StatsRow => ({
  key: r.key,
  label: r.label,
  cycles: r.cycles,
  inputTokens: r.input ?? 0,
  outputTokens: r.output ?? 0,
  costUsd: r.cost ?? 0,
});

/**
 * Usage totals between two dates. Uses each cycle's own usage, so sub-agents are never counted twice.
 * Reads `cycle_usage`, which outlives the cycles, so deleted cycles still count.
 */
export function computeStats(db: DB, from?: string, to?: string): Stats {
  const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
  const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const where = "created_at >= ? AND created_at <= ?";
  const agg =
    "COUNT(*) AS cycles, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost";
  const totals = one<Omit<Agg, "key" | "label">>(
    db,
    `SELECT ${agg} FROM cycle_usage WHERE ${where}`,
    fromIso,
    toIso,
  );
  return {
    from: fromIso,
    to: toIso,
    totals: {
      cycles: totals?.cycles ?? 0,
      inputTokens: totals?.input ?? 0,
      outputTokens: totals?.output ?? 0,
      costUsd: totals?.cost ?? 0,
    },
    byDay: all<Agg>(
      db,
      `SELECT substr(created_at, 1, 10) AS key, substr(created_at, 1, 10) AS label, ${agg}
       FROM cycle_usage WHERE ${where} GROUP BY key ORDER BY key`,
      fromIso,
      toIso,
    ).map(toRow),
    byAgent: all<Agg>(
      db,
      `SELECT agent_slug AS key, MAX(agent_name) AS label, ${agg}
       FROM cycle_usage WHERE ${where} GROUP BY agent_slug ORDER BY cost DESC`,
      fromIso,
      toIso,
    ).map(toRow),
    byModel: all<Agg>(
      db,
      `SELECT model AS key, model AS label, ${agg} FROM cycle_usage WHERE ${where} GROUP BY model ORDER BY cost DESC`,
      fromIso,
      toIso,
    ).map(toRow),
  };
}
