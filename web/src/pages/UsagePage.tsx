import type { StatsRow } from "@agentcave/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, cx, ErrorBox, PageHeader, Spinner } from "../components/ui";
import { api, keys } from "../lib/api";
import { formatCost, formatTokens } from "../lib/format";

const RANGES = [7, 30, 90, 365];

export function UsagePage() {
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: keys.stats(days),
    queryFn: () => api.stats({ from: new Date(Date.now() - days * 86_400_000).toISOString() }),
  });
  const s = stats.data;

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="Tokens and money spent on OpenRouter. Sub-agent cycles are counted once, under their own agent."
        actions={
          <div className="flex gap-1 rounded-xl border border-cave-750 bg-cave-900 p-1">
            {RANGES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={cx(
                  "rounded-lg px-2.5 py-1 text-xs",
                  days === d ? "bg-cave-700 text-cave-100" : "text-cave-400 hover:text-cave-200",
                )}
              >
                {d === 365 ? "1 year" : `${d} days`}
              </button>
            ))}
          </div>
        }
      />
      <ErrorBox error={stats.error} />
      {!s ? (
        <div className="flex justify-center py-16 text-cave-400">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Spent" value={formatCost(s.totals.costUsd)} accent />
            <Tile label="Cycles" value={s.totals.cycles.toLocaleString()} />
            <Tile label="Input tokens" value={formatTokens(s.totals.inputTokens)} />
            <Tile label="Output tokens" value={formatTokens(s.totals.outputTokens)} />
          </div>
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-cave-100">Cost per day</h2>
            <DayChart rows={s.byDay} from={s.from} to={s.to} />
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown title="By agent" rows={s.byAgent} />
            <Breakdown title="By model" rows={s.byModel} mono />
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-cave-400">{label}</div>
      <div
        className={cx(
          "mt-1 font-mono text-2xl font-semibold tabular-nums",
          accent ? "text-torch-300" : "text-cave-100",
        )}
      >
        {value}
      </div>
    </Card>
  );
}

function DayChart({ rows, from, to }: { rows: StatsRow[]; from: string; to: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out: { key: string; cost: number; cycles: number; tokens: number }[] = [];
    const start = new Date(from.slice(0, 10));
    const end = new Date(to.slice(0, 10));
    for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
      const key = d.toISOString().slice(0, 10);
      const r = byKey.get(key);
      out.push({
        key,
        cost: r?.costUsd ?? 0,
        cycles: r?.cycles ?? 0,
        tokens: (r?.inputTokens ?? 0) + (r?.outputTokens ?? 0),
      });
    }
    return out;
  }, [rows, from, to]);
  const max = Math.max(...days.map((d) => d.cost), 0.0001);
  const W = 1000;
  const H = 180;
  const bw = W / days.length;
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H + 24}`}
        className="h-52 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Cost per day"
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={H - H * f}
            y2={H - H * f}
            stroke="#262b32"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {days.map((d, i) => {
          const bh = (d.cost / max) * (H - 4);
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect
                x={i * bw + bw * 0.15}
                y={H - bh}
                width={bw * 0.7}
                height={Math.max(bh, d.cycles ? 1.5 : 0)}
                rx={Math.min(3, bw * 0.2)}
                fill={hover === i ? "#fbbf24" : "#d97706"}
                opacity={hover === null || hover === i ? 1 : 0.6}
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-cave-500">
        <span>{days[0]?.key}</span>
        <span>{days[days.length - 1]?.key}</span>
      </div>
      {h ? (
        <div className="pointer-events-none absolute top-0 right-0 rounded-lg border border-cave-700 bg-cave-850 px-3 py-2 text-xs shadow-xl">
          <div className="font-medium text-cave-100">{h.key}</div>
          <div className="font-mono text-torch-300">{formatCost(h.cost)}</div>
          <div className="text-cave-400">
            {h.cycles} cycles · {formatTokens(h.tokens)} tokens
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Breakdown({ title, rows, mono }: { title: string; rows: StatsRow[]; mono?: boolean }) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0.0001);
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-cave-100">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-cave-500">Nothing yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className={cx("truncate text-cave-200", mono && "font-mono")}>{r.label}</span>
                <span className="shrink-0 font-mono text-cave-300">
                  {formatCost(r.costUsd)}{" "}
                  <span className="text-cave-500">
                    · {r.cycles} cycles · {formatTokens(r.inputTokens + r.outputTokens)} tok
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cave-750">
                <div
                  className="h-full rounded-full bg-torch-600"
                  style={{ width: `${(r.costUsd / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
