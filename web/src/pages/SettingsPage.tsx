import type { Settings, SettingsUpdate, TokenCheck } from "@agentcave/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { IconCheck, IconRefresh } from "../components/icons";
import { Button, Card, CopyButton, ErrorBox, Field, Input, PageHeader, Spinner } from "../components/ui";
import { api, keys } from "../lib/api";

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => api.settings.get() });
  const update = useMutation({
    mutationFn: (u: SettingsUpdate) => api.settings.update(u),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.health });
    },
  });
  const s = settings.data;
  if (!s) {
    return (
      <div className="flex justify-center py-16 text-cave-400">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Settings"
        subtitle="Stored in the SQLite database inside the container's /data volume."
      />
      <div className="space-y-6">
        <TokenCard settings={s} onSave={(t) => update.mutateAsync({ openrouterToken: t })} />
        <RuntimeCard settings={s} saving={update.isPending} onSave={(u) => update.mutateAsync(u)} />
        <WebhookCard settings={s} onSave={(u) => update.mutateAsync(u)} />
        <MaintenanceCard />
        <ErrorBox error={update.error} />
      </div>
    </div>
  );
}

function TokenCard({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (t: string | null) => Promise<unknown>;
}) {
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const test = useMutation({ mutationFn: (t?: string) => api.settings.testToken(t), onSuccess: setCheck });
  const save = useMutation({
    mutationFn: async () => {
      await onSave(token.trim());
      setToken("");
      setCheck(await api.settings.testToken());
    },
  });
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-cave-100">OpenRouter token</h2>
      <p className="mt-1 mb-4 text-sm text-cave-400">
        Every agent uses this key to call models. Create one at{" "}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          className="text-torch-400 hover:underline"
        >
          openrouter.ai/keys
        </a>
        .
      </p>
      <div className="mb-3 flex items-center gap-2 text-sm">
        {settings.openrouterToken.set ? (
          <>
            <IconCheck size={15} className="text-emerald-400" />
            <span className="font-mono text-cave-200">{settings.openrouterToken.masked}</span>
            <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate(undefined)}>
              Test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (confirm("Remove the OpenRouter token? Agents will stop working.")) void onSave(null);
              }}
            >
              Remove
            </Button>
          </>
        ) : (
          <span className="text-torch-300">No token set.</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="sk-or-v1-…"
          autoComplete="off"
          className="font-mono"
        />
        <Button
          variant="ghost"
          disabled={!token.trim()}
          loading={test.isPending}
          onClick={() => test.mutate(token.trim())}
        >
          Test
        </Button>
        <Button
          variant="primary"
          disabled={!token.trim()}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </div>
      {check ? (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
            check.ok
              ? "border-emerald-900 bg-emerald-950/30 text-emerald-200"
              : "border-rose-900 bg-rose-950/30 text-rose-200"
          }`}
        >
          {check.ok ? (
            <>
              Token works{check.label ? ` (${check.label})` : ""}.{" "}
              {check.limitRemaining !== null
                ? `Credit left: $${check.limitRemaining.toFixed(2)}. `
                : "No credit limit on this key. "}
              {check.usage !== null ? `Used so far: $${check.usage.toFixed(2)}.` : ""}
              {check.isFreeTier ? " Free tier." : ""}
            </>
          ) : (
            <>Token check failed: {check.error}</>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function RuntimeCard({
  settings,
  saving,
  onSave,
}: {
  settings: Settings;
  saving: boolean;
  onSave: (u: SettingsUpdate) => Promise<unknown>;
}) {
  const init = () => ({
    maxParallel: String(settings.maxParallel),
    retentionDays: String(settings.retentionDays),
    maxTimeSec: settings.defaultLimits.maxTimeSec?.toString() ?? "",
    maxCostUsd: settings.defaultLimits.maxCostUsd?.toString() ?? "",
    maxTokens: settings.defaultLimits.maxTokens?.toString() ?? "",
    hardStepCap: String(settings.hardStepCap),
    maxNudges: String(settings.maxNudges),
    subagentMaxDepth: String(settings.subagentMaxDepth),
    toolOutputCapKb: String(Math.round(settings.toolOutputCapBytes / 1024)),
    commandTimeoutSec: String(settings.commandTimeoutSec),
    contextTrimRatio: String(settings.contextTrimRatio),
    maxRequestMb: String(settings.maxRequestMb),
  });
  const [f, setF] = useState(init);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved settings change
  useEffect(() => setF(init()), [settings]);
  const num = (s: string) => Number(s);
  const optional = (s: string) => (s.trim() === "" ? null : Number(s));
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        inputMode="decimal"
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        className="font-mono"
      />
    </Field>
  );
  return (
    <Card className="p-5">
      <h2 className="mb-4 text-sm font-semibold text-cave-100">Runtime</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("maxParallel", "Cycles running at the same time", "Others wait in the queue.")}
        {field("retentionDays", "Delete finished cycles after (days)", "0 = keep forever.")}
      </div>
      <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wider text-cave-400 uppercase">
        Default limits per turn
      </h3>
      <div className="grid gap-4 sm:grid-cols-3">
        {field("maxTimeSec", "Max time (seconds)", "Empty = no limit")}
        {field("maxCostUsd", "Max money (USD)", "Empty = no limit")}
        {field("maxTokens", "Max tokens", "Empty = no limit")}
      </div>
      <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wider text-cave-400 uppercase">Advanced</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        {field("hardStepCap", "Hidden step cap", "Last safety net.")}
        {field("maxNudges", "Reminders to call submit_answer", "Then the cycle fails.")}
        {field("subagentMaxDepth", "Max sub-agent depth")}
        {field("toolOutputCapKb", "Tool output cap (KB)", "Longer output is shortened.")}
        {field("commandTimeoutSec", "Single command timeout (s)")}
        {field("contextTrimRatio", "Trim old outputs at", "Share of the context window (0.1–0.95).")}
        {field("maxRequestMb", "Max request size (MB)")}
      </div>
      <div className="mt-5 flex justify-end">
        <Button
          variant="primary"
          loading={saving}
          onClick={() =>
            void onSave({
              maxParallel: num(f.maxParallel),
              retentionDays: num(f.retentionDays),
              defaultLimits: {
                maxTimeSec: optional(f.maxTimeSec),
                maxCostUsd: optional(f.maxCostUsd),
                maxTokens: optional(f.maxTokens),
              },
              hardStepCap: num(f.hardStepCap),
              maxNudges: num(f.maxNudges),
              subagentMaxDepth: num(f.subagentMaxDepth),
              toolOutputCapBytes: Math.round(num(f.toolOutputCapKb) * 1024),
              commandTimeoutSec: num(f.commandTimeoutSec),
              contextTrimRatio: num(f.contextTrimRatio),
              maxRequestMb: num(f.maxRequestMb),
            })
          }
        >
          Save runtime settings
        </Button>
      </div>
    </Card>
  );
}

function WebhookCard({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (u: SettingsUpdate) => Promise<unknown>;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-cave-100">Webhook signing secret</h2>
      <p className="mt-1 mb-4 text-sm text-cave-400">
        Optional. When set, every webhook carries{" "}
        <code className="font-mono text-cave-200">X-AgentCave-Signature: sha256=&lt;hmac&gt;</code> so
        receivers can check it came from here.
      </p>
      {settings.webhookSecret ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-cave-700 bg-cave-900 px-3 py-2 font-mono text-xs text-cave-200">
            {settings.webhookSecret}
          </code>
          <CopyButton text={settings.webhookSecret} />
          <Button size="sm" onClick={() => void onSave({ webhookSecret: "generate" })}>
            <IconRefresh size={13} /> New
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void onSave({ webhookSecret: null })}>
            Clear
          </Button>
        </div>
      ) : (
        <Button onClick={() => void onSave({ webhookSecret: "generate" })}>Generate a secret</Button>
      )}
    </Card>
  );
}

function MaintenanceCard() {
  const [result, setResult] = useState<string | null>(null);
  const cleanup = useMutation({
    mutationFn: () =>
      api.request<{ deletedCycles: number; deletedBlobs: number }>("POST", "/maintenance/cleanup"),
    onSuccess: (r) => setResult(`Deleted ${r.deletedCycles} old cycles and ${r.deletedBlobs} unused files.`),
  });
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-cave-100">Maintenance</h2>
      <p className="mt-1 mb-4 text-sm text-cave-400">Cleanup runs every hour. You can also run it now.</p>
      <div className="flex items-center gap-3">
        <Button loading={cleanup.isPending} onClick={() => cleanup.mutate()}>
          Run cleanup now
        </Button>
        {result ? <span className="text-sm text-cave-300">{result}</span> : null}
      </div>
    </Card>
  );
}
