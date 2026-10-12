# @agentcave/client

Tiny typed client for the [AgentCave](../README.md) HTTP API. No dependencies; uses `fetch`. Works in Node 20+ and browsers.

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
const done = await cave.cycles.wait(cycle.id, { timeoutMs: 20 * 60_000 });
console.log(done.status, done.answer, done.files);

// Follow up, stop, re-run, files
await cave.cycles.followUp(cycle.id, { prompt: "Now fix them." });
await cave.cycles.stop(cycle.id);
const zip = await cave.cycles.downloadZip(cycle.id, { changedOnly: true });
```

Errors are thrown as `AgentCaveError` with `status`, `code` and `message`.

All request/response types (`Cycle`, `CycleEvent`, `Agent`, …) are exported from the package and documented in [`src/types.ts`](src/types.ts).
