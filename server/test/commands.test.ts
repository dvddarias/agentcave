import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CycleEvent, HttpCommand, HttpCommandCall } from "@agentcave/client";
import { afterEach, describe, expect, it } from "vitest";
import { helpText, usageLine } from "../src/engine/http-commands.js";
import { signPayload } from "../src/webhooks.js";
import { createTestCave, p, promptText, step, submit, type TestCave, until } from "./helpers.js";

// A local server standing in for the caller's own system.
interface Received {
  path: string;
  body: HttpCommandCall;
  raw: string;
  headers: http.IncomingHttpHeaders;
}

interface Receiver {
  url: string;
  calls: Received[];
  /** callIds whose request was cut off by AgentCave before it was answered. */
  aborted: string[];
  close(): Promise<void>;
}

const ORDERS: Record<string, { status: string; items: string[] }> = {
  A1: { status: "shipped", items: ["book", "pen"] },
  B2: { status: "pending", items: ["lamp"] },
  C3: { status: "pending", items: [] },
};

async function startReceiver(): Promise<Receiver> {
  const r: Receiver = { url: "", calls: [], aborted: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as HttpCommandCall;
      r.calls.push({ path: req.url ?? "", body, raw, headers: req.headers });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      switch (req.url) {
        case "/orders": {
          const order = ORDERS[String(body.input.orderId)];
          if (order) json(200, { id: body.input.orderId, ...order, updatedAt: "2026-11-01" });
          else json(404, { error: "no such order" });
          return;
        }
        case "/echo":
          json(200, body.input);
          return;
        case "/fail":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("boom: database down");
          return;
        case "/big":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n"));
          return;
        case "/slow": {
          const timer = setTimeout(() => json(200, { late: true }), 30_000);
          res.on("close", () => {
            clearTimeout(timer);
            if (!res.writableFinished) r.aborted.push(body.callId);
          });
          return;
        }
        default:
          json(404, { error: "unknown path" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return r;
}

/** A URL nothing listens on. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/gone`;
}

const SECRET = "Bearer SECRET-TOKEN-123";

function orderCommand(base: string, extra: Partial<HttpCommand> = {}): HttpCommand {
  return {
    name: "get_order_status",
    description: "Get the current status of an order by its id. Prints JSON: { status, items[], updatedAt }.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string", description: "The order id, e.g. A1" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    url: `${base}/orders`,
    headers: { Authorization: SECRET },
    ...extra,
  };
}

interface BashOut {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

function bashResults(events: CycleEvent[]): BashOut[] {
  return events.flatMap((e) =>
    e.type === "tool.result" && e.data.tool === "bash" ? [e.data.output as BashOut] : [],
  );
}

function httpCalls(events: CycleEvent[]) {
  return events.flatMap((e) => (e.type === "http.call" ? [e.data] : []));
}

/** A model that runs one bash command per step, then submits. */
function runs(...commands: string[]) {
  return (n: number) =>
    n < commands.length ? step(p.call("bash", { command: commands[n] })) : submit("done");
}

let t: TestCave;
let rx: Receiver;
afterEach(async () => {
  await t?.close();
  await rx?.close();
});

describe("HTTP commands", () => {
  it("runs a command: the server gets the body, headers and signature; stdout is the response", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.req("PUT", "/settings", { webhookSecret: "sign-me" });
    await t.createAgent({ slug: "support", model: "m/support" });
    t.setScript("m/support", (n) =>
      n === 0
        ? step(p.call("bash", { command: "get_order_status --orderId A1" }))
        : submit("Order A1 has shipped."),
    );
    const cycle = await t.startCycle({
      agent: "support",
      prompt: "Where is order A1?",
      labels: { customer: "c1" },
      commands: [orderCommand(rx.url)],
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.answer).toEqual({ format: "markdown", text: "Order A1 has shipped." });

    expect(rx.calls).toHaveLength(1);
    const got = rx.calls[0];
    expect(got.body).toEqual({
      command: "get_order_status",
      input: { orderId: "A1" },
      cycleId: cycle.id,
      turn: 0,
      callId: expect.stringMatching(/^call_/),
      labels: { customer: "c1" },
    });
    expect(got.headers.authorization).toBe(SECRET);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["x-agentcave-signature"]).toBe(signPayload("sign-me", got.raw));

    const events = t.events(cycle.id);
    const [out] = bashResults(events);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(`${JSON.stringify({ id: "A1", ...ORDERS.A1, updatedAt: "2026-11-01" })}\n`);

    // The http.call event: same callId as the request, tied to its bash tool call, no headers.
    const bashCall = events.find((e) => e.type === "tool.call" && e.data.tool === "bash");
    const [call] = httpCalls(events);
    expect(call).toMatchObject({
      step: 1,
      callId: got.body.callId,
      toolCallId: bashCall?.type === "tool.call" ? bashCall.data.callId : "?",
      command: "get_order_status",
      input: { orderId: "A1" },
      status: 200,
      error: null,
    });
    expect(call.bytes).toBe(out.stdout.length - 1);
    expect(call.preview).toBe(out.stdout.trimEnd());
    // http.call comes before the bash result.
    const types = events.map((e) => e.type);
    expect(types.indexOf("http.call")).toBeLessThan(types.indexOf("tool.result"));

    // The model was told about the command (name, description, usage) and nothing secret.
    const system = promptText(t.calls["m/support"][0]);
    expect(system).toContain("Commands for this task");
    expect(system).toContain("`get_order_status --orderId <string>`: Get the current status of an order");
    expect(system).toContain("--help");
    expect(system).not.toContain("SECRET-TOKEN");
  });

  it("converts flags by schema type, reads --json (also from stdin), and rejects bad arguments with exit 2", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "flags", model: "m/flags" });
    const lines = [
      "search --q hello --limit 5 --minScore=0.5 --open --no-archived --tag a --tag b --ids 1 --ids 2 --sort new",
      "search --q=a=b --archived=false --open true",
      `search --json '{"q":"x","filter":{"a":"y"}}'`,
      `echo '{"q":"from stdin"}' | search --json -`,
      `search --json '{"q":"x"}' --limit 1`,
      "search --limit 5",
      "search --q x --limit abc",
      "search --q x --limit 1.5",
      "search --q x --bogus 1",
      "search --q",
      "search --q x --sort sideways",
      "search --q x --filter y",
      "search hello",
      "search --help",
      "search -h",
    ];
    t.setScript("m/flags", runs(...lines));
    const cycle = await t.startCycle({
      agent: "flags",
      prompt: "x",
      commands: [
        {
          name: "search",
          description: "Search things.",
          inputSchema: {
            type: "object",
            properties: {
              q: { type: "string", description: "What to look for." },
              limit: { type: "integer", default: 10 },
              minScore: { type: "number" },
              open: { type: "boolean" },
              archived: { type: "boolean" },
              tag: { type: "array", items: { type: "string" } },
              ids: { type: "array", items: { type: "integer" } },
              sort: { type: "string", enum: ["new", "old"] },
              filter: { type: "object", properties: { a: { type: "string" } } },
            },
            required: ["q"],
            additionalProperties: false,
          },
          url: `${rx.url}/echo`,
        },
      ],
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    const out = bashResults(t.events(cycle.id));
    expect(out).toHaveLength(lines.length);
    const json = (i: number) => JSON.parse(out[i].stdout);

    expect(out[0].exitCode).toBe(0);
    expect(json(0)).toEqual({
      q: "hello",
      limit: 5,
      minScore: 0.5,
      open: true,
      archived: false,
      tag: ["a", "b"],
      ids: [1, 2],
      sort: "new",
    });
    expect(json(1)).toEqual({ q: "a=b", archived: false, open: true });
    expect(json(2)).toEqual({ q: "x", filter: { a: "y" } });
    expect(json(3)).toEqual({ q: "from stdin" });

    const usage = (i: number, message: string) => {
      expect(out[i].exitCode, lines[i]).toBe(2);
      expect(out[i].stdout, lines[i]).toBe("");
      expect(out[i].stderr, lines[i]).toContain(message);
      expect(out[i].stderr, lines[i]).toContain("usage: search --q <string>");
    };
    usage(4, "--json can't be combined with other flags");
    usage(5, "missing required flag --q");
    usage(6, "--limit needs a number, got 'abc'");
    usage(7, "--limit needs a whole number");
    usage(8, "unknown flag --bogus");
    usage(9, "--q needs a value");
    usage(10, "--sort must be equal to one of the allowed values");
    usage(11, "--filter takes an object: pass the whole input as JSON with --json instead");
    usage(12, "unexpected argument 'hello'");

    for (const i of [13, 14]) {
      expect(out[i].exitCode).toBe(0);
      expect(out[i].stdout).toBe(out[13].stdout);
    }
    const help = out[13].stdout;
    expect(help).toContain("search: Search things.");
    expect(help).toContain("search --q <string> [--limit <integer>] [--minScore <number>] [--open]");
    expect(help).toMatch(/--q <string> +Required\. What to look for\./);
    expect(help).toMatch(/--limit <integer> +Optional\. Default: 10\./);
    expect(help).toContain("--sort <new|old>");
    expect(help).toContain("One of: new, old.");
    expect(help).toContain("--no-open");
    expect(help).toContain("Repeat it for more than one value.");
    expect(help).toContain("An object: only through --json.");
    expect(help).toContain("Example:\n  search --q value\n");
    expect(help).toContain("2 = bad arguments");

    // Only the four good lines reached the server.
    expect(rx.calls).toHaveLength(4);
    expect(httpCalls(t.events(cycle.id))).toHaveLength(4);
  });

  it("composes with loops, pipes, jq and files", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "loops", model: "m/loops" });
    t.setScript(
      "m/loops",
      runs(
        `for id in A1 B2 C3; do get_order_status --orderId "$id"; done | jq -r '.status'`,
        "get_order_status --orderId A1 > /tmp/a1.json && jq '.items | length' /tmp/a1.json",
        "get_order_status --orderId B2 | jq -c '{s: .status}'",
      ),
    );
    const cycle = await t.startCycle({ agent: "loops", prompt: "x", commands: [orderCommand(rx.url)] });
    expect((await t.waitFor(cycle.id)).status).toBe("completed");
    const events = t.events(cycle.id);
    const out = bashResults(events);
    expect(out.map((o) => o.stdout)).toEqual(["shipped\npending\npending\n", "2\n", '{"s":"pending"}\n']);
    expect(out.every((o) => o.exitCode === 0)).toBe(true);
    expect(rx.calls.map((c) => c.body.input.orderId)).toEqual(["A1", "B2", "C3", "A1", "B2"]);

    // Every call is tied to the bash call that made it.
    const bashIds = events.flatMap((e) => (e.type === "tool.call" ? [e.data.callId] : []));
    expect(httpCalls(events).map((c) => c.toolCallId)).toEqual([
      bashIds[0],
      bashIds[0],
      bashIds[0],
      bashIds[1],
      bashIds[2],
    ]);
  });

  it("reports a 500, a timeout and a refused connection on stderr with exit 1, and the turn goes on", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "flaky", model: "m/flaky" });
    t.setScript(
      "m/flaky",
      runs('failing; echo "exit=$?"', 'slowpoke; echo "exit=$?"', 'nowhere; echo "exit=$?"'),
    );
    const base = { description: "x", inputSchema: { type: "object" } };
    const cycle = await t.startCycle({
      agent: "flaky",
      prompt: "x",
      commands: [
        { ...base, name: "failing", url: `${rx.url}/fail` },
        { ...base, name: "slowpoke", url: `${rx.url}/slow`, timeoutSec: 0.3 },
        { ...base, name: "nowhere", url: await deadUrl() },
      ],
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    const out = bashResults(t.events(cycle.id));
    expect(out.map((o) => o.stdout)).toEqual(["exit=1\n", "exit=1\n", "exit=1\n"]);
    expect(out[0].stderr).toBe("failing: HTTP 500: boom: database down\n");
    expect(out[1].stderr).toBe("slowpoke: timed out after 0.3s\n");
    expect(out[2].stderr).toBe("nowhere: connection refused\n");
    const calls = httpCalls(t.events(cycle.id));
    expect(calls.map((c) => [c.status, c.error])).toEqual([
      [500, "HTTP 500"],
      [null, "timed out after 0.3s"],
      [null, "connection refused"],
    ]);
    expect(calls[0].preview).toBe("boom: database down");
  });

  it("shortens output over the cap and saves the full text, like any bash output", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.req("PUT", "/settings", { toolOutputCapBytes: 2048 });
    await t.createAgent({ slug: "big", model: "m/big" });
    t.setScript("m/big", runs("big_report", "tail -n 1 /tmp/agentcave/out-1.txt"));
    const cycle = await t.startCycle({
      agent: "big",
      prompt: "x",
      commands: [
        { name: "big_report", description: "x", inputSchema: { type: "object" }, url: `${rx.url}/big` },
      ],
    });
    await t.waitFor(cycle.id);
    const out = bashResults(t.events(cycle.id));
    expect(out[0].truncated).toBe(true);
    expect(out[0].fullOutputPath).toBe("/tmp/agentcave/out-1.txt");
    expect(out[0].stdout.length).toBeLessThan(2600);
    expect(out[1].stdout).toBe("line 2000\n");
    const [call] = httpCalls(t.events(cycle.id));
    expect(call.preview).toHaveLength(2048);
    expect(call.bytes).toBeGreaterThan(15_000);
  });

  it("aborts a call that is still waiting when the cycle is stopped", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "waiter", model: "m/waiter" });
    t.setScript("m/waiter", () => step(p.call("bash", { command: "slow_call" })));
    const cycle = await t.startCycle({
      agent: "waiter",
      prompt: "x",
      commands: [
        {
          name: "slow_call",
          description: "x",
          inputSchema: { type: "object" },
          url: `${rx.url}/slow`,
          timeoutSec: 120,
        },
      ],
    });
    await until(() => rx.calls.length === 1);
    const started = Date.now();
    await t.req("POST", `/cycles/${cycle.id}/stop`);
    expect((await t.waitFor(cycle.id)).status).toBe("stopped");
    await until(() => rx.aborted.length === 1, 3000);
    expect(rx.aborted).toEqual([rx.calls[0].body.callId]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("works with any internet mode, none included", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "offline", model: "m/offline", internet: { mode: "none", allowlist: [] } });
    await t.createAgent({
      slug: "listed",
      model: "m/listed",
      internet: { mode: "allowlist", allowlist: ["https://example.com/"] },
    });
    const line = "get_order_status --orderId A1 | jq -r .status; which curl; echo curl=$?";
    t.setScript("m/offline", runs(line));
    t.setScript("m/listed", runs("get_order_status --orderId B2 | jq -r .status"));
    const a = await t.startCycle({ agent: "offline", prompt: "x", commands: [orderCommand(rx.url)] });
    const b = await t.startCycle({ agent: "listed", prompt: "x", commands: [orderCommand(rx.url)] });
    await t.waitFor(a.id);
    await t.waitFor(b.id);
    expect(bashResults(t.events(a.id))[0].stdout).toBe("shipped\ncurl=1\n");
    expect(bashResults(t.events(b.id))[0].stdout).toBe("pending\n");
    expect(rx.calls).toHaveLength(2);
  });

  it("never shows the headers: API, list, events, SSE, webhooks or the prompt", async () => {
    rx = await startReceiver();
    const hooks: string[] = [];
    t = await createTestCave({
      fetchImpl: async (input, init) => {
        if (String(input).includes("/hook")) {
          hooks.push(String(init?.body));
          return new Response("ok");
        }
        return new Response(JSON.stringify({ data: [] }));
      },
    });
    await t.createAgent({ slug: "secretive", model: "m/secretive" });
    t.setScript("m/secretive", (n) =>
      n % 2 === 0 ? step(p.call("bash", { command: "get_order_status --orderId A1" })) : submit("ok"),
    );
    const command = orderCommand(rx.url, { headers: { Authorization: SECRET, "X-Api-Key": "KEY-456" } });
    const cycle = await t.startCycle({
      agent: "secretive",
      prompt: "x",
      commands: [command],
      webhookUrl: "https://example.com/hook",
    });
    await t.waitFor(cycle.id);
    await t.req("POST", `/cycles/${cycle.id}/messages`, { prompt: "again", commands: [command] });
    await until(() => t.cave.ctx.cycles.get(cycle.id).turn === 1);
    await t.waitFor(cycle.id);
    await until(() => hooks.length === 2);
    expect(rx.calls.map((c) => c.headers["x-api-key"])).toEqual(["KEY-456", "KEY-456"]);

    const one = await t.req("GET", `/cycles/${cycle.id}`);
    expect(one.body.commands).toEqual([
      {
        name: "get_order_status",
        description: command.description,
        inputSchema: command.inputSchema,
        url: command.url,
        headers: { Authorization: "••••", "X-Api-Key": "••••" },
        timeoutSec: 20,
      },
    ]);
    const seen = [
      JSON.stringify(one.body),
      JSON.stringify((await t.req("GET", "/cycles")).body),
      JSON.stringify((await t.req("GET", "/cycles?rootOnly=false&q=get_order")).body),
      JSON.stringify((await t.req("GET", `/cycles/${cycle.id}/turns`)).body),
      JSON.stringify((await t.req("GET", `/cycles/${cycle.id}/events?format=json`)).body),
      String((await t.req("GET", `/cycles/${cycle.id}/events`)).body),
      JSON.stringify((await t.req("GET", `/cycles/${cycle.id}/webhooks`)).body),
      ...hooks,
      ...t.calls["m/secretive"].map(promptText),
    ];
    for (const text of seen) {
      expect(text).not.toContain("SECRET-TOKEN-123");
      expect(text).not.toContain("KEY-456");
    }
    expect(hooks[0]).toContain('"Authorization":"••••"');
  });

  it("refuses name clashes, bad schemas and too many commands (400)", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "strict", model: "m/strict" });
    const ok = {
      name: "lookup",
      description: "x",
      inputSchema: { type: "object" },
      url: "https://example.com/x",
    };
    const bad = async (commands: unknown[], message: string) => {
      const r = await t.req("POST", "/cycles", { agent: "strict", prompt: "x", commands });
      expect(r.status, message).toBe(400);
      expect(r.body.error.message).toContain(message);
    };
    for (const name of ["ls", "curl", "jq", "python3", "cd", "export", "if"]) {
      await bad([{ ...ok, name }], "already a command or shell builtin");
    }
    await bad([ok, ok], "is used twice");
    await bad([{ ...ok, name: "Get-Order" }], "commands.0.name");
    await bad([{ ...ok, inputSchema: { type: "string" } }], 'must be an object schema ("type": "object")');
    await bad(
      [{ ...ok, inputSchema: { type: "object", properties: { a: { type: "nope" } } } }],
      "not a valid JSON Schema",
    );
    await bad([{ ...ok, inputSchema: { type: "object", properties: { json: {} } } }], "can't be a flag");
    await bad([{ ...ok, url: "ftp://example.com/x" }], "commands.0.url");
    await bad([{ ...ok, timeoutSec: 121 }], "commands.0.timeoutSec");
    await bad([{ ...ok, description: undefined }], "commands.0.description");
    await bad([{ ...ok, headers: { "Bad Header": "x" } }], "commands.0.headers");
    await bad([{ ...ok, headers: { Authorization: "Bearer 秘密" } }], "characters HTTP headers can't carry");
    await bad(
      Array.from({ length: 33 }, (_, i) => ({ ...ok, name: `cmd${i}` })),
      "At most 32 commands per cycle",
    );
    // A draft 2020-12 schema (what zod's toJSONSchema writes) is fine.
    const zodLike = {
      ...ok,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
      },
    };
    t.setScript("m/strict", () => submit("ok"));
    const r = await t.req("POST", "/cycles", { agent: "strict", prompt: "x", commands: [zodLike] });
    expect(r.status).toBe(202);
    await t.waitFor(r.body.id);
    // A follow-up with bad commands changes nothing.
    const follow = await t.req("POST", `/cycles/${r.body.id}/messages`, {
      prompt: "y",
      commands: [{ ...ok, name: "cat" }],
    });
    expect(follow.status).toBe(400);
    expect(t.cave.ctx.cycles.get(r.body.id).turns).toBe(1);
  });

  it("keeps the commands for follow-ups and re-runs; a follow-up with commands replaces them and says so", async () => {
    rx = await startReceiver();
    t = await createTestCave();
    await t.createAgent({ slug: "desk", model: "m/desk" });
    const refund: HttpCommand = {
      name: "refund_order",
      description: "Refund an order.",
      inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
      url: `${rx.url}/echo`,
      headers: { Authorization: "Bearer T2" },
    };
    t.setScript("m/desk", (n) => {
      const turnLines = [
        "get_order_status --orderId A1 | jq -r .status", // turn 0
        "get_order_status --orderId B2 | jq -r .status", // turn 1: same commands
        'refund_order --orderId A1; get_order_status --orderId A1; echo "exit=$?"', // turn 2: replaced
      ];
      return n % 2 === 0
        ? step(p.call("bash", { command: turnLines[n / 2] }))
        : submit(`turn ${(n - 1) / 2}`);
    });
    const cycle = await t.startCycle({
      agent: "desk",
      prompt: "x",
      commands: [orderCommand(rx.url, { headers: { Authorization: "Bearer T1" } })],
    });
    await t.waitFor(cycle.id);
    const finishTurn = async (turn: number) => {
      await until(() => {
        const c = t.cave.ctx.cycles.get(cycle.id);
        return c.turn === turn && c.status === "completed";
      });
    };

    await t.req("POST", `/cycles/${cycle.id}/messages`, { prompt: "and B2?" });
    await finishTurn(1);
    const r = await t.req("POST", `/cycles/${cycle.id}/messages`, {
      prompt: "refund A1",
      commands: [refund],
    });
    expect(r.status).toBe(202);
    expect(r.body.commands.map((c: { name: string }) => c.name)).toEqual(["refund_order"]);
    await finishTurn(2);

    expect(rx.calls.map((c) => [c.body.command, c.body.turn, c.headers.authorization])).toEqual([
      ["get_order_status", 0, "Bearer T1"],
      ["get_order_status", 1, "Bearer T1"],
      ["refund_order", 2, "Bearer T2"],
    ]);
    const out = bashResults(t.events(cycle.id));
    expect(out[1].stdout).toBe("pending\n");
    expect(out[2].stdout).toBe('{"orderId":"A1"}\nexit=127\n');

    // Turn 2 saw the new list in the system prompt and a line about the change.
    const turn2 = t.calls["m/desk"][4];
    const prompt = promptText(turn2);
    expect(prompt).toContain(
      "Note: the commands for this task changed: added `refund_order`; removed `get_order_status` (it no longer exists).",
    );
    const system = JSON.stringify(turn2.prompt[0]);
    expect(system).toContain("`refund_order --orderId <string>`");
    expect(system).not.toContain("`get_order_status");
    // Turn 1 (no change) had no such line.
    expect(promptText(t.calls["m/desk"][2])).not.toContain("the commands for this task changed");
    const starts = t.events(cycle.id).flatMap((e) => (e.type === "turn.start" ? [e.data.systemPrompt] : []));
    expect(starts[0]).toContain("get_order_status");
    expect(starts[2]).toContain("refund_order");

    // A re-run gets the cycle's (current) commands, headers included.
    let k = 0;
    t.setScript("m/desk", () =>
      k++ === 0 ? step(p.call("bash", { command: "refund_order --orderId C3" })) : submit("ok"),
    );
    const rerun = await t.req("POST", `/cycles/${cycle.id}/rerun`, {});
    expect(rerun.status).toBe(202);
    await t.waitFor(rerun.body.id);
    expect(rx.calls.at(-1)?.headers.authorization).toBe("Bearer T2");
    expect(rx.calls.at(-1)?.body.cycleId).toBe(rerun.body.id);
  });

  it("keeps the commands through restart recovery", async () => {
    rx = await startReceiver();
    const first = await createTestCave({ start: false });
    const dataDir = first.dataDir;
    await first.createAgent({ slug: "again", model: "m/again" });
    const cycle = await first.startCycle({ agent: "again", prompt: "x", commands: [orderCommand(rx.url)] });
    first.cave.ctx.cycles.markRunning(cycle.id, first.cave.ctx.cycles.latestTurn(cycle.id).id);
    await first.cave.close();

    t = await createTestCave({ dataDir });
    t.setScript("m/again", runs("get_order_status --orderId C3 | jq -r .status"));
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    expect(bashResults(t.events(cycle.id))[0].stdout).toBe("pending\n");
    expect(rx.calls[0].headers.authorization).toBe(SECRET);
    await t.close();
    t = undefined as unknown as TestCave;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("HTTP command usage and help", () => {
  it("builds usage lines for optional, repeated and --json-only inputs", () => {
    expect(
      usageLine({
        name: "find",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string" },
            tag: { type: "array", items: { type: "string" } },
            mode: { enum: ["a", "b"] },
            deep: { type: ["boolean", "null"] },
            where: { type: "object" },
          },
          required: ["q"],
        },
      }),
    ).toBe("find --q <string> [--tag <string>]... [--mode <a|b>] [--deep]");
    expect(
      usageLine({
        name: "create",
        inputSchema: { type: "object", properties: { order: { type: "object" } }, required: ["order"] },
      }),
    ).toBe("create --json '<object>'");
    expect(usageLine({ name: "ping", inputSchema: { type: "object" } })).toBe("ping");
  });

  it("uses examples in --help and falls back to --json for required objects", () => {
    const help = helpText({
      name: "create",
      description: "Create an order.",
      inputSchema: {
        type: "object",
        properties: {
          order: { type: "object", examples: [{ sku: "X1", qty: 2 }] },
          note: { type: "string" },
        },
        required: ["order"],
      },
    });
    expect(help).toContain(`Example:\n  create --json '{"order":{"sku":"X1","qty":2}}'\n`);
    expect(help).toContain("--order");
    expect(help).toContain("Required. An object: only through --json.");
  });
});
