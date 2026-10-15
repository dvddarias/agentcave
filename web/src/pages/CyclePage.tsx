import {
  CONTINUABLE_ERRORS,
  FINAL_STATUSES,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@agentcave/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ContinuePanel } from "../components/cycle/ContinuePanel";
import { DetailsPanel, FilesPanel, RawPanel } from "../components/cycle/Panels";
import { SystemPromptCard, Timeline } from "../components/cycle/Timeline";
import { FileDrop } from "../components/FileDrop";
import {
  IconBranch,
  IconChevron,
  IconClock,
  IconCoin,
  IconDownload,
  IconRefresh,
  IconSend,
  IconStop,
  IconTrash,
} from "../components/icons";
import { ModelPicker } from "../components/ModelPicker";
import {
  Button,
  cx,
  ErrorBox,
  Field,
  LimitBar,
  Modal,
  Pill,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
} from "../components/ui";
import { api, errorText, keys } from "../lib/api";
import type { PickedFile } from "../lib/files";
import { formatCost, formatDuration, formatTokens } from "../lib/format";
import { useCycleEvents, useNow } from "../lib/live";
import { buildTimeline } from "../lib/timeline";

type PanelTab = "files" | "details" | "raw";

export function CyclePage() {
  const { id = "" } = useParams();
  // A fresh view per cycle (scroll position, selected file, tabs).
  return <CycleView key={id} id={id} />;
}

function CycleView({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cycleQ = useQuery({ queryKey: keys.cycle(id), queryFn: () => api.cycles.get(id) });
  const { events, connected } = useCycleEvents(id);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const cycle = cycleQ.data;
  const running = cycle?.status === "running" || cycle?.status === "queued";
  const now = useNow(1000, cycle?.status === "running");
  const [tab, setTab] = useState<PanelTab>("files");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when new items arrive or the status changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [timeline.items, cycle?.status]);

  const stop = useMutation({
    mutationFn: () => api.cycles.stop(id),
    onSuccess: (c) =>
      qc.setQueryData(keys.cycle(id), (old: typeof c | undefined) => ({
        ...c,
        systemPrompt: old?.systemPrompt,
      })),
  });
  const del = useMutation({
    mutationFn: () => api.cycles.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cycles"] });
      navigate("/cycles");
    },
  });

  // Files/turns refresh whenever a turn ends.
  const refreshKey = `${cycle?.turn ?? 0}:${cycle?.status ?? ""}`;

  if (cycleQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-cave-400">
        <Spinner />
      </div>
    );
  }
  if (!cycle) {
    return (
      <div className="p-8">
        <ErrorBox error={cycleQ.error ?? "Cycle not found"} />
      </div>
    );
  }

  // What the latest turn used against its limits (sub-agents included). Time ticks live while
  // running: the run's start plus what earlier runs of a continued turn used.
  const used = cycle.limitUsage;
  const timeUsed =
    cycle.status === "running" && timeline.run
      ? timeline.run.usedSec + Math.max(0, now - new Date(timeline.run.ts).getTime()) / 1000
      : used.timeSec;
  const isFinal = FINAL_STATUSES.includes(cycle.status);
  const continuable =
    cycle.status === "failed" &&
    !cycle.parentId &&
    (CONTINUABLE_ERRORS as readonly string[]).includes(cycle.error?.code ?? "");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-cave-800 bg-cave-950/80 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link to="/cycles" className="text-xs text-cave-500 hover:text-cave-300">
            Cycles
          </Link>
          <IconChevron size={12} className="text-cave-600" />
          {cycle.parentId ? (
            <>
              <Link
                to={`/cycles/${cycle.parentId}`}
                className="flex items-center gap-1 text-xs text-teal-300 hover:underline"
              >
                <IconBranch size={12} /> parent
              </Link>
              <IconChevron size={12} className="text-cave-600" />
            </>
          ) : null}
          <span className="font-mono text-xs text-cave-400">{cycle.id}</span>
          <StatusBadge status={cycle.status} />
          {!connected && events.length > 0 && running ? (
            <Pill className="text-torch-300">reconnecting…</Pill>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {running ? (
              <Button variant="danger" size="sm" loading={stop.isPending} onClick={() => stop.mutate()}>
                <IconStop size={13} /> Stop
              </Button>
            ) : null}
            {!cycle.parentId ? (
              <Button size="sm" onClick={() => setRerunOpen(true)}>
                <IconRefresh size={13} /> Re-run
              </Button>
            ) : null}
            <a href={api.cycles.zipUrl(cycle.id)}>
              <Button size="sm">
                <IconDownload size={13} /> Files
              </Button>
            </a>
            {isFinal && !cycle.parentId ? (
              <Button
                size="sm"
                variant="ghost"
                title="Delete cycle"
                onClick={() => {
                  if (confirm("Delete this cycle, its files and its sub-agent cycles?")) del.mutate();
                }}
              >
                <IconTrash size={13} />
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="hidden lg:inline-flex"
              onClick={() => setPanelOpen(!panelOpen)}
            >
              {panelOpen ? "Hide panel" : "Show panel"}
            </Button>
          </div>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
          <div className="col-span-2 min-w-0 md:col-span-1">
            <div className="flex items-center gap-1.5 truncate text-sm text-cave-100">
              <Link to={`/agents/${cycle.agent.slug}`} className="font-medium hover:text-torch-300">
                {cycle.agent.name}
              </Link>
              <span className="text-cave-500">v{cycle.agent.version}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-cave-400">
              {cycle.model} · reasoning {cycle.reasoning}
              {cycle.turns > 1 ? ` · turn ${cycle.turn + 1} of ${cycle.turns}` : ""}
            </div>
          </div>
          <LimitBar
            label="Time (this turn)"
            icon={<IconClock size={12} />}
            value={timeUsed}
            max={cycle.limits.maxTimeSec}
            format={(s) => formatDuration(s * 1000)}
          />
          <LimitBar
            label="Tokens (this turn)"
            icon={<span className="font-mono text-[10px]">tok</span>}
            value={used.tokens}
            max={cycle.limits.maxTokens}
            format={formatTokens}
          />
          <LimitBar
            label="Cost (this turn)"
            icon={<IconCoin size={12} />}
            value={used.costUsd}
            max={cycle.limits.maxCostUsd}
            format={(v) => formatCost(v)}
          />
        </div>
      </header>

      {/* Body */}
      <div
        className={cx(
          "grid min-h-0 flex-1",
          panelOpen ? "lg:grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1",
        )}
      >
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="min-h-0 overflow-y-auto"
        >
          <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 md:px-6">
            {cycle.systemPrompt ? (
              <SystemPromptCard text={cycle.systemPrompt} model={cycle.model} reasoning={cycle.reasoning} />
            ) : null}
            <Timeline
              items={timeline.items}
              streamingKey={timeline.streamingKey}
              running={cycle.status === "running"}
              onOpenFile={(p) => {
                setSelectedFile(p);
                setTab("files");
                setPanelOpen(true);
              }}
            />
            {cycle.status === "running" ? (
              <div className="flex items-center gap-2 py-2 pl-1 text-xs text-sky-300/80">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
                </span>
                <span className="truncate font-mono">{cycle.progress.activity ?? "working…"}</span>
                {timeline.step ? <span className="text-cave-500">· step {timeline.step}</span> : null}
              </div>
            ) : cycle.status === "queued" ? (
              <div className="flex items-center gap-2 py-2 pl-1 text-xs text-cave-400">
                <Spinner size={12} /> Waiting for a free slot…
              </div>
            ) : null}
            {continuable ? <ContinuePanel cycle={cycle} /> : null}
            {!cycle.parentId ? <FollowUp cycleId={cycle.id} enabled={isFinal} /> : null}
            <div className="h-8" />
          </div>
        </div>
        {panelOpen ? (
          <aside className="hidden min-h-0 flex-col border-l border-cave-800 bg-cave-900/40 lg:flex">
            <Tabs
              className="px-2"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "files", label: "Files" },
                { id: "details", label: "Details" },
                { id: "raw", label: "Raw events" },
              ]}
            />
            <div className="min-h-0 flex-1">
              {tab === "files" ? (
                <FilesPanel
                  cycle={cycle}
                  refreshKey={refreshKey}
                  selected={selectedFile}
                  onSelect={setSelectedFile}
                />
              ) : tab === "details" ? (
                <DetailsPanel cycle={cycle} refreshKey={refreshKey} />
              ) : (
                <RawPanel events={events} />
              )}
            </div>
          </aside>
        ) : null}
      </div>
      <RerunModal
        open={rerunOpen}
        onClose={() => setRerunOpen(false)}
        cycleId={cycle.id}
        agentSlug={cycle.agent.slug}
        model={cycle.model}
        reasoning={cycle.reasoning}
        version={cycle.agent.version}
      />
    </div>
  );
}

function FollowUp({ cycleId, enabled }: { cycleId: string; enabled: boolean }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const send = useMutation({
    mutationFn: () => api.cycles.followUp(cycleId, { prompt, files: files.map((f) => f.input) }),
    onSuccess: (c) => {
      setPrompt("");
      setFiles([]);
      setShowFiles(false);
      qc.setQueryData(keys.cycle(cycleId), (old: typeof c | undefined) => ({
        ...c,
        systemPrompt: old?.systemPrompt,
      }));
    },
  });
  return (
    <div
      className={cx(
        "mt-6 rounded-2xl border bg-cave-850/80 p-3",
        enabled ? "border-cave-700" : "border-cave-800 opacity-60",
      )}
    >
      <Textarea
        rows={3}
        value={prompt}
        disabled={!enabled}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && enabled) send.mutate();
        }}
        placeholder={
          enabled
            ? "Send a follow-up (same memory and sandbox files)…  Ctrl+Enter to send"
            : "Follow-ups are possible once the cycle has finished."
        }
        className="border-0 bg-transparent focus:ring-0"
      />
      {showFiles ? (
        <div className="mt-2">
          <FileDrop files={files} onChange={setFiles} compact />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => setShowFiles(!showFiles)}>
          {showFiles ? "Hide files" : files.length ? `${files.length} files` : "Add files"}
        </Button>
        {send.error ? <span className="text-xs text-rose-300">{errorText(send.error)}</span> : null}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={!enabled || !prompt.trim()}
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          <IconSend size={13} /> Send
        </Button>
      </div>
    </div>
  );
}

function RerunModal({
  open,
  onClose,
  cycleId,
  agentSlug,
  model,
  reasoning,
  version,
}: {
  open: boolean;
  onClose: () => void;
  cycleId: string;
  agentSlug: string;
  model: string;
  reasoning: ReasoningEffort;
  version: number;
}) {
  const navigate = useNavigate();
  const versions = useQuery({
    queryKey: keys.versions(agentSlug),
    queryFn: () => api.agents.versions(agentSlug),
    enabled: open,
  });
  const [m, setM] = useState(model);
  const [r, setR] = useState<ReasoningEffort>(reasoning);
  const [v, setV] = useState(version);
  useEffect(() => {
    if (open) {
      setM(model);
      setR(reasoning);
      setV(version);
    }
  }, [open, model, reasoning, version]);
  const rerun = useMutation({
    mutationFn: () => api.cycles.rerun(cycleId, { agentVersion: v, overrides: { model: m, reasoning: r } }),
    onSuccess: (c) => {
      onClose();
      navigate(`/cycles/${c.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Re-run this cycle"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={rerun.isPending} onClick={() => rerun.mutate()}>
            <IconRefresh size={14} /> Re-run
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-cave-400">
        Runs the first prompt again, with the same input files, as a new cycle.
      </p>
      <div className="space-y-4">
        <Field label="Agent version">
          <Select value={v} onChange={(e) => setV(Number(e.target.value))}>
            {(versions.data ?? [{ version, note: null }]).map((x) => (
              <option key={x.version} value={x.version}>
                v{x.version}
                {x.version === version ? " (used before)" : ""}
                {x.note ? ` — ${x.note}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model">
          <ModelPicker value={m} onChange={setM} />
        </Field>
        <Field label="Reasoning">
          <Select value={r} onChange={(e) => setR(e.target.value as ReasoningEffort)}>
            {REASONING_EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorBox error={rerun.error} />
      </div>
    </Modal>
  );
}
