import type { ModelMessage } from "ai";

const MARK = "[output shortened by AgentCave to save context]";

export function estimateTokens(messages: ModelMessage[], extraChars = 0): number {
  return Math.ceil((JSON.stringify(messages).length + extraChars) / 4);
}

function preview(output: unknown, chars = 500): string {
  let text: string;
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value;
    text = typeof value === "string" ? value : JSON.stringify(value);
  } else {
    text = typeof output === "string" ? output : JSON.stringify(output);
  }
  text = text ?? "";
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

function isTrimmed(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { type?: string }).type === "text" &&
    String((output as { value?: unknown }).value ?? "").endsWith(MARK)
  );
}

export interface TrimResult {
  messages: ModelMessage[];
  trimmed: number;
  estimatedTokens: number;
}

/**
 * When the prompt gets above `ratio` of the context window, replaces all but the last
 * `keepLast` tool outputs with a short preview. Returns null when nothing needs to change.
 */
export function maybeTrim(
  messages: ModelMessage[],
  opts: { contextLength: number; ratio: number; systemChars: number; keepLast?: number },
): TrimResult | null {
  const keepLast = opts.keepLast ?? 6;
  const estimatedTokens = estimateTokens(messages, opts.systemChars);
  if (estimatedTokens < opts.contextLength * opts.ratio) return null;

  const positions: [number, number][] = [];
  messages.forEach((m, mi) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return;
    m.content.forEach((part, pi) => {
      if (part.type === "tool-result" && !isTrimmed(part.output)) positions.push([mi, pi]);
    });
  });
  const toTrim = positions.slice(0, Math.max(0, positions.length - keepLast));
  if (toTrim.length === 0) return null;

  const next = messages.slice();
  for (const [mi, pi] of toTrim) {
    const msg = next[mi];
    if (msg.role !== "tool") continue;
    const content = msg.content.slice();
    const part = content[pi];
    if (part.type !== "tool-result") continue;
    content[pi] = { ...part, output: { type: "text", value: `${preview(part.output)}\n${MARK}` } };
    next[mi] = { ...msg, content };
  }
  return { messages: next, trimmed: toTrim.length, estimatedTokens };
}
