import fs from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentConfig,
  AgentFileInfo,
  AgentInput,
  AgentStats,
  AgentVersion,
} from "@agentcave/client";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import YAML from "yaml";
import type { BlobStore, Manifest } from "./blobs.js";
import { all, type DB, nowIso, one, parseJson, run, tx } from "./db.js";
import { assertValidSchema } from "./engine/answer-schema.js";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";
import { newId } from "./ids.js";
import { decodeFileContent, normalizeRelPath } from "./paths.js";
import { agentInputSchema } from "./schemas.js";

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  current_version: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  agent_id: string;
  version: number;
  note: string | null;
  config: string;
  created_at: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a careful, capable assistant.

Work step by step. Inspect the files you were given before drawing conclusions, and keep your final answer concise and well structured.`;

const EMPTY_STATS: AgentStats = { cycles: 0, running: 0, costUsd: 0, lastRunAt: null };

export class AgentService {
  constructor(
    private readonly db: DB,
    private readonly blobs: BlobStore,
    private readonly agentFilesDir: string,
  ) {}

  // ------------------------------------------------------------------ reads

  list(opts: { archived?: boolean } = {}): Agent[] {
    const rows = all<AgentRow>(
      this.db,
      `SELECT * FROM agents ${opts.archived ? "" : "WHERE archived = 0"} ORDER BY name COLLATE NOCASE`,
    );
    const stats = this.statsByAgent();
    return rows.map((r) => this.toDTO(r, stats.get(r.id)));
  }

  getRow(slug: string): AgentRow {
    const row = one<AgentRow>(this.db, "SELECT * FROM agents WHERE slug = ?", slug);
    if (!row) throw notFound(`Agent '${slug}'`);
    return row;
  }

  get(slug: string): Agent {
    const row = this.getRow(slug);
    return this.toDTO(row, this.statsByAgent(row.id).get(row.id));
  }

  getVersionRow(agentId: string, version: number): VersionRow {
    const row = one<VersionRow>(
      this.db,
      "SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?",
      agentId,
      version,
    );
    if (!row) throw notFound(`Agent version ${version}`);
    return row;
  }

  getVersionById(versionId: string): VersionRow {
    const row = one<VersionRow>(this.db, "SELECT * FROM agent_versions WHERE id = ?", versionId);
    if (!row) throw notFound("Agent version");
    return row;
  }

  versions(slug: string): AgentVersion[] {
    const agent = this.getRow(slug);
    return all<VersionRow>(
      this.db,
      "SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC",
      agent.id,
    ).map((v) => this.versionDTO(v));
  }

  version(slug: string, version: number): AgentVersion {
    const agent = this.getRow(slug);
    return this.versionDTO(this.getVersionRow(agent.id, version));
  }

  versionDTO(v: VersionRow): AgentVersion {
    return {
      ...parseConfig(v.config),
      version: v.version,
      note: v.note,
      files: this.versionFiles(v.id),
      createdAt: v.created_at,
    };
  }

  config(v: VersionRow): AgentConfig {
    return parseConfig(v.config);
  }

  versionFiles(versionId: string): AgentFileInfo[] {
    return all<{ path: string; sha256: string; size: number }>(
      this.db,
      "SELECT path, sha256, size FROM agent_version_files WHERE version_id = ? ORDER BY path",
      versionId,
    ).map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }));
  }

  async readFile(slug: string, filePath: string, version?: number): Promise<Buffer> {
    const agent = this.getRow(slug);
    const v = this.getVersionRow(agent.id, version ?? agent.current_version);
    const rel = normalizeRelPath(filePath);
    const file = this.versionFiles(v.id).find((f) => f.path === rel);
    if (!file) throw notFound(`File '${rel}'`);
    return this.blobs.read(file.sha256);
  }

  /** Writes the version's own files to disk once (read-only mount source). Returns null when there are none. */
  async materializeFiles(versionId: string): Promise<string | null> {
    const files = this.versionFiles(versionId);
    if (files.length === 0) return null;
    const dir = path.join(this.agentFilesDir, versionId);
    const marker = `${dir}.complete`;
    try {
      await fs.access(marker);
      return dir;
    } catch {
      // not yet materialized
    }
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    const manifest: Manifest = Object.fromEntries(
      files.map((f) => [f.path, { sha256: f.sha256, size: f.size }]),
    );
    await this.blobs.materialize(tmp, manifest, { clean: true });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
    await fs.writeFile(marker, "");
    return dir;
  }

  // ------------------------------------------------------------------ writes

  async create(input: AgentInput): Promise<Agent> {
    if (!input.slug) throw badRequest("slug is required");
    if (!input.name) throw badRequest("name is required");
    if (one(this.db, "SELECT 1 FROM agents WHERE slug = ?", input.slug)) {
      throw conflict(`An agent with slug '${input.slug}' already exists`, "slug_taken");
    }
    const config = this.buildConfig(null, input, input.slug);
    const files = await this.applyFileChanges(new Map(), input);
    const now = nowIso();
    const id = newId("agt");
    tx(this.db, () => {
      run(
        this.db,
        "INSERT INTO agents (id, slug, name, description, current_version, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
        id,
        input.slug!,
        config.name,
        config.description,
        now,
        now,
      );
      this.insertVersion(id, 1, config, files, input.note ?? null, now);
    });
    return this.get(input.slug);
  }

  async update(slug: string, input: AgentInput): Promise<Agent> {
    const agent = this.getRow(slug);
    if (input.slug && input.slug !== slug) throw badRequest("The slug of an agent cannot be changed");
    const currentRow = this.getVersionRow(agent.id, agent.current_version);
    const current = parseConfig(currentRow.config);
    const config = this.buildConfig(current, input, slug);
    const currentFiles = new Map(this.versionFiles(currentRow.id).map((f) => [f.path, f]));
    const files = await this.applyFileChanges(currentFiles, input);

    const sameConfig = JSON.stringify(config) === JSON.stringify(current);
    const sameFiles =
      files.size === currentFiles.size &&
      [...files.entries()].every(([p, f]) => currentFiles.get(p)?.sha256 === f.sha256);
    if (sameConfig && sameFiles && !input.note) return this.get(slug);

    const now = nowIso();
    const nextVersion = agent.current_version + 1;
    tx(this.db, () => {
      this.insertVersion(agent.id, nextVersion, config, files, input.note ?? null, now);
      run(
        this.db,
        "UPDATE agents SET current_version = ?, name = ?, description = ?, updated_at = ? WHERE id = ?",
        nextVersion,
        config.name,
        config.description,
        now,
        agent.id,
      );
    });
    return this.get(slug);
  }

  async restore(slug: string, version: number): Promise<Agent> {
    const agent = this.getRow(slug);
    const v = this.getVersionRow(agent.id, version);
    const config = parseConfig(v.config);
    const files = new Map(this.versionFiles(v.id).map((f) => [f.path, f]));
    const now = nowIso();
    const nextVersion = agent.current_version + 1;
    tx(this.db, () => {
      this.insertVersion(agent.id, nextVersion, config, files, `Restored from version ${version}`, now);
      run(
        this.db,
        "UPDATE agents SET current_version = ?, name = ?, description = ?, updated_at = ? WHERE id = ?",
        nextVersion,
        config.name,
        config.description,
        now,
        agent.id,
      );
    });
    return this.get(slug);
  }

  archive(slug: string, archived: boolean): void {
    const agent = this.getRow(slug);
    run(
      this.db,
      "UPDATE agents SET archived = ?, updated_at = ? WHERE id = ?",
      archived ? 1 : 0,
      nowIso(),
      agent.id,
    );
  }

  // ------------------------------------------------------------------ import / export

  async export(slug: string): Promise<{ filename: string; contentType: string; data: Uint8Array }> {
    const agent = this.getRow(slug);
    const v = this.getVersionRow(agent.id, agent.current_version);
    const config = parseConfig(v.config);
    const { systemPrompt, ...front } = config;
    const md = `---\n${YAML.stringify({ slug, ...front }, { lineWidth: 0 })}---\n${systemPrompt}`;
    const files = this.versionFiles(v.id);
    if (files.length === 0) {
      return { filename: `${slug}.md`, contentType: "text/markdown; charset=utf-8", data: strToU8(md) };
    }
    const entries: Record<string, Uint8Array> = { "agent.md": strToU8(md) };
    for (const f of files) entries[`files/${f.path}`] = new Uint8Array(await this.blobs.read(f.sha256));
    return { filename: `${slug}.zip`, contentType: "application/zip", data: zipSync(entries) };
  }

  async import(data: Uint8Array, contentType: string): Promise<Agent> {
    let md: string;
    const files: { path: string; content: string; encoding: "base64" }[] = [];
    const isZip = contentType.includes("zip") || (data[0] === 0x50 && data[1] === 0x4b);
    if (isZip) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(data);
      } catch {
        throw badRequest("Could not read the zip file");
      }
      const mdName = Object.keys(entries).find((n) => n === "agent.md" || n.endsWith("/agent.md"));
      if (!mdName) throw badRequest("The zip must contain agent.md");
      md = strFromU8(entries[mdName]);
      const base = mdName.slice(0, -"agent.md".length);
      for (const [name, bytes] of Object.entries(entries)) {
        if (!name.startsWith(`${base}files/`) || name.endsWith("/")) continue;
        files.push({
          path: name.slice(`${base}files/`.length),
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        });
      }
    } else {
      md = strFromU8(data);
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md.replace(/^﻿/, ""));
    if (!match) throw badRequest("The file must start with a '---' YAML front matter block");
    let front: Record<string, unknown>;
    try {
      front = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
    } catch (err) {
      throw badRequest(`Invalid front matter: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = agentInputSchema.safeParse({ ...front, systemPrompt: match[2] });
    if (!parsed.success) throw new ApiError(400, "invalid_agent", "Invalid agent file", parsed.error.issues);
    const input = parsed.data as AgentInput;
    if (!input.slug) throw badRequest("The front matter needs a 'slug'");
    const existing = one<AgentRow>(this.db, "SELECT * FROM agents WHERE slug = ?", input.slug);
    if (existing) {
      const currentFiles = this.versionFiles(this.getVersionRow(existing.id, existing.current_version).id);
      const remove = currentFiles.map((f) => f.path).filter((p) => !files.some((nf) => nf.path === p));
      this.archive(input.slug, false);
      return this.update(input.slug, { ...input, note: "Imported", files: { upsert: files, remove } });
    }
    return this.create({
      ...input,
      name: input.name ?? input.slug,
      note: "Imported",
      files: { upsert: files },
    });
  }

  // ------------------------------------------------------------------ helpers

  private buildConfig(current: AgentConfig | null, input: AgentInput, selfSlug: string): AgentConfig {
    const config: AgentConfig = {
      name: input.name ?? current?.name ?? selfSlug,
      description: input.description ?? current?.description ?? "",
      systemPrompt: input.systemPrompt ?? current?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: input.model ?? current?.model ?? "",
      reasoning: input.reasoning ?? current?.reasoning ?? "medium",
      internet: input.internet
        ? { mode: input.internet.mode, allowlist: input.internet.allowlist ?? [] }
        : (current?.internet ?? { mode: "none", allowlist: [] }),
      javascript: input.javascript ?? current?.javascript ?? false,
      python: input.python ?? current?.python ?? false,
      limits: input.limits ?? current?.limits ?? {},
      subagents: input.subagents ?? current?.subagents ?? [],
      outputSchema: input.outputSchema !== undefined ? input.outputSchema : (current?.outputSchema ?? null),
    };
    if (!config.model) throw badRequest("model is required");
    if (config.outputSchema) assertValidSchema(config.outputSchema);
    config.subagents = [...new Set(config.subagents)];
    for (const sub of config.subagents) {
      if (sub === selfSlug) throw badRequest("An agent cannot list itself as a sub-agent");
      if (!one(this.db, "SELECT 1 FROM agents WHERE slug = ?", sub))
        throw badRequest(`Unknown sub-agent '${sub}'`);
    }
    if (config.internet.mode === "allowlist" && config.internet.allowlist.length === 0) {
      throw badRequest("internet.allowlist needs at least one URL when mode is 'allowlist'");
    }
    return config;
  }

  private async applyFileChanges(
    current: Map<string, AgentFileInfo>,
    input: AgentInput,
  ): Promise<Map<string, AgentFileInfo>> {
    const next = new Map(current);
    for (const p of input.files?.remove ?? []) next.delete(normalizeRelPath(p));
    for (const f of input.files?.upsert ?? []) {
      const rel = normalizeRelPath(f.path);
      const entry = await this.blobs.put(decodeFileContent(f.content, f.encoding));
      next.set(rel, { path: rel, sha256: entry.sha256, size: entry.size });
    }
    return next;
  }

  private insertVersion(
    agentId: string,
    version: number,
    config: AgentConfig,
    files: Map<string, AgentFileInfo>,
    note: string | null,
    now: string,
  ): void {
    const versionId = newId("agv");
    run(
      this.db,
      "INSERT INTO agent_versions (id, agent_id, version, note, config, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      versionId,
      agentId,
      version,
      note,
      JSON.stringify(config),
      now,
    );
    for (const f of files.values()) {
      run(
        this.db,
        "INSERT INTO agent_version_files (version_id, path, sha256, size) VALUES (?, ?, ?, ?)",
        versionId,
        f.path,
        f.sha256,
        f.size,
      );
    }
  }

  /** Totals come from `cycle_usage`, so cycles deleted by retention (or by hand) still count. */
  private statsByAgent(agentId?: string): Map<string, AgentStats> {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const params = agentId ? [agentId] : [];
    const rows = all<{ agent_id: string; cycles: number; cost: number; last: string | null }>(
      this.db,
      `SELECT agent_id, COUNT(*) AS cycles, SUM(cost_usd) AS cost, MAX(created_at) AS last
       FROM cycle_usage ${where} GROUP BY agent_id`,
      ...params,
    );
    const running = new Map(
      all<{ agent_id: string; n: number }>(
        this.db,
        `SELECT agent_id, COUNT(*) AS n FROM cycles
         WHERE status IN ('running', 'queued') ${agentId ? "AND agent_id = ?" : ""} GROUP BY agent_id`,
        ...params,
      ).map((r) => [r.agent_id, r.n]),
    );
    return new Map(
      rows.map((r) => [
        r.agent_id,
        { cycles: r.cycles, running: running.get(r.agent_id) ?? 0, costUsd: r.cost ?? 0, lastRunAt: r.last },
      ]),
    );
  }

  private toDTO(row: AgentRow, stats?: AgentStats): Agent {
    const v = this.getVersionRow(row.id, row.current_version);
    return {
      id: row.id,
      slug: row.slug,
      archived: row.archived === 1,
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config: this.versionDTO(v),
      stats: stats ?? EMPTY_STATS,
    };
  }
}

function parseConfig(json: string): AgentConfig {
  const c = parseJson<Partial<AgentConfig>>(json, {});
  return {
    name: c.name ?? "",
    description: c.description ?? "",
    systemPrompt: c.systemPrompt ?? "",
    model: c.model ?? "",
    reasoning: c.reasoning ?? "medium",
    internet: c.internet ?? { mode: "none", allowlist: [] },
    javascript: c.javascript ?? false,
    python: c.python ?? false,
    limits: c.limits ?? {},
    subagents: c.subagents ?? [],
    outputSchema: c.outputSchema ?? null,
  };
}
