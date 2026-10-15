import type {
  Answer,
  CycleError,
  CycleEvent,
  CycleStatus,
  FileChanges,
  Limits,
  LimitUsage,
  Usage,
} from "@agentcave/client";

export interface ToolResult {
  output: unknown;
  error: string | null;
  exitCode: number | null;
  truncated: boolean;
  ms: number;
}

export interface SubagentRef {
  childId: string;
  agent: string;
  prompt: string;
  status?: CycleStatus;
  costUsd?: number;
}

export type TimelineItem =
  | { kind: "turn"; key: string; turn: number; attempt: number; prompt: string; files: string[]; ts: string }
  | { kind: "restart"; key: string; attempt: number; reason: string; ts: string }
  | {
      kind: "continue";
      key: string;
      after: CycleError;
      limits: Limits;
      used: LimitUsage;
      message: string;
      ts: string;
    }
  | {
      kind: "reasoning";
      key: string;
      step: number;
      text: string;
      hidden: boolean;
      tokens?: number;
      ts: string;
    }
  | { kind: "text"; key: string; step: number; text: string; ts: string }
  | {
      kind: "tool";
      key: string;
      step: number;
      callId: string;
      tool: string;
      input: unknown;
      result?: ToolResult;
      /** The run ended (limit, stop, restart) before the tool returned. */
      interrupted?: boolean;
      subagent?: SubagentRef;
      ts: string;
    }
  | { kind: "nudge"; key: string; count: number; message: string; ts: string }
  | { kind: "trim"; key: string; trimmed: number; estimatedTokens: number; contextLength: number; ts: string }
  | { kind: "answer"; key: string; answer: Answer; files: FileChanges; ts: string }
  | { kind: "error"; key: string; error: CycleError; ts: string }
  | {
      kind: "turnEnd";
      key: string;
      status: CycleStatus;
      usage: Usage;
      files: FileChanges | null;
      ts: string;
    };

export interface Timeline {
  items: TimelineItem[];
  /** Step number currently running. */
  step: number;
  /** When the latest run started, and the time its turn had used before (a continued turn). */
  run: { ts: string; usedSec: number } | null;
  /** Key of the block still streaming (last text/reasoning when nothing came after it). */
  streamingKey: string | null;
}

export function buildTimeline(events: CycleEvent[]): Timeline {
  const items: TimelineItem[] = [];
  const index = new Map<string, number>();
  let step = 0;
  let run: Timeline["run"] = null;
  // Tool calls still waiting for their result.
  const pending = new Set<string>();

  const put = (item: TimelineItem) => {
    index.set(item.key, items.length);
    items.push(item);
  };
  const interruptPending = () => {
    for (const key of pending) {
      const at = index.get(key);
      if (at !== undefined)
        items[at] = { ...(items[at] as Extract<TimelineItem, { kind: "tool" }>), interrupted: true };
    }
    pending.clear();
  };

  for (const e of events) {
    const scope = `${e.turn}:${e.attempt}`;
    switch (e.type) {
      case "turn.start":
        step = 0;
        run = { ts: e.ts, usedSec: 0 };
        put({
          kind: "turn",
          key: `turn:${scope}`,
          turn: e.turn,
          attempt: e.attempt,
          prompt: e.data.prompt,
          files: e.data.files,
          ts: e.ts,
        });
        break;
      case "turn.continue":
        run = { ts: e.ts, usedSec: e.data.used.timeSec };
        put({
          kind: "continue",
          key: `continue:${scope}:${e.seq}`,
          after: e.data.after,
          limits: e.data.limits,
          used: e.data.used,
          message: e.data.message,
          ts: e.ts,
        });
        break;
      case "restart":
        interruptPending();
        put({
          kind: "restart",
          key: `restart:${scope}:${e.seq}`,
          attempt: e.data.attempt,
          reason: e.data.reason,
          ts: e.ts,
        });
        break;
      case "step.start":
        step = e.data.step;
        break;
      case "reasoning": {
        const key = `r:${scope}:${e.data.blockId}`;
        const at = index.get(key);
        if (at !== undefined) {
          const it = items[at] as Extract<TimelineItem, { kind: "reasoning" }>;
          items[at] = { ...it, text: it.text + e.data.text };
        } else {
          put({
            kind: "reasoning",
            key,
            step: e.data.step,
            text: e.data.text,
            hidden: !!e.data.hidden,
            tokens: e.data.tokens,
            ts: e.ts,
          });
        }
        break;
      }
      case "text": {
        const key = `t:${scope}:${e.data.blockId}`;
        const at = index.get(key);
        if (at !== undefined) {
          const it = items[at] as Extract<TimelineItem, { kind: "text" }>;
          items[at] = { ...it, text: it.text + e.data.text };
        } else {
          put({ kind: "text", key, step: e.data.step, text: e.data.text, ts: e.ts });
        }
        break;
      }
      case "tool.call":
        pending.add(`tool:${scope}:${e.data.callId}`);
        put({
          kind: "tool",
          key: `tool:${scope}:${e.data.callId}`,
          step: e.data.step,
          callId: e.data.callId,
          tool: e.data.tool,
          input: e.data.input,
          ts: e.ts,
        });
        break;
      case "tool.result": {
        pending.delete(`tool:${scope}:${e.data.callId}`);
        const at = index.get(`tool:${scope}:${e.data.callId}`);
        const result: ToolResult = {
          output: e.data.output,
          error: e.data.error,
          exitCode: e.data.exitCode,
          truncated: e.data.truncated,
          ms: e.data.ms,
        };
        if (at !== undefined)
          items[at] = { ...(items[at] as Extract<TimelineItem, { kind: "tool" }>), result };
        break;
      }
      case "subagent.start": {
        const at = index.get(`tool:${scope}:${e.data.callId}`);
        if (at !== undefined) {
          items[at] = {
            ...(items[at] as Extract<TimelineItem, { kind: "tool" }>),
            subagent: { childId: e.data.childId, agent: e.data.agent, prompt: e.data.prompt },
          };
        }
        break;
      }
      case "subagent.end": {
        const at = index.get(`tool:${scope}:${e.data.callId}`);
        if (at !== undefined) {
          const it = items[at] as Extract<TimelineItem, { kind: "tool" }>;
          items[at] = {
            ...it,
            subagent: {
              ...(it.subagent ?? { childId: e.data.childId, agent: e.data.agent, prompt: "" }),
              status: e.data.status,
              costUsd: e.data.costUsd,
            },
          };
        }
        break;
      }
      case "nudge":
        put({
          kind: "nudge",
          key: `nudge:${scope}:${e.seq}`,
          count: e.data.count,
          message: e.data.message,
          ts: e.ts,
        });
        break;
      case "trim":
        put({
          kind: "trim",
          key: `trim:${scope}:${e.seq}`,
          trimmed: e.data.trimmedOutputs,
          estimatedTokens: e.data.estimatedTokens,
          contextLength: e.data.contextLength,
          ts: e.ts,
        });
        break;
      case "answer":
        put({ kind: "answer", key: `answer:${scope}`, answer: e.data.answer, files: e.data.files, ts: e.ts });
        break;
      case "error":
        put({ kind: "error", key: `error:${scope}:${e.seq}`, error: e.data, ts: e.ts });
        break;
      case "turn.end":
        interruptPending();
        // A continued turn ends more than once.
        put({
          kind: "turnEnd",
          key: `end:${scope}:${e.seq}`,
          status: e.data.status,
          usage: e.data.usage,
          files: e.data.files,
          ts: e.ts,
        });
        break;
      default:
        break;
    }
  }

  const last = items[items.length - 1];
  const streamingKey = last && (last.kind === "text" || last.kind === "reasoning") ? last.key : null;
  return { items, step, run, streamingKey };
}
