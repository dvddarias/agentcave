/**
 * One tiny real cycle against OpenRouter. Skipped unless OPENROUTER_TOKEN_TEST is set.
 *   OPENROUTER_TOKEN_TEST=sk-or-… npm run test:smoke -w @agentcave/server
 * Optional: OPENROUTER_SMOKE_MODEL=<model id> (default: a cheap tool-capable model from the catalog), and
 * OPENROUTER_SMOKE_VISION_MODEL=<model id> for the image test (default: a cheap one that takes images).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
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

  it("shows a vision model a prompt image and one it opens with view_image", {
    timeout: 180_000,
  }, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcave-smoke-"));
    const cave = await createAgentCave({ dataDir });
    try {
      cave.ctx.settings.update({ openrouterToken: token! });
      let model = process.env.OPENROUTER_SMOKE_VISION_MODEL;
      if (!model) {
        const { models } = await cave.ctx.models.list({ refresh: true });
        model = models
          .filter((m) => m.supportsImages && m.pricing.prompt > 0 && /mini|flash|haiku|small/i.test(m.id))
          .sort(
            (a, b) => a.pricing.prompt + a.pricing.completion - (b.pricing.prompt + b.pricing.completion),
          )[0]?.id;
      }
      expect(model, "no vision model found for the smoke test").toBeTruthy();
      await cave.ctx.agents.create({
        slug: "smoke-vision",
        name: "Smoke vision",
        model,
        reasoning: "off",
        systemPrompt: "You are a terse assistant. Always use the tools you are given.",
      });
      cave.start();
      const square = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer();
      const circle =
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><circle cx="100" cy="100" r="80" fill="#0000ff"/></svg>';
      const cycle = await cave.cycles.start({
        agent: "smoke-vision",
        prompt:
          "square.png is shown to you. Use the view_image tool to look at /workspace/circle.svg. Then call submit_answer with two lowercase colour words, separated by a space: the colour of the square, then the colour of the circle.",
        files: [
          { path: "square.png", content: square.toString("base64"), encoding: "base64" },
          { path: "circle.svg", content: circle },
        ],
        overrides: { limits: { maxCostUsd: 0.05, maxTimeSec: 120 } },
      });
      expect(cycle.vision).toBe(true);
      for (;;) {
        const c = cave.ctx.cycles.get(cycle.id);
        if (["completed", "failed", "stopped"].includes(c.status)) {
          expect(c.error).toBeNull();
          const answer = JSON.stringify(c.answer).toLowerCase();
          expect(answer).toContain("red");
          expect(answer).toContain("blue");
          const [turn] = cave.ctx.cycles.turns(cycle.id);
          expect(turn.images.map((i) => i.source)).toEqual(["prompt", "view_image"]);
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
