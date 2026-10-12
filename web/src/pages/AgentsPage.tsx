import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  IconAgents,
  IconBranch,
  IconFile,
  IconFlask,
  IconGlobe,
  IconPlus,
  IconUpload,
} from "../components/icons";
import { Button, Card, cx, Empty, ErrorBox, PageHeader, Pill, Spinner } from "../components/ui";
import { api, keys } from "../lib/api";
import { formatCost, timeAgo } from "../lib/format";

export function AgentsPage() {
  const [archived, setArchived] = useState(false);
  const agents = useQuery({ queryKey: keys.agents(archived), queryFn: () => api.agents.list({ archived }) });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const importRef = useRef<HTMLInputElement>(null);
  const importer = useMutation({
    mutationFn: async (file: File) => {
      const isZip = file.name.endsWith(".zip");
      return api.agents.import(isZip ? new Uint8Array(await file.arrayBuffer()) : await file.text());
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/agents/${a.slug}`);
    },
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="An agent is a Markdown system prompt, a model and a few switches. Every save is a new version."
        actions={
          <>
            <label className="flex items-center gap-1.5 text-xs text-cave-400">
              <input
                type="checkbox"
                className="accent-torch-500"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Show archived
            </label>
            <Button loading={importer.isPending} onClick={() => importRef.current?.click()}>
              <IconUpload size={15} /> Import
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".md,.markdown,.zip,text/markdown,application/zip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importer.mutate(f);
                e.target.value = "";
              }}
            />
            <Button variant="primary" onClick={() => navigate("/agents/new")}>
              <IconPlus size={15} /> New agent
            </Button>
          </>
        }
      />
      <ErrorBox error={importer.error ?? agents.error} />
      {agents.isLoading ? (
        <div className="flex justify-center py-16 text-cave-400">
          <Spinner />
        </div>
      ) : agents.data?.length === 0 ? (
        <Empty icon={<IconAgents size={28} />} title="No agents yet">
          Create one, or import a <code className="font-mono">.md</code> /{" "}
          <code className="font-mono">.zip</code> export.
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agents.data?.map((a) => (
            <Card
              key={a.slug}
              className={cx(
                "flex flex-col p-4 transition-colors hover:border-cave-600",
                a.archived && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <Link to={`/agents/${a.slug}`} className="min-w-0">
                  <div className="truncate text-[15px] font-semibold text-cave-100 hover:text-torch-300">
                    {a.config.name}
                  </div>
                  <div className="truncate font-mono text-[11px] text-cave-500">
                    {a.slug} · v{a.currentVersion}
                  </div>
                </Link>
                {a.stats.running ? (
                  <Pill className="border-sky-800 text-sky-300">{a.stats.running} running</Pill>
                ) : null}
                {a.archived ? <Pill>archived</Pill> : null}
              </div>
              <p className="mt-2 line-clamp-2 min-h-[2.5em] text-sm text-cave-400">
                {a.config.description || "No description."}
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Pill className="font-mono">{a.config.model}</Pill>
                <Pill>reasoning {a.config.reasoning}</Pill>
                {a.config.internet.mode !== "none" ? (
                  <Pill className="text-sky-300">
                    <IconGlobe size={11} /> {a.config.internet.mode === "full" ? "internet" : "allowlist"}
                  </Pill>
                ) : null}
                {a.config.javascript ? <Pill>JS</Pill> : null}
                {a.config.python ? <Pill>Python</Pill> : null}
                {a.config.subagents.length ? (
                  <Pill className="text-teal-300">
                    <IconBranch size={11} /> {a.config.subagents.length}
                  </Pill>
                ) : null}
                {a.config.files.length ? (
                  <Pill>
                    <IconFile size={11} /> {a.config.files.length}
                  </Pill>
                ) : null}
                {a.config.outputSchema ? <Pill>JSON answer</Pill> : null}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-cave-750 pt-3 text-xs text-cave-400">
                <span>
                  {a.stats.cycles} cycles · {formatCost(a.stats.costUsd)} ·{" "}
                  {a.stats.lastRunAt ? timeAgo(a.stats.lastRunAt) : "never run"}
                </span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/playground?agent=${a.slug}`)}>
                    <IconFlask size={13} /> Test
                  </Button>
                  <Button size="sm" onClick={() => navigate(`/agents/${a.slug}`)}>
                    Edit
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
