import type { FileInput, JsonSchema, Limits, ReasoningEffort } from "@agentcave/client";
import type { Manifest } from "./blobs.js";
import type { Ctx } from "./context.js";
import type { CreateCycleParams, CycleRow } from "./cycle-store.js";
import { one } from "./db.js";
import { assertValidSchema } from "./engine/answer-schema.js";
import { buildSystemPrompt, type SubagentInfo, subagentToolName } from "./engine/prompt.js";
import { badRequest, conflict } from "./errors.js";
import { decodeFileContent, normalizeRelPath } from "./paths.js";
import { mergeLimits } from "./settings.js";

export interface NewCycleRequest {
  agent: string;
  agentVersion?: number;
  prompt: string;
  /** Files sent by the caller… */
  files?: FileInput[];
  /** …or an already-stored manifest (re-runs, sub-agents). */
  inputManifest?: Manifest;
  overrides?: { model?: string; reasoning?: ReasoningEffort; limits?: Limits };
  outputSchema?: JsonSchema | null;
  labels?: Record<string, string>;
  webhookUrl?: string | null;
  source: CreateCycleParams["source"];
  parent?: CycleRow;
  rerunOf?: string;
}

/** Stores request files in the blob store and returns their manifest. */
export async function storeFiles(ctx: Ctx, files: FileInput[] | undefined): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const f of files ?? []) {
    const rel = normalizeRelPath(f.path);
    if (manifest[rel]) throw badRequest(`Duplicate file path: ${rel}`);
    manifest[rel] = await ctx.blobs.put(decodeFileContent(f.content, f.encoding));
  }
  return manifest;
}

/** Resolves the agent version and every effective setting, and builds the exact system prompt. */
export async function newCycleParams(ctx: Ctx, req: NewCycleRequest): Promise<CreateCycleParams> {
  const agentRow = ctx.agents.getRow(req.agent);
  if (agentRow.archived && req.source !== "rerun") {
    throw conflict(`Agent '${req.agent}' is archived`, "agent_archived");
  }
  const versionRow = ctx.agents.getVersionRow(agentRow.id, req.agentVersion ?? agentRow.current_version);
  const config = ctx.agents.config(versionRow);
  const settings = ctx.settings.get();

  const outputSchema = req.outputSchema !== undefined ? req.outputSchema : config.outputSchema;
  if (outputSchema) assertValidSchema(outputSchema);

  const subagents: SubagentInfo[] = [];
  for (const slug of config.subagents) {
    const row = one<{ name: string; description: string; archived: number }>(
      ctx.db,
      "SELECT name, description, archived FROM agents WHERE slug = ?",
      slug,
    );
    if (!row || row.archived) continue;
    subagents.push({ slug, toolName: subagentToolName(slug), name: row.name, description: row.description });
  }

  const systemPrompt = buildSystemPrompt({
    agentPrompt: config.systemPrompt,
    internet: config.internet,
    javascript: config.javascript,
    python: config.python,
    agentFiles: ctx.agents.versionFiles(versionRow.id).map((f) => f.path),
    subagents,
    outputSchema,
    isSubagent: !!req.parent,
  });

  const inputManifest = req.inputManifest ?? (await storeFiles(ctx, req.files));

  return {
    agentId: agentRow.id,
    agentVersionId: versionRow.id,
    agentSlug: agentRow.slug,
    agentName: config.name,
    agentVersion: versionRow.version,
    parentId: req.parent?.id ?? null,
    rootId: req.parent?.root_id ?? null,
    depth: req.parent ? req.parent.depth + 1 : 0,
    source: req.source,
    rerunOf: req.rerunOf ?? null,
    model: req.overrides?.model ?? config.model,
    reasoning: req.overrides?.reasoning ?? config.reasoning,
    limits: mergeLimits(settings.defaultLimits, config.limits, req.overrides?.limits),
    outputSchema,
    labels: req.labels ?? {},
    webhookUrl: req.webhookUrl ?? null,
    systemPrompt,
    prompt: req.prompt,
    inputManifest,
  };
}
