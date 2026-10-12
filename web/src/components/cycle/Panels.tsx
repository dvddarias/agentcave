import type { Cycle, CycleEvent, WorkspaceFile } from "@agentcave/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, keys } from "../../lib/api";
import { formatBytes, formatCost, formatDate, formatDuration, formatTokens } from "../../lib/format";
import { IconDownload, IconExternal, IconFile, IconX } from "../icons";
import { CodeBlock } from "../Markdown";
import { CopyButton, cx, Pill, Spinner, StatusBadge } from "../ui";

const STATUS_COLOR: Record<WorkspaceFile["status"], string> = {
  added: "text-emerald-300",
  modified: "text-torch-300",
  deleted: "text-rose-300 line-through",
  unchanged: "text-cave-300",
};
const STATUS_SIGN: Record<WorkspaceFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  unchanged: "",
};

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  json: "json",
  py: "python",
  sh: "bash",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  html: "xml",
  xml: "xml",
  css: "css",
  sql: "sql",
  go: "go",
  rs: "rust",
  diff: "diff",
};

export function FilesPanel({
  cycle,
  refreshKey,
  selected,
  onSelect,
}: {
  cycle: Cycle;
  refreshKey: string;
  selected: string | null;
  onSelect: (p: string | null) => void;
}) {
  const [onlyChanged, setOnlyChanged] = useState(false);
  const files = useQuery({
    queryKey: [...keys.files(cycle.id), refreshKey],
    queryFn: () => api.cycles.files(cycle.id),
  });
  const list = (files.data ?? []).filter((f) => !onlyChanged || f.status !== "unchanged");
  const changedCount = (files.data ?? []).filter((f) => f.status !== "unchanged").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-cave-750 px-3 py-2">
        <label className="flex items-center gap-1.5 text-xs text-cave-300">
          <input
            type="checkbox"
            className="accent-torch-500"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          Only changed ({changedCount})
        </label>
        <div className="ml-auto flex gap-1">
          <a
            href={api.cycles.zipUrl(cycle.id, { changedOnly: true })}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-cave-300 hover:bg-cave-750 hover:text-cave-100"
            title="Download changed files as zip"
          >
            <IconDownload size={13} /> changed
          </a>
          <a
            href={api.cycles.zipUrl(cycle.id)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-cave-300 hover:bg-cave-750 hover:text-cave-100"
            title="Download the whole workspace as zip"
          >
            <IconDownload size={13} /> all
          </a>
        </div>
      </div>
      {selected ? (
        <FilePreview
          cycleId={cycle.id}
          path={selected}
          file={files.data?.find((f) => f.path === selected)}
          onClose={() => onSelect(null)}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.isLoading ? (
          <div className="flex justify-center p-6 text-cave-400">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <div className="p-6 text-center text-xs text-cave-500">
            No files{onlyChanged ? " changed yet" : ""}.
          </div>
        ) : (
          <ul className="py-1">
            {list.map((f) => {
              const depth = f.path.split("/").length - 1;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    disabled={f.status === "deleted"}
                    onClick={() => onSelect(f.path)}
                    className={cx(
                      "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-cave-800",
                      selected === f.path && "bg-cave-800",
                    )}
                  >
                    <span className="w-3 shrink-0 font-mono text-[10px] font-bold text-cave-500">
                      {STATUS_SIGN[f.status]}
                    </span>
                    <IconFile size={12} className="shrink-0 text-cave-500" />
                    <span
                      className={cx("min-w-0 flex-1 truncate font-mono", STATUS_COLOR[f.status])}
                      style={{ paddingLeft: depth * 8 }}
                    >
                      {f.path}
                    </span>
                    <span className="shrink-0 text-[10px] text-cave-500">{formatBytes(f.size)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilePreview({
  cycleId,
  path,
  file,
  onClose,
}: {
  cycleId: string;
  path: string;
  file?: WorkspaceFile;
  onClose: () => void;
}) {
  const url = api.cycles.fileUrl(cycleId, path);
  const isImage = IMAGE.test(path);
  const tooBig = (file?.size ?? 0) > 400_000;
  const [text, setText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the file content (sha256) changes
  useEffect(() => {
    setText(null);
    setBinary(false);
    if (isImage || tooBig) return;
    let cancelled = false;
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const bytes = new Uint8Array(buf);
        if (bytes.subarray(0, 2048).includes(0)) setBinary(true);
        else setText(new TextDecoder().decode(bytes));
      });
    return () => {
      cancelled = true;
    };
  }, [url, isImage, tooBig, file?.sha256]);
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  return (
    <div className="flex max-h-[60%] min-h-48 flex-col border-b border-cave-750 bg-cave-925">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-cave-100">{path}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded p-1 text-cave-400 hover:text-cave-100"
          title="Open"
        >
          <IconExternal size={13} />
        </a>
        <a
          href={`${url}?download=true`}
          className="rounded p-1 text-cave-400 hover:text-cave-100"
          title="Download"
        >
          <IconDownload size={13} />
        </a>
        <button type="button" onClick={onClose} className="rounded p-1 text-cave-400 hover:text-cave-100">
          <IconX size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {isImage ? (
          <img src={url} alt={path} className="max-w-full rounded border border-cave-750" />
        ) : tooBig ? (
          <div className="text-xs text-cave-400">
            Too big to preview ({formatBytes(file?.size ?? 0)}). Download it instead.
          </div>
        ) : binary ? (
          <div className="text-xs text-cave-400">Binary file. Download it to open.</div>
        ) : text === null ? (
          <Spinner size={14} />
        ) : (
          <CodeBlock code={text} lang={LANG[ext] ?? (text.length < 30_000 ? undefined : "plaintext")} />
        )}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1.5 text-xs">
      <div className="text-cave-500">{k}</div>
      <div className="min-w-0 break-words text-cave-200">{children}</div>
    </div>
  );
}

export function DetailsPanel({ cycle, refreshKey }: { cycle: Cycle; refreshKey: string }) {
  const turns = useQuery({
    queryKey: [...keys.turns(cycle.id), refreshKey],
    queryFn: () => api.cycles.turns(cycle.id),
  });
  const children = useQuery({
    queryKey: [...keys.children(cycle.id), refreshKey],
    queryFn: () => api.cycles.children(cycle.id),
  });
  const hooks = useQuery({
    queryKey: [...keys.webhooks(cycle.id), refreshKey],
    queryFn: () => api.cycles.webhooks(cycle.id),
    enabled: !!cycle.webhookUrl,
    refetchInterval: cycle.webhookUrl ? 5000 : false,
  });
  const lim = cycle.limits;
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <section className="divide-y divide-cave-800">
        <Row k="Cycle id">
          <span className="font-mono">{cycle.id}</span> <CopyButton text={cycle.id} />
        </Row>
        <Row k="Agent">
          <Link className="text-torch-400 hover:underline" to={`/agents/${cycle.agent.slug}`}>
            {cycle.agent.name}
          </Link>{" "}
          <span className="text-cave-500">v{cycle.agent.version}</span>
        </Row>
        <Row k="Model">
          <span className="font-mono">{cycle.model}</span>
        </Row>
        <Row k="Reasoning">{cycle.reasoning}</Row>
        <Row k="Source">{cycle.source}</Row>
        {cycle.parentId ? (
          <Row k="Parent">
            <Link className="font-mono text-torch-400 hover:underline" to={`/cycles/${cycle.parentId}`}>
              {cycle.parentId}
            </Link>
          </Row>
        ) : null}
        {cycle.rerunOf ? (
          <Row k="Re-run of">
            <Link className="font-mono text-torch-400 hover:underline" to={`/cycles/${cycle.rerunOf}`}>
              {cycle.rerunOf}
            </Link>
          </Row>
        ) : null}
        <Row k="Limits (per turn)">
          {lim.maxTimeSec ? `${formatDuration(lim.maxTimeSec * 1000)}` : "no time limit"} ·{" "}
          {lim.maxCostUsd ? `$${lim.maxCostUsd}` : "no money limit"} ·{" "}
          {lim.maxTokens ? `${formatTokens(lim.maxTokens)} tokens` : "no token limit"}
        </Row>
        <Row k="Answer schema">
          {cycle.outputSchema ? (
            <CodeBlock code={JSON.stringify(cycle.outputSchema, null, 2)} lang="json" maxHeight={200} />
          ) : (
            "Markdown"
          )}
        </Row>
        <Row k="Labels">
          {Object.keys(cycle.labels).length ? (
            <div className="flex flex-wrap gap-1">
              {Object.entries(cycle.labels).map(([k, v]) => (
                <Pill key={k} className="font-mono">
                  {k}={v}
                </Pill>
              ))}
            </div>
          ) : (
            <span className="text-cave-500">none</span>
          )}
        </Row>
        <Row k="Created">{formatDate(cycle.createdAt)}</Row>
        {cycle.attempts > 0 ? <Row k="Restarts">{cycle.attempts}</Row> : null}
        <Row k="Own usage">
          {formatTokens(cycle.usage.inputTokens)} in · {formatTokens(cycle.usage.outputTokens)} out ·{" "}
          {formatTokens(cycle.usage.reasoningTokens)} reasoning · {formatTokens(cycle.usage.cachedTokens)}{" "}
          cached · {formatCost(cycle.usage.costUsd, cycle.usage.costEstimated)}
        </Row>
        <Row k="With sub-agents">
          {formatTokens(cycle.totalUsage.inputTokens + cycle.totalUsage.outputTokens)} tokens ·{" "}
          {formatCost(cycle.totalUsage.costUsd)}
        </Row>
      </section>

      <h3 className="mt-5 mb-2 text-[11px] font-semibold tracking-wider text-cave-400 uppercase">Turns</h3>
      <div className="overflow-hidden rounded-lg border border-cave-750">
        <table className="w-full text-xs">
          <thead className="bg-cave-800 text-cave-400">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">#</th>
              <th className="px-2 py-1.5 text-left font-medium">Status</th>
              <th className="px-2 py-1.5 text-right font-medium">Steps</th>
              <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
              <th className="px-2 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cave-800">
            {turns.data?.map((t) => (
              <tr key={t.index} title={t.prompt.slice(0, 300)}>
                <td className="px-2 py-1.5 text-cave-300">{t.index + 1}</td>
                <td className="px-2 py-1.5">
                  <StatusBadge status={t.status} className="scale-90" />
                  {t.nudges ? <span className="ml-1 text-torch-300">· {t.nudges} nudge</span> : null}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{t.usage.steps}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {formatTokens(t.usage.inputTokens + t.usage.outputTokens)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {formatCost(t.usage.costUsd, t.usage.costEstimated)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {children.data && children.data.length > 0 ? (
        <>
          <h3 className="mt-5 mb-2 text-[11px] font-semibold tracking-wider text-cave-400 uppercase">
            Sub-agent cycles
          </h3>
          <ul className="space-y-1">
            {children.data.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/cycles/${c.id}`}
                  className="flex items-center gap-2 rounded-lg border border-cave-750 px-2.5 py-1.5 text-xs hover:bg-cave-800"
                >
                  <StatusBadge status={c.status} className="scale-90" />
                  <span className="flex-1 truncate text-cave-200">{c.agent.name}</span>
                  <span className="font-mono text-cave-400">{formatCost(c.totalUsage.costUsd)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {cycle.webhookUrl ? (
        <>
          <h3 className="mt-5 mb-2 text-[11px] font-semibold tracking-wider text-cave-400 uppercase">
            Webhook
          </h3>
          <div className="mb-2 font-mono text-xs break-all text-cave-300">{cycle.webhookUrl}</div>
          <ul className="space-y-1">
            {hooks.data?.map((d) => (
              <li key={d.id} className="rounded-lg border border-cave-750 px-2.5 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-cave-200">{d.event}</span>
                  <span
                    className={cx(
                      "ml-auto rounded px-1.5 text-[10px] uppercase",
                      d.status === "delivered"
                        ? "bg-emerald-950 text-emerald-300"
                        : d.status === "failed"
                          ? "bg-rose-950 text-rose-300"
                          : "bg-cave-800 text-cave-300",
                    )}
                  >
                    {d.status}
                  </span>
                </div>
                <div className="mt-0.5 text-cave-500">
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                  {d.lastStatusCode ? ` · HTTP ${d.lastStatusCode}` : ""}
                  {d.lastError ? ` · ${d.lastError}` : ""}
                  {d.nextRetryAt ? ` · retry ${formatDate(d.nextRetryAt)}` : ""}
                </div>
              </li>
            ))}
            {hooks.data?.length === 0 ? <li className="text-xs text-cave-500">Nothing sent yet.</li> : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function RawPanel({ events }: { events: CycleEvent[] }) {
  const [type, setType] = useState("");
  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const shown = events.filter((e) => !type || e.type === type).slice(-300);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-cave-750 px-3 py-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-md border border-cave-700 bg-cave-900 px-2 py-1 text-xs"
        >
          <option value="">All events ({events.length})</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-cave-500">last 300 shown</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {shown.map((e) => (
          <details key={e.seq} className="rounded-md border border-cave-800 bg-cave-900/60">
            <summary className="cursor-pointer px-2 py-1 font-mono text-[11px] text-cave-300">
              <span className="text-cave-500">#{e.seq}</span> {e.type}
              <span className="text-cave-500"> · turn {e.turn + 1}</span>
            </summary>
            <CodeBlock code={JSON.stringify(e, null, 2)} lang="json" className="m-1.5" maxHeight={320} />
          </details>
        ))}
      </div>
    </div>
  );
}
