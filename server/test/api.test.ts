import type { CycleEvent, WebhookPayload } from "@agentcave/client";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { signPayload } from "../src/webhooks.js";
import { createTestCave, p, step, submit, type TestCave, until } from "./helpers.js";

let t: TestCave;
afterEach(async () => {
  await t?.close();
});

function parseSse(text: string): CycleEvent[] {
  return text
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join(""),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}

describe("agents API", () => {
  it("creates, versions, restores, archives", async () => {
    t = await createTestCave();
    const created = await t.req("POST", "/agents", {
      slug: "reviewer",
      name: "Reviewer",
      model: "m/a",
      systemPrompt: "# Be strict",
      reasoning: "high",
    });
    expect(created.status).toBe(201);
    expect(created.body.currentVersion).toBe(1);
    expect(created.body.config.reasoning).toBe("high");

    const dup = await t.req("POST", "/agents", { slug: "reviewer", name: "x", model: "m" });
    expect(dup.status).toBe(409);

    const v2 = await t.req("PUT", "/agents/reviewer", { systemPrompt: "# Be kind", note: "softer" });
    expect(v2.body.currentVersion).toBe(2);
    expect(v2.body.config.reasoning).toBe("high"); // kept

    const same = await t.req("PUT", "/agents/reviewer", { systemPrompt: "# Be kind" });
    expect(same.body.currentVersion).toBe(2); // no-op save makes no version

    const versions = await t.req("GET", "/agents/reviewer/versions");
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions.body.versions[0].note).toBe("softer");

    const restored = await t.req("POST", "/agents/reviewer/versions/1/restore");
    expect(restored.body.currentVersion).toBe(3);
    expect(restored.body.config.systemPrompt).toBe("# Be strict");

    expect((await t.req("DELETE", "/agents/reviewer")).status).toBe(204);
    expect((await t.req("GET", "/agents")).body.agents).toHaveLength(0);
    expect((await t.req("GET", "/agents?archived=true")).body.agents).toHaveLength(1);
    const blocked = await t.req("POST", "/cycles", { agent: "reviewer", prompt: "x" });
    expect(blocked.status).toBe(409);
    await t.req("POST", "/agents/reviewer/unarchive");
    expect((await t.req("GET", "/agents")).body.agents).toHaveLength(1);
  });

  it("validates input", async () => {
    t = await createTestCave();
    expect((await t.req("POST", "/agents", { slug: "Bad Slug", name: "x", model: "m" })).status).toBe(400);
    expect((await t.req("POST", "/agents", { slug: "ok", name: "x" })).status).toBe(400); // no model
    expect(
      (await t.req("POST", "/agents", { slug: "ok", name: "x", model: "m", subagents: ["missing"] })).status,
    ).toBe(400);
    expect(
      (await t.req("POST", "/agents", { slug: "ok", name: "x", model: "m", outputSchema: { type: "nope" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.req("POST", "/agents", {
          slug: "ok",
          name: "x",
          model: "m",
          internet: { mode: "allowlist", allowlist: [] },
        })
      ).status,
    ).toBe(400);
    expect((await t.req("GET", "/agents/nope")).status).toBe(404);
  });

  it("manages agent files and exports/imports .md and .zip", async () => {
    t = await createTestCave();
    await t.createAgent({
      slug: "docs",
      name: "Docs",
      description: "Knows the docs",
      systemPrompt: "Use the guide.",
      files: {
        upsert: [
          { path: "guide.md", content: "# Guide" },
          { path: "img/logo.bin", content: "AAEC", encoding: "base64" },
        ],
      },
    });
    const file = await t.req("GET", "/agents/docs/files/guide.md");
    expect(file.body).toBe("# Guide");

    const exp = await t.cave.app.request("/api/v1/agents/docs/export");
    expect(exp.headers.get("content-type")).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await exp.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["agent.md", "files/guide.md", "files/img/logo.bin"]);
    const md = new TextDecoder().decode(entries["agent.md"]);
    expect(md).toMatch(/^---\nslug: docs\n/);
    expect(md).toContain("Use the guide.");

    // Import the .md under a new slug.
    const imported = await t.cave.app.request("/api/v1/agents/import", {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: md.replace("slug: docs", "slug: docs-copy"),
    });
    expect(imported.status).toBe(201);
    const copy = (await imported.json()) as any;
    expect(copy.slug).toBe("docs-copy");
    expect(copy.config.description).toBe("Knows the docs");
    expect(copy.config.systemPrompt).toBe("Use the guide.");

    // Re-importing the zip over the existing slug creates a new version with the files.
    const zipped = await t.cave.app.request("/api/v1/agents/import", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: await (await t.cave.app.request("/api/v1/agents/docs/export")).arrayBuffer(),
    });
    expect(zipped.status).toBe(201);
    const again = (await zipped.json()) as any;
    expect(again.config.files.map((f: { path: string }) => f.path)).toEqual(["guide.md", "img/logo.bin"]);

    // Remove a file → new version.
    const removed = await t.req("PUT", "/agents/docs", { files: { remove: ["img/logo.bin"] } });
    expect(removed.body.config.files).toHaveLength(1);
    expect(removed.body.currentVersion).toBe(3);
  });
});

describe("cycles API", () => {
  it("validates cycle requests", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "a" });
    expect((await t.req("POST", "/cycles", { agent: "nope", prompt: "x" })).status).toBe(404);
    expect((await t.req("POST", "/cycles", { agent: "a" })).status).toBe(400);
    expect(
      (await t.req("POST", "/cycles", { agent: "a", prompt: "x", files: [{ path: "../x", content: "" }] }))
        .status,
    ).toBe(400);
    expect(
      (await t.req("POST", "/cycles", { agent: "a", prompt: "x", outputSchema: { type: 12 } })).status,
    ).toBe(400);
    expect((await t.req("POST", "/cycles", { agent: "a", prompt: "x", extra: 1 })).status).toBe(400);
    const bad = await t.cave.app.request("/api/v1/cycles", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await t.req("GET", "/cycles/cyc_missing")).status).toBe(404);
  });

  it("lists with filters and cursors, streams SSE, serves files and zips", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "w", model: "m/w" });
    t.setScript("m/w", (n) =>
      n % 2 === 0
        ? step(
            p.text("Working on it.\n\nAlmost done."),
            p.call("bash", { command: "echo out > out.txt; rm del.txt" }),
          )
        : submit("ok"),
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await t.startCycle({
        agent: "w",
        prompt: `job ${i}`,
        labels: { team: i === 0 ? "red" : "blue" },
        files: [
          { path: "in.txt", content: "x" },
          { path: "del.txt", content: "gone" },
        ],
      });
      ids.push(c.id);
      await t.waitFor(c.id);
    }

    const all = await t.req("GET", "/cycles?limit=2");
    expect(all.body.cycles).toHaveLength(2);
    expect(all.body.cycles[0].id).toBe(ids[2]);
    const page2 = await t.req("GET", `/cycles?limit=2&cursor=${all.body.nextCursor}`);
    expect(page2.body.cycles.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
    expect(page2.body.nextCursor).toBeNull();

    const red = await t.req("GET", "/cycles?label.team=red");
    expect(red.body.cycles.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
    expect((await t.req("GET", "/cycles?status=failed")).body.cycles).toHaveLength(0);
    expect((await t.req("GET", "/cycles?q=job%201")).body.cycles.map((c: { id: string }) => c.id)).toEqual([
      ids[1],
    ]);

    // SSE of a finished cycle replays everything and ends.
    const sse = await t.cave.app.request(`/api/v1/cycles/${ids[0]}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await sse.text());
    expect(events[0].type).toBe("cycle.status");
    expect(events.at(-1)?.type).toBe("cycle.status");
    const texts = events.filter((e) => e.type === "text").map((e) => (e.data as { text: string }).text);
    expect(texts).toEqual(["Working on it.\n\n", "Almost done."]);
    // Resume after a sequence number.
    const resumed = parseSse(
      await (await t.cave.app.request(`/api/v1/cycles/${ids[0]}/events?after=${events[3].seq}`)).text(),
    );
    expect(resumed[0].seq).toBe(events[4].seq);
    // JSON format.
    const json = await t.req("GET", `/cycles/${ids[0]}/events?format=json&limit=2`);
    expect(json.body.events).toHaveLength(2);

    // Files.
    const files = await t.req("GET", `/cycles/${ids[0]}/files`);
    const byPath = Object.fromEntries(
      files.body.files.map((f: { path: string; status: string }) => [f.path, f.status]),
    );
    expect(byPath).toEqual({ "del.txt": "deleted", "in.txt": "unchanged", "out.txt": "added" });
    const changed = await t.req("GET", `/cycles/${ids[0]}/files?changed=true`);
    expect(changed.body.files).toHaveLength(2);
    const dl = await t.cave.app.request(`/api/v1/cycles/${ids[0]}/files/out.txt?download=true`);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(await dl.text()).toBe("out\n");
    expect((await t.req("GET", `/cycles/${ids[0]}/files/nope.txt`)).status).toBe(404);
    expect((await t.req("GET", `/cycles/${ids[0]}/files/..%2Fsecret`)).status).toBe(400);

    const zip = await t.cave.app.request(`/api/v1/cycles/${ids[0]}/files.zip`);
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer()))).sort()).toEqual([
      "in.txt",
      "out.txt",
    ]);
    const zipChanged = await t.cave.app.request(`/api/v1/cycles/${ids[0]}/files.zip?changed=true`);
    expect(Object.keys(unzipSync(new Uint8Array(await zipChanged.arrayBuffer())))).toEqual(["out.txt"]);

    const answer = await t.req("GET", `/cycles/${ids[0]}/answer`);
    expect(answer.body.answer).toEqual({ format: "markdown", text: "ok" });

    // Delete.
    expect((await t.req("DELETE", `/cycles/${ids[0]}`)).status).toBe(204);
    expect((await t.req("GET", `/cycles/${ids[0]}`)).status).toBe(404);
  });

  it("streams live events over SSE and closes at the end", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "live", model: "m/live" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.setScript("m/live", async (n) => {
      if (n === 0) {
        await gate;
        return step(p.text("Live paragraph."));
      }
      return submit("done");
    });
    const cycle = await t.startCycle({ agent: "live", prompt: "x" });
    const res = await t.cave.app.request(`/api/v1/cycles/${cycle.id}/events`);
    setTimeout(release, 100);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.type)).toContain("text");
    expect(events.at(-1)).toMatchObject({ type: "cycle.status", data: { status: "completed" } });
    // No duplicates.
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("stops queued cycles and respects the parallel limit", async () => {
    t = await createTestCave();
    await t.req("PUT", "/settings", { maxParallel: 1 });
    await t.createAgent({ slug: "q", model: "m/q" });
    t.setScript("m/q", () => step(p.call("bash", { command: "sleep 30" })));
    const a = await t.startCycle({ agent: "q", prompt: "1" });
    const b = await t.startCycle({ agent: "q", prompt: "2" });
    await until(() => t.cave.ctx.cycles.get(a.id).status === "running");
    expect(t.cave.ctx.cycles.get(b.id).status).toBe("queued");
    const health = await t.req("GET", "/health");
    expect(health.body.queue).toMatchObject({ running: 1, queued: 1, maxParallel: 1 });
    const stopped = await t.req("POST", `/cycles/${b.id}/stop`);
    expect(stopped.body.status).toBe("stopped");
    await t.req("POST", `/cycles/${a.id}/stop`);
    expect((await t.waitFor(a.id)).status).toBe("stopped");
  });

  it("re-runs with another model and keeps labels and files", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "r", model: "m/one" });
    t.setScript("m/one", () => submit("one"));
    t.setScript("m/two", (n) => (n === 0 ? step(p.call("bash", { command: "cat in.txt" })) : submit("two")));
    const first = await t.startCycle({
      agent: "r",
      prompt: "go",
      labels: { k: "v" },
      files: [{ path: "in.txt", content: "data" }],
    });
    await t.waitFor(first.id);
    const rerun = await t.req("POST", `/cycles/${first.id}/rerun`, { overrides: { model: "m/two" } });
    expect(rerun.status).toBe(202);
    const done = await t.waitFor(rerun.body.id);
    expect(done.model).toBe("m/two");
    expect(done.rerunOf).toBe(first.id);
    expect(done.source).toBe("rerun");
    expect(done.labels).toEqual({ k: "v" });
    expect(done.answer).toEqual({ format: "markdown", text: "two" });
    expect(JSON.stringify(t.events(done.id).find((e) => e.type === "tool.result")?.data)).toContain("data");
  });

  it("delivers signed webhooks with retries", async () => {
    const hooks: { body: string; headers: Headers }[] = [];
    let failures = 1;
    t = await createTestCave({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://hooks.example.com")) {
          hooks.push({ body: String(init?.body), headers: new Headers(init?.headers) });
          if (failures-- > 0) return new Response("nope", { status: 500 });
          return new Response("ok", { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    const settings = await t.req("PUT", "/settings", { webhookSecret: "generate" });
    const secret = settings.body.webhookSecret as string;
    expect(secret.length).toBeGreaterThan(10);
    await t.createAgent({ slug: "h", model: "m/h" });
    t.setScript("m/h", () => submit("hooked"));
    const c = await t.startCycle({ agent: "h", prompt: "x", webhookUrl: "https://hooks.example.com/in" });
    await t.waitFor(c.id);
    await until(() => hooks.length >= 2, 10_000);
    await until(() => t.cave.ctx.webhooks.list(c.id)[0]?.status === "delivered", 10_000);
    const last = hooks[1];
    const payload = JSON.parse(last.body) as WebhookPayload;
    expect(payload.event).toBe("cycle.completed");
    expect(payload.cycle.answer).toEqual({ format: "markdown", text: "hooked" });
    expect(last.headers.get("x-agentcave-signature")).toBe(signPayload(secret, last.body));
    const deliveries = await t.req("GET", `/cycles/${c.id}/webhooks`);
    expect(deliveries.body.deliveries[0]).toMatchObject({ status: "delivered", attempts: 2 });
  });
});

describe("system API", () => {
  it("settings, stats, health and openapi", async () => {
    t = await createTestCave();
    const s = await t.req("PUT", "/settings", {
      openrouterToken: "sk-or-v1-abcdefghijklmnop",
      maxParallel: 2,
    });
    expect(s.body.openrouterToken).toEqual({ set: true, masked: "sk-or-v1…mnop" });
    expect(JSON.stringify((await t.req("GET", "/settings")).body)).not.toContain("abcdefghijklmnop");
    expect((await t.req("PUT", "/settings", { maxParallel: 0 })).status).toBe(400);

    await t.createAgent({ slug: "s", model: "m/s" });
    t.setScript("m/s", () => submit("x"));
    const c = await t.startCycle({ agent: "s", prompt: "x" });
    await t.waitFor(c.id);
    const stats = await t.req("GET", "/stats");
    expect(stats.body.totals.cycles).toBe(1);
    expect(stats.body.byAgent[0]).toMatchObject({ key: "s", cycles: 1 });
    expect(stats.body.byModel[0].key).toBe("m/s");

    const health = await t.req("GET", "/health");
    expect(health.body).toMatchObject({ ok: true, tokenSet: true });

    const spec = await t.req("GET", "/openapi.json");
    expect(spec.body.openapi).toBe("3.1.0");
    expect(
      spec.body.paths["/cycles"].post.requestBody.content["application/json"].schema.properties.agent,
    ).toBeTruthy();

    expect((await t.req("GET", "/nope")).status).toBe(404);
  });

  it("keeps spend in usage totals after cycles are deleted", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "spender", model: "m/spend" });
    t.setScript("m/spend", () =>
      step(p.call("submit_answer", { answer: "x" }), p.finish("tool-calls", { cost: 0.25 })),
    );
    const a = await t.startCycle({ agent: "spender", prompt: "x" });
    const b = await t.startCycle({ agent: "spender", prompt: "y" });
    await t.waitFor(a.id);
    await t.waitFor(b.id);

    const totals = async () => {
      const stats = (await t.req("GET", "/stats")).body;
      const agent = (await t.req("GET", "/agents/spender")).body;
      return {
        usage: stats.totals,
        byAgent: stats.byAgent[0],
        byModel: stats.byModel[0],
        agent: agent.stats,
      };
    };
    const before = await totals();
    expect(before.usage).toMatchObject({ cycles: 2, inputTokens: 200, outputTokens: 40 });
    expect(before.usage.costUsd).toBeCloseTo(0.5);
    expect(before.agent).toMatchObject({ cycles: 2, running: 0 });
    expect(before.agent.costUsd).toBeCloseTo(0.5);

    // Deleted by hand, and by retention.
    expect((await t.req("DELETE", `/cycles/${a.id}`)).status).toBe(204);
    await t.req("PUT", "/settings", { retentionDays: 1 });
    t.cave.ctx.db
      .prepare("UPDATE cycles SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(b.id);
    expect((await t.req("POST", "/maintenance/cleanup")).body.deletedCycles).toBe(1);
    expect((await t.req("GET", "/cycles")).body.cycles).toHaveLength(0);

    expect(await totals()).toEqual(before);
  });
});
