import type { Stats, StatsRow } from "@agentcave/client";
import { all, type DB, one, type Param } from "./db.js";
import { type Scope, scopeSql } from "./scope.js";

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
 * Reads `cycle_usage`, which outlives the cycles, so deleted cycles still count. With a `scope`, only
 * cycles whose root's labels have every pair of it.
 */
export function computeStats(db: DB, from?: string, to?: string, scope?: Scope | null): Stats {
  const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
  const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const s = scope ? scopeSql("root_labels", scope) : null;
  const where = `created_at >= ? AND created_at <= ?${s ? ` AND ${s.sql}` : ""}`;
  const params: Param[] = [fromIso, toIso, ...(s?.params ?? [])];
  const agg =
    "COUNT(*) AS cycles, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost";
  const totals = one<Omit<Agg, "key" | "label">>(
    db,
    `SELECT ${agg} FROM cycle_usage WHERE ${where}`,
    ...params,
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
      ...params,
    ).map(toRow),
    byAgent: all<Agg>(
      db,
      `SELECT agent_slug AS key, MAX(agent_name) AS label, ${agg}
       FROM cycle_usage WHERE ${where} GROUP BY agent_slug ORDER BY cost DESC`,
      ...params,
    ).map(toRow),
    byModel: all<Agg>(
      db,
      `SELECT model AS key, model AS label, ${agg} FROM cycle_usage WHERE ${where} GROUP BY model ORDER BY cost DESC`,
      ...params,
    ).map(toRow),
  };
}
