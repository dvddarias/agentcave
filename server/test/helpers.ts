import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInput, Cycle, CycleEvent } from "@agentcave/client";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { type AgentCave, type AgentCaveOptions, createAgentCave } from "../src/app.js";
import type { ModelRequest } from "../src/openrouter.js";

export type Part = LanguageModelV4StreamPart;

/** A scripted model: `(callIndex, options) => stream parts` per model id. */
export type Script = (
  call: number,
  options: LanguageModelV4CallOptions,
  req: ModelRequest,
) => Part[] | Promise<Part[]>;

let callSeq = 0;

export const p = {
  text: (s: string, id = "t"): Part[] => [
    { type: "text-start", id },
    { type: "text-delta", id, delta: s },
    { type: "text-end", id },
  ],
  reasoning: (s: string, id = "r"): Part[] => [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta: s },
    { type: "reasoning-end", id },
  ],
  call: (toolName: string, input: unknown, toolCallId = `call_${++callSeq}`): Part[] => [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  ],
  finish: (
    reason: "tool-calls" | "stop" = "tool-calls",
    opts: { cost?: number | null; input?: number; output?: number; reasoning?: number } = {},
  ): Part[] => [
    {
      type: "finish",
      usage: {
        inputTokens: { total: opts.input ?? 100, noCache: opts.input ?? 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: {
          total: opts.output ?? 20,
          text: (opts.output ?? 20) - (opts.reasoning ?? 0),
          reasoning: opts.reasoning ?? 0,
        },
      },
      finishReason: { unified: reason, raw: reason },
      providerMetadata:
        opts.cost === null ? undefined : { openrouter: { usage: { cost: opts.cost ?? 0.001 } } },
    },
  ],
};

/** One model call: tool calls end with `tool-calls`, plain text with `stop`. */
export function step(...parts: Part[][]): Part[] {
  const flat = parts.flat();
  const hasCall = flat.some((x) => x.type === "tool-call");
  const hasFinish = flat.some((x) => x.type === "finish");
  return [
    { type: "stream-start", warnings: [] },
    ...flat,
    ...(hasFinish ? [] : p.finish(hasCall ? "tool-calls" : "stop")),
  ];
}

export const submit = (answer: string) => step(p.call("submit_answer", { answer }));

/** Prompt sent to the model, as text (to assert on). */
export function promptText(options: LanguageModelV4CallOptions): string {
  return JSON.stringify(options.prompt);
}

export interface TestCave {
  cave: AgentCave;
  dataDir: string;
  calls: Record<string, LanguageModelV4CallOptions[]>;
  setScript(model: string, script: Script): void;
  req<T = any>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: T; res: Response }>;
  createAgent(input: Partial<AgentInput> & { slug: string }): Promise<void>;
  startCycle(body: Record<string, unknown>): Promise<Cycle>;
  waitFor(id: string, statuses?: string[], timeoutMs?: number): Promise<Cycle>;
  events(id: string): CycleEvent[];
  close(): Promise<void>;
}

export async function createTestCave(
  opts: Partial<AgentCaveOptions> & { dataDir?: string; start?: boolean } = {},
): Promise<TestCave> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentcave-test-"));
  const scripts: Record<string, Script> = {};
  const calls: Record<string, LanguageModelV4CallOptions[]> = {};
  const counters: Record<string, number> = {};

  const modelFactory = Object.assign(
    (req: ModelRequest) =>
      new MockLanguageModelV4({
        modelId: req.modelId,
        doStream: async (options) => {
          const script = scripts[req.modelId];
          if (!script) throw new Error(`No script for model ${req.modelId}`);
          const n = (counters[req.modelId] ?? -1) + 1;
          counters[req.modelId] = n;
          calls[req.modelId] = [...(calls[req.modelId] ?? []), options];
          const parts = await script(n, options, req);
          return { stream: convertArrayToReadableStream(parts) };
        },
      }),
    { requiresToken: false },
  );

  const cave = await createAgentCave({
    dataDir,
    webDist: opts.webDist,
    basePath: opts.basePath,
    modelFactory,
    fetchImpl: opts.fetchImpl ?? (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    webhookBackoffMs: opts.webhookBackoffMs ?? [50, 50],
  });
  if (opts.start !== false) cave.start();

  const t: TestCave = {
    cave,
    dataDir,
    calls,
    setScript: (model, script) => {
      scripts[model] = script;
    },
    async req<T = any>(method: string, url: string, body?: unknown) {
      const res = await cave.app.request(`/api/v1${url}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get("content-type") ?? "";
      const parsed = type.includes("application/json") ? await res.clone().json() : await res.clone().text();
      return { status: res.status, body: parsed as T, res };
    },
    async createAgent(input) {
      const r = await t.req("POST", "/agents", { name: input.slug, model: "test/model", ...input });
      if (r.status !== 201) throw new Error(`createAgent failed: ${JSON.stringify(r.body)}`);
    },
    async startCycle(body) {
      const r = await t.req("POST", "/cycles", body);
      if (r.status !== 202) throw new Error(`startCycle failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as Cycle;
    },
    async waitFor(id, statuses = ["completed", "failed", "stopped"], timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const c = cave.ctx.cycles.get(id);
        if (statuses.includes(c.status)) return c;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}: still ${c.status}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    events: (id) => cave.ctx.events.list(id, 0, 100_000),
    async close() {
      await cave.close();
      if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

export async function until(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
