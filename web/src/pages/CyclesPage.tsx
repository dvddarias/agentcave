import type { Cycle, CycleStatus } from "@agentcave/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { IconBranch, IconCycles, IconPlus, IconRefresh, IconSearch, IconTag } from "../components/icons";
import { Button, cx, Empty, ErrorBox, PageHeader, Pill, Spinner, StatusBadge } from "../components/ui";
import { api, keys } from "../lib/api";
import { formatCost, formatDuration, formatTokens, timeAgo } from "../lib/format";
import { useNow } from "../lib/live";

const STATUSES: (CycleStatus | "all")[] = ["all", "running", "queued", "completed", "failed", "stopped"];

export function CyclesPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "all") as CycleStatus | "all";
  const agent = params.get("agent") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [label, setLabel] = useState(params.get("label") ?? "");
  const navigate = useNavigate();

  const labels: Record<string, string> = {};
  const lm = /^([^=]+)=(.*)$/.exec(params.get("label") ?? "");
  if (lm) labels[lm[1].trim()] = lm[2].trim();

  const query = { status, agent, q: params.get("q") ?? "", labels };
  const cycles = useInfiniteQuery({
    queryKey: keys.cycles(query),
    queryFn: ({ pageParam }) =>
      api.cycles.list({
        status: status === "all" ? undefined : status,
        agent: agent || undefined,
        q: query.q || undefined,
        labels,
        limit: 50,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const agents = useQuery({
    queryKey: keys.agents(true),
    queryFn: () => api.agents.list({ archived: true }),
  });
  const rows = cycles.data?.pages.flatMap((p) => p.cycles) ?? [];
  const anyRunning = rows.some((r) => r.status === "running");
  const now = useNow(anyRunning ? 1000 : 30_000);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Cycles"
        subtitle="Every agentic cycle started from the API or the Playground, live."
        actions={
          <>
            <Button variant="ghost" onClick={() => void cycles.refetch()}>
              <IconRefresh size={15} />
            </Button>
            <Button variant="primary" onClick={() => navigate("/playground")}>
              <IconPlus size={15} /> New cycle
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-cave-750 bg-cave-900 p-1">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set("status", s)}
              className={cx(
                "rounded-lg px-2.5 py-1 text-xs capitalize",
                status === s ? "bg-cave-700 text-cave-100" : "text-cave-400 hover:text-cave-200",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={agent}
          onChange={(e) => set("agent", e.target.value)}
          className="rounded-lg border border-cave-700 bg-cave-900 px-2.5 py-1.5 text-xs text-cave-200 focus:border-torch-600 focus:outline-none"
        >
          <option value="">All agents</option>
          {agents.data?.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.config.name}
            </option>
          ))}
        </select>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", q);
          }}
        >
          <IconSearch size={14} className="absolute top-2 left-2.5 text-cave-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => set("q", q)}
            placeholder="Search prompts, ids…"
            className="w-56 rounded-lg border border-cave-700 bg-cave-900 py-1.5 pr-3 pl-8 text-xs text-cave-100 placeholder:text-cave-500 focus:border-torch-600 focus:outline-none"
          />
        </form>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set("label", label);
          }}
        >
          <IconTag size={14} className="absolute top-2 left-2.5 text-cave-500" />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => set("label", label)}
            placeholder="label key=value"
            className="w-44 rounded-lg border border-cave-700 bg-cave-900 py-1.5 pr-3 pl-8 font-mono text-xs text-cave-100 placeholder:text-cave-500 focus:border-torch-600 focus:outline-none"
          />
        </form>
      </div>

      <ErrorBox error={cycles.error} />
      {cycles.isLoading ? (
        <div className="flex justify-center py-16 text-cave-400">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <Empty icon={<IconCycles size={28} />} title="No cycles yet">
          Start one from the{" "}
          <Link to="/playground" className="text-torch-400 hover:underline">
            Playground
          </Link>{" "}
          or with <code className="rounded bg-cave-800 px-1 font-mono text-xs">POST /api/v1/cycles</code>.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-cave-750">
          <ul className="divide-y divide-cave-800">
            {rows.map((c) => (
              <CycleRow key={c.id} cycle={c} now={now} />
            ))}
          </ul>
          {cycles.hasNextPage ? (
            <div className="border-t border-cave-800 p-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                loading={cycles.isFetchingNextPage}
                onClick={() => void cycles.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle: c, now }: { cycle: Cycle; now: number }) {
  const start = c.startedAt ? new Date(c.startedAt).getTime() : null;
  const end = c.finishedAt ? new Date(c.finishedAt).getTime() : c.status === "running" ? now : null;
  return (
    <li>
      <Link
        to={`/cycles/${c.id}`}
        className="grid grid-cols-1 gap-x-4 gap-y-1.5 bg-cave-850/40 px-4 py-3 transition-colors hover:bg-cave-800/70 md:grid-cols-[110px_1fr_170px_120px]"
      >
        <div className="flex items-start">
          <StatusBadge status={c.status} />
        </div>
        <div className="min-w-0">
          <div className="line-clamp-2 text-sm text-cave-100">
            {c.promptPreview || <span className="text-cave-500">(no prompt)</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-cave-400">
            <span className="text-cave-300">{c.agent.name}</span>
            <span className="text-cave-600">v{c.agent.version}</span>
            <span className="text-cave-600">·</span>
            <span className="font-mono">{c.model}</span>
            {c.turns > 1 ? <Pill>{c.turns} turns</Pill> : null}
            {c.source !== "api" ? <Pill>{c.source}</Pill> : null}
            {c.totalUsage.costUsd > c.usage.costUsd ? (
              <Pill title="Used sub-agents">
                <IconBranch size={11} /> sub-agents
              </Pill>
            ) : null}
            {Object.entries(c.labels).map(([k, v]) => (
              <Pill key={k} className="font-mono">
                {k}={v}
              </Pill>
            ))}
          </div>
          {c.status === "running" && c.progress.activity ? (
            <div className="mt-1 truncate font-mono text-[11px] text-sky-300/80">{c.progress.activity}</div>
          ) : null}
          {c.error ? (
            <div className="mt-1 truncate text-[11px] text-rose-300/90">{c.error.message}</div>
          ) : null}
        </div>
        <div className="font-mono text-xs text-cave-300 md:text-right">
          <div>{formatCost(c.totalUsage.costUsd, c.usage.costEstimated)}</div>
          <div className="text-cave-500">
            {formatTokens(c.totalUsage.inputTokens + c.totalUsage.outputTokens)} tok · {c.usage.steps} steps
          </div>
        </div>
        <div className="text-xs text-cave-400 md:text-right">
          <div>{start && end ? formatDuration(end - start) : "—"}</div>
          <div className="text-cave-500">{timeAgo(c.createdAt, now)}</div>
        </div>
      </Link>
    </li>
  );
}
