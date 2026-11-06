import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import typesSource from "../../../client/src/types.ts?raw";
import { IconChevron } from "../components/icons";
import { CodeBlock } from "../components/Markdown";
import { Card, cx, PageHeader, Pill, Tabs } from "../components/ui";
import { api, keys, publicUrl } from "../lib/api";

interface OpenApiOp {
  tags: string[];
  summary: string;
  description?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
  requestBody?: { content: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description: string; content?: Record<string, { example?: unknown }> }>;
}
type Spec = { paths: Record<string, Record<string, OpenApiOp>> };

const METHOD_COLOR: Record<string, string> = {
  get: "bg-sky-950 text-sky-300 border-sky-900",
  post: "bg-emerald-950 text-emerald-300 border-emerald-900",
  put: "bg-torch-700/20 text-torch-300 border-torch-700/50",
  delete: "bg-rose-950 text-rose-300 border-rose-900",
};

type Section = "guide" | "reference" | "types";

export function DocsPage() {
  const [section, setSection] = useState<Section>("guide");
  const base = `${publicUrl}/api/v1`;
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="API docs"
        subtitle={
          <>
            Base URL <code className="font-mono text-cave-200">{base}</code> · JSON everywhere · no
            authentication built in (put your own proxy in front) ·{" "}
            <a className="text-torch-400 hover:underline" href={api.url("/openapi.json")}>
              openapi.json
            </a>
          </>
        }
      />
      <Tabs
        className="mb-6"
        value={section}
        onChange={setSection}
        tabs={[
          { id: "guide", label: "Quick start" },
          { id: "reference", label: "Endpoints" },
          { id: "types", label: "TypeScript types" },
        ]}
      />
      {section === "guide" ? (
        <Guide base={base} />
      ) : section === "reference" ? (
        <Reference />
      ) : (
        <CodeBlock code={typesSource} lang="typescript" />
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[40px_1fr]">
      <div className="flex size-8 items-center justify-center rounded-full border border-torch-700/60 bg-torch-500/10 font-mono text-sm text-torch-300">
        {n}
      </div>
      <div className="min-w-0 space-y-2">
        <h2 className="text-base font-semibold text-cave-100">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Guide({ base }: { base: string }) {
  return (
    <div className="space-y-10">
      <Step n={1} title="Start a cycle">
        <p className="text-sm text-cave-400">
          Pick an agent by slug, send a prompt and any files (text as-is, binary as base64). Optional:
          overrides, a JSON answer schema, labels and a webhook. You get the cycle back right away with status{" "}
          <code className="font-mono">queued</code>.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -X POST ${base}/cycles \\
  -H 'content-type: application/json' \\
  -d '{
    "agent": "code-reviewer",
    "prompt": "Review src/app.ts and list real bugs only.",
    "files": [
      { "path": "src/app.ts", "content": "export const x = 1;\\n" },
      { "path": "logo.png", "content": "iVBORw0KGgo…", "encoding": "base64" }
    ],
    "overrides": { "model": "openai/gpt-5.2", "reasoning": "high", "limits": { "maxCostUsd": 0.5 } },
    "outputSchema": { "type": "object", "properties": { "bugs": { "type": "array", "items": { "type": "string" } } }, "required": ["bugs"] },
    "labels": { "customer": "123" },
    "webhookUrl": "https://example.com/agentcave-hook"
  }'`}
        />
      </Step>
      <Step n={2} title="Poll the status">
        <p className="text-sm text-cave-400">
          <code className="font-mono">status</code> is <code className="font-mono">queued</code> →{" "}
          <code className="font-mono">running</code> → <code className="font-mono">completed</code> |{" "}
          <code className="font-mono">failed</code> | <code className="font-mono">stopped</code>.{" "}
          <code className="font-mono">progress.activity</code> tells you what the agent is doing right now.
        </p>
        <CodeBlock lang="bash" code={`curl ${base}/cycles/cyc_01JA…`} />
        <CodeBlock
          lang="json"
          code={`{
  "id": "cyc_01JA…",
  "status": "running",
  "progress": { "steps": 5, "activity": "running bash: grep -rn TODO src/", "lastParagraph": "I found three…" },
  "usage": { "inputTokens": 48211, "outputTokens": 2210, "costUsd": 0.0412, … },
  "answer": null,
  "error": null
}`}
        />
      </Step>
      <Step n={3} title="…or stream it live (Server-Sent Events)">
        <p className="text-sm text-cave-400">
          Thinking and text arrive about one paragraph at a time; tool calls and results as they happen. The
          stream ends after the final status. Resume with{" "}
          <code className="font-mono">?after=&lt;seq&gt;</code>.
        </p>
        <CodeBlock lang="bash" code={`curl -N ${base}/cycles/cyc_01JA…/events`} />
        <CodeBlock
          lang="bash"
          code={`data: {"seq":7,"type":"reasoning","data":{"step":1,"blockId":"s1-r0","text":"Let me look at the files first.\\n\\n"}, …}
data: {"seq":8,"type":"tool.call","data":{"step":1,"callId":"call_1","tool":"bash","input":{"command":"ls -R"}}, …}
data: {"seq":9,"type":"tool.result","data":{"callId":"call_1","output":{"stdout":"src\\n…","exitCode":0}, …}}
data: {"seq":15,"type":"answer","data":{"answer":{"format":"json","data":{"bugs":["…"]}},"files":{…}}}
data: {"seq":17,"type":"cycle.status","data":{"status":"completed","error":null}}`}
        />
      </Step>
      <Step n={4} title="Get the answer and the files">
        <CodeBlock
          lang="bash"
          code={`curl ${base}/cycles/cyc_01JA…/answer                     # { status, answer, files, error }
curl ${base}/cycles/cyc_01JA…/files?changed=true         # what the agent added / modified / deleted
curl -O ${base}/cycles/cyc_01JA…/files/report.md         # one file
curl -o out.zip '${base}/cycles/cyc_01JA…/files.zip?changed=true'`}
        />
      </Step>
      <Step n={5} title="Follow up, continue after a limit, stop, re-run">
        <p className="text-sm text-cave-400">
          A follow-up is a new turn with fresh limits. If a limit stopped a turn that was nearly done (
          <code className="font-mono">error.code</code> <code className="font-mono">limit_time</code>,{" "}
          <code className="font-mono">limit_money</code>, <code className="font-mono">limit_tokens</code> or{" "}
          <code className="font-mono">limit_steps</code>), <code className="font-mono">continue</code> runs
          the same turn on from its last finished step, with the same memory and files. What it already used
          still counts: <code className="font-mono">cycle.limitUsage</code> shows how much. With no body, each
          exhausted limit gets +50% of itself as new room.
        </p>
        <CodeBlock
          lang="bash"
          code={`# Continue the same conversation and sandbox (only when the cycle has finished)
curl -X POST ${base}/cycles/cyc_01JA…/messages -H 'content-type: application/json' -d '{"prompt":"Now fix them."}'

# A limit stopped it: give it 50% more room and let it carry on where it stopped
curl -X POST ${base}/cycles/cyc_01JA…/continue
# …or set the new limits yourself (totals for the turn), with a note for the agent
curl -X POST ${base}/cycles/cyc_01JA…/continue -H 'content-type: application/json' \\
  -d '{"limits":{"maxTimeSec":1500},"message":"You were close. Write the report now."}'

# Stop it (sub-agents stop too)
curl -X POST ${base}/cycles/cyc_01JA…/stop

# Run the first prompt again as a new cycle, maybe with another model
curl -X POST ${base}/cycles/cyc_01JA…/rerun -H 'content-type: application/json' -d '{"overrides":{"model":"anthropic/claude-sonnet-5.5"}}'`}
        />
      </Step>
      <Step n={6} title="Webhooks">
        <p className="text-sm text-cave-400">
          At the end of every turn AgentCave POSTs{" "}
          <code className="font-mono">{"{ event, turn, sentAt, cycle }"}</code> to your{" "}
          <code className="font-mono">webhookUrl</code> (<code className="font-mono">cycle.completed</code>,{" "}
          <code className="font-mono">cycle.failed</code> or <code className="font-mono">cycle.stopped</code>
          ). Failed deliveries are retried 5 times. With a signing secret (Settings), verify it like this:
        </p>
        <CodeBlock
          lang="typescript"
          code={`import { createHmac, timingSafeEqual } from "node:crypto";

function isFromAgentCave(rawBody: string, header: string | undefined, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return !!header && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}`}
        />
      </Step>
      <Step n={7} title="HTTP commands: let the agent reach your own systems">
        <p className="text-sm text-cave-400">
          Give a cycle <code className="font-mono">commands</code> and each one becomes a real command in the
          sandbox, like <code className="font-mono">get_order_status --orderId A1</code>. AgentCave runs it on
          the server: it checks the flags against <code className="font-mono">inputSchema</code>, then POSTs{" "}
          <code className="font-mono">{"{ command, input, cycleId, turn, callId, labels }"}</code> to your{" "}
          <code className="font-mono">url</code> with your <code className="font-mono">headers</code>. The
          response body is the command's stdout. The headers are secret: the model never sees them and the API
          only shows them masked. Because they are commands, the agent can use pipes, loops,{" "}
          <code className="font-mono">jq</code> and files, so big responses stay out of its context.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -X POST ${base}/cycles \\
  -H 'content-type: application/json' \\
  -d '{
    "agent": "support-agent",
    "prompt": "Where are orders A1 and B2?",
    "commands": [{
      "name": "get_order_status",
      "description": "Get the current status of an order by its id. Prints JSON: { status, items[], updatedAt }.",
      "inputSchema": {
        "type": "object",
        "properties": { "orderId": { "type": "string", "description": "The order id, e.g. A1" } },
        "required": ["orderId"]
      },
      "url": "https://shop.example.com/agent-tools/order-status",
      "headers": { "Authorization": "Bearer <short-lived token>" },
      "timeoutSec": 20
    }]
  }'`}
        />
        <p className="text-sm text-cave-400">What the agent can then do inside the sandbox:</p>
        <CodeBlock
          lang="bash"
          code={`get_order_status --help                       # flags, an example, exit codes
for id in A1 B2 C3; do get_order_status --orderId "$id"; done | jq -r '.status'
get_order_status --orderId A1 > /tmp/a1.json && jq '.items | length' /tmp/a1.json
echo '{"orderId":"A1"}' | get_order_status --json -`}
        />
        <ul className="list-disc space-y-1 pl-5 text-sm text-cave-400">
          <li>
            Flags follow the schema's top-level properties: numbers and booleans are converted (
            <code className="font-mono">--flag</code>, <code className="font-mono">--no-flag</code>), arrays
            repeat the flag, and objects go through <code className="font-mono">--json</code>.
          </li>
          <li>
            Exit codes: <code className="font-mono">0</code> success (2xx),{" "}
            <code className="font-mono">1</code> the call failed (any other status, timeout, network error;
            the reason and the first 2 KB of the body are on stderr), <code className="font-mono">2</code> bad
            arguments (nothing was sent). Redirects are not followed, and responses over 10 MB fail.
          </li>
          <li>
            The server makes the call, so the agent's internet mode doesn't matter, and any URL works,{" "}
            <strong className="text-cave-300">internal addresses included</strong>: the caller chooses it,
            like a <code className="font-mono">webhookUrl</code>.
          </li>
          <li>
            <code className="font-mono">timeoutSec</code> (default 20, max 120) is per call. A whole bash
            command line also has the sandbox's command time limit (Settings, default 60 s), shared by every
            call in it: a loop of many calls must finish within it, or the line is cut (exit 124) and its
            output is lost. Files written before that are kept.
          </li>
          <li>
            The commands stay for follow-ups, <code className="font-mono">continue</code> and restarts. A
            follow-up or re-run with <code className="font-mono">commands</code> replaces them (e.g. a fresh
            token); <code className="font-mono">[]</code> removes them.
          </li>
          <li>
            Every call is also an <code className="font-mono">http.call</code> event (input, status, time and
            the first 2 KB of the response, never the headers).
          </li>
        </ul>
        <p className="text-sm text-cave-400">
          A small receiver (Node) that only trusts signed calls (Settings → webhook signing secret):
        </p>
        <CodeBlock
          lang="typescript"
          code={`import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.AGENTCAVE_SECRET!; // the signing secret from Settings
const TOKEN = process.env.AGENT_TOOLS_TOKEN!; // what you put in the command's "headers"

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const expected = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const sig = String(req.headers["x-agentcave-signature"] ?? "");
  const signed = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!signed || req.headers.authorization !== \`Bearer \${TOKEN}\`) {
    res.writeHead(401).end("not allowed");
    return;
  }
  const { command, input } = JSON.parse(raw); // also: cycleId, turn, callId, labels
  if (command === "get_order_status") {
    const order = await findOrder(input.orderId); // your code
    res.writeHead(order ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(order ?? { error: \`no order \${input.orderId}\` }));
    return;
  }
  res.writeHead(404).end(\`unknown command \${command}\`);
}).listen(8080);`}
        />
      </Step>
      <Step n={8} title="TypeScript client">
        <p className="text-sm text-cave-400">
          The repository ships <code className="font-mono">@agentcave/client</code>: zero dependencies, works
          in Node 20+ and browsers.
        </p>
        <CodeBlock
          lang="typescript"
          code={`import { AgentCave } from "@agentcave/client";

const cave = new AgentCave({ baseUrl: "${publicUrl}" });
const { id } = await cave.cycles.start({ agent: "code-reviewer", prompt: "Review this", files });

for await (const ev of cave.cycles.events(id)) {
  if (ev.type === "text") process.stdout.write(ev.data.text);
}
const done = await cave.cycles.wait(id);          // or poll yourself
console.log(done.answer, done.files);
const zip = await cave.cycles.downloadZip(id, { changedOnly: true });`}
        />
      </Step>
    </div>
  );
}

function Reference() {
  const spec = useQuery({
    queryKey: keys.openapi,
    queryFn: () => api.request<Spec>("GET", "/openapi.json"),
    staleTime: Infinity,
  });
  const groups = useMemo(() => {
    const out = new Map<string, { method: string; path: string; op: OpenApiOp }[]>();
    for (const [path, ops] of Object.entries(spec.data?.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        const tag = op.tags[0] ?? "Other";
        if (!out.has(tag)) out.set(tag, []);
        out.get(tag)!.push({ method, path, op });
      }
    }
    return [...out.entries()];
  }, [spec.data]);
  return (
    <div className="space-y-8">
      {groups.map(([tag, ops]) => (
        <div key={tag}>
          <h2 className="mb-3 text-xs font-semibold tracking-wider text-cave-400 uppercase">{tag}</h2>
          <Card className="divide-y divide-cave-800 overflow-hidden">
            {ops.map((o) => (
              <Endpoint key={`${o.method} ${o.path}`} {...o} />
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}

function Endpoint({ method, path, op }: { method: string; path: string; op: OpenApiOp }) {
  const [open, setOpen] = useState(false);
  const body = op.requestBody?.content?.["application/json"]?.schema;
  const example = Object.values(op.responses ?? {})[0]?.content?.["application/json"]?.example;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-cave-800/60"
      >
        <span
          className={cx(
            "w-16 rounded border px-1.5 py-0.5 text-center font-mono text-[10px] uppercase",
            METHOD_COLOR[method],
          )}
        >
          {method}
        </span>
        <span className="font-mono text-sm text-cave-100">{path}</span>
        <span className="ml-auto truncate text-xs text-cave-400">{op.summary}</span>
        <IconChevron
          size={13}
          className={cx("shrink-0 text-cave-500 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="space-y-3 bg-cave-925 px-4 py-4">
          {op.description ? (
            <p className="text-sm whitespace-pre-line text-cave-300">{op.description.replace(/`/g, "")}</p>
          ) : null}
          {op.parameters?.length ? (
            <table className="w-full text-xs">
              <tbody className="divide-y divide-cave-800">
                {op.parameters.map((p) => (
                  <tr key={p.name}>
                    <td className="py-1.5 pr-3 font-mono text-cave-100">{p.name}</td>
                    <td className="py-1.5 pr-3">
                      <Pill>{p.in}</Pill>{" "}
                      {p.required ? <Pill className="text-torch-300">required</Pill> : null}
                    </td>
                    <td className="py-1.5 text-cave-400">{p.description?.replace(/`/g, "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {body ? (
            <div>
              <div className="mb-1 text-[11px] tracking-wider text-cave-500 uppercase">
                Request body (JSON Schema)
              </div>
              <CodeBlock code={JSON.stringify(body, null, 2)} lang="json" maxHeight={360} />
            </div>
          ) : null}
          {example ? (
            <div>
              <div className="mb-1 text-[11px] tracking-wider text-cave-500 uppercase">Example response</div>
              <CodeBlock code={JSON.stringify(example, null, 2)} lang="json" maxHeight={360} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
