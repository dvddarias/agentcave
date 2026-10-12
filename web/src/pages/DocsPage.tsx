import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import typesSource from "../../../client/src/types.ts?raw";
import { IconChevron } from "../components/icons";
import { CodeBlock } from "../components/Markdown";
import { Card, cx, PageHeader, Pill, Tabs } from "../components/ui";
import { api, keys } from "../lib/api";

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
  const base = `${window.location.origin}/api/v1`;
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="API docs"
        subtitle={
          <>
            Base URL <code className="font-mono text-cave-200">{base}</code> · JSON everywhere · no
            authentication built in (put your own proxy in front) ·{" "}
            <a className="text-torch-400 hover:underline" href="/api/v1/openapi.json">
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
      <Step n={5} title="Follow up, stop, re-run">
        <CodeBlock
          lang="bash"
          code={`# Continue the same conversation and sandbox (only when the cycle has finished)
curl -X POST ${base}/cycles/cyc_01JA…/messages -H 'content-type: application/json' -d '{"prompt":"Now fix them."}'

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
      <Step n={7} title="TypeScript client">
        <p className="text-sm text-cave-400">
          The repository ships <code className="font-mono">@agentcave/client</code>: zero dependencies, works
          in Node 20+ and browsers.
        </p>
        <CodeBlock
          lang="typescript"
          code={`import { AgentCave } from "@agentcave/client";

const cave = new AgentCave({ baseUrl: "${window.location.origin}" });
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
