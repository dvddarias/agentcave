import { useState } from "react";
import { formatBytes } from "../../lib/format";
import type { HttpCall } from "../../lib/timeline";
import { IconPlug } from "../icons";
import { CodeBlock } from "../Markdown";
import { cx, Pill } from "../ui";

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The status code, or why there is none (`timeout`, `connection refused`…). */
export function callOutcome(c: HttpCall): string {
  if (c.status !== null) return String(c.status);
  return c.error?.startsWith("timed out") ? "timeout" : (c.error ?? "failed");
}

export function HttpCallChip({
  call,
  selected,
  onClick,
}: {
  call: HttpCall;
  selected: boolean;
  onClick: () => void;
}) {
  const failed = !!call.error;
  return (
    <button
      type="button"
      onClick={onClick}
      title={call.error ?? `HTTP ${call.status}`}
      className={cx(
        "flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px] hover:border-cave-500",
        failed ? "border-rose-900/70 text-rose-300" : "border-cave-700 text-cave-200",
        selected && "bg-cave-800",
      )}
    >
      <IconPlug size={11} className={failed ? "text-rose-400" : "text-torch-400"} />
      {call.command}
      <span className={failed ? "text-rose-300" : "text-emerald-300"}>{callOutcome(call)}</span>
      <span className="text-cave-500">{formatMs(call.ms)}</span>
    </button>
  );
}

/** What the command sent and the start of what came back. Headers are never part of it. */
export function HttpCallDetail({ call }: { call: HttpCall }) {
  let preview = call.preview;
  let lang = "plaintext";
  if (preview && call.bytes <= preview.length) {
    try {
      preview = JSON.stringify(JSON.parse(preview), null, 2);
      lang = "json";
    } catch {
      // not JSON: show as is
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-cave-400">
        <span className="font-mono text-cave-200">{call.command}</span>
        <span>{call.status !== null ? `HTTP ${call.status}` : call.error}</span>
        <span>{formatMs(call.ms)}</span>
        <span>{formatBytes(call.bytes)}</span>
        {call.error && call.status !== null ? <span className="text-rose-300">{call.error}</span> : null}
      </div>
      <div>
        <div className="mb-1 text-[10px] tracking-wider text-cave-500 uppercase">Input</div>
        <CodeBlock code={JSON.stringify(call.input, null, 2)} lang="json" maxHeight={200} />
      </div>
      <div>
        <div className="mb-1 text-[10px] tracking-wider text-cave-500 uppercase">
          Response{call.bytes > call.preview.length ? ` (first ${formatBytes(call.preview.length)})` : ""}
        </div>
        {call.preview ? (
          <CodeBlock code={preview} lang={lang} maxHeight={260} />
        ) : (
          <div className="text-xs text-cave-500">(empty)</div>
        )}
      </div>
    </div>
  );
}

/** The calls one bash command line made: a chip each, click for the input and the response. */
export function HttpCallChips({ calls }: { calls: HttpCall[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const selected = calls.find((c) => c.callId === open);
  return (
    <div className="border-t border-cave-750/70 px-3 py-1.5">
      <div className="flex flex-wrap gap-1">
        {calls.slice(0, 60).map((c) => (
          <HttpCallChip
            key={c.callId}
            call={c}
            selected={c.callId === open}
            onClick={() => setOpen(c.callId === open ? null : c.callId)}
          />
        ))}
        {calls.length > 60 ? <Pill>+{calls.length - 60} more (see Details)</Pill> : null}
      </div>
      {selected ? (
        <div className="mt-2 mb-1">
          <HttpCallDetail call={selected} />
        </div>
      ) : null}
    </div>
  );
}
