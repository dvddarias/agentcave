/**
 * One tiny real cycle against OpenRouter. Skipped unless OPENROUTER_TOKEN_TEST is set.
 *   OPENROUTER_TOKEN_TEST=sk-or-… npm run test:smoke -w @agentcave/server
 * Optional: OPENROUTER_SMOKE_MODEL=<model id> (default: a cheap tool-capable model from the catalog).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentCave } from "../src/app.js";

const token = process.env.OPENROUTER_TOKEN_TEST;

describe.skipIf(!token)("OpenRouter smoke test", () => {
  it("runs a real cycle that uses bash and submit_answer", { timeout: 180_000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcave-smoke-"));
    const cave = await createAgentCave({ dataDir });
    try {
      cave.ctx.settings.update({ openrouterToken: token! });
      let model = process.env.OPENROUTER_SMOKE_MODEL;
      if (!model) {
        const { models } = await cave.ctx.models.list({ refresh: true });
        const cheap = models
          .filter(
            (m) => m.pricing.prompt > 0 && m.contextLength >= 32_000 && /mini|flash|haiku|small/i.test(m.id),
          )
          .sort(
            (a, b) => a.pricing.prompt + a.pricing.completion - (b.pricing.prompt + b.pricing.completion),
          );
        model = cheap[0]?.id;
      }
      expect(model, "no model found for the smoke test").toBeTruthy();
      await cave.ctx.agents.create({
        slug: "smoke",
        name: "Smoke",
        model,
        reasoning: "off",
        systemPrompt: "You are a terse assistant. Always use the tools you are given.",
      });
      cave.start();
      const cycle = await cave.cycles.start({
        agent: "smoke",
        prompt:
          "Use the bash tool to run `cat note.txt`, then call submit_answer with exactly the file's content.",
        files: [{ path: "note.txt", content: "agentcave-smoke-ok" }],
        overrides: { limits: { maxCostUsd: 0.05, maxTimeSec: 120 } },
      });
      for (;;) {
        const c = cave.ctx.cycles.get(cycle.id);
        if (["completed", "failed", "stopped"].includes(c.status)) {
          expect(c.error).toBeNull();
          expect(c.status).toBe("completed");
          expect(JSON.stringify(c.answer)).toContain("agentcave-smoke-ok");
          expect(c.usage.costUsd).toBeGreaterThan(0);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await cave.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
