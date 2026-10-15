import type { Cycle } from "@agentcave/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api, errorText, keys } from "../../lib/api";
import { LIMIT_ERRORS, raisedLimit } from "../../lib/limits";
import { IconAlert, IconClock, IconCoin, IconPlay } from "../icons";
import { Button, cx, Input, Textarea } from "../ui";

const PERCENTS = [25, 50, 100];

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
        active
          ? "border-torch-500/70 bg-torch-500/15 text-torch-200"
          : "border-cave-700 bg-cave-850 text-cave-200 hover:border-cave-500",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Shown when a limit stopped the latest turn: give it more room and the agent carries on from
 * where it stopped, instead of starting over.
 */
export function ContinuePanel({ cycle }: { cycle: Cycle }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<number | "custom">(50);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);

  const info = LIMIT_ERRORS[cycle.error?.code ?? ""];
  const key = info?.key ?? null;
  const max = key ? (cycle.limits[key] ?? null) : null;
  const used = info?.used ? cycle.limitUsage[info.used] : 0;
  // The custom amount is typed in minutes, dollars or thousands of tokens.
  const unit = key === "maxTimeSec" ? 60 : key === "maxTokens" ? 1000 : 1;
  const room = choice === "custom" ? Number(custom) * unit : max !== null ? (max * choice) / 100 : 0;
  const newMax = key && max !== null && room > 0 ? raisedLimit(key, max, used, room) : null;
  const ready = max === null || newMax !== null;

  const send = useMutation({
    mutationFn: () =>
      api.cycles.continue(cycle.id, {
        ...(choice === "custom" && key && newMax !== null
          ? { limits: { [key]: newMax } }
          : { extendPercent: choice === "custom" ? undefined : choice }),
        message: note.trim() || undefined,
      }),
    onSuccess: (c) =>
      qc.setQueryData(keys.cycle(cycle.id), (old: Cycle | undefined) => ({
        ...c,
        systemPrompt: old?.systemPrompt,
      })),
  });
  if (!info) return null;
  const Icon = key === "maxTimeSec" ? IconClock : key === "maxCostUsd" ? IconCoin : IconAlert;

  return (
    <div className="fade-in mt-6 rounded-2xl border border-torch-700/50 bg-torch-500/5 p-4">
      <div className="flex items-start gap-3">
        <Icon size={16} className="mt-0.5 shrink-0 text-torch-300" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-cave-100">The {info.label} stopped this turn</div>
          <p className="mt-0.5 text-xs text-cave-400">
            {max !== null
              ? `It used ${info.format(used)} of ${info.format(max)}. `
              : `${cycle.error?.message ?? ""}. `}
            Give it more room and the agent carries on from where it stopped, with the same memory and files.
            What it used so far still counts.
          </p>
        </div>
      </div>

      {key && max !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 sm:pl-7">
          {PERCENTS.map((p) => (
            <Choice key={p} active={choice === p} onClick={() => setChoice(p)}>
              +{p}% <span className="font-mono text-cave-400">{info.format((max * p) / 100)}</span>
            </Choice>
          ))}
          <Choice active={choice === "custom"} onClick={() => setChoice("custom")}>
            Custom
          </Choice>
          {choice === "custom" ? (
            <div className="flex items-center gap-1.5 text-xs text-cave-400">
              {key === "maxCostUsd" ? "+ $" : "+"}
              <Input
                type="number"
                min={0}
                step="any"
                autoFocus
                aria-label={`Extra ${info.label}`}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="h-7 w-20 px-2 py-0 text-xs"
              />
              {key === "maxTimeSec" ? "min" : key === "maxTokens" ? "k tokens" : ""}
            </div>
          ) : null}
        </div>
      ) : null}

      {showNote ? (
        <div className="mt-3 sm:pl-7">
          <Textarea
            rows={2}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) send.mutate();
            }}
            placeholder="A note for the agent, e.g. “Skip the extra checks and write the report now.”"
            className="text-xs"
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:pl-7">
        <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setShowNote(!showNote)}>
          {showNote ? "Hide the note" : "Add a note"}
        </Button>
        {newMax !== null ? (
          <span className="text-xs text-cave-400">
            New {info.label}: <span className="font-mono text-cave-100">{info.format(newMax)}</span>
          </span>
        ) : null}
        {send.error ? <span className="text-xs text-rose-300">{errorText(send.error)}</span> : null}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={!ready}
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          <IconPlay size={12} /> Continue
        </Button>
      </div>
    </div>
  );
}
