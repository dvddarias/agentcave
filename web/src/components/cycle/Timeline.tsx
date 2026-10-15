import type { CycleStatus, FileChanges } from "@agentcave/client";
import { useState } from "react";
import { Link } from "react-router";
import { formatCost, formatDuration, formatTokens } from "../../lib/format";
import { LIMIT_ERRORS } from "../../lib/limits";
import type { TimelineItem, ToolResult } from "../../lib/timeline";
import {
  IconAlert,
  IconBell,
  IconBrain,
  IconBranch,
  IconCheck,
  IconChevron,
  IconFile,
  IconHistory,
  IconMessage,
  IconPlay,
  IconScissors,
  IconTerminal,
} from "../icons";
import { CodeBlock, Markdown } from "../Markdown";
import { cx, Pill, Spinner, StatusBadge } from "../ui";

export function SystemPromptCard({
  text,
  model,
  reasoning,
}: {
  text: string;
  model: string;
  reasoning: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-cave-750 bg-cave-900/70">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-cave-400 hover:text-cave-200"
      >
        <IconChevron size={14} className={cx("transition-transform", open && "rotate-90")} />
        <span className="font-medium tracking-wide text-cave-300 uppercase">System prompt</span>
        <span className="truncate text-cave-500">
          {text.length.toLocaleString()} chars · {model} · reasoning {reasoning}
        </span>
      </button>
      {open ? (
        <div className="max-h-[60vh] overflow-y-auto border-t border-cave-750 px-5 py-4">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
}

function TurnCard({ item }: { item: Extract<TimelineItem, { kind: "turn" }> }) {
  const [showAll, setShowAll] = useState(false);
  const long = item.prompt.length > 1200;
  return (
    <div className="fade-in">
      {item.turn > 0 ? (
        <div className="my-6 flex items-center gap-3 text-[11px] tracking-wider text-cave-500 uppercase">
          <div className="h-px flex-1 bg-cave-750" />
          Follow-up · turn {item.turn + 1}
          <div className="h-px flex-1 bg-cave-750" />
        </div>
      ) : null}
      <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-md border border-cave-700 bg-cave-800 px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-cave-400 uppercase">
          <IconMessage size={12} /> Prompt
        </div>
        <div
          className={cx(
            !showAll &&
              long &&
              "max-h-64 overflow-hidden [mask-image:linear-gradient(black_70%,transparent)]",
          )}
        >
          <Markdown text={item.prompt} />
        </div>
        {long ? (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="mt-1 text-xs text-torch-400 hover:underline"
          >
            {showAll ? "Show less" : "Show the whole prompt"}
          </button>
        ) : null}
        {item.files.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {item.files.slice(0, 30).map((f) => (
              <Pill key={f} className="font-mono">
                <IconFile size={11} /> {f}
              </Pill>
            ))}
            {item.files.length > 30 ? <Pill>+{item.files.length - 30} more</Pill> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThinkingBlock({
  item,
  streaming,
}: {
  item: Extract<TimelineItem, { kind: "reasoning" }>;
  streaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (item.hidden) {
    return (
      <div className="flex items-center gap-2 pl-1 text-xs text-violet-300/70">
        <IconBrain size={14} />
        Thinking (hidden by the provider) · {formatTokens(item.tokens ?? 0)} tokens
      </div>
    );
  }
  return (
    <div className="fade-in rounded-xl border-l-2 border-violet-500/50 bg-violet-950/10 py-2 pr-3 pl-4">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-violet-300/80 uppercase"
      >
        <IconBrain size={13} className={cx(streaming && "animate-pulse")} />
        Thinking
        <span className="font-normal tracking-normal text-violet-300/50 normal-case">step {item.step}</span>
        <IconChevron size={12} className={cx("transition-transform", !collapsed && "rotate-90")} />
      </button>
      {collapsed ? (
        <div className="truncate text-xs text-cave-500 italic">{item.text.slice(0, 160)}</div>
      ) : (
        <Markdown text={item.text + (streaming ? " ▍" : "")} className="thinking" />
      )}
    </div>
  );
}

function TextBlock({
  item,
  streaming,
}: {
  item: Extract<TimelineItem, { kind: "text" }>;
  streaming: boolean;
}) {
  if (!item.text.trim()) return null;
  return (
    <div className="fade-in px-1">
      <Markdown text={item.text + (streaming ? " ▍" : "")} />
    </div>
  );
}

function toolSummary(tool: string, input: unknown): { icon: React.ReactNode; title: string; mono: boolean } {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "bash")
    return { icon: <IconTerminal size={14} />, title: String(i.command ?? ""), mono: true };
  if (tool === "readFile")
    return { icon: <IconFile size={14} />, title: `read ${String(i.path ?? "")}`, mono: true };
  if (tool === "writeFile") {
    const size = typeof i.content === "string" ? ` (${i.content.length} chars)` : "";
    return { icon: <IconFile size={14} />, title: `write ${String(i.path ?? "")}${size}`, mono: true };
  }
  return { icon: <IconTerminal size={14} />, title: tool, mono: true };
}

function BashOutput({ result }: { result: ToolResult }) {
  const out = (result.output ?? {}) as { stdout?: string; stderr?: string; fullOutputPath?: string };
  return (
    <div className="space-y-2">
      {out.stdout ? (
        <CodeBlock code={out.stdout.replace(/\n$/, "")} lang="plaintext" maxHeight={420} />
      ) : null}
      {out.stderr ? (
        <div>
          <div className="mb-1 text-[10px] tracking-wider text-rose-300/70 uppercase">stderr</div>
          <pre className="max-h-60 overflow-auto rounded-lg border border-rose-950 bg-rose-950/20 p-3 font-mono text-[0.75rem] text-rose-200">
            {out.stderr}
          </pre>
        </div>
      ) : null}
      {!out.stdout && !out.stderr && !result.error ? (
        <div className="text-xs text-cave-500">(no output)</div>
      ) : null}
      {out.fullOutputPath ? (
        <div className="text-[11px] text-cave-400">
          Output was shortened for the model; the full text is in{" "}
          <code className="font-mono">{out.fullOutputPath}</code> inside the sandbox.
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const r = item.result;
  if (item.tool === "submit_answer") {
    if (r && !r.error) {
      return (
        <div className="flex items-center gap-2 pl-1 text-xs text-emerald-300/80">
          <IconCheck size={14} /> Called <code className="font-mono">submit_answer</code>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-rose-900/60 bg-rose-950/20 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 text-left text-xs text-rose-300"
        >
          <IconAlert size={14} />
          {r?.error ? "Answer rejected: " : "Submitting answer…"}
          <span className="truncate text-rose-200/80">{r?.error}</span>
          <IconChevron
            size={12}
            className={cx("ml-auto shrink-0 transition-transform", open && "rotate-90")}
          />
        </button>
        {open ? <CodeBlock code={JSON.stringify(item.input, null, 2)} lang="json" className="mt-2" /> : null}
      </div>
    );
  }
  if (item.tool.startsWith("ask_")) return <SubagentCard item={item} />;

  const s = toolSummary(item.tool, item.input);
  const exit = r?.exitCode;
  const failed = !!r?.error || (exit !== null && exit !== undefined && exit !== 0);
  return (
    <div
      className={cx(
        "fade-in overflow-hidden rounded-xl border bg-cave-900/80",
        failed ? "border-rose-900/60" : "border-cave-750",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-cave-850"
      >
        <span className={cx("shrink-0", failed ? "text-rose-400" : "text-torch-400")}>{s.icon}</span>
        <span className={cx("min-w-0 flex-1 truncate text-[0.8rem] text-cave-100", s.mono && "font-mono")}>
          {item.tool === "bash" ? <span className="mr-1.5 text-cave-500">$</span> : null}
          {s.title.split("\n")[0]}
          {s.title.includes("\n") ? <span className="text-cave-500"> …</span> : null}
        </span>
        {!r && item.interrupted ? (
          <Pill className="border-torch-700/50 text-torch-300">interrupted</Pill>
        ) : !r ? (
          <Spinner size={13} className="shrink-0 text-sky-400" />
        ) : (
          <>
            {r.truncated ? <Pill className="border-torch-700/50 text-torch-300">shortened</Pill> : null}
            {exit !== null && exit !== undefined ? (
              <span
                className={cx(
                  "rounded px-1.5 py-0.5 font-mono text-[10px]",
                  exit === 0 ? "bg-emerald-950/60 text-emerald-300" : "bg-rose-950/60 text-rose-300",
                )}
              >
                exit {exit}
              </span>
            ) : r.error ? (
              <span className="rounded bg-rose-950/60 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                error
              </span>
            ) : (
              <IconCheck size={13} className="text-emerald-400" />
            )}
            <span className="w-12 text-right font-mono text-[10px] text-cave-500">
              {formatDuration(r.ms).replace(/^0s$/, "<1s")}
            </span>
          </>
        )}
        <IconChevron
          size={13}
          className={cx("shrink-0 text-cave-500 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-cave-750 bg-cave-925 p-3">
          {item.tool === "bash" && s.title.includes("\n") ? <CodeBlock code={s.title} lang="bash" /> : null}
          {item.tool === "writeFile" ? (
            <CodeBlock code={String((item.input as { content?: string })?.content ?? "")} maxHeight={360} />
          ) : null}
          {item.tool !== "bash" && item.tool !== "writeFile" && item.tool !== "readFile" ? (
            <CodeBlock code={JSON.stringify(item.input, null, 2)} lang="json" />
          ) : null}
          {r?.error ? (
            <pre className="overflow-auto rounded-lg border border-rose-950 bg-rose-950/20 p-3 font-mono text-[0.75rem] whitespace-pre-wrap text-rose-200">
              {r.error}
            </pre>
          ) : null}
          {r && item.tool === "bash" ? <BashOutput result={r} /> : null}
          {r && item.tool === "readFile" ? (
            <CodeBlock code={String((r.output as { content?: string })?.content ?? "")} maxHeight={420} />
          ) : null}
          {r && !r.error && item.tool !== "bash" && item.tool !== "readFile" ? (
            <CodeBlock code={JSON.stringify(r.output, null, 2)} lang="json" maxHeight={300} />
          ) : null}
          {!r ? (
            <div className="flex items-center gap-2 text-xs text-cave-400">
              {item.interrupted ? (
                "The run ended before this returned."
              ) : (
                <>
                  <Spinner size={12} /> running…
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SubagentCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const sub = item.subagent;
  const prompt = String((item.input as { prompt?: string })?.prompt ?? "");
  const out = item.result?.output as
    | { answer?: unknown; filesCopiedTo?: string | null; status?: string }
    | undefined;
  const status = (sub?.status ?? (item.result ? "completed" : "running")) as CycleStatus;
  return (
    <div className="fade-in rounded-xl border border-teal-800/50 bg-teal-950/10">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <IconBranch size={15} className="shrink-0 text-teal-400" />
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="text-sm text-cave-100">
            Sub-agent <span className="font-medium text-teal-300">{sub?.agent ?? item.tool.slice(4)}</span>
          </div>
          <div className="truncate text-xs text-cave-400">{prompt}</div>
        </button>
        <StatusBadge status={status} />
        {sub?.costUsd !== undefined ? (
          <span className="font-mono text-[11px] text-cave-400">{formatCost(sub.costUsd)}</span>
        ) : null}
        {sub?.childId ? (
          <Link to={`/cycles/${sub.childId}`} className="text-xs text-torch-400 hover:underline">
            open
          </Link>
        ) : null}
        <button type="button" onClick={() => setOpen(!open)}>
          <IconChevron size={13} className={cx("text-cave-500 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-teal-900/40 p-3">
          <div>
            <div className="mb-1 text-[10px] tracking-wider text-cave-500 uppercase">Task</div>
            <Markdown text={prompt} />
          </div>
          {out ? (
            <div>
              <div className="mb-1 text-[10px] tracking-wider text-cave-500 uppercase">Answer</div>
              {typeof out.answer === "string" ? (
                <Markdown text={out.answer} />
              ) : (
                <CodeBlock code={JSON.stringify(out.answer ?? out, null, 2)} lang="json" />
              )}
              {out.filesCopiedTo ? (
                <div className="mt-2 text-xs text-cave-400">
                  Files copied to <code className="font-mono text-cave-200">{out.filesCopiedTo}</code>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ContinueCard({ item }: { item: Extract<TimelineItem, { kind: "continue" }> }) {
  const [open, setOpen] = useState(false);
  const info = LIMIT_ERRORS[item.after.code];
  const max = info?.key ? item.limits[info.key] : null;
  return (
    <div className="fade-in py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 text-xs text-torch-300/90 hover:text-torch-200"
      >
        <div className="h-px flex-1 bg-torch-700/40" />
        <IconPlay size={12} />
        <span>
          Continued after the {info?.label ?? item.after.code.replace(/_/g, " ")}
          {info && max != null ? ` · now ${info.format(max)}` : ""}
        </span>
        <IconChevron size={12} className={cx("transition-transform", open && "rotate-90")} />
        <div className="h-px flex-1 bg-torch-700/40" />
      </button>
      {open ? (
        <div className="mt-2 rounded-xl border border-torch-700/40 bg-torch-500/5 px-4 py-3">
          <div className="mb-1.5 text-[11px] font-medium tracking-wide text-torch-300/80 uppercase">
            Sent to the agent
          </div>
          <Markdown text={item.message} />
        </div>
      ) : null}
    </div>
  );
}

function FileChips({ files, onOpen }: { files: FileChanges; onOpen?: (path: string) => void }) {
  const all = [
    ...files.added.map((p) => ({ p, s: "added" as const })),
    ...files.modified.map((p) => ({ p, s: "modified" as const })),
    ...files.deleted.map((p) => ({ p, s: "deleted" as const })),
  ];
  if (all.length === 0) return null;
  const color = {
    added: "text-emerald-300",
    modified: "text-torch-300",
    deleted: "text-rose-300 line-through",
  };
  const sign = { added: "+", modified: "~", deleted: "−" };
  return (
    <div className="mt-3 flex flex-wrap gap-1 border-t border-cave-750 pt-3">
      {all.slice(0, 40).map(({ p, s }) => (
        <button
          key={p}
          type="button"
          disabled={s === "deleted" || !onOpen}
          onClick={() => onOpen?.(p)}
          className={cx(
            "rounded-md border border-cave-700 bg-cave-850 px-1.5 py-0.5 font-mono text-[11px] hover:border-cave-500",
            color[s],
          )}
        >
          {sign[s]} {p}
        </button>
      ))}
      {all.length > 40 ? <Pill>+{all.length - 40} more</Pill> : null}
    </div>
  );
}

export function Timeline({
  items,
  streamingKey,
  running,
  onOpenFile,
}: {
  items: TimelineItem[];
  streamingKey: string | null;
  running: boolean;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="space-y-3">
      {items.map((item) => {
        switch (item.kind) {
          case "turn":
            return <TurnCard key={item.key} item={item} />;
          case "restart":
            return (
              <div key={item.key} className="flex items-center gap-3 py-2 text-xs text-torch-300/80">
                <div className="h-px flex-1 bg-torch-700/40" />
                <IconHistory size={13} /> {item.reason} · attempt {item.attempt + 1}
                <div className="h-px flex-1 bg-torch-700/40" />
              </div>
            );
          case "continue":
            return <ContinueCard key={item.key} item={item} />;
          case "reasoning":
            return (
              <ThinkingBlock key={item.key} item={item} streaming={running && item.key === streamingKey} />
            );
          case "text":
            return <TextBlock key={item.key} item={item} streaming={running && item.key === streamingKey} />;
          case "tool":
            return <ToolCard key={item.key} item={item} />;
          case "nudge":
            return (
              <div
                key={item.key}
                title={item.message}
                className="flex items-center gap-2 rounded-lg border border-torch-700/40 bg-torch-500/5 px-3 py-2 text-xs text-torch-200"
              >
                <IconBell size={14} />
                The agent stopped without calling <code className="font-mono">submit_answer</code>. AgentCave
                reminded it (#
                {item.count}).
              </div>
            );
          case "trim":
            return (
              <div key={item.key} className="flex items-center gap-2 pl-1 text-[11px] text-cave-500">
                <IconScissors size={13} />
                Shortened {item.trimmed} old tool output{item.trimmed === 1 ? "" : "s"} to save context (~
                {formatTokens(item.estimatedTokens)} of {formatTokens(item.contextLength)} tokens)
              </div>
            );
          case "answer":
            return (
              <div
                key={item.key}
                className="fade-in rounded-2xl border border-emerald-800/50 bg-gradient-to-b from-emerald-950/30 to-cave-900/60 px-5 py-4 shadow-[0_0_40px_-20px_rgba(16,185,129,.5)]"
              >
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-emerald-300 uppercase">
                  <IconCheck size={14} /> Final answer
                </div>
                {item.answer.format === "markdown" ? (
                  <Markdown text={item.answer.text} />
                ) : (
                  <CodeBlock code={JSON.stringify(item.answer.data, null, 2)} lang="json" />
                )}
                <FileChips files={item.files} onOpen={onOpenFile} />
              </div>
            );
          case "error":
            return (
              <div key={item.key} className="rounded-xl border border-rose-900/60 bg-rose-950/25 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-rose-300">
                  <IconAlert size={15} /> {item.error.code.replace(/_/g, " ")}
                </div>
                <div className="mt-1 text-sm break-words text-rose-200/90">{item.error.message}</div>
              </div>
            );
          case "turnEnd":
            return (
              <div
                key={item.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 text-[11px] text-cave-500"
              >
                <StatusBadge status={item.status} className="scale-90" />
                <span>{item.usage.steps} steps</span>
                <span>{formatTokens(item.usage.inputTokens + item.usage.outputTokens)} tokens</span>
                <span>{formatCost(item.usage.costUsd, item.usage.costEstimated)}</span>
                {item.files &&
                item.files.added.length + item.files.modified.length + item.files.deleted.length > 0 ? (
                  <span>
                    files +{item.files.added.length} ~{item.files.modified.length} −
                    {item.files.deleted.length}
                  </span>
                ) : null}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
