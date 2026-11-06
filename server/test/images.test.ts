import type { Cycle, Turn, TurnImage } from "@agentcave/client";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImageError,
  moveToolImages,
  prepareImage,
  reviveImageUrls,
  sniffImage,
  toolImagePart,
} from "../src/engine/images.js";
import { maybeTrim } from "../src/engine/trim.js";
import { createTestCave, p, promptText, step, submit, type TestCave } from "./helpers.js";

const png = (width: number, height: number, alpha = false) =>
  sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: { r: 200, g: 40, b: 40, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

const jpeg = (width: number, height: number, orientation?: number) => {
  const img = sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).jpeg();
  return (orientation ? img.withMetadata({ orientation }) : img).toBuffer();
};

const SVG =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0a0"/></svg>';

describe("preparing images", () => {
  it("tells images from other files by their first bytes", async () => {
    expect(sniffImage(await png(4, 4))).toBe("png");
    expect(sniffImage(await jpeg(4, 4))).toBe("jpeg");
    expect(
      sniffImage(
        await sharp(await png(4, 4))
          .gif()
          .toBuffer(),
      ),
    ).toBe("gif");
    expect(
      sniffImage(
        await sharp(await png(4, 4))
          .webp()
          .toBuffer(),
      ),
    ).toBe("webp");
    expect(sniffImage(Buffer.from(SVG))).toBe("svg");
    expect(sniffImage(Buffer.from("hello, not an image"))).toBeNull();
    expect(sniffImage(Buffer.from("<html><svg></svg></html>"))).toBeNull();
  });

  it("sends a small PNG as it is", async () => {
    const bytes = await png(300, 200);
    const img = await prepareImage(bytes, { maxEdge: 1568 });
    expect(img.converted).toBe(false);
    expect(img.data.equals(bytes)).toBe(true);
    expect(img).toMatchObject({ mediaType: "image/png", width: 300, height: 200 });
  });

  it("scales big images down to the longest-side limit", async () => {
    const img = await prepareImage(await png(3000, 1000, true), { maxEdge: 1568 });
    expect(img).toMatchObject({ mediaType: "image/png", width: 1568, height: 523, converted: true });
    expect(img).toMatchObject({ sourceWidth: 3000, sourceHeight: 1000 });
    const photo = await prepareImage(await jpeg(4000, 3000), { maxEdge: 1000 });
    expect(photo).toMatchObject({ mediaType: "image/jpeg", width: 1000, height: 750 });
  });

  it("turns photos upright", async () => {
    // EXIF orientation 6: stored 400×200, shown 200×400.
    const img = await prepareImage(await jpeg(400, 200, 6), { maxEdge: 1568 });
    expect(img).toMatchObject({
      width: 200,
      height: 400,
      sourceWidth: 200,
      sourceHeight: 400,
      converted: true,
    });
    const meta = await sharp(img.data).metadata();
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([200, 400, 1]);
  });

  it("renders SVG and converts other formats", async () => {
    const svg = await prepareImage(Buffer.from(SVG), { maxEdge: 1568 });
    expect(svg).toMatchObject({ mediaType: "image/png", width: 400, height: 200, converted: true });
    const tiff = await prepareImage(
      await sharp(await png(50, 40))
        .tiff()
        .toBuffer(),
      { maxEdge: 1568 },
    );
    expect(tiff).toMatchObject({ mediaType: "image/png", width: 50, height: 40 });
  });

  it("explains what it can't show", async () => {
    await expect(prepareImage(Buffer.from("plain text"), { maxEdge: 1568 })).rejects.toThrow(ImageError);
    const broken = Buffer.concat([(await png(10, 10)).subarray(0, 40), Buffer.alloc(40)]);
    await expect(prepareImage(broken, { maxEdge: 1568 })).rejects.toThrow(/could not be read/);
    const bmp = Buffer.alloc(64);
    bmp.write("BM", 0, "latin1");
    await expect(prepareImage(bmp, { maxEdge: 1568 })).rejects.toThrow(/BMP/);
  });
});

describe("images in messages", () => {
  const image = { sha256: "a".repeat(64), mediaType: "image/png" };

  it("moves tool-result images into a user message after the tool results", () => {
    const data = { type: "data" as const, data: new Uint8Array([1, 2, 3]) };
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "look" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "view_image",
            output: {
              type: "content",
              value: [
                { type: "text", text: "/workspace/a.png (10×10):" },
                { type: "file", mediaType: "image/png", data },
              ],
            },
          },
          { type: "tool-result", toolCallId: "c2", toolName: "bash", output: { type: "text", value: "ok" } },
        ],
      },
    ];
    const out = moveToolImages(prompt);
    expect(out).toHaveLength(3);
    expect(JSON.stringify(out[1])).not.toContain('"file"');
    expect(JSON.stringify(out[1])).toContain("attached in the next message");
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "/workspace/a.png (10×10):" },
        { type: "file", mediaType: "image/png", data },
      ],
    });
  });

  it("puts image URLs back after a JSON round trip", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "view_image",
            output: { type: "content", value: [{ type: "text", text: "x" }, toolImagePart(image)] },
          },
        ],
      },
    ];
    const revived = reviveImageUrls(JSON.parse(JSON.stringify(messages)));
    const part = (revived[0].content[0] as { output: { value: { data?: { url?: unknown } }[] } }).output
      .value[1];
    expect(part.data?.url).toBeInstanceOf(URL);
    expect(String(part.data?.url)).toBe(`agentcave-image:${image.sha256}`);
  });

  it("counts images when estimating the context, and drops them when trimming", () => {
    const toolResult = (id: string, withImage: boolean): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: `/workspace/${id}.png` },
              ...(withImage ? [toolImagePart(image)] : []),
            ],
          },
        },
      ],
    });
    const messages = Array.from({ length: 8 }, (_, i) => toolResult(`i${i}`, true));
    // 8 images ≈ 12,800 tokens: over 60% of a 20k context, though the JSON itself is small.
    const r = maybeTrim(messages, { contextLength: 20_000, ratio: 0.6, systemChars: 0 });
    expect(r?.trimmed).toBe(2);
    const first = r!.messages[0].content[0] as { output: { type: string; value: string } };
    expect(first.output.type).toBe("text");
    expect(first.output.value).toContain("/workspace/i0.png");
    expect(first.output.value).toContain("[image]");
  });
});

// -----------------------------------------------------------------------------

const MODELS = [
  { id: "m/vision", input_modalities: ["text", "image"] },
  { id: "m/text", input_modalities: ["text"] },
];

/** A catalog where `m/vision` takes images and `m/text` does not. */
const catalogFetch = async () =>
  new Response(
    JSON.stringify({
      data: MODELS.map((m) => ({
        id: m.id,
        name: m.id,
        context_length: 200_000,
        architecture: { input_modalities: m.input_modalities },
        supported_parameters: ["tools"],
      })),
    }),
    { status: 200 },
  );

type Prompt = LanguageModelV4CallOptions["prompt"];
type FilePart = { type: "file"; mediaType: string; data: { type: string; data?: Uint8Array } };

function fileParts(prompt: Prompt): { role: string; part: FilePart }[] {
  const out: { role: string; part: FilePart }[] = [];
  for (const m of prompt) {
    if (m.role === "system") continue;
    for (const part of m.content as { type: string }[]) {
      if (part.type === "file") out.push({ role: m.role, part: part as unknown as FilePart });
    }
  }
  return out;
}

const b64 = (b: Buffer) => b.toString("base64");

let t: TestCave;
afterEach(async () => {
  await t?.close();
});

describe("vision models", () => {
  it("shows image files sent with the prompt to a vision model", async () => {
    t = await createTestCave({ fetchImpl: catalogFetch });
    await t.createAgent({ slug: "looker", model: "m/vision" });
    t.setScript("m/vision", () => submit("A red square."));
    const photo = await png(64, 48);
    const big = await png(3000, 1500);
    const cycle = await t.startCycle({
      agent: "looker",
      prompt: "What is in the pictures?",
      files: [
        { path: "notes.txt", content: "not an image" },
        { path: "pics/photo.png", content: b64(photo), encoding: "base64" },
        { path: "pics/big.png", content: b64(big), encoding: "base64" },
      ],
    });
    expect(cycle.vision).toBe(true);
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");

    // The model got both images as image parts, before the prompt text, each after a line naming it.
    const call = t.calls["m/vision"][0];
    const user = call.prompt.find((m) => m.role === "user")!;
    const content = user.content as { type: string; text?: string; mediaType?: string }[];
    expect(content.map((c) => c.type)).toEqual(["text", "file", "text", "file", "text"]);
    expect(content[0].text).toBe("/workspace/pics/big.png:");
    expect(content[2].text).toBe("/workspace/pics/photo.png:");
    expect(content[4].text).toContain("What is in the pictures?");
    expect(content[4].text).toContain("/workspace/pics/big.png (");
    expect(content[4].text).toContain("image shown above at 1568×784");
    const files = fileParts(call.prompt);
    expect(Buffer.from(files[1].part.data.data!).equals(photo)).toBe(true); // small: sent as it is
    const sent = await sharp(Buffer.from(files[0].part.data.data!)).metadata();
    expect([sent.width, sent.height]).toEqual([1568, 784]); // big: scaled down
    expect(promptText(call)).toContain("`view_image`");
    expect(call.tools?.map((tool) => tool.name)).toContain("view_image");

    // The turn, its start event and the image endpoint say what the model saw.
    const turns = (await t.req<{ turns: Turn[] }>("GET", `/cycles/${cycle.id}/turns`)).body.turns;
    expect(turns[0].images.map((i) => [i.path, i.source, i.width, i.height])).toEqual([
      ["/workspace/pics/big.png", "prompt", 1568, 784],
      ["/workspace/pics/photo.png", "prompt", 64, 48],
    ]);
    const start = t.events(cycle.id).find((e) => e.type === "turn.start");
    expect(start?.type === "turn.start" && start.data.images).toHaveLength(2);
    const res = await t.cave.app.request(`/api/v1/cycles/${cycle.id}/images/${turns[0].images[1].sha256}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(photo)).toBe(true);
    expect((await t.req("GET", `/cycles/${cycle.id}/images/${"0".repeat(64)}`)).status).toBe(404);
  });

  it("treats images as plain files for a model without vision", async () => {
    t = await createTestCave({ fetchImpl: catalogFetch });
    await t.createAgent({ slug: "reader", model: "m/text" });
    t.setScript("m/text", () => submit("ok"));
    const cycle = await t.startCycle({
      agent: "reader",
      prompt: "Describe it",
      files: [{ path: "photo.png", content: b64(await png(10, 10)), encoding: "base64" }],
    });
    expect(cycle.vision).toBe(false);
    await t.waitFor(cycle.id);
    const call = t.calls["m/text"][0];
    expect(fileParts(call.prompt)).toHaveLength(0);
    expect(call.tools?.map((tool) => tool.name)).not.toContain("view_image");
    expect(promptText(call)).toContain("/workspace/photo.png (");
    expect(promptText(call)).not.toContain("view_image");
  });

  it("says which images were not shown, and why", async () => {
    t = await createTestCave({ fetchImpl: catalogFetch });
    await t.req("PUT", "/settings", { maxPromptImages: 1 });
    await t.createAgent({ slug: "looker", model: "m/vision" });
    t.setScript("m/vision", () => submit("ok"));
    const bmp = Buffer.alloc(64);
    bmp.write("BM", 0, "latin1");
    const cycle = await t.startCycle({
      agent: "looker",
      prompt: "Look",
      files: [
        { path: "a.png", content: b64(await png(10, 10)), encoding: "base64" },
        { path: "b.png", content: b64(await png(10, 10, true)), encoding: "base64" },
        { path: "0.bmp", content: b64(bmp), encoding: "base64" },
      ],
    });
    await t.waitFor(cycle.id);
    const text = promptText(t.calls["m/vision"][0]);
    expect(text).toContain("/workspace/b.png (");
    expect(text).toContain("image not shown: only 1 image is shown with a prompt; use `view_image`");
    expect(text).toContain("image not shown: BMP images can't be shown");
    expect(fileParts(t.calls["m/vision"][0].prompt)).toHaveLength(1);
    const start = t.events(cycle.id).find((e) => e.type === "turn.start");
    expect(start?.type === "turn.start" && start.data.imagesNotShown.map((i) => i.path)).toEqual([
      "/workspace/0.bmp",
      "/workspace/b.png",
    ]);
  });

  it("lets the agent look at an image with view_image, also in later turns", async () => {
    t = await createTestCave({ fetchImpl: catalogFetch });
    await t.createAgent({ slug: "looker", model: "m/vision" });
    const svg = Buffer.from(SVG);
    t.setScript("m/vision", (n) =>
      n === 0
        ? step(p.call("bash", { command: "mkdir -p out && cp chart.svg out/chart.svg" }))
        : n === 1
          ? step(p.call("view_image", { path: "out/chart.svg" }, "view1"))
          : n === 2
            ? step(p.call("view_image", { path: "/workspace/missing.png" }, "view2"))
            : submit(`done ${n}`),
    );
    const cycle = await t.startCycle({
      agent: "looker",
      prompt: "Draw a chart and check it",
      files: [{ path: "chart.svg", content: svg.toString("utf8") }],
    });
    const done = await t.waitFor(cycle.id);
    expect(done.status).toBe("completed");

    // The SVG sent with the prompt is shown rendered.
    expect(fileParts(t.calls["m/vision"][0].prompt)).toHaveLength(1);
    // After view_image: the tool result names the image, which follows in a user message.
    const after = t.calls["m/vision"][2].prompt;
    const toolAt = after.findIndex((m) => m.role === "tool" && JSON.stringify(m.content).includes('"view1"'));
    expect(JSON.stringify(after[toolAt].content)).toContain("attached in the next message");
    const next = after[toolAt + 1];
    expect(next.role).toBe("user");
    const parts = next.content as { type: string; text?: string; data?: { data?: Uint8Array } }[];
    expect(parts[0].text).toBe("/workspace/out/chart.svg (400×200):");
    expect(parts[1].type).toBe("file");
    expect((await sharp(Buffer.from(parts[1].data!.data!)).metadata()).format).toBe("png");

    // A missing file is a tool error the model can read.
    const missing = t.events(cycle.id).find((e) => e.type === "tool.result" && e.data.callId === "view2");
    expect(missing?.type === "tool.result" && missing.data.error).toContain("does not exist");

    const turn0 = (await t.req<{ turns: Turn[] }>("GET", `/cycles/${cycle.id}/turns`)).body.turns[0];
    const viewed = turn0.images.find((i: TurnImage) => i.source === "view_image");
    expect(viewed).toMatchObject({ path: "/workspace/out/chart.svg", callId: "view1", width: 400 });

    // A follow-up reloads the saved conversation: the image is still there for the model.
    await t.req("POST", `/cycles/${cycle.id}/messages`, { prompt: "And now?" });
    const second = await t.waitFor(cycle.id);
    expect(second.status).toBe("completed");
    const followUp = t.calls["m/vision"].at(-1)!.prompt;
    expect(fileParts(followUp).map((f) => f.role)).toEqual(["user", "user"]);
    expect(fileParts(followUp).every((f) => f.part.data.data instanceof Uint8Array)).toBe(true);
  });

  it("does not show a sub-agent its parent's images with the prompt", async () => {
    t = await createTestCave({ fetchImpl: catalogFetch });
    await t.createAgent({ slug: "helper", model: "m/vision" });
    await t.createAgent({ slug: "boss", model: "m/text", subagents: ["helper"] });
    t.setScript("m/text", (n) =>
      n === 0 ? step(p.call("ask_helper", { prompt: "Look at photo.png with view_image" })) : submit("ok"),
    );
    t.setScript("m/vision", () => submit("a photo"));
    const cycle = await t.startCycle({
      agent: "boss",
      prompt: "Get help",
      files: [{ path: "photo.png", content: b64(await png(10, 10)), encoding: "base64" }],
    });
    expect((await t.waitFor(cycle.id)).status).toBe("completed");
    const child = (await t.req<{ cycles: Cycle[] }>("GET", `/cycles/${cycle.id}/children`)).body.cycles[0];
    expect(child.vision).toBe(true);
    const call = t.calls["m/vision"][0];
    expect(fileParts(call.prompt)).toHaveLength(0);
    expect(call.tools?.map((tool) => tool.name)).toContain("view_image");
  });
});
