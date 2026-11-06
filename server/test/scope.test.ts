import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentCave, type Cycle, type CycleUpdate } from "@agentcave/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseScope } from "../src/scope.js";
import { createTestCave, p, step, submit, type TestCave, until } from "./helpers.js";

let t: TestCave;
let dataDir: string | undefined;
afterEach(async () => {
  await t?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** A request as the proxy forwards it, with `scope` as X-AgentCave-Scope (none when undefined). */
async function req(method: string, url: string, scope?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (scope !== undefined) headers["x-agentcave-scope"] = scope;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await t.cave.app.request(url.startsWith("/cave/") ? url : `/api/v1${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const parsed: any = type.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, body: parsed, type };
}

const ids = (cycles: Cycle[]) => cycles.map((c) => c.id).sort();

/** `fetch` against the in-process app. Aborting ends the response body, as a closed connection does. */
const fetchApp: typeof fetch = async (url, init) => {
  const res = await t.cave.app.request(String(url), init);
  if (!res.body) return res;
  const reader = res.body.getReader();
  init?.signal?.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, res);
};

/**
 * Three finished cycles: `mine` (userId=5, app=cc) with a sub-agent cycle `child`, `theirs`
 * (userId=6, app=cc) and `other` (userId=5, app=other). Each has the input file note.txt.
 */
async function setup() {
  t = await createTestCave({ dataDir });
  await t.createAgent({ slug: "helper", model: "m/helper" });
  await t.createAgent({ slug: "boss", model: "m/boss", subagents: ["helper"] });
  await t.createAgent({ slug: "solo", model: "m/solo" });
  t.setScript("m/helper", () => submit("helped"));
  t.setScript("m/boss", (n) => (n === 0 ? step(p.call("ask_helper", { prompt: "help" })) : submit("done")));
  t.setScript("m/solo", () => submit("done"));
  const start = async (agent: string, labels: Record<string, string>) => {
    const c = await t.startCycle({
      agent,
      prompt: "go",
      labels,
      files: [{ path: "note.txt", content: "hi" }],
    });
    await t.waitFor(c.id);
    return c.id;
  };
  const mine = await start("boss", { userId: "5", app: "cc" });
  const theirs = await start("solo", { userId: "6", app: "cc" });
  const other = await start("solo", { userId: "5", app: "other" });
  const kids = (await req("GET", `/cycles/${mine}/children`)).body.cycles as Cycle[];
  expect(kids).toHaveLength(1);
  return { mine, child: kids[0].id, theirs, other };
}

describe("parseScope", () => {
  it("reads key=value pairs", () => {
    expect(parseScope(undefined)).toBeNull();
    expect(parseScope("userId=5")).toEqual({ userId: "5" });
    expect(parseScope("userId=5; app=checkincopilot")).toEqual({ userId: "5", app: "checkincopilot" });
    expect(parseScope(" userId = 5 ;; app=cc, ")).toEqual({ userId: "5", app: "cc" });
    // Percent-encoded keys and values; a header sent twice (joined with ", ") only narrows.
    expect(parseScope("a%3Bb=c%3Dd%2C%20e")).toEqual({ "a;b": "c=d, e" });
    expect(parseScope("userId=5, userId=5")).toEqual({ userId: "5" });
    expect(parseScope("__proto__=x")).toEqual(JSON.parse('{"__proto__":"x"}'));
  });

  it("refuses a header that names no usable pair, rather than opening the full view", () => {
    for (const bad of ["", " ", ";", "userId", "=5", "userId=", "userId=5; userId=6", "k=%E0%A4%A"]) {
      expect(() => parseScope(bad), bad).toThrow(/X-AgentCave-Scope/);
    }
  });
});

describe("view scope", () => {
  it("shows only the scope's cycles (with their sub-agents); others are 404", async () => {
    const { mine, child, theirs, other } = await setup();
    const scope = "userId=5; app=cc";

    // Lists
    expect(ids((await req("GET", "/cycles")).body.cycles)).toEqual([mine, theirs, other].sort());
    expect(ids((await req("GET", "/cycles", scope)).body.cycles)).toEqual([mine]);
    expect(ids((await req("GET", "/cycles", "userId=5")).body.cycles)).toEqual([mine, other].sort());
    expect(ids((await req("GET", "/cycles", "app=cc")).body.cycles)).toEqual([mine, theirs].sort());
    expect(ids((await req("GET", "/cycles?rootOnly=false", scope)).body.cycles)).toEqual(
      [mine, child].sort(),
    );
    expect(ids((await req("GET", `/cycles?parent=${mine}`, scope)).body.cycles)).toEqual([child]);
    expect((await req("GET", `/cycles?parent=${theirs}&rootOnly=false`, scope)).body.cycles).toEqual([]);
    expect((await req("GET", "/cycles?label.userId=6", scope)).body.cycles).toEqual([]);
    expect((await req("GET", "/cycles?q=solo", scope)).body.cycles).toEqual([]);

    // Every read of one cycle: in scope it works, outside it the cycle doesn't exist.
    const reads = [
      "",
      "/answer",
      "/turns",
      "/children",
      "/webhooks",
      "/events?format=json",
      "/events",
      "/files",
      "/files?changed=true",
      "/files.zip",
      "/files/note.txt",
    ];
    for (const r of reads) {
      const own = await req("GET", `/cycles/${mine}${r}`, scope);
      expect(own.status, r).toBe(200);
      const out = await req("GET", `/cycles/${theirs}${r}`, scope);
      expect(out.status, r).toBe(404);
      expect(out.body.error, r).toEqual({ code: "not_found", message: `Cycle '${theirs}' not found` });
      // Labels must match every pair: same user, other app.
      expect((await req("GET", `/cycles/${other}${r}`, scope)).status, r).toBe(404);
    }
    const own = await req("GET", `/cycles/${mine}`, scope);
    expect(own.body.labels).toEqual({ userId: "5", app: "cc" });
    expect(String((await req("GET", `/cycles/${mine}/events`, scope)).body)).toContain('"cycle.status"');
    expect((await req("GET", `/cycles/${mine}/files/note.txt`, scope)).body).toBe("hi");
    // Images: the scope check comes first, then the image lookup.
    const sha = "a".repeat(64);
    expect((await req("GET", `/cycles/${theirs}/images/${sha}`, scope)).body.error.message).toBe(
      `Cycle '${theirs}' not found`,
    );
    expect((await req("GET", `/cycles/${mine}/images/${sha}`, scope)).body.error.message).toBe(
      `Image '${sha}' not found`,
    );

    // The sub-agent cycle belongs to its root's scope.
    expect((await req("GET", `/cycles/${child}`, scope)).status).toBe(200);
    expect((await req("GET", `/cycles/${child}/events?format=json`, scope)).status).toBe(200);
    expect((await req("GET", `/cycles/${child}`, "userId=6")).status).toBe(404);
    expect(ids((await req("GET", `/cycles/${mine}/children`, scope)).body.cycles)).toEqual([child]);

    // Unknown ids look the same as other people's.
    expect((await req("GET", "/cycles/cyc_nope", scope)).status).toBe(404);
    // Without the header nothing changes.
    for (const id of [mine, child, theirs, other])
      expect((await req("GET", `/cycles/${id}`)).status).toBe(200);
  });

  it("is read-only: every write and the agents, settings and models endpoints are 403", async () => {
    const { mine, theirs } = await setup();
    const scope = "userId=5";
    const forbidden: [string, string, unknown?][] = [
      ["POST", "/cycles", { agent: "solo", prompt: "x", labels: { userId: "5" } }],
      ["POST", `/cycles/${mine}/stop`],
      ["POST", `/cycles/${mine}/messages`, { prompt: "more" }],
      ["POST", `/cycles/${mine}/continue`, {}],
      ["POST", `/cycles/${mine}/rerun`, {}],
      ["DELETE", `/cycles/${mine}`],
      // Outside the scope too: a write never says whether the cycle exists.
      ["POST", `/cycles/${theirs}/stop`],
      ["DELETE", `/cycles/${theirs}`],
      ["GET", "/agents"],
      ["GET", "/agents/solo"],
      ["GET", "/agents/solo/versions"],
      ["GET", "/agents/solo/export"],
      ["POST", "/agents", { slug: "new", name: "New", model: "m/x" }],
      ["PUT", "/agents/solo", { systemPrompt: "changed" }],
      ["DELETE", "/agents/solo"],
      ["POST", "/agents/solo/unarchive"],
      ["POST", "/agents/solo/versions/1/restore"],
      ["POST", "/agents/import", { content: "---\nslug: x\nname: X\nmodel: m/x\n---\nHi" }],
      ["GET", "/settings"],
      ["PUT", "/settings", { maxParallel: 9 }],
      ["POST", "/settings/test-token", { token: "x" }],
      ["GET", "/models"],
      ["POST", "/maintenance/cleanup"],
      ["GET", "/openapi.json"],
    ];
    for (const [method, url, body] of forbidden) {
      const r = await req(method, url, scope, body);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.body.error.code, `${method} ${url}`).toBe("forbidden");
    }
    // Nothing happened.
    expect((await req("GET", "/cycles")).body.cycles).toHaveLength(3);
    expect((await req("GET", `/cycles/${mine}`)).body.turns).toBe(1);
    expect((await req("GET", "/agents")).body.agents).toHaveLength(3);
    expect((await req("GET", "/agents/solo")).body.currentVersion).toBe(1);
    expect((await req("GET", "/settings")).body.maxParallel).not.toBe(9);

    // What a scoped view may read.
    expect((await req("GET", "/session", scope)).body).toEqual({ scope: { userId: "5" } });
    expect((await req("GET", "/session")).body).toEqual({ scope: null });
    expect((await req("GET", "/health", scope)).body.ok).toBe(true);
  });

  it("refuses a malformed header with 400, on reads and writes", async () => {
    const { mine } = await setup();
    for (const bad of ["", "userId", "userId=5; userId=6"]) {
      for (const [method, url] of [
        ["GET", "/cycles"],
        ["GET", `/cycles/${mine}`],
        ["DELETE", `/cycles/${mine}`],
      ]) {
        const r = await req(method, url, bad);
        expect(r.status, `${method} ${url} ${bad}`).toBe(400);
        expect(r.body.error.code).toBe("invalid_scope");
      }
    }
    expect((await req("GET", `/cycles/${mine}`)).status).toBe(200);
  });

  it("filters usage stats, also after the cycles are deleted", async () => {
    const { mine, theirs } = await setup();
    const totals = async (scope?: string) => (await req("GET", "/stats", scope)).body.totals.cycles;
    // mine + its sub-agent cycle, theirs, other
    expect(await totals()).toBe(4);
    expect(await totals("userId=5; app=cc")).toBe(2);
    expect(await totals("userId=5")).toBe(3);
    expect(await totals("userId=6")).toBe(1);
    expect(await totals("userId=7")).toBe(0);
    const byAgent = (await req("GET", "/stats", "userId=5; app=cc")).body.byAgent.map(
      (r: { key: string }) => r.key,
    );
    expect(byAgent.sort()).toEqual(["boss", "helper"]);

    expect((await req("DELETE", `/cycles/${mine}`)).status).toBe(204);
    expect((await req("DELETE", `/cycles/${theirs}`)).status).toBe(204);
    expect(await totals("userId=5; app=cc")).toBe(2);
    expect(await totals("userId=6")).toBe(1);
  });

  it("filters the global feed, deletions included", async () => {
    const { mine, child, theirs, other } = await setup();
    // The client, with the header a proxy would add, against the in-process app.
    const feed = (scope?: string) => {
      const cave = new AgentCave({
        baseUrl: "http://cave.test",
        headers: scope ? { "X-AgentCave-Scope": scope } : {},
        fetch: fetchApp,
      });
      const ac = new AbortController();
      const updates: CycleUpdate[] = [];
      const done = (async () => {
        try {
          for await (const u of cave.updates(ac.signal)) updates.push(u);
        } catch {
          // aborted
        }
      })();
      const seen = (type: CycleUpdate["type"], id: string) =>
        updates.some((u) => u.type === type && u.id === id);
      const close = () => {
        ac.abort();
        return done;
      };
      return { updates, seen, close };
    };
    const scoped = feed("userId=5; app=cc");
    const all = feed();
    // Let both subscribe before anything changes.
    await new Promise((r) => setTimeout(r, 100));

    for (const id of [mine, child, theirs, other]) t.cave.ctx.events.touch(id);
    await until(() => scoped.seen("cycle.updated", mine) && scoped.seen("cycle.updated", child));
    await until(() => all.seen("cycle.updated", theirs) && all.seen("cycle.updated", other));

    await req("DELETE", `/cycles/${theirs}`);
    await req("DELETE", `/cycles/${mine}`);
    await until(() => scoped.seen("cycle.deleted", mine) && scoped.seen("cycle.deleted", child));
    await until(() => all.seen("cycle.deleted", mine) && all.seen("cycle.deleted", theirs));
    await Promise.all([scoped.close(), all.close()]);

    expect([...new Set(scoped.updates.map((u) => u.id))].sort()).toEqual([mine, child].sort());
    expect(scoped.updates.every((u) => u.cycle === null || u.cycle.rootId === mine)).toBe(true);
  });

  it("counts the queue of the scope, and works under BASE_PATH", async () => {
    t = await createTestCave({ basePath: "/cave" });
    await t.req("PUT", "/settings", { maxParallel: 1 });
    await t.createAgent({ slug: "solo", model: "m/solo" });
    t.setScript("m/solo", () => step(p.call("bash", { command: "sleep 30" })));
    const start = async (userId: string) =>
      (await t.startCycle({ agent: "solo", prompt: "go", labels: { userId } })).id;
    const theirs = await start("6");
    await until(() => t.cave.ctx.cycles.get(theirs).status === "running");
    const mine = await start("5");
    const theirs2 = await start("6");

    const queue = async (scope?: string) => (await req("GET", "/cave/api/v1/health", scope)).body.queue;
    expect(await queue()).toMatchObject({ running: 1, queued: 2 });
    expect(await queue("userId=5")).toMatchObject({ running: 0, queued: 1, maxParallel: 1 });
    expect(await queue("userId=6")).toMatchObject({ running: 1, queued: 1 });
    expect(await queue("userId=7")).toMatchObject({ running: 0, queued: 0 });

    expect(ids((await req("GET", "/cave/api/v1/cycles", "userId=5")).body.cycles)).toEqual([mine]);
    expect((await req("GET", `/cave/api/v1/cycles/${theirs}`, "userId=5")).status).toBe(404);
    expect((await req("POST", `/cave/api/v1/cycles/${mine}/stop`, "userId=5")).status).toBe(403);
    expect((await req("GET", "/cave/api/v1/agents", "userId=5")).status).toBe(403);
    // The proxy may also strip the prefix.
    expect((await req("GET", `/cycles/${theirs}`, "userId=5")).status).toBe(404);
    expect((await req("GET", `/cycles/${mine}`, "userId=5")).status).toBe(200);
    for (const id of [mine, theirs2, theirs]) await t.req("POST", `/cycles/${id}/stop`);
    await t.waitFor(theirs);
  });

  it("keeps the usage of cycles from before the upgrade in their scope (migration 6)", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcave-test-"));
    const { mine } = await setup();
    await t.close();
    // Back to schema 5: no root_labels.
    const db = new DatabaseSync(path.join(dataDir, "agentcave.db"));
    db.exec("ALTER TABLE cycle_usage DROP COLUMN root_labels; PRAGMA user_version = 5;");
    db.close();
    t = await createTestCave({ dataDir });
    expect((await req("GET", "/stats", "userId=5; app=cc")).body.totals.cycles).toBe(2);
    expect((await req("GET", "/stats", "userId=6")).body.totals.cycles).toBe(1);
    expect((await req("GET", `/cycles/${mine}`, "userId=5")).status).toBe(200);
  });
});
