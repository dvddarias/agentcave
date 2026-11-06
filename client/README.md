# @agentcave/client

Tiny typed client for the [AgentCave](https://github.com/dvddarias/agentcave) HTTP API. No dependencies; uses `fetch`. ESM, works in Node 20+ and browsers.

## Install

Straight from the GitHub Releases:

```bash
# a fixed version (recommended)
npm install https://github.com/dvddarias/agentcave/releases/download/v0.4.1/agentcave-client-0.4.1.tgz
# or the build of the latest push to main (re-run this command to update)
npm install https://github.com/dvddarias/agentcave/releases/download/client-latest/agentcave-client.tgz
```

## Use

```ts
import { AgentCave, fileInput } from "@agentcave/client";

const cave = new AgentCave({ baseUrl: "http://localhost:7420" });

// Start a cycle (binary files: fileInput() base64-encodes Uint8Array content)
const cycle = await cave.cycles.start({
  agent: "code-reviewer",
  prompt: "Review src/app.ts",
  files: [fileInput("src/app.ts", source), fileInput("logo.png", pngBytes)],
  labels: { ticket: "ABC-9" },
});

// Live events (thinking/text arrive about one paragraph at a time)
for await (const e of cave.cycles.events(cycle.id)) {
  if (e.type === "tool.call") console.log("tool:", e.data.tool, e.data.input);
  if (e.type === "text") process.stdout.write(e.data.text);
}

// …or just wait (polls every 2 s)
let done = await cave.cycles.wait(cycle.id, { timeoutMs: 20 * 60_000 });
console.log(done.status, done.answer, done.files);

// A limit stopped it before the answer? Give it more room and let it carry on (same turn, memory and files)
if (done.error?.code.startsWith("limit_")) {
  await cave.cycles.continue(cycle.id, { extendPercent: 50, message: "Wrap up and submit." });
  done = await cave.cycles.wait(cycle.id);
}

// Follow up, stop, re-run, files
await cave.cycles.followUp(cycle.id, { prompt: "Now fix them." });
await cave.cycles.stop(cycle.id);
const zip = await cave.cycles.downloadZip(cycle.id, { changedOnly: true });
```

HTTP commands give the agent commands that call your own systems (AgentCave POSTs an `HttpCommandCall` to your URL from the server; the headers never reach the model):

```ts
const orderStatus: HttpCommand = {
  name: "get_order_status",
  description: "Get the current status of an order by its id. Prints JSON: { status, items[], updatedAt }.",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  url: "https://shop.example.com/agent-tools/order-status",
  headers: { Authorization: `Bearer ${token}` },
};
const support = await cave.cycles.start({ agent: "support-agent", prompt: "Where is A1?", commands: [orderStatus] });
// Later, with a fresh token (replaces the commands from this turn on)
await cave.cycles.followUp(support.id, {
  prompt: "And B2?",
  commands: [{ ...orderStatus, headers: { Authorization: `Bearer ${freshToken}` } }],
});
for await (const e of cave.cycles.events(support.id)) {
  if (e.type === "http.call") console.log(e.data.command, e.data.status, `${e.data.ms} ms`);
}
```

With a model that takes images (`cycle.vision`), image files are shown to it with the prompt, and it can open others with its `view_image` tool. Each turn lists what it saw:

```ts
const shot = await cave.cycles.start({
  agent: "designer",
  prompt: "What is wrong with this form?",
  files: [fileInput("form.png", pngBytes)],
});
await cave.cycles.wait(shot.id);
const [turn] = await cave.cycles.turns(shot.id);
for (const img of turn.images) console.log(img.path, img.source, cave.cycles.imageUrl(shot.id, img.sha256));
```

Errors are thrown as `AgentCaveError` with `status`, `code` and `message`.

All request/response types (`Cycle`, `CycleEvent`, `Agent`, …) are exported from the package and documented in [`src/types.ts`](src/types.ts).
