import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NUDGE_MESSAGE } from "../src/engine/runner.js";
import { createTestCave, p, promptText, step, submit, type TestCave, until } from "./helpers.js";

let t: TestCave;
afterEach(async () => {
  await t?.close();
});

describe("agent loop", () => {
  it("runs a full cycle: thinking, text, bash, submit_answer, files and usage", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "worker", model: "m/worker" });
    t.setScript("m/worker", (n) =>
      n === 0
        ? step(
            p.reasoning("Let me look at the file.\n\nThen write the result."),
            p.text("Checking the input first."),
            p.call("bash", { command: "cat input.txt && echo done > result.txt" }),
          )
        : submit("The file says **hello**."),
    );
    const cycle = await t.startCycle({
      agent: "worker",
      prompt: "Read input.txt",
      files: [{ path: "input.txt", content: "hello" }],
      labels: { customer: "c1" },
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.answer).toEqual({ format: "markdown", text: "The file says **hello**." });
    expect(done.files).toEqual({ added: ["result.txt"], modified: [], deleted: [] });
    expect(done.usage.steps).toBe(2);
    expect(done.usage.costUsd).toBeCloseTo(0.002);
    expect(done.labels).toEqual({ customer: "c1" });

    const events = t.events(cycle.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("cycle.status");
    expect(types).toContain("turn.start");
    const reasoning = events
      .filter((e) => e.type === "reasoning")
      .map((e) => (e.data as { text: string }).text);
    expect(reasoning).toEqual(["Let me look at the file.\n\n", "Then write the result."]);
    const result = events.find((e) => e.type === "tool.result" && e.data.tool === "bash");
    expect(result?.type === "tool.result" && result.data.exitCode).toBe(0);
    expect(JSON.stringify(result?.data)).toContain("hello");
    expect(types.at(-1)).toBe("cycle.status");
    expect(types).toContain("answer");

    // The model saw the system prompt and the file list.
    const firstPrompt = promptText(t.calls["m/worker"][0]);
    expect(firstPrompt).toContain("AgentCave environment");
    expect(firstPrompt).toContain("/workspace/input.txt");

    // Files are on disk and downloadable.
    const file = await t.req("GET", `/cycles/${cycle.id}/files/result.txt`);
    expect(file.body).toBe("done\n");
  });

  it("nudges an agent that forgets submit_answer", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "forgetful", model: "m/forgetful" });
    t.setScript("m/forgetful", (n) => (n === 0 ? step(p.text("Here is my answer: 42")) : submit("42")));
    const cycle = await t.startCycle({ agent: "forgetful", prompt: "What is 6*7?" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.answer).toEqual({ format: "markdown", text: "42" });
    const nudges = t.events(cycle.id).filter((e) => e.type === "nudge");
    expect(nudges).toHaveLength(1);
    expect(promptText(t.calls["m/forgetful"][1])).toContain(NUDGE_MESSAGE.slice(0, 40));
    const turns = await t.req("GET", `/cycles/${cycle.id}/turns`);
    expect(turns.body.turns[0].nudges).toBe(1);
  });

  it("fails with no_submit after the reminders run out", async () => {
    t = await createTestCave();
    await t.req("PUT", "/settings", { maxNudges: 2 });
    await t.createAgent({ slug: "chatty", model: "m/chatty" });
    t.setScript("m/chatty", () => step(p.text("I am done (but I never submit).")));
    const cycle = await t.startCycle({ agent: "chatty", prompt: "x" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("no_submit");
    expect(t.calls["m/chatty"]).toHaveLength(3);
  });

  it("rejects an answer that does not match the JSON schema and accepts the fix", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "json", model: "m/json" });
    t.setScript("m/json", (n) =>
      n === 0
        ? step(p.call("submit_answer", { bugs: "not an array" }))
        : step(p.call("submit_answer", { bugs: ["off by one"] })),
    );
    const cycle = await t.startCycle({
      agent: "json",
      prompt: "Find bugs",
      outputSchema: {
        type: "object",
        properties: { bugs: { type: "array", items: { type: "string" } } },
        required: ["bugs"],
      },
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.answer).toEqual({ format: "json", data: { bugs: ["off by one"] } });
    const errors = t.events(cycle.id).filter((e) => e.type === "tool.result" && e.data.error);
    expect(errors).toHaveLength(1);
    expect(promptText(t.calls["m/json"][1])).toContain("does not match");
  });

  it("stops at the money limit", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "spender", model: "m/spender", limits: { maxCostUsd: 1 } });
    t.setScript("m/spender", () =>
      step(p.call("bash", { command: "echo hi" }), p.finish("tool-calls", { cost: 0.6 })),
    );
    const cycle = await t.startCycle({ agent: "spender", prompt: "x" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("limit_money");
    expect(done.usage.costUsd).toBeCloseTo(1.2);
  });

  it("stops at the token limit and estimates cost when the provider sends none", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "tokens", model: "m/tokens" });
    t.setScript("m/tokens", () =>
      step(
        p.call("bash", { command: "echo hi" }),
        p.finish("tool-calls", { cost: null, input: 600, output: 10 }),
      ),
    );
    const cycle = await t.startCycle({
      agent: "tokens",
      prompt: "x",
      overrides: { limits: { maxTokens: 1000 } },
    });
    const done = await t.waitFor(cycle.id);
    expect(done.error?.code).toBe("limit_tokens");
    expect(done.usage.costEstimated).toBe(true);
  });

  it("stops at the time limit", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "slow", model: "m/slow", limits: { maxTimeSec: 1 } });
    t.setScript("m/slow", () => step(p.call("bash", { command: "sleep 30" })));
    const cycle = await t.startCycle({ agent: "slow", prompt: "x" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("limit_time");
  });

  it("can be stopped while a command is running", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "sleeper", model: "m/sleeper" });
    t.setScript("m/sleeper", () => step(p.call("bash", { command: "sleep 30" })));
    const cycle = await t.startCycle({ agent: "sleeper", prompt: "x" });
    await until(() => t.events(cycle.id).some((e) => e.type === "tool.call"));
    const started = Date.now();
    const r = await t.req("POST", `/cycles/${cycle.id}/stop`);
    expect(r.status).toBe(200);
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("follow-ups keep the memory and the files", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "memo", model: "m/memo" });
    t.setScript("m/memo", (n) => {
      if (n === 0) return step(p.call("bash", { command: "echo 'secret=7' > notes.txt" }));
      if (n === 1) return submit("Saved.");
      if (n === 2) return step(p.call("bash", { command: "cat notes.txt" }));
      return submit("It was 7.");
    });
    const cycle = await t.startCycle({ agent: "memo", prompt: "Remember 7" });
    await t.waitFor(cycle.id);
    const r = await t.req("POST", `/cycles/${cycle.id}/messages`, {
      prompt: "What was it?",
      files: [{ path: "extra.txt", content: "more" }],
    });
    expect(r.status).toBe(202);
    const done = await t.waitFor(cycle.id, ["completed", "failed", "stopped"]);
    await until(
      () =>
        t.cave.ctx.cycles.get(cycle.id).turn === 1 && t.cave.ctx.cycles.get(cycle.id).status === "completed",
    );
    const final = t.cave.ctx.cycles.get(cycle.id);
    expect(final.turns).toBe(2);
    expect(final.answer).toEqual({ format: "markdown", text: "It was 7." });
    expect(done).toBeTruthy();
    // The third model call (turn 1) includes turn 0's conversation.
    const prompt = promptText(t.calls["m/memo"][2]);
    expect(prompt).toContain("Remember 7");
    expect(prompt).toContain("What was it?");
    expect(prompt).toContain("/workspace/extra.txt");
    const result = t
      .events(cycle.id)
      .filter((e) => e.type === "tool.result")
      .at(-2);
    expect(JSON.stringify(result?.data)).toContain("secret=7");
  });

  it("refuses follow-ups while running", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "busy", model: "m/busy" });
    t.setScript("m/busy", () => step(p.call("bash", { command: "sleep 30" })));
    const cycle = await t.startCycle({ agent: "busy", prompt: "x" });
    await until(() => t.events(cycle.id).some((e) => e.type === "tool.call"));
    const r = await t.req("POST", `/cycles/${cycle.id}/messages`, { prompt: "more" });
    expect(r.status).toBe(409);
    await t.req("POST", `/cycles/${cycle.id}/stop`);
    await t.waitFor(cycle.id);
  });

  it("mounts the agent's own files read-only at /agent", async () => {
    t = await createTestCave();
    await t.createAgent({
      slug: "reader",
      model: "m/reader",
      files: { upsert: [{ path: "docs/guide.md", content: "# Guide\nuse tabs" }] },
    });
    t.setScript("m/reader", (n) =>
      n === 0
        ? step(p.call("bash", { command: "cat /agent/docs/guide.md; echo x > /agent/new.txt; echo exit=$?" }))
        : submit("ok"),
    );
    const cycle = await t.startCycle({ agent: "reader", prompt: "x" });
    await t.waitFor(cycle.id);
    const result = t.events(cycle.id).find((e) => e.type === "tool.result");
    const out =
      result?.type === "tool.result" ? (result.data.output as { stdout: string; stderr: string }) : null;
    expect(out?.stdout).toContain("use tabs");
    // Writes to /agent stay in memory: the stored agent files never change.
    const agentDirs = fs.readdirSync(path.join(t.dataDir, "agents")).filter((n) => !n.endsWith(".complete"));
    expect(agentDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(t.dataDir, "agents", agentDirs[0], "new.txt"))).toBe(false);
    expect(fs.existsSync(path.join(t.dataDir, "agents", agentDirs[0], "docs", "guide.md"))).toBe(true);
  });

  it("shortens huge command output and saves the full text in /tmp", async () => {
    t = await createTestCave();
    await t.req("PUT", "/settings", { toolOutputCapBytes: 2048 });
    await t.createAgent({ slug: "big", model: "m/big" });
    t.setScript("m/big", (n) =>
      n === 0
        ? step(p.call("bash", { command: "seq 1 5000" }))
        : n === 1
          ? step(p.call("bash", { command: "tail -n 1 /tmp/agentcave/out-1.txt" }))
          : submit("ok"),
    );
    const cycle = await t.startCycle({ agent: "big", prompt: "x" });
    await t.waitFor(cycle.id);
    const results = t.events(cycle.id).filter((e) => e.type === "tool.result");
    const first = results[0];
    expect(first.type === "tool.result" && first.data.truncated).toBe(true);
    const out = first.type === "tool.result" ? (first.data.output as { stdout: string }) : null;
    expect(out!.stdout.length).toBeLessThan(2600);
    const second = results[1];
    expect(JSON.stringify(second.data)).toContain("5000");
  });

  it("reports model errors", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "broken", model: "m/broken" });
    t.setScript("m/broken", () => {
      throw Object.assign(new Error("Provider exploded"), { statusCode: 500 });
    });
    const cycle = await t.startCycle({ agent: "broken", prompt: "x" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("model_error");
    expect(done.error?.message).toContain("Provider exploded");
  });
});

describe("sub-agents", () => {
  it("runs a sub-agent on a copy of the workspace and copies its files back", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "helper", model: "m/helper", description: "Writes summaries" });
    await t.createAgent({ slug: "boss", model: "m/boss", subagents: ["helper"] });
    t.setScript("m/helper", (n, options) => {
      if (n === 0) {
        expect(promptText(options)).toContain("Summarise data.txt");
        return step(
          p.call("bash", { command: "cat data.txt | wc -l > summary.txt" }),
          p.finish("tool-calls", { cost: 0.01 }),
        );
      }
      return step(
        p.call("submit_answer", { answer: "Wrote summary.txt" }),
        p.finish("tool-calls", { cost: 0.01 }),
      );
    });
    t.setScript("m/boss", (n) => {
      if (n === 0) return step(p.call("ask_helper", { prompt: "Summarise data.txt" }));
      if (n === 1) return step(p.call("bash", { command: "cat .subagents/helper-1/summary.txt" }));
      return submit("Summary has 3 lines.");
    });
    const cycle = await t.startCycle({
      agent: "boss",
      prompt: "Delegate",
      files: [{ path: "data.txt", content: "a\nb\nc\n" }],
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    const kids = await t.req("GET", `/cycles/${cycle.id}/children`);
    expect(kids.body.cycles).toHaveLength(1);
    const child = kids.body.cycles[0];
    expect(child.parentId).toBe(cycle.id);
    expect(child.depth).toBe(1);
    expect(child.status).toBe("completed");
    expect(child.source).toBe("subagent");
    // Usage rolls up: parent own = 3 steps * 0.001, child = 0.02.
    expect(done.totalUsage.costUsd).toBeCloseTo(0.023);
    expect(done.usage.costUsd).toBeCloseTo(0.003);
    // The turn's limits count the sub-agent too.
    expect(done.limitUsage.costUsd).toBeCloseTo(0.023);
    // Copied-back file.
    const bash = t.events(cycle.id).filter((e) => e.type === "tool.result" && e.data.tool === "bash");
    expect(JSON.stringify(bash[0].data)).toContain("3");
    const sub = t.events(cycle.id).filter((e) => e.type.startsWith("subagent."));
    expect(sub.map((e) => e.type)).toEqual(["subagent.start", "subagent.end"]);
    // Sub-agent cycles are hidden from the default list.
    const list = await t.req("GET", "/cycles");
    expect(list.body.cycles.map((c: { id: string }) => c.id)).toEqual([cycle.id]);
  });

  it("stopping the parent stops the sub-agent", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "sleepy", model: "m/sleepy" });
    await t.createAgent({ slug: "parent", model: "m/parent", subagents: ["sleepy"] });
    t.setScript("m/sleepy", () => step(p.call("bash", { command: "sleep 30" })));
    t.setScript("m/parent", () => step(p.call("ask_sleepy", { prompt: "sleep" })));
    const cycle = await t.startCycle({ agent: "parent", prompt: "x" });
    await until(() =>
      t.cave.ctx.cycles.children(cycle.id).some((c) => c.progress.activity?.includes("sleep")),
    );
    await t.req("POST", `/cycles/${cycle.id}/stop`);
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("stopped");
    expect(t.cave.ctx.cycles.children(cycle.id)[0].status).toBe("stopped");
  });

  it("respects the depth limit", async () => {
    t = await createTestCave();
    await t.req("PUT", "/settings", { subagentMaxDepth: 0 });
    await t.createAgent({ slug: "leaf", model: "m/leaf" });
    await t.createAgent({ slug: "root", model: "m/root", subagents: ["leaf"] });
    t.setScript("m/root", (n) =>
      n === 0 ? step(p.call("ask_leaf", { prompt: "x" })) : submit("did it myself"),
    );
    const cycle = await t.startCycle({ agent: "root", prompt: "x" });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(JSON.stringify(t.events(cycle.id).find((e) => e.type === "tool.result")?.data)).toContain(
      "depth limit",
    );
  });
});

describe("continue after a limit", () => {
  it("continues a turn stopped by the token limit, with its memory, step numbers and usage", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "big-task", model: "m/big", limits: { maxTokens: 1000 } });
    t.setScript("m/big", (n) =>
      n < 2
        ? step(
            p.call("bash", { command: `echo part-${n}` }),
            p.finish("tool-calls", { input: 600, output: 10 }),
          )
        : submit("All parts done."),
    );
    const cycle = await t.startCycle({ agent: "big-task", prompt: "Do the big task" });
    const stopped = await t.waitFor(cycle.id);
    expect(stopped.error?.code).toBe("limit_tokens");
    expect(stopped.limitUsage.tokens).toBe(1220);

    const r = await t.req("POST", `/cycles/${cycle.id}/continue`, {});
    expect(r.status).toBe(202);
    expect(["queued", "running"]).toContain(r.body.status);
    expect(r.body.error).toBeNull();
    // No room left under 1000 tokens: +50% of the limit on top of what was used.
    expect(r.body.limits.maxTokens).toBe(1720);
    await until(() => t.cave.ctx.cycles.get(cycle.id).status === "completed");

    const done = t.cave.ctx.cycles.get(cycle.id);
    expect(done.answer).toEqual({ format: "markdown", text: "All parts done." });
    expect(done.turns).toBe(1);
    expect(done.usage.steps).toBe(3);
    expect(done.limitUsage.tokens).toBe(1340);
    // The model saw the whole turn so far, then the continue message.
    const prompt = promptText(t.calls["m/big"][2]);
    expect(prompt).toContain("Do the big task");
    expect(prompt).toContain("part-0");
    expect(prompt).toContain("part-1");
    expect(prompt).toContain("You were stopped before you finished");
    const events = t.events(cycle.id);
    const cont = events.find((e) => e.type === "turn.continue");
    expect(cont?.type === "turn.continue" && cont.data.after.code).toBe("limit_tokens");
    expect(cont?.type === "turn.continue" && cont.data.used.tokens).toBe(1220);
    expect(events.filter((e) => e.type === "turn.start")).toHaveLength(1);
    const steps = events.flatMap((e) => (e.type === "step.start" ? [e.data.step] : []));
    expect(steps).toEqual([1, 2, 3]);
    // The webhook-facing turn list shows one turn that completed.
    const turns = await t.req("GET", `/cycles/${cycle.id}/turns`);
    expect(turns.body.turns.map((x: { status: string }) => x.status)).toEqual(["completed"]);
  });

  it("keeps the finished steps when the time limit cuts a run short, and continues from them", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "slowpoke", model: "m/slowpoke", limits: { maxTimeSec: 1 } });
    t.setScript("m/slowpoke", (n) => {
      if (n === 0) return step(p.call("bash", { command: "echo draft > report.md && echo saved-draft" }));
      if (n === 1) return step(p.call("bash", { command: "sleep 30" }));
      return submit("Report finished.");
    });
    const cycle = await t.startCycle({ agent: "slowpoke", prompt: "Write the report" });
    const stopped = await t.waitFor(cycle.id);
    expect(stopped.error?.code).toBe("limit_time");
    expect(stopped.limitUsage.timeSec).toBe(1);
    expect(t.cave.ctx.cycles.latestTurn(cycle.id).messages).toContain("saved-draft");

    const r = await t.req("POST", `/cycles/${cycle.id}/continue`, {
      limits: { maxTimeSec: 30 },
      message: "Skip the slow part.",
    });
    expect(r.status).toBe(202);
    await until(() => t.cave.ctx.cycles.get(cycle.id).status === "completed");
    const done = t.cave.ctx.cycles.get(cycle.id);
    expect(done.limits.maxTimeSec).toBe(30);
    expect(done.answer).toEqual({ format: "markdown", text: "Report finished." });
    // Files from both runs count as the turn's changes.
    expect(done.files).toEqual({ added: ["report.md"], modified: [], deleted: [] });
    const prompt = promptText(t.calls["m/slowpoke"][2]);
    expect(prompt).toContain("saved-draft");
    expect(prompt).toContain("Skip the slow part.");
  });

  it("gives a turn stopped by the step cap another round of steps", async () => {
    t = await createTestCave();
    await t.req("PUT", "/settings", { hardStepCap: 2 });
    await t.createAgent({ slug: "looper", model: "m/looper" });
    t.setScript("m/looper", (n) =>
      n < 3 ? step(p.call("bash", { command: `echo ${n}` })) : submit("Got there."),
    );
    const cycle = await t.startCycle({ agent: "looper", prompt: "x" });
    const stopped = await t.waitFor(cycle.id);
    expect(stopped.error?.code).toBe("limit_steps");
    const r = await t.req("POST", `/cycles/${cycle.id}/continue`);
    expect(r.status).toBe(202);
    // No limit was exhausted, so none changed.
    expect(r.body.limits).toEqual(stopped.limits);
    await until(() => t.cave.ctx.cycles.get(cycle.id).status === "completed");
    expect(promptText(t.calls["m/looper"][2])).toContain("up to 2 more steps");
  });

  it("refuses cycles that did not stop on a limit, and limits that leave no room", async () => {
    t = await createTestCave();
    await t.createAgent({ slug: "spend", model: "m/spend", limits: { maxCostUsd: 1 } });
    await t.createAgent({ slug: "quick", model: "m/quick" });
    t.setScript("m/spend", () =>
      step(p.call("bash", { command: "echo hi" }), p.finish("tool-calls", { cost: 0.6 })),
    );
    t.setScript("m/quick", () => submit("ok"));

    const quick = await t.startCycle({ agent: "quick", prompt: "x" });
    await t.waitFor(quick.id);
    const notLimited = await t.req("POST", `/cycles/${quick.id}/continue`, {});
    expect(notLimited.status).toBe(409);
    expect(notLimited.body.error.code).toBe("not_continuable");

    const spender = await t.startCycle({ agent: "spend", prompt: "x" });
    const stopped = await t.waitFor(spender.id);
    expect(stopped.error?.code).toBe("limit_money");
    const tooLow = await t.req("POST", `/cycles/${spender.id}/continue`, { limits: { maxCostUsd: 1.1 } });
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error.code).toBe("no_room");
    expect(t.cave.ctx.cycles.get(spender.id).status).toBe("failed");
    const bad = await t.req("POST", `/cycles/${spender.id}/continue`, { extendPercent: -5 });
    expect(bad.status).toBe(400);
  });
});

describe("upgrading", () => {
  it("continues a turn the time limit stopped before turns could be continued", async () => {
    const first = await createTestCave();
    const dataDir = first.dataDir;
    await first.createAgent({ slug: "legacy", model: "m/legacy", limits: { maxTimeSec: 1 } });
    first.setScript("m/legacy", (n) =>
      n === 0
        ? step(p.call("bash", { command: "echo half > notes.md" }))
        : step(p.reasoning("Thinking about the rest…"), p.call("bash", { command: "sleep 30" })),
    );
    const cycle = await first.startCycle({ agent: "legacy", prompt: "Write the notes" });
    expect((await first.waitFor(cycle.id)).error?.code).toBe("limit_time");
    await first.cave.close();

    // Put the database back the way the previous version left such a turn: only the prompt was
    // saved, and the columns of migration 2 did not exist.
    const db = new DatabaseSync(path.join(dataDir, "agentcave.db"));
    const turn = db.prepare("SELECT messages FROM turns WHERE cycle_id = ?").get(cycle.id) as {
      messages: string;
    };
    const promptOnly = JSON.stringify(JSON.parse(turn.messages).slice(0, 1));
    db.prepare("UPDATE turns SET messages = ? WHERE cycle_id = ?").run(promptOnly, cycle.id);
    for (const col of ["elapsed_ms", "run_started_at", "spent_usd", "spent_tokens", "last_step", "resume"])
      db.exec(`ALTER TABLE turns DROP COLUMN ${col}`);
    db.exec("PRAGMA user_version = 1");
    db.close();

    t = await createTestCave({ dataDir });
    const migrated = t.cave.ctx.cycles.get(cycle.id);
    expect(migrated.limitUsage.timeSec).toBeGreaterThanOrEqual(1);
    t.setScript("m/legacy", () => submit("Notes done."));
    const r = await t.req("POST", `/cycles/${cycle.id}/continue`, {});
    expect(r.status).toBe(202);
    await until(() => t.cave.ctx.cycles.get(cycle.id).status === "completed");
    // Its memory of the run was lost, so the agent is pointed at the files instead.
    expect(promptText(t.calls["m/legacy"][0])).toContain("look at `/workspace`");
    expect(t.cave.ctx.cycles.get(cycle.id).files?.added).toEqual(["notes.md"]);
    // The step cut off mid-way keeps its number: the continued run starts after it.
    const steps = t.events(cycle.id).flatMap((e) => (e.type === "step.start" ? [e.data.step] : []));
    expect(steps).toEqual([1, 2, 3]);
    await t.close();
    t = undefined as unknown as TestCave;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("restart recovery", () => {
  it("re-queues a cycle that was running when the container stopped and runs it again", async () => {
    const first = await createTestCave({ start: false });
    const dataDir = first.dataDir;
    await first.createAgent({ slug: "again", model: "m/again" });
    const cycle = await first.startCycle({
      agent: "again",
      prompt: "x",
      files: [{ path: "in.txt", content: "1" }],
    });
    // Simulate a crash mid-run: running status, start snapshot already taken, a file already modified.
    const turn = first.cave.ctx.cycles.latestTurn(cycle.id);
    first.cave.ctx.cycles.markRunning(cycle.id, turn.id);
    const ws = first.cave.runner.workspaceDir(cycle.id);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "in.txt"), "1");
    first.cave.ctx.cycles.setStartSnapshot(turn.id, await first.cave.ctx.blobs.snapshotDir(ws));
    fs.writeFileSync(path.join(ws, "in.txt"), "half-done garbage");
    await first.cave.close();

    t = await createTestCave({ dataDir });
    t.setScript("m/again", (n) =>
      n === 0 ? step(p.call("bash", { command: "cat in.txt" })) : submit("restarted"),
    );
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    expect(t.events(cycle.id).some((e) => e.type === "restart")).toBe(true);
    // The workspace was restored from the snapshot before the retry.
    const result = t.events(cycle.id).find((e) => e.type === "tool.result" && e.attempt === 1);
    expect(result).toBeDefined();
    expect((result!.data as { output: { stdout: string } }).output.stdout).toBe("1");
    await t.close();
    t = undefined as unknown as TestCave;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
