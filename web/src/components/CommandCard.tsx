import type { JsonSchema } from "@agentcave/client";
import { useMemo, useState } from "react";
import { commandParams, commandUsage, showValue } from "../lib/commands";
import { IconChevron, IconCode, IconPlug } from "./icons";
import { CodeBlock } from "./Markdown";
import { cx, Pill } from "./ui";

/** What the card needs: a `CycleCommand` from the API, or an `HttpCommand` typed in the Playground. */
export interface CommandLike {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  url: string;
  headers?: Record<string, string>;
  timeoutSec?: number;
}

const MASK = "••••";

/**
 * An HTTP command, shown the way the agent will use it: name, description, usage line and a table of
 * its flags. The endpoint, timeout, headers (always masked) and the raw JSON are one click away.
 */
export function CommandCard({
  command,
  defaultOpen = false,
}: {
  command: CommandLike;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [raw, setRaw] = useState(false);
  const params = useMemo(() => commandParams(command.inputSchema), [command.inputSchema]);
  const usage = useMemo(() => commandUsage(command.name, command.inputSchema), [command]);
  const headerNames = Object.keys(command.headers ?? {});
  const timeoutSec = command.timeoutSec ?? 20;
  const masked = { ...command, headers: Object.fromEntries(headerNames.map((k) => [k, MASK])), timeoutSec };

  return (
    <div className="overflow-hidden rounded-xl border border-cave-750 bg-cave-900/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-cave-850/60"
      >
        <IconPlug size={15} className="mt-0.5 shrink-0 text-torch-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[13px] font-medium text-cave-100">{command.name}</span>
            <span className="text-[11px] text-cave-500">
              {params.length} flag{params.length === 1 ? "" : "s"} · {timeoutSec}s timeout
            </span>
          </div>
          <div className={cx("mt-0.5 text-xs leading-relaxed text-cave-300", !open && "line-clamp-2")}>
            {command.description}
          </div>
        </div>
        <IconChevron
          size={13}
          className={cx("mt-1 shrink-0 text-cave-500 transition-transform", open && "rotate-90")}
        />
      </button>

      <div className="px-3 pb-2.5">
        <div className="rounded-md border border-cave-800 bg-cave-950 px-2.5 py-1.5 font-mono text-[11.5px] break-words text-cave-200">
          <span className="mr-1.5 text-cave-500">$</span>
          {usage}
        </div>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-cave-750 bg-cave-925/60 px-3 py-3">
          <section>
            <div className="mb-1.5 text-[10px] tracking-wider text-cave-500 uppercase">Flags</div>
            {params.length === 0 ? (
              <div className="text-xs text-cave-500">No flags: the command takes no input.</div>
            ) : (
              <ul className="divide-y divide-cave-800 rounded-lg border border-cave-800">
                {params.map((p) => (
                  <li key={p.name} className="space-y-1 px-2.5 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-cave-100">--{p.name}</span>
                      <Pill className="font-mono text-sky-300">{p.type}</Pill>
                      {p.required ? (
                        <Pill className="border-torch-700/50 text-torch-300">required</Pill>
                      ) : (
                        <Pill className="text-cave-400">optional</Pill>
                      )}
                      {p.kind === "array" ? (
                        <span className="text-[11px] text-cave-500">repeat the flag</span>
                      ) : null}
                      {p.kind === "boolean" ? (
                        <span className="font-mono text-[11px] text-cave-500">--no-{p.name} for false</span>
                      ) : null}
                      {p.kind === "complex" ? (
                        <span className="text-[11px] text-cave-500">only through --json</span>
                      ) : null}
                    </div>
                    {p.description ? <div className="text-cave-300">{p.description}</div> : null}
                    {p.values || p.hasDefault || p.examples.length ? (
                      <div className="flex flex-wrap items-center gap-1 text-[11px] text-cave-400">
                        {p.values ? (
                          <>
                            <span>one of</span>
                            {p.values.map((v) => (
                              <code
                                key={showValue(v)}
                                className="rounded bg-cave-800 px-1 font-mono text-[10.5px] text-cave-200"
                              >
                                {showValue(v)}
                              </code>
                            ))}
                          </>
                        ) : null}
                        {p.hasDefault ? (
                          <span>
                            default{" "}
                            <code className="rounded bg-cave-800 px-1 font-mono text-[10.5px] text-cave-200">
                              {JSON.stringify(p.default)}
                            </code>
                          </span>
                        ) : null}
                        {p.examples.length ? (
                          <span>
                            e.g.{" "}
                            <code className="rounded bg-cave-800 px-1 font-mono text-[10.5px] text-cave-200">
                              {showValue(p.examples[0])}
                            </code>
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 text-[11px] text-cave-500">
              Or the whole input as JSON:{" "}
              <code className="font-mono text-cave-400">{command.name} --json '&lt;object&gt;'</code> (
              <code className="font-mono text-cave-400">--json -</code> reads stdin).
            </div>
          </section>

          <section className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1.5 text-xs">
            <div className="text-cave-500">Endpoint</div>
            <div className="min-w-0 font-mono text-[11px] break-all text-cave-300">
              <span className="text-emerald-300">POST</span> {command.url}
            </div>
            <div className="text-cave-500">Headers</div>
            <div className="flex min-w-0 flex-wrap gap-1" title="Header values are secret and never shown">
              {headerNames.length ? (
                headerNames.map((k) => (
                  <Pill key={k} className="font-mono">
                    {k}: {MASK}
                  </Pill>
                ))
              ) : (
                <span className="text-cave-500">none</span>
              )}
            </div>
            <div className="text-cave-500">Timeout</div>
            <div className="text-cave-300">{timeoutSec} s per call</div>
          </section>

          <div>
            <button
              type="button"
              onClick={() => setRaw(!raw)}
              className="flex items-center gap-1.5 text-[11px] text-cave-400 hover:text-cave-200"
            >
              <IconCode size={12} /> {raw ? "Hide" : "Show"} raw JSON
            </button>
            {raw ? (
              <CodeBlock
                code={JSON.stringify(masked, null, 2)}
                lang="json"
                className="mt-1.5"
                maxHeight={320}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
