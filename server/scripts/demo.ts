/**
 * Demo mode: runs AgentCave with a scripted fake model (no OpenRouter token, $0) and three sample agents,
 * so you can explore the UI and watch thinking/text/tool calls stream in. The support agent uses an HTTP
 * command served by this script itself (a tiny fake shop at /demo-shop/orders).
 *
 *   npm run demo            → http://localhost:7420
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { serve } from "@hono/node-server";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createAgentCave } from "../src/app.js";
import { normalizeBasePath } from "../src/http/base-path.js";
import { log } from "../src/log.js";
import type { ModelRequest } from "../src/openrouter.js";

type Part = LanguageModelV4StreamPart;
let n = 0;
const id = () => `demo_${++n}`;

function chunks(text: string): string[] {
  return (
    text.match(/\S+\s*|\s+/g)?.reduce<string[]>((acc, w, i) => {
      if (i % 3 === 0) acc.push(w);
      else acc[acc.length - 1] += w;
      return acc;
    }, []) ?? [text]
  );
}

const reasoning = (text: string): Part[] => {
  const rid = id();
  return [
    { type: "reasoning-start", id: rid },
    ...chunks(text).map((delta): Part => ({ type: "reasoning-delta", id: rid, delta })),
    { type: "reasoning-end", id: rid },
  ];
};
const text = (t: string): Part[] => {
  const tid = id();
  return [
    { type: "text-start", id: tid },
    ...chunks(t).map((delta): Part => ({ type: "text-delta", id: tid, delta })),
    { type: "text-end", id: tid },
  ];
};
const call = (toolName: string, input: unknown): Part => ({
  type: "tool-call",
  toolCallId: id(),
  toolName,
  input: JSON.stringify(input),
});
const finish = (
  reason: "tool-calls" | "stop",
  cost: number,
  input = 2400,
  output = 380,
  reasoningTokens = 0,
): Part => ({
  type: "finish",
  usage: {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output - reasoningTokens, reasoning: reasoningTokens },
  },
  finishReason: { unified: reason, raw: reason },
  providerMetadata: { openrouter: { usage: { cost } } },
});

function stageOf(options: LanguageModelV4CallOptions): number {
  return options.prompt.filter((m) => m.role === "assistant").length;
}

const REVIEWER: ((o: LanguageModelV4CallOptions) => Part[])[] = [
  () => [
    ...reasoning(
      "The user wants a review of the code they sent. First I should see which files are in the workspace and how big they are.\n\nThen I can read the main module and look for the usual suspects: unchecked inputs, off-by-one errors, and missing error handling.",
    ),
    ...text("I'll start by looking at what was sent."),
    call("bash", { command: "ls -la && wc -l *.ts" }),
    finish("tool-calls", 0.0031, 2400, 380, 140),
  ],
  () => [
    ...reasoning("There is one TypeScript file. Let me read it and search for TODOs at the same time."),
    call("bash", { command: "cat -n app.ts; echo; grep -n 'TODO' app.ts" }),
    finish("tool-calls", 0.0042, 3100, 210, 60),
  ],
  () => [
    ...reasoning(
      "`average` divides by `values.length` without checking for an empty array: that returns `NaN`.\n\n`range(1, 3)` uses `<=` against `end - 1`… actually it stops one early: `i < end - 1` skips the last element. That is a real off-by-one.\n\nI should also get tests written for these cases. The test-writer sub-agent can do that while I prepare the summary.",
    ),
    ...text("I found two real problems. I'll ask the test writer to cover them with tests."),
    call("ask_test_writer", {
      prompt: "Write vitest tests for app.ts that cover: average([]) and range(1, 4) (should be [1, 2, 3]).",
    }),
    finish("tool-calls", 0.0063, 3900, 520, 230),
  ],
  () => [
    call("bash", { command: "ls -R .subagents && head -n 20 .subagents/test-writer-1/app.test.ts" }),
    finish("tool-calls", 0.0022),
  ],
  () => [
    ...text(
      "Both bugs are now covered by tests in `.subagents/test-writer-1/app.test.ts`.\n\nHere is the fixed version of `range`:\n\n```ts\nexport function range(start: number, end: number): number[] {\n  const out: number[] = [];\n  for (let i = start; i < end; i++) out.push(i);\n  return out;\n}\n```\n\nI'm submitting the review now.",
    ),
    call("submit_answer", {
      answer:
        "## Review of `app.ts`\n\n| # | Problem | Severity |\n|---|---|---|\n| 1 | `average([])` divides by zero and returns `NaN` | **high** |\n| 2 | `range()` stops one element early (`i < end - 1`) | **high** |\n| 3 | `TODO` left in `parseConfig` (no error handling for bad JSON) | medium |\n\n### Suggested fixes\n\n- Return `0` (or throw) when `values.length === 0`.\n- Loop with `i < end`.\n- Wrap `JSON.parse` in `try/catch` and report the file name.\n\nTests for 1 and 2 were written by the **test-writer** sub-agent (see `.subagents/test-writer-1/`).",
    }),
    finish("tool-calls", 0.0049),
  ],
];

const TEST_WRITER: ((o: LanguageModelV4CallOptions) => Part[])[] = [
  () => [
    ...reasoning(
      "I need to write tests for `average` and `range`. I'll write a single test file next to app.ts.",
    ),
    call("writeFile", {
      path: "app.test.ts",
      content:
        'import { describe, expect, it } from "vitest";\nimport { average, range } from "./app";\n\ndescribe("average", () => {\n  it("handles an empty list", () => {\n    expect(average([])).toBe(0);\n  });\n});\n\ndescribe("range", () => {\n  it("includes every number before end", () => {\n    expect(range(1, 4)).toEqual([1, 2, 3]);\n  });\n});\n',
    }),
    finish("tool-calls", 0.0012, 1800, 260, 40),
  ],
  () => [
    call("submit_answer", { answer: "Wrote `app.test.ts` with 2 tests (empty average, range end)." }),
    finish("tool-calls", 0.0008, 1900, 60, 0),
  ],
];

const SUPPORT: ((o: LanguageModelV4CallOptions) => Part[])[] = [
  () => [
    ...reasoning(
      "The customer asks about two orders. I have `get_order_status`, so I can look both up in one command and keep only what matters with jq.",
    ),
    call("bash", {
      command: `for id in A1 B2; do get_order_status --orderId "$id"; done | jq -c '{id, status, items: (.items | length)}'`,
    }),
    finish("tool-calls", 0.0018, 2100, 160, 50),
  ],
  () => [
    ...reasoning("A1 shipped, B2 is pending. They also mentioned an old order Z9; let me check it too."),
    call("bash", { command: 'get_order_status --orderId Z9; echo "exit=$?"' }),
    finish("tool-calls", 0.0012, 2300, 90, 20),
  ],
  () => [
    call("submit_answer", {
      answer:
        "Hi! Here is where your orders are:\n\n- **A1**: shipped (2 items).\n- **B2**: still pending (1 item); it should ship soon.\n- **Z9**: I couldn't find this order. Could you check the number?",
    }),
    finish("tool-calls", 0.0015, 2500, 120, 0),
  ],
];

const SCRIPTS: Record<string, ((o: LanguageModelV4CallOptions) => Part[])[]> = {
  "demo/reviewer": REVIEWER,
  "demo/test-writer": TEST_WRITER,
  "demo/support": SUPPORT,
};

function demoModel(req: ModelRequest) {
  return new MockLanguageModelV4({
    modelId: req.modelId,
    doStream: async (options) => {
      const script = SCRIPTS[req.modelId] ?? REVIEWER;
      const stage = stageOf(options);
      const parts: Part[] = [
        { type: "stream-start", warnings: [] },
        ...(script[stage] ?? script[script.length - 1])(options),
      ];
      return {
        stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 600, chunkDelayInMs: 45 }),
      };
    },
  });
}

const APP_TS = `export function average(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end - 1; i++) out.push(i);
  return out;
}

export function parseConfig(text: string) {
  // TODO: handle invalid JSON
  return JSON.parse(text);
}
`;

const ORDERS: Record<string, unknown> = {
  A1: {
    id: "A1",
    status: "shipped",
    items: [
      { sku: "BOOK-12", qty: 1 },
      { sku: "PEN-3", qty: 2 },
    ],
    updatedAt: "2026-11-02T09:14:00Z",
  },
  B2: { id: "B2", status: "pending", items: [{ sku: "LAMP-7", qty: 1 }], updatedAt: "2026-11-05T16:40:00Z" },
};

/** Stands in for the caller's own system, so the HTTP command demo needs nothing else. */
async function demoShop(req: Request): Promise<Response> {
  if (req.headers.get("authorization") !== "Bearer demo-token")
    return new Response("not allowed", { status: 401 });
  const { input } = (await req.json()) as { input: { orderId?: string } };
  await new Promise((r) => setTimeout(r, 150));
  const order = ORDERS[String(input.orderId)];
  return Response.json(order ?? { error: `no order ${input.orderId}` }, { status: order ? 200 : 404 });
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.DATA_DIR ?? path.join(os.tmpdir(), "agentcave-demo");
  const webDist = path.resolve(here, "../../web/dist");
  const cave = await createAgentCave({
    dataDir,
    webDist: existsSync(path.join(webDist, "index.html")) ? webDist : null,
    basePath: process.env.BASE_PATH,
    modelFactory: Object.assign(demoModel, { requiresToken: false }),
  });
  const agents = cave.ctx.agents;
  try {
    agents.getRow("test-writer");
  } catch {
    await agents.create({
      slug: "test-writer",
      name: "Test Writer",
      description: "Writes focused unit tests for the code it is given.",
      model: "demo/test-writer",
      reasoning: "low",
      systemPrompt: "# Role\n\nYou write small, focused unit tests with vitest.",
    });
  }
  try {
    agents.getRow("code-reviewer");
  } catch {
    await agents.create({
      slug: "code-reviewer",
      name: "Code Reviewer",
      description: "Reviews code, finds real bugs and gets tests written for them.",
      model: "demo/reviewer",
      reasoning: "high",
      subagents: ["test-writer"],
      limits: { maxCostUsd: 0.5, maxTimeSec: 600 },
      systemPrompt:
        "# Role\n\nYou are a meticulous **code reviewer**.\n\n# Rules\n\n- Only report real bugs, not style nits.\n- Prove each bug with a concrete input.\n- Delegate writing tests to the test writer.\n",
      files: {
        upsert: [
          { path: "checklist.md", content: "- [ ] empty inputs\n- [ ] off-by-one\n- [ ] error handling\n" },
        ],
      },
    });
  }
  try {
    agents.getRow("support-agent");
  } catch {
    await agents.create({
      slug: "support-agent",
      name: "Support Agent",
      description: "Answers customers about their orders, using the shop's order-status command.",
      model: "demo/support",
      reasoning: "low",
      systemPrompt: "# Role\n\nYou answer customers about their orders. Be short and friendly.",
    });
  }
  cave.start();
  const port = Number(process.env.PORT ?? 7420);
  const fetchDemo = (req: Request) =>
    new URL(req.url).pathname === "/demo-shop/orders" ? demoShop(req) : cave.app.fetch(req);
  serve({ fetch: fetchDemo, port }, () => {
    log.info(
      `AgentCave DEMO on http://localhost:${port}${normalizeBasePath(process.env.BASE_PATH)} (fake model, no token needed)`,
      { dataDir },
    );
  });
  if (process.env.DEMO_AUTOSTART !== "0") {
    setTimeout(async () => {
      await cave.cycles.start({
        agent: "code-reviewer",
        prompt: "Please review `app.ts`. Report only real bugs and make sure they get tests.",
        files: [{ path: "app.ts", content: APP_TS }],
        labels: { demo: "true" },
        source: "api",
      });
      await cave.cycles.start({
        agent: "support-agent",
        prompt: "Hi, where are my orders A1 and B2? Also an older one, Z9.",
        labels: { demo: "true", customer: "c-1042" },
        commands: [
          {
            name: "get_order_status",
            description:
              "Get the current status of an order by its id. Prints JSON: { id, status, items[], updatedAt }.",
            inputSchema: {
              type: "object",
              properties: {
                orderId: { type: "string", description: "The order id, e.g. A1", examples: ["A1"] },
              },
              required: ["orderId"],
            },
            url: `http://127.0.0.1:${port}/demo-shop/orders`,
            headers: { Authorization: "Bearer demo-token" },
          },
        ],
        source: "api",
      });
    }, 1500);
  }
  process.on("SIGINT", async () => {
    await cave.close();
    process.exit(0);
  });
}

void main();
