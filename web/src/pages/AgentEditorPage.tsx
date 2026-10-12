import {
  type Agent,
  type AgentConfig,
  type AgentInput,
  type InternetMode,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@agentcave/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { JsonEditor, MarkdownEditor } from "../components/Editors";
import { FileDrop } from "../components/FileDrop";
import {
  IconAlert,
  IconChevron,
  IconDownload,
  IconFile,
  IconFlask,
  IconHistory,
  IconTrash,
  IconX,
} from "../components/icons";
import { CodeBlock } from "../components/Markdown";
import { ModelPicker, useModels } from "../components/ModelPicker";
import {
  Button,
  cx,
  ErrorBox,
  Field,
  Input,
  Modal,
  Pill,
  Select,
  Spinner,
  Tabs,
  Textarea,
  Toggle,
} from "../components/ui";
import { api, errorText, keys } from "../lib/api";
import { diffLines } from "../lib/diff";
import type { PickedFile } from "../lib/files";
import { formatBytes, formatDate, timeAgo } from "../lib/format";

const STARTER_PROMPT = `# Role

You are a careful, capable assistant.

# How to work

1. Look at the files in \`/workspace\` before drawing conclusions.
2. Use bash to search, read and check things; prefer facts over guesses.
3. Keep the final answer short, structured and actionable.
`;

const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" }
  },
  "required": ["summary"]
}`;

interface Form {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  reasoning: ReasoningEffort;
  internetMode: InternetMode;
  allowlist: string;
  javascript: boolean;
  python: boolean;
  maxTimeSec: string;
  maxCostUsd: string;
  maxTokens: string;
  subagents: string[];
  useSchema: boolean;
  schema: string;
}

function toForm(slug: string, c: AgentConfig): Form {
  return {
    slug,
    name: c.name,
    description: c.description,
    systemPrompt: c.systemPrompt,
    model: c.model,
    reasoning: c.reasoning,
    internetMode: c.internet.mode,
    allowlist: c.internet.allowlist.join("\n"),
    javascript: c.javascript,
    python: c.python,
    maxTimeSec: c.limits.maxTimeSec?.toString() ?? "",
    maxCostUsd: c.limits.maxCostUsd?.toString() ?? "",
    maxTokens: c.limits.maxTokens?.toString() ?? "",
    subagents: c.subagents,
    useSchema: !!c.outputSchema,
    schema: c.outputSchema ? JSON.stringify(c.outputSchema, null, 2) : DEFAULT_SCHEMA,
  };
}

const EMPTY: Form = {
  slug: "",
  name: "",
  description: "",
  systemPrompt: STARTER_PROMPT,
  model: "",
  reasoning: "medium",
  internetMode: "none",
  allowlist: "",
  javascript: false,
  python: false,
  maxTimeSec: "",
  maxCostUsd: "",
  maxTokens: "",
  subagents: [],
  useSchema: false,
  schema: DEFAULT_SCHEMA,
};

function toInput(f: Form): AgentInput {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const limits: AgentInput["limits"] = {};
  if (num(f.maxTimeSec) !== undefined) limits.maxTimeSec = num(f.maxTimeSec);
  if (num(f.maxCostUsd) !== undefined) limits.maxCostUsd = num(f.maxCostUsd);
  if (num(f.maxTokens) !== undefined) limits.maxTokens = num(f.maxTokens);
  return {
    name: f.name.trim(),
    description: f.description,
    systemPrompt: f.systemPrompt,
    model: f.model,
    reasoning: f.reasoning,
    internet: {
      mode: f.internetMode,
      allowlist: f.allowlist
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    },
    javascript: f.javascript,
    python: f.python,
    limits,
    subagents: f.subagents,
    outputSchema: f.useSchema ? JSON.parse(f.schema) : null,
  };
}

type Tab = "prompt" | "files" | "schema" | "versions";

export function AgentEditorPage() {
  const { slug } = useParams();
  const isNew = !slug || slug === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const agentQ = useQuery({
    queryKey: keys.agent(slug ?? ""),
    queryFn: () => api.agents.get(slug!),
    enabled: !isNew,
  });
  const all = useQuery({ queryKey: keys.agents(), queryFn: () => api.agents.list() });
  const models = useModels();
  const [form, setForm] = useState<Form>(EMPTY);
  const [base, setBase] = useState<Form>(EMPTY);
  const [pendingFiles, setPendingFiles] = useState<PickedFile[]>([]);
  const [removedFiles, setRemovedFiles] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("prompt");
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (agentQ.data) {
      const f = toForm(agentQ.data.slug, agentQ.data.config);
      setForm(f);
      setBase(f);
      setPendingFiles([]);
      setRemovedFiles([]);
    } else if (isNew) {
      setForm(EMPTY);
      setBase(EMPTY);
    }
  }, [agentQ.data, isNew]);

  const dirty =
    JSON.stringify(form) !== JSON.stringify(base) || pendingFiles.length > 0 || removedFiles.length > 0;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (confirm("You have unsaved changes. Leave anyway?")) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const modelInfo = models.data?.models.find((m) => m.id === form.model);
  let schemaError: string | null = null;
  if (form.useSchema) {
    try {
      JSON.parse(form.schema);
    } catch (e) {
      schemaError = errorText(e);
    }
  }

  const save = useMutation({
    mutationFn: async (): Promise<Agent> => {
      const input = toInput(form);
      if (pendingFiles.length || removedFiles.length) {
        input.files = { upsert: pendingFiles.map((f) => f.input), remove: removedFiles };
      }
      if (note.trim()) input.note = note.trim();
      if (isNew) return api.agents.create({ ...input, slug: form.slug, name: form.name.trim() || form.slug });
      return api.agents.update(slug!, input);
    },
    onSuccess: (a) => {
      setSaveError(null);
      setNote("");
      const f = toForm(a.slug, a.config);
      setBase(f);
      setForm(f);
      setPendingFiles([]);
      setRemovedFiles([]);
      qc.setQueryData(keys.agent(a.slug), a);
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: keys.versions(a.slug) });
      if (isNew) setTimeout(() => navigate(`/agents/${a.slug}`, { replace: true }), 0);
    },
    onError: (e) => setSaveError(e),
  });

  const archive = useMutation({
    mutationFn: async () => {
      if (agentQ.data?.archived) await api.agents.unarchive(slug!);
      else await api.agents.archive(slug!);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: keys.agent(slug!) });
    },
  });

  if (!isNew && agentQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-cave-400">
        <Spinner />
      </div>
    );
  }
  if (!isNew && agentQ.error) {
    return (
      <div className="p-8">
        <ErrorBox error={agentQ.error} />
      </div>
    );
  }
  const agent = agentQ.data;
  const others = (all.data ?? []).filter((a) => a.slug !== slug);
  const canSave =
    dirty && !!form.model && (!isNew || /^[a-z0-9][a-z0-9-]{0,62}$/.test(form.slug)) && !schemaError;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cave-800 bg-cave-950/80 px-4 py-3 md:px-6">
        <Link to="/agents" className="text-xs text-cave-500 hover:text-cave-300">
          Agents
        </Link>
        <IconChevron size={12} className="text-cave-600" />
        <span className="text-sm font-semibold text-cave-100">{isNew ? "New agent" : form.name || slug}</span>
        {agent ? (
          <Pill className="font-mono">
            {agent.slug} · v{agent.currentVersion}
          </Pill>
        ) : null}
        {agent?.archived ? <Pill className="text-torch-300">archived</Pill> : null}
        {dirty ? <span className="text-xs text-torch-300">● unsaved changes</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!isNew ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/playground?agent=${slug}`)}>
                <IconFlask size={13} /> Test
              </Button>
              <a href={api.agents.exportUrl(slug!)}>
                <Button size="sm" variant="ghost">
                  <IconDownload size={13} /> Export
                </Button>
              </a>
              <Button size="sm" variant="ghost" loading={archive.isPending} onClick={() => archive.mutate()}>
                {agent?.archived ? "Unarchive" : "Archive"}
              </Button>
            </>
          ) : null}
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Version note (optional)"
            className="h-8 w-52 py-1 text-xs"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {isNew ? "Create agent" : "Save new version"}
          </Button>
        </div>
      </header>
      {saveError ? (
        <div className="px-6 pt-3">
          <ErrorBox error={saveError} />
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Settings */}
        <aside className="min-h-0 space-y-4 overflow-y-auto border-r border-cave-800 bg-cave-900/30 p-4">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Code Reviewer"
            />
          </Field>
          <Field
            label="Slug"
            hint={
              isNew
                ? 'Used in the API: { "agent": "<slug>" }. Cannot change later.'
                : "Used in the API. Cannot change."
            }
          >
            <Input
              value={form.slug}
              disabled={!isNew}
              onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="code-reviewer"
              className="font-mono"
            />
          </Field>
          <Field label="Description" hint="Shown to other agents that can call this one as a sub-agent.">
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <Field label="Model (OpenRouter)">
            <ModelPicker value={form.model} onChange={(m) => set("model", m)} />
          </Field>
          <Field
            label="Default reasoning"
            hint={
              modelInfo && !modelInfo.supportsReasoning
                ? "This model does not support reasoning; the setting is ignored."
                : undefined
            }
          >
            <Select
              value={form.reasoning}
              onChange={(e) => set("reasoning", e.target.value as ReasoningEffort)}
            >
              {REASONING_EFFORTS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-1.5 text-xs font-medium text-cave-300">Internet in the sandbox</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-cave-700 bg-cave-900 p-1">
              {(["none", "allowlist", "full"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set("internetMode", m)}
                  className={cx(
                    "rounded-md py-1 text-xs capitalize",
                    form.internetMode === m
                      ? "bg-cave-700 text-cave-100"
                      : "text-cave-400 hover:text-cave-200",
                  )}
                >
                  {m === "none" ? "No access" : m === "allowlist" ? "Allow list" : "Full"}
                </button>
              ))}
            </div>
            {form.internetMode === "allowlist" ? (
              <Textarea
                rows={3}
                className="mt-2 font-mono text-xs"
                value={form.allowlist}
                onChange={(e) => set("allowlist", e.target.value)}
                placeholder={"https://api.github.com/\nhttps://example.com/docs/"}
              />
            ) : null}
            {form.internetMode === "full" ? (
              <div className="mt-2 flex gap-2 rounded-lg border border-torch-700/40 bg-torch-500/5 p-2 text-[11px] text-torch-200">
                <IconAlert size={13} className="mt-0.5 shrink-0" />
                Full access can reach anything the container can reach, including your internal network.
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Toggle
              checked={form.javascript}
              onChange={(v) => set("javascript", v)}
              label="JavaScript"
              hint="js-exec (QuickJS sandbox)"
            />
            <Toggle
              checked={form.python}
              onChange={(v) => set("python", v)}
              label="Python"
              hint="python3 (WebAssembly sandbox)"
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-cave-300">Default limits per turn</div>
            <div className="grid grid-cols-3 gap-2">
              <Input
                inputMode="numeric"
                value={form.maxTimeSec}
                onChange={(e) => set("maxTimeSec", e.target.value)}
                placeholder="sec"
              />
              <Input
                inputMode="decimal"
                value={form.maxCostUsd}
                onChange={(e) => set("maxCostUsd", e.target.value)}
                placeholder="$"
              />
              <Input
                inputMode="numeric"
                value={form.maxTokens}
                onChange={(e) => set("maxTokens", e.target.value)}
                placeholder="tokens"
              />
            </div>
            <p className="mt-1 text-[11px] text-cave-500">
              Empty = use the defaults from Settings. Callers can override per cycle.
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-cave-300">Sub-agents it may call</div>
            {others.length === 0 ? (
              <p className="text-[11px] text-cave-500">Create more agents to use them as sub-agents.</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-cave-750 p-1.5">
                {others.map((a) => (
                  <label
                    key={a.slug}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-cave-800"
                  >
                    <input
                      type="checkbox"
                      className="accent-torch-500"
                      checked={form.subagents.includes(a.slug)}
                      onChange={(e) =>
                        set(
                          "subagents",
                          e.target.checked
                            ? [...form.subagents, a.slug]
                            : form.subagents.filter((s) => s !== a.slug),
                        )
                      }
                    />
                    <span className="text-cave-200">{a.config.name}</span>
                    <span className="font-mono text-cave-500">{a.slug}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Main editor */}
        <section className="flex min-h-0 flex-col">
          <Tabs
            className="px-4"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "prompt", label: "System prompt" },
              {
                id: "files",
                label: `Own files (${(agent?.config.files.length ?? 0) - removedFiles.length + pendingFiles.length})`,
              },
              { id: "schema", label: form.useSchema ? "Answer schema ●" : "Answer schema" },
              ...(!isNew ? [{ id: "versions" as const, label: "Versions" }] : []),
            ]}
          />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "prompt" ? (
              <div className="h-full min-h-[480px]">
                <MarkdownEditor value={form.systemPrompt} onChange={(v) => set("systemPrompt", v)} />
              </div>
            ) : tab === "files" ? (
              <AgentFiles
                agent={agent}
                pending={pendingFiles}
                setPending={setPendingFiles}
                removed={removedFiles}
                setRemoved={setRemovedFiles}
              />
            ) : tab === "schema" ? (
              <div className="max-w-3xl space-y-3">
                <Toggle
                  checked={form.useSchema}
                  onChange={(v) => set("useSchema", v)}
                  label="Answer with JSON"
                  hint="The agent's submit_answer tool must match this JSON Schema. Callers can still override it per cycle."
                />
                {form.useSchema ? (
                  <JsonEditor value={form.schema} onChange={(v) => set("schema", v)} height={420} />
                ) : null}
                {!form.useSchema ? (
                  <p className="text-sm text-cave-400">
                    Without a schema the answer is free Markdown:{" "}
                    <code className="font-mono">{'{ format: "markdown", text }'}</code>.
                  </p>
                ) : null}
              </div>
            ) : agent ? (
              <Versions agent={agent} currentPrompt={form.systemPrompt} />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function AgentFiles({
  agent,
  pending,
  setPending,
  removed,
  setRemoved,
}: {
  agent?: Agent;
  pending: PickedFile[];
  setPending: (f: PickedFile[]) => void;
  removed: string[];
  setRemoved: (r: string[]) => void;
}) {
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const existing = (agent?.config.files ?? []).filter((f) => !pending.some((p) => p.path === f.path));
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-cave-400">
        Reference files that are always available to this agent at{" "}
        <code className="font-mono text-cave-200">/agent</code> (read-only: changes made there are discarded).
        Saved with each version.
      </p>
      {existing.length > 0 ? (
        <ul className="divide-y divide-cave-800 rounded-xl border border-cave-750">
          {existing.map((f) => {
            const gone = removed.includes(f.path);
            return (
              <li key={f.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                <IconFile size={14} className="text-cave-500" />
                <button
                  type="button"
                  className={cx(
                    "min-w-0 flex-1 truncate text-left font-mono text-xs",
                    gone ? "text-rose-300 line-through" : "text-cave-200 hover:text-torch-300",
                  )}
                  onClick={async () =>
                    setPreview({ path: f.path, text: await api.agents.fileText(agent!.slug, f.path) })
                  }
                >
                  {f.path}
                </button>
                <span className="text-xs text-cave-500">{formatBytes(f.size)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setRemoved(gone ? removed.filter((r) => r !== f.path) : [...removed, f.path])
                  }
                >
                  {gone ? "Undo" : <IconTrash size={13} />}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <FileDrop
        files={pending}
        onChange={setPending}
        label="Drop files or folders to add (saved with the next version)"
      />
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.path} wide>
        <CodeBlock code={preview?.text ?? ""} maxHeight={520} />
      </Modal>
    </div>
  );
}

function Versions({ agent, currentPrompt }: { agent: Agent; currentPrompt: string }) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: keys.versions(agent.slug),
    queryFn: () => api.agents.versions(agent.slug),
  });
  const [selected, setSelected] = useState<number | null>(null);
  const sel = versions.data?.find((v) => v.version === selected);
  const diff = useMemo(() => (sel ? diffLines(sel.systemPrompt, currentPrompt) : []), [sel, currentPrompt]);
  const restore = useMutation({
    mutationFn: (v: number) => api.agents.restore(agent.slug, v),
    onSuccess: (a) => {
      qc.setQueryData(keys.agent(a.slug), a);
      void qc.invalidateQueries({ queryKey: keys.versions(a.slug) });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setSelected(null);
    },
  });
  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <ul className="space-y-1.5">
        {versions.data?.map((v) => (
          <li key={v.version}>
            <button
              type="button"
              onClick={() => setSelected(v.version)}
              className={cx(
                "w-full rounded-lg border px-3 py-2 text-left",
                selected === v.version
                  ? "border-torch-600 bg-torch-500/5"
                  : "border-cave-750 hover:border-cave-600",
              )}
            >
              <div className="flex items-center gap-2 text-sm">
                <IconHistory size={13} className="text-cave-500" />
                <span className="font-medium text-cave-100">v{v.version}</span>
                {v.version === agent.currentVersion ? (
                  <Pill className="text-emerald-300">current</Pill>
                ) : null}
                <span className="ml-auto text-[11px] text-cave-500" title={formatDate(v.createdAt)}>
                  {timeAgo(v.createdAt)}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-cave-400">
                {v.note ?? "—"} · <span className="font-mono">{v.model}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        {sel ? (
          <div className="rounded-xl border border-cave-750">
            <div className="flex items-center gap-2 border-b border-cave-750 px-4 py-2.5">
              <span className="text-sm text-cave-200">
                v{sel.version} → editor (what changed in the system prompt)
              </span>
              {sel.version !== agent.currentVersion ? (
                <Button
                  size="sm"
                  className="ml-auto"
                  loading={restore.isPending}
                  onClick={() => restore.mutate(sel.version)}
                >
                  Restore v{sel.version}
                </Button>
              ) : null}
              <button
                type="button"
                className="text-cave-500 hover:text-cave-200"
                onClick={() => setSelected(null)}
              >
                <IconX size={14} />
              </button>
            </div>
            <pre className="max-h-[60vh] overflow-auto p-3 font-mono text-[12px] leading-relaxed">
              {diff.map((l, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static, read-only diff lines
                  key={i}
                  className={cx(
                    "px-2 whitespace-pre-wrap",
                    l.kind === "add" && "bg-emerald-950/40 text-emerald-200",
                    l.kind === "del" && "bg-rose-950/40 text-rose-200",
                    l.kind === "same" && "text-cave-400",
                  )}
                >
                  {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                  {l.text}
                </div>
              ))}
            </pre>
            <div className="border-t border-cave-750 px-4 py-2 text-[11px] text-cave-500">
              v{sel.version}: model {sel.model} · reasoning {sel.reasoning} · internet {sel.internet.mode} ·{" "}
              {sel.files.length} files
            </div>
          </div>
        ) : (
          <p className="text-sm text-cave-500">
            Pick a version to compare its system prompt with the editor, or restore it.
          </p>
        )}
      </div>
    </div>
  );
}
