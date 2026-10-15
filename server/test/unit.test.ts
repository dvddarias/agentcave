import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { diffManifests } from "../src/blobs.js";
import { prepareAnswerSchema } from "../src/engine/answer-schema.js";
import { Budget, limitsForContinue, roomLeft } from "../src/engine/budget.js";
import { findCut, ParagraphChunker } from "../src/engine/chunker.js";
import {
  buildContinueMessage,
  buildSystemPrompt,
  buildUserMessage,
  subagentToolName,
} from "../src/engine/prompt.js";
import { maybeTrim } from "../src/engine/trim.js";
import { needsExplicitCaching, openRouterChatSettings } from "../src/openrouter.js";
import { normalizeRelPath } from "../src/paths.js";
import { mergeLimits } from "../src/settings.js";

describe("ParagraphChunker", () => {
  function collect(input: string[], opts = {}) {
    const out: string[] = [];
    const ch = new ParagraphChunker((t) => out.push(t), { idleMs: 60_000, ...opts });
    for (const d of input) ch.push(d);
    ch.flush();
    return out;
  }

  it("emits one paragraph at a time and loses nothing", () => {
    const text = "First paragraph\nstill first.\n\nSecond one.\n\nThird";
    const out = collect(text.split(""));
    expect(out.join("")).toBe(text);
    expect(out).toEqual(["First paragraph\nstill first.\n\n", "Second one.\n\n", "Third"]);
  });

  it("keeps fenced code blocks whole", () => {
    const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    const out = collect([text]);
    expect(out.join("")).toBe(text);
    expect(out).toContain("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n");
  });

  it("splits very long paragraphs", () => {
    const long = `${"word ".repeat(1000)}`;
    const out = collect([long], { maxChars: 500 });
    expect(out.length).toBeGreaterThan(5);
    expect(out.join("")).toBe(long);
    for (const piece of out.slice(0, -1)) expect(piece.length).toBeLessThanOrEqual(500);
  });

  it("flushes after the idle timeout without splitting words", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const ch = new ParagraphChunker((t) => out.push(t), { idleMs: 1000 });
    ch.push("Hello wor");
    vi.advanceTimersByTime(1100);
    expect(out).toEqual(["Hello "]);
    ch.push("ld.");
    ch.flush();
    expect(out.join("")).toBe("Hello world.");
    vi.useRealTimers();
  });

  it("findCut waits for a complete blank line", () => {
    expect(findCut("abc\n", 100)).toBe(-1);
    expect(findCut("abc\n\n", 100)).toBe(5);
    expect(findCut("\n\nabc", 100)).toBe(-1);
  });
});

describe("normalizeRelPath", () => {
  it("normalises safe paths", () => {
    expect(normalizeRelPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath("src\\win\\a.ts")).toBe("src/win/a.ts");
    expect(normalizeRelPath("/workspace/x.txt")).toBe("x.txt");
  });
  it("rejects unsafe paths", () => {
    expect(() => normalizeRelPath("../etc/passwd")).toThrow();
    expect(() => normalizeRelPath("/etc/passwd")).toThrow();
    expect(() => normalizeRelPath("a/../../b")).toThrow();
    expect(() => normalizeRelPath("")).toThrow();
    expect(() => normalizeRelPath("a\0b")).toThrow();
  });
});

describe("answer schema", () => {
  it("defaults to a markdown answer", () => {
    const s = prepareAnswerSchema(null);
    expect(s.validate({ answer: "hi" })).toEqual({ ok: true, answer: { format: "markdown", text: "hi" } });
    expect(s.validate({ answer: 1 }).ok).toBe(false);
  });
  it("validates object schemas", () => {
    const s = prepareAnswerSchema({
      type: "object",
      properties: { bugs: { type: "array", items: { type: "string" } } },
      required: ["bugs"],
    });
    expect(s.validate({ bugs: ["x"] })).toEqual({
      ok: true,
      answer: { format: "json", data: { bugs: ["x"] } },
    });
    const bad = s.validate({ bugs: "x" });
    expect(bad.ok).toBe(false);
  });
  it("wraps non-object schemas", () => {
    const s = prepareAnswerSchema({ type: "array", items: { type: "number" } });
    expect(s.toolSchema.type).toBe("object");
    expect(s.validate({ result: [1, 2] })).toEqual({ ok: true, answer: { format: "json", data: [1, 2] } });
  });
});

describe("limits and budget", () => {
  it("merges layers with null meaning unlimited", () => {
    expect(mergeLimits({ maxTimeSec: 10, maxCostUsd: 1 }, { maxCostUsd: null }, { maxTokens: 5 })).toEqual({
      maxTimeSec: 10,
      maxCostUsd: null,
      maxTokens: 5,
    });
  });
  it("child spending counts against the parent", () => {
    const parent = new Budget({ maxCostUsd: 1 });
    const child = new Budget({ maxCostUsd: 10 }, parent);
    child.add(0.6, 10);
    expect(parent.exceeded()).toBeNull();
    child.add(0.6, 10);
    expect(child.exceeded()?.code).toBe("limit_money");
    expect(parent.costUsd).toBeCloseTo(1.2);
  });
  it("token limit", () => {
    const b = new Budget({ maxTokens: 100 });
    b.add(0, 101);
    expect(b.exceeded()?.code).toBe("limit_tokens");
  });
  it("a continued turn starts from what it already spent", () => {
    const b = new Budget({ maxCostUsd: 1 }, null, { costUsd: 0.9, tokens: 50 });
    b.add(0.2, 10);
    expect(b.exceeded()?.code).toBe("limit_money");
    expect(b.tokens).toBe(60);
  });
});

describe("limits for continuing a turn", () => {
  const limits = { maxTimeSec: 600, maxCostUsd: 1, maxTokens: 100_000 };

  it("gives the exhausted limit 50% of itself as new room by default", () => {
    // Time ran out; money and tokens still had room and stay as they were.
    expect(limitsForContinue(limits, { timeSec: 600, costUsd: 0.4, tokens: 5000 }, {})).toEqual({
      maxTimeSec: 900,
      maxCostUsd: 1,
      maxTokens: 100_000,
    });
  });
  it("adds the room on top of an overshoot", () => {
    // Money is checked after each step, so a turn can go over: the new room is still +25% of $1.
    const out = limitsForContinue(limits, { timeSec: 30, costUsd: 1.2, tokens: 5000 }, { extendPercent: 25 });
    expect(out.maxCostUsd).toBeCloseTo(1.45);
  });
  it("uses explicit limits as given, and still raises other exhausted ones", () => {
    const used = { timeSec: 600, costUsd: 1.05, tokens: 5000 };
    expect(limitsForContinue(limits, used, { limits: { maxTimeSec: 1200, maxTokens: null } })).toEqual({
      maxTimeSec: 1200,
      maxCostUsd: 1.55,
      maxTokens: null,
    });
  });
  it("refuses limits that leave no room", () => {
    const used = { timeSec: 600, costUsd: 0.4, tokens: 5000 };
    expect(() => limitsForContinue(limits, used, { limits: { maxTimeSec: 600 } })).toThrow(/no room/);
  });
  it("describes the room left for the agent", () => {
    const room = roomLeft(
      { maxTimeSec: 900, maxCostUsd: 1.5, maxTokens: null },
      {
        timeSec: 600,
        costUsd: 1,
        tokens: 0,
      },
    );
    expect(room).toEqual(["5m more time", "$0.50 more to spend"]);
    const msg = buildContinueMessage({
      reason: "Time limit reached (600s)",
      room,
      steps: null,
      historyLost: false,
      note: "Just write the report.",
    });
    expect(msg).toContain("you now have 5m more time and $0.50 more to spend");
    expect(msg).toContain("Message from the user:\nJust write the report.");
  });
});

describe("trim", () => {
  const big = "x".repeat(10_000);
  const messages: ModelMessage[] = [{ role: "user", content: "go" }];
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "bash", input: { command: "cat x" } }],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: "bash",
          output: { type: "json", value: { stdout: big } },
        },
      ],
    });
  }

  it("does nothing under the threshold", () => {
    expect(maybeTrim(messages, { contextLength: 1_000_000, ratio: 0.6, systemChars: 0 })).toBeNull();
  });

  it("shortens all but the last 6 tool outputs", () => {
    const r = maybeTrim(messages, { contextLength: 20_000, ratio: 0.6, systemChars: 0 });
    expect(r?.trimmed).toBe(4);
    const after = JSON.stringify(r?.messages).length;
    expect(after).toBeLessThan(JSON.stringify(messages).length);
    // Already-trimmed outputs are not trimmed again.
    const again = maybeTrim(r!.messages, { contextLength: 20_000, ratio: 0.6, systemChars: 0 });
    expect(again).toBeNull();
  });
});

describe("prompts", () => {
  it("builds the environment section", () => {
    const s = buildSystemPrompt({
      agentPrompt: "You are X.",
      internet: { mode: "allowlist", allowlist: ["https://api.github.com/"] },
      javascript: true,
      python: false,
      agentFiles: ["a.md"],
      subagents: [
        {
          slug: "test-writer",
          toolName: subagentToolName("test-writer"),
          name: "Test Writer",
          description: "Writes tests",
        },
      ],
      outputSchema: null,
      isSubagent: false,
    });
    expect(s).toContain("You are X.");
    expect(s).toContain("`/agent/a.md`");
    expect(s).toContain("https://api.github.com/");
    expect(s).toContain("js-exec");
    expect(s).not.toContain("python3");
    expect(s).toContain("`ask_test_writer`");
    expect(s).toContain("submit_answer");
  });
  it("lists files in the user message", () => {
    const m = buildUserMessage("Do it", { "a.txt": { sha256: "x", size: 2048 } });
    expect(m).toContain("/workspace/a.txt (2.0 KB)");
  });
});

describe("diffManifests", () => {
  it("finds added, modified and deleted files", () => {
    expect(
      diffManifests(
        { a: { sha256: "1", size: 1 }, b: { sha256: "2", size: 1 } },
        { a: { sha256: "1", size: 1 }, b: { sha256: "3", size: 1 }, c: { sha256: "4", size: 1 } },
      ),
    ).toEqual({ added: ["c"], modified: ["b"], deleted: [] });
  });
});

describe("OpenRouter chat settings", () => {
  const req = { reasoning: "medium" as const, token: "t", sessionId: "cyc_ROOT" };

  it("sends the run's session_id for every model", () => {
    for (const modelId of ["anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash"]) {
      expect(openRouterChatSettings({ ...req, modelId }).extraBody).toEqual({ session_id: "cyc_ROOT" });
    }
  });

  it("turns on automatic prompt caching for Claude models only", () => {
    expect(openRouterChatSettings({ ...req, modelId: "anthropic/claude-haiku-5.5" }).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(
      openRouterChatSettings({ ...req, modelId: "~anthropic/claude-sonnet-latest" }).cache_control,
    ).toBeDefined();
    expect(
      openRouterChatSettings({ ...req, modelId: "deepseek/deepseek-v4.1-flash" }).cache_control,
    ).toBeUndefined();
    expect(needsExplicitCaching("openai/gpt-5.6")).toBe(false);
  });
});
