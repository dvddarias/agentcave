import {
  HTTP_COMMAND_TIMEOUT_SEC,
  type HttpCommand,
  MAX_HTTP_COMMANDS,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type StartCycleRequest,
} from "@agentcave/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CommandCard } from "../components/CommandCard";
import { JsonEditor } from "../components/Editors";
import { FileDrop } from "../components/FileDrop";
import { IconCode, IconPlay, IconPlus, IconX } from "../components/icons";
import { CodeBlock } from "../components/Markdown";
import { ModelPicker, useModels } from "../components/ModelPicker";
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
  Toggle,
} from "../components/ui";
import { api, keys, publicUrl } from "../lib/api";
import type { PickedFile } from "../lib/files";

let labelSeq = 0;

/** Files the server will likely treat as images (it checks their content). */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|tiff?|svg)$/i;

const EXAMPLE_COMMANDS = `[
  {
    "name": "get_order_status",
    "description": "Get the current status of an order by its id. Prints JSON: { status, items[], updatedAt }.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "orderId": { "type": "string", "description": "The order id, e.g. A1" }
      },
      "required": ["orderId"]
    },
    "url": "https://shop.example.com/agent-tools/order-status",
    "headers": { "Authorization": "Bearer <token>" },
    "timeoutSec": 20
  },
  {
    "name": "search_orders",
    "description": "Find a customer's orders. Prints a JSON array of { id, status, total }.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "customerId": { "type": "string", "description": "The customer id", "examples": ["c-1042"] },
        "status": { "type": "string", "enum": ["pending", "shipped", "delivered"], "description": "Only orders with this status" },
        "limit": { "type": "integer", "default": 20, "description": "How many orders at most" },
        "tag": { "type": "array", "items": { "type": "string" }, "description": "Only orders with all these tags" },
        "includeItems": { "type": "boolean", "description": "Add each order's items" }
      },
      "required": ["customerId"]
    },
    "url": "https://shop.example.com/agent-tools/search-orders",
    "headers": { "Authorization": "Bearer <token>" }
  }
]`;

/** Parses the Commands editor. The server checks the rest (name clashes, schema validity). */
function parseCommands(text: string): { commands: HttpCommand[] } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(value)) return { error: "Commands must be a JSON array: [ { name, description, … } ]" };
  if (value.length > MAX_HTTP_COMMANDS) return { error: `At most ${MAX_HTTP_COMMANDS} commands` };
  const names = new Set<string>();
  for (const [i, c] of value.entries()) {
    const at = `Command ${i + 1}`;
    if (!c || typeof c !== "object" || Array.isArray(c)) return { error: `${at} must be an object` };
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(o.name))
      return { error: `${at}: name must match ^[a-z][a-z0-9_-]{0,63}$` };
    if (names.has(o.name)) return { error: `${at}: the name ${o.name} is used twice` };
    names.add(o.name);
    if (typeof o.description !== "string" || !o.description.trim())
      return { error: `${o.name}: description is required` };
    const schema = o.inputSchema as Record<string, unknown> | undefined;
    if (!schema || typeof schema !== "object" || schema.type !== "object")
      return { error: `${o.name}: inputSchema must be a JSON Schema with "type": "object"` };
    if (typeof o.url !== "string" || !/^https?:\/\/\S+$/.test(o.url))
      return { error: `${o.name}: url must be an http(s) URL` };
    if (
      o.headers !== undefined &&
      (!o.headers ||
        typeof o.headers !== "object" ||
        Object.values(o.headers).some((v) => typeof v !== "string"))
    )
      return { error: `${o.name}: headers must be an object of strings` };
    if (
      o.timeoutSec !== undefined &&
      (typeof o.timeoutSec !== "number" || o.timeoutSec <= 0 || o.timeoutSec > HTTP_COMMAND_TIMEOUT_SEC.max)
    )
      return { error: `${o.name}: timeoutSec must be between 0 and ${HTTP_COMMAND_TIMEOUT_SEC.max}` };
  }
  return { commands: value as HttpCommand[] };
}

export function PlaygroundPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: keys.agents(), queryFn: () => api.agents.list() });
  const [agent, setAgent] = useState(params.get("agent") ?? "");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningEffort | "">("");
  const [maxTimeSec, setMaxTimeSec] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [useSchema, setUseSchema] = useState(false);
  const [schema, setSchema] = useState(
    '{\n  "type": "object",\n  "properties": {\n    "summary": { "type": "string" }\n  },\n  "required": ["summary"]\n}',
  );
  const [labels, setLabels] = useState<{ id: number; k: string; v: string }[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [useCommands, setUseCommands] = useState(false);
  const [commandsText, setCommandsText] = useState(EXAMPLE_COMMANDS);
  const [commandsView, setCommandsView] = useState<"preview" | "json">("preview");
  const parsedCommands = useMemo(
    () => (useCommands ? parseCommands(commandsText) : null),
    [useCommands, commandsText],
  );
  const commandsError = parsedCommands && "error" in parsedCommands ? parsedCommands.error : null;
  const [curlOpen, setCurlOpen] = useState(false);

  useEffect(() => {
    if (!agent && agents.data?.length) setAgent(agents.data[0].slug);
  }, [agents.data, agent]);
  const current = agents.data?.find((a) => a.slug === agent);
  const models = useModels();
  const modelId = model || current?.config.model || "";
  const sees = models.data?.models.find((m) => m.id === modelId)?.supportsImages;
  const images = files.filter((f) => IMAGE_FILE.test(f.path)).length;

  const request = useMemo((): StartCycleRequest | null => {
    if (!agent) return null;
    const limits: Record<string, number> = {};
    if (maxTimeSec) limits.maxTimeSec = Number(maxTimeSec);
    if (maxCostUsd) limits.maxCostUsd = Number(maxCostUsd);
    if (maxTokens) limits.maxTokens = Number(maxTokens);
    const overrides: StartCycleRequest["overrides"] = {};
    if (model) overrides.model = model;
    if (reasoning) overrides.reasoning = reasoning;
    if (Object.keys(limits).length) overrides.limits = limits;
    let outputSchema: StartCycleRequest["outputSchema"];
    if (useSchema) {
      try {
        outputSchema = JSON.parse(schema);
      } catch {
        outputSchema = undefined;
      }
    }
    const labelObj = Object.fromEntries(labels.filter((l) => l.k.trim()).map((l) => [l.k.trim(), l.v]));
    return {
      agent,
      prompt,
      ...(files.length ? { files: files.map((f) => f.input) } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(Object.keys(labelObj).length ? { labels: labelObj } : {}),
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      ...(parsedCommands && "commands" in parsedCommands ? { commands: parsedCommands.commands } : {}),
    };
  }, [
    agent,
    prompt,
    files,
    model,
    reasoning,
    maxTimeSec,
    maxCostUsd,
    maxTokens,
    useSchema,
    schema,
    labels,
    webhookUrl,
    parsedCommands,
  ]);

  const start = useMutation({
    mutationFn: () => api.cycles.start({ ...request!, source: "ui" }),
    onSuccess: (c) => navigate(`/cycles/${c.id}`),
  });

  if (agents.data && agents.data.length === 0) {
    return (
      <div>
        <PageHeader title="Playground" subtitle="Try an agent with your own prompt and files." />
        <Empty title="You have no agents yet">
          <Link to="/agents/new" className="text-torch-400 hover:underline">
            Create your first agent
          </Link>{" "}
          to start testing.
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Playground"
        subtitle="Try an agent exactly like the API would: prompt, files and optional overrides. Then watch it think."
        actions={
          <Button variant="ghost" onClick={() => setCurlOpen(true)} disabled={!request}>
            <IconCode size={15} /> Copy as curl
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card className="p-4">
            <Field label="Agent">
              <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
                {agents.data?.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.config.name} ({a.slug}) · v{a.currentVersion}
                  </option>
                ))}
              </Select>
            </Field>
            {current?.config.description ? (
              <p className="mt-2 text-xs text-cave-400">{current.config.description}</p>
            ) : null}
          </Card>
          <Card className="p-4">
            <Field label="Prompt">
              <Textarea
                rows={10}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && !commandsError)
                    start.mutate();
                }}
                placeholder="What should the agent do? (Ctrl+Enter to run)"
                className="font-mono text-[13px]"
              />
            </Field>
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-xs font-medium text-cave-300">Files (put into /workspace)</div>
            <FileDrop files={files} onChange={setFiles} />
            {images > 0 && sees !== undefined ? (
              <div className={cx("mt-2 text-[11px]", sees ? "text-cave-400" : "text-torch-300")}>
                {sees
                  ? `${modelId} can see images: ${images === 1 ? "the image is" : "they are"} shown to it with the prompt.`
                  : `${modelId} can’t see images: ${images === 1 ? "it stays a plain file" : "they stay plain files"} in /workspace.`}
              </div>
            ) : null}
          </Card>
          <Card className="space-y-3 p-4">
            <Toggle
              checked={useCommands}
              onChange={setUseCommands}
              label="Commands"
              hint="HTTP commands the agent can run like any other (get_order_status --orderId A1). AgentCave POSTs to your URL from the server; the headers stay secret."
            />
            {useCommands ? (
              <CommandsInput
                text={commandsText}
                onChange={setCommandsText}
                parsed={parsedCommands}
                view={commandsView}
                onView={setCommandsView}
              />
            ) : null}
          </Card>
          <ErrorBox error={start.error} />
          <div className="flex items-center justify-end gap-3">
            {commandsError ? <span className="text-xs text-rose-300">Fix the commands first.</span> : null}
            <Button
              variant="primary"
              disabled={!prompt.trim() || !agent || !!commandsError}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              <IconPlay size={14} /> Run cycle
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card className="space-y-4 p-4">
            <div className="text-xs font-semibold tracking-wider text-cave-400 uppercase">
              Overrides (this cycle only)
            </div>
            <Field label="Model" hint={current ? `Agent default: ${current.config.model}` : undefined}>
              <ModelPicker value={model} onChange={setModel} allowEmpty />
            </Field>
            <Field
              label="Reasoning"
              hint={current ? `Agent default: ${current.config.reasoning}` : undefined}
            >
              <Select
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value as ReasoningEffort | "")}
              >
                <option value="">Agent default</option>
                {REASONING_EFFORTS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Max sec">
                <Input
                  inputMode="numeric"
                  value={maxTimeSec}
                  onChange={(e) => setMaxTimeSec(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Max $">
                <Input
                  inputMode="decimal"
                  value={maxCostUsd}
                  onChange={(e) => setMaxCostUsd(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Max tokens">
                <Input
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="—"
                />
              </Field>
            </div>
          </Card>
          <Card className="space-y-3 p-4">
            <Toggle
              checked={useSchema}
              onChange={setUseSchema}
              label="JSON answer"
              hint={
                current?.config.outputSchema
                  ? "The agent already has a default schema; this overrides it."
                  : "Get a checked JSON object instead of Markdown."
              }
            />
            {useSchema ? <JsonEditor value={schema} onChange={setSchema} height={200} /> : null}
          </Card>
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold tracking-wider text-cave-400 uppercase">Labels</div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLabels([...labels, { id: ++labelSeq, k: "", v: "" }])}
              >
                <IconPlus size={13} /> Add
              </Button>
            </div>
            {labels.map((l, i) => (
              <div key={l.id} className="flex gap-1.5">
                <Input
                  value={l.k}
                  placeholder="key"
                  className="font-mono text-xs"
                  onChange={(e) =>
                    setLabels(labels.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))
                  }
                />
                <Input
                  value={l.v}
                  placeholder="value"
                  className="font-mono text-xs"
                  onChange={(e) =>
                    setLabels(labels.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className="px-1 text-cave-500 hover:text-rose-300"
                  onClick={() => setLabels(labels.filter((_, j) => j !== i))}
                >
                  <IconX size={14} />
                </button>
              </div>
            ))}
            <Field label="Webhook URL" hint="Optional. Called when the cycle finishes.">
              <Input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://…"
                className="font-mono text-xs"
              />
            </Field>
          </Card>
        </div>
      </div>
      <CurlModal open={curlOpen} onClose={() => setCurlOpen(false)} request={request} />
    </div>
  );
}

/** The Playground's commands: shown as cards (what the agent gets), edited as JSON. */
function CommandsInput({
  text,
  onChange,
  parsed,
  view,
  onView,
}: {
  text: string;
  onChange: (v: string) => void;
  parsed: ReturnType<typeof parseCommands> | null;
  view: "preview" | "json";
  onView: (v: "preview" | "json") => void;
}) {
  const error = parsed && "error" in parsed ? parsed.error : null;
  const commands = parsed && "commands" in parsed ? parsed.commands : [];
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="flex gap-0.5 rounded-lg bg-cave-900 p-0.5">
          {(["preview", "json"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className={cx(
                "rounded-md px-2.5 py-0.5 text-xs",
                view === v ? "bg-cave-700 text-cave-100" : "text-cave-400 hover:text-cave-200",
              )}
            >
              {v === "preview" ? "Preview" : "JSON"}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-cave-500">
          {error ? "" : `${commands.length} command${commands.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {view === "json" ? (
        <>
          <JsonEditor value={text} onChange={onChange} height={300} />
          {error && !error.startsWith("Not valid JSON") ? (
            <p className="text-[11px] text-rose-400">{error}</p>
          ) : null}
        </>
      ) : error ? (
        <div className="rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
          {error}{" "}
          <button type="button" onClick={() => onView("json")} className="text-torch-400 hover:underline">
            Edit the JSON
          </button>
        </div>
      ) : commands.length === 0 ? (
        <p className="text-xs text-cave-500">
          No commands.{" "}
          <button type="button" onClick={() => onView("json")} className="text-torch-400 hover:underline">
            Add some in JSON
          </button>
        </p>
      ) : (
        <div className="space-y-2">
          {commands.map((c) => (
            <CommandCard key={c.name} command={c} defaultOpen={commands.length === 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function CurlModal({
  open,
  onClose,
  request,
}: {
  open: boolean;
  onClose: () => void;
  request: StartCycleRequest | null;
}) {
  const body = request
    ? JSON.stringify(
        {
          ...request,
          files: request.files?.map((f) => ({
            ...f,
            content: f.content.length > 200 ? `${f.content.slice(0, 200)}…` : f.content,
          })),
        },
        null,
        2,
      )
    : "{}";
  const cmd = `curl -X POST ${publicUrl}/api/v1/cycles \\\n  -H 'content-type: application/json' \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  return (
    <Modal open={open} onClose={onClose} title="The same request with curl" wide>
      <p className="mb-3 text-sm text-cave-400">
        Long file contents are shortened here. Poll{" "}
        <code className="font-mono text-cave-200">GET /api/v1/cycles/&lt;id&gt;</code> or stream{" "}
        <code className="font-mono text-cave-200">/events</code> afterwards.
      </p>
      <CodeBlock code={cmd} lang="bash" maxHeight={460} />
    </Modal>
  );
}
