import { REASONING_EFFORTS, type ReasoningEffort, type StartCycleRequest } from "@agentcave/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { JsonEditor } from "../components/Editors";
import { FileDrop } from "../components/FileDrop";
import { IconCode, IconPlay, IconPlus, IconX } from "../components/icons";
import { CodeBlock } from "../components/Markdown";
import { ModelPicker } from "../components/ModelPicker";
import {
  Button,
  Card,
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
import { api, keys } from "../lib/api";
import type { PickedFile } from "../lib/files";

let labelSeq = 0;

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
  const [curlOpen, setCurlOpen] = useState(false);

  useEffect(() => {
    if (!agent && agents.data?.length) setAgent(agents.data[0].slug);
  }, [agents.data, agent]);
  const current = agents.data?.find((a) => a.slug === agent);

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
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) start.mutate();
                }}
                placeholder="What should the agent do? (Ctrl+Enter to run)"
                className="font-mono text-[13px]"
              />
            </Field>
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-xs font-medium text-cave-300">Files (put into /workspace)</div>
            <FileDrop files={files} onChange={setFiles} />
          </Card>
          <ErrorBox error={start.error} />
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!prompt.trim() || !agent}
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

function CurlModal({
  open,
  onClose,
  request,
}: {
  open: boolean;
  onClose: () => void;
  request: StartCycleRequest | null;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:7420";
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
  const cmd = `curl -X POST ${origin}/api/v1/cycles \\\n  -H 'content-type: application/json' \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
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
