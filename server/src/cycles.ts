import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  Cycle,
  FollowUpRequest,
  JsonSchema,
  Limits,
  RerunRequest,
  StartCycleRequest,
  WorkspaceFile,
} from "@agentcave/client";
import { Zip, ZipDeflate } from "fflate";
import type { Manifest } from "./blobs.js";
import type { Ctx } from "./context.js";
import { newCycleParams, storeFiles } from "./cycle-factory.js";
import { FINAL } from "./cycle-store.js";
import { parseJson } from "./db.js";
import type { Runner } from "./engine/runner.js";
import type { Scheduler } from "./engine/scheduler.js";
import { ApiError, conflict, notFound } from "./errors.js";
import { normalizeRelPath } from "./paths.js";
import { deleteCycleTree } from "./retention.js";

const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/plain",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function mimeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const type = MIME[ext];
  if (!type) return "application/octet-stream";
  return type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type;
}

/** API-level cycle operations (validation, queueing, files). */
export class CycleService {
  constructor(
    private readonly ctx: Ctx,
    private readonly scheduler: Scheduler,
    private readonly runner: Runner,
  ) {}

  private requireToken(): void {
    if (this.ctx.modelFactory.requiresToken && !this.ctx.settings.get().openrouterToken) {
      throw new ApiError(400, "no_token", "The OpenRouter token is not set. Add it in Settings first.");
    }
  }

  async start(req: StartCycleRequest): Promise<Cycle> {
    this.requireToken();
    const params = await newCycleParams(this.ctx, { ...req, source: req.source ?? "api" });
    const row = this.ctx.cycles.create(params);
    this.scheduler.tick();
    return this.ctx.cycles.get(row.id);
  }

  async followUp(id: string, req: FollowUpRequest): Promise<Cycle> {
    const row = this.ctx.cycles.getRow(id);
    if (row.parent_id)
      throw conflict("Sub-agent cycles are driven by their parent and cannot take follow-ups");
    if (!FINAL.includes(row.status)) {
      throw conflict(`The cycle is ${row.status}; send the follow-up when it has finished`, "cycle_busy");
    }
    this.requireToken();
    const manifest = await storeFiles(this.ctx, req.files);
    this.ctx.cycles.addTurn(id, req.prompt, manifest);
    this.scheduler.tick();
    return this.ctx.cycles.get(id);
  }

  async rerun(id: string, req: RerunRequest): Promise<Cycle> {
    const row = this.ctx.cycles.getRow(id);
    this.requireToken();
    const first = this.ctx.cycles.turn(id, 0);
    const sameVersion = !req.agentVersion || req.agentVersion === row.agent_version;
    const origLimits = parseJson<Limits>(row.limits, {});
    const params = await newCycleParams(this.ctx, {
      agent: row.agent_slug,
      agentVersion: req.agentVersion ?? row.agent_version,
      prompt: first.prompt,
      inputManifest: parseJson<Manifest>(first.input_manifest, {}),
      overrides: sameVersion
        ? {
            model: req.overrides?.model ?? row.model,
            reasoning: req.overrides?.reasoning ?? row.reasoning,
            limits: { ...origLimits, ...req.overrides?.limits },
          }
        : req.overrides,
      outputSchema:
        req.outputSchema !== undefined
          ? req.outputSchema
          : sameVersion
            ? parseJson<JsonSchema | null>(row.output_schema, null)
            : undefined,
      labels: req.labels ?? parseJson<Record<string, string>>(row.labels, {}),
      webhookUrl: req.webhookUrl !== undefined ? req.webhookUrl : row.webhook_url,
      source: "rerun",
      rerunOf: id,
    });
    const created = this.ctx.cycles.create(params);
    this.scheduler.tick();
    return this.ctx.cycles.get(created.id);
  }

  stop(id: string): Cycle {
    this.scheduler.stop(id);
    return this.ctx.cycles.get(id);
  }

  async delete(id: string): Promise<void> {
    const row = this.ctx.cycles.getRow(id);
    if (row.parent_id) throw conflict("Delete the parent cycle instead; sub-agent cycles belong to it");
    if (!FINAL.includes(row.status))
      throw conflict(`Stop the cycle before deleting it (it is ${row.status})`);
    await deleteCycleTree(this.ctx, id);
  }

  /** Current workspace manifest: the latest snapshot when finished, a live one while running. */
  private async currentManifest(id: string): Promise<Manifest> {
    const row = this.ctx.cycles.getRow(id);
    const latest = this.ctx.cycles.latestTurn(id);
    if (FINAL.includes(row.status) && latest.end_snapshot)
      return parseJson<Manifest>(latest.end_snapshot, {});
    const dir = this.runner.workspaceDir(id);
    try {
      await fs.access(dir);
    } catch {
      // Not started yet: the workspace will hold the input files.
      return parseJson<Manifest>(latest.input_manifest, {});
    }
    return this.ctx.blobs.snapshotDir(dir);
  }

  async files(id: string, opts: { changed?: boolean; turn?: number } = {}): Promise<WorkspaceFile[]> {
    this.ctx.cycles.getRow(id);
    const baseTurn = this.ctx.cycles.turn(id, opts.turn ?? 0);
    const base = parseJson<Manifest>(baseTurn.start_snapshot ?? baseTurn.input_manifest, {});
    const current = await this.currentManifest(id);
    const out: WorkspaceFile[] = [];
    for (const [p, e] of Object.entries(current)) {
      const prev = base[p];
      const status = !prev ? "added" : prev.sha256 !== e.sha256 ? "modified" : "unchanged";
      out.push({ path: p, size: e.size, sha256: e.sha256, status });
    }
    for (const [p, e] of Object.entries(base)) {
      if (!current[p]) out.push({ path: p, size: e.size, sha256: e.sha256, status: "deleted" });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return opts.changed ? out.filter((f) => f.status !== "unchanged") : out;
  }

  /** Opens a file from the cycle's workspace (falls back to the stored snapshot). */
  async openFile(
    id: string,
    filePath: string,
  ): Promise<{ stream: ReadableStream; size: number; type: string }> {
    this.ctx.cycles.getRow(id);
    const rel = normalizeRelPath(filePath);
    const abs = path.join(this.runner.workspaceDir(id), ...rel.split("/"));
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new Error("not a file");
      return {
        stream: Readable.toWeb(createReadStream(abs)) as ReadableStream,
        size: stat.size,
        type: mimeFor(rel),
      };
    } catch {
      const entry = (await this.currentManifest(id))[rel];
      if (!entry) throw notFound(`File '${rel}'`);
      return {
        stream: Readable.toWeb(createReadStream(this.ctx.blobs.pathOf(entry.sha256))) as ReadableStream,
        size: entry.size,
        type: mimeFor(rel),
      };
    }
  }

  /** Streams the workspace (or only the changed files) as a zip. */
  async zip(id: string, changedOnly: boolean): Promise<ReadableStream<Uint8Array>> {
    const files = (await this.files(id, { changed: changedOnly })).filter((f) => f.status !== "deleted");
    const blobs = this.ctx.blobs;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const zip = new Zip((err, chunk, final) => {
          if (err) {
            controller.error(err);
            return;
          }
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        for (const f of files) {
          const entry = new ZipDeflate(f.path, { level: 6 });
          zip.add(entry);
          entry.push(new Uint8Array(await blobs.read(f.sha256)), true);
        }
        zip.end();
      },
    });
  }
}
