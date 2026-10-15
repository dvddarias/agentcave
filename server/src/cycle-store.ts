import type {
  Answer,
  Cycle,
  CycleError,
  CycleSource,
  CycleStatus,
  FileChanges,
  JsonSchema,
  Limits,
  LimitUsage,
  ReasoningEffort,
  StepUsage,
  Turn,
  Usage,
} from "@agentcave/client";
import type { ModelMessage } from "ai";
import type { Manifest } from "./blobs.js";
import { all, type DB, nowIso, one, type Param, parseJson, run, tx } from "./db.js";
import { badRequest, notFound } from "./errors.js";
import type { EventHub } from "./events.js";
import { newId } from "./ids.js";

export interface CycleRow {
  id: string;
  agent_id: string;
  agent_version_id: string;
  agent_slug: string;
  agent_name: string;
  agent_version: number;
  parent_id: string | null;
  root_id: string;
  depth: number;
  source: CycleSource;
  rerun_of: string | null;
  status: CycleStatus;
  model: string;
  reasoning: ReasoningEffort;
  limits: string;
  output_schema: string | null;
  labels: string;
  webhook_url: string | null;
  system_prompt: string;
  turn: number;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  cost_estimated: number;
  steps: number;
  sub_input_tokens: number;
  sub_output_tokens: number;
  sub_cost_usd: number;
  attempts: number;
  activity: string | null;
  last_paragraph: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TurnRow {
  id: string;
  cycle_id: string;
  idx: number;
  prompt: string;
  input_manifest: string;
  start_snapshot: string | null;
  end_snapshot: string | null;
  messages: string;
  status: CycleStatus;
  answer: string | null;
  changes: string | null;
  error_code: string | null;
  error_message: string | null;
  nudges: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  cost_estimated: number;
  steps: number;
  started_at: string | null;
  finished_at: string | null;
  /** Running time of the turn's finished runs (a continued turn runs more than once). */
  elapsed_ms: number;
  /** When the current (or last) run started. */
  run_started_at: string | null;
  /** Cost and input+output tokens with sub-agents included: what the limits count. */
  spent_usd: number;
  spent_tokens: number;
  /** Highest step number used so far; a continued run numbers its steps after it. */
  last_step: number;
  /** JSON `Resume` while a continue request waits to run. */
  resume: string | null;
}

/** A continue request waiting for the runner. */
export interface Resume {
  /** The error that stopped the previous run. */
  after: CycleError;
  /** The user message that tells the agent to continue. */
  message: string;
}

type JoinedRow = CycleRow & {
  p0: string | null;
  t_answer: string | null;
  t_changes: string | null;
  t_steps: number | null;
  t_elapsed_ms: number | null;
  t_run_started_at: string | null;
  t_spent_usd: number | null;
  t_spent_tokens: number | null;
};

export interface CreateCycleParams {
  agentId: string;
  agentVersionId: string;
  agentSlug: string;
  agentName: string;
  agentVersion: number;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  source: CycleSource;
  rerunOf: string | null;
  model: string;
  reasoning: ReasoningEffort;
  limits: Limits;
  outputSchema: JsonSchema | null;
  labels: Record<string, string>;
  webhookUrl: string | null;
  systemPrompt: string;
  prompt: string;
  inputManifest: Manifest;
  status?: CycleStatus;
}

export interface ListQuery {
  agent?: string;
  status?: CycleStatus[];
  labels?: Record<string, string>;
  parent?: string;
  rootOnly?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export const FINAL: CycleStatus[] = ["completed", "failed", "stopped"];

const SELECT_JOINED = `SELECT c.*, t.answer AS t_answer, t.changes AS t_changes, t.steps AS t_steps,
    t.elapsed_ms AS t_elapsed_ms, t.run_started_at AS t_run_started_at, t.spent_usd AS t_spent_usd,
    t.spent_tokens AS t_spent_tokens,
    (SELECT substr(t0.prompt, 1, 300) FROM turns t0 WHERE t0.cycle_id = c.id AND t0.idx = 0) AS p0
  FROM cycles c LEFT JOIN turns t ON t.cycle_id = c.id AND t.idx = c.turn`;

export function rowUsage(r: {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  cost_estimated: number;
  steps: number;
}): Usage {
  return {
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    cachedTokens: r.cached_tokens,
    costUsd: r.cost_usd,
    costEstimated: r.cost_estimated === 1,
    steps: r.steps,
  };
}

export function limitUsage(
  t: { elapsed_ms: number; run_started_at: string | null; spent_usd: number; spent_tokens: number },
  running: boolean,
): LimitUsage {
  const live = running && t.run_started_at ? Math.max(0, Date.now() - Date.parse(t.run_started_at)) : 0;
  return { timeSec: (t.elapsed_ms + live) / 1000, costUsd: t.spent_usd, tokens: t.spent_tokens };
}

/** Data access for cycles and turns. */
export class CycleStore {
  constructor(
    private readonly db: DB,
    private readonly events: EventHub,
  ) {}

  // ------------------------------------------------------------------ reads

  findRow(id: string): CycleRow | undefined {
    return one<CycleRow>(this.db, "SELECT * FROM cycles WHERE id = ?", id);
  }

  getRow(id: string): CycleRow {
    const row = this.findRow(id);
    if (!row) throw notFound(`Cycle '${id}'`);
    return row;
  }

  get(id: string, opts: { withSystemPrompt?: boolean } = {}): Cycle {
    const row = one<JoinedRow>(this.db, `${SELECT_JOINED} WHERE c.id = ?`, id);
    if (!row) throw notFound(`Cycle '${id}'`);
    return this.toDTO(row, opts);
  }

  turnRows(cycleId: string): TurnRow[] {
    return all<TurnRow>(this.db, "SELECT * FROM turns WHERE cycle_id = ? ORDER BY idx", cycleId);
  }

  turn(cycleId: string, idx: number): TurnRow {
    const row = one<TurnRow>(this.db, "SELECT * FROM turns WHERE cycle_id = ? AND idx = ?", cycleId, idx);
    if (!row) throw notFound(`Turn ${idx}`);
    return row;
  }

  latestTurn(cycleId: string): TurnRow {
    const row = one<TurnRow>(
      this.db,
      "SELECT * FROM turns WHERE cycle_id = ? ORDER BY idx DESC LIMIT 1",
      cycleId,
    );
    if (!row) throw notFound("Turn");
    return row;
  }

  turns(cycleId: string): Turn[] {
    this.getRow(cycleId);
    return this.turnRows(cycleId).map((t) => this.turnDTO(t));
  }

  children(cycleId: string): Cycle[] {
    return all<JoinedRow>(
      this.db,
      `${SELECT_JOINED} WHERE c.parent_id = ? ORDER BY c.created_at`,
      cycleId,
    ).map((r) => this.toDTO(r));
  }

  /** Ids of every cycle below `cycleId` (children, grandchildren…). */
  descendantIds(cycleId: string): string[] {
    return all<{ id: string }>(
      this.db,
      `WITH RECURSIVE sub(id) AS (SELECT id FROM cycles WHERE parent_id = ?
         UNION ALL SELECT c.id FROM cycles c JOIN sub ON c.parent_id = sub.id)
       SELECT id FROM sub`,
      cycleId,
    ).map((r) => r.id);
  }

  ancestorIds(row: CycleRow): string[] {
    const out: string[] = [];
    let parent = row.parent_id;
    while (parent) {
      out.push(parent);
      parent =
        one<{ parent_id: string | null }>(this.db, "SELECT parent_id FROM cycles WHERE id = ?", parent)
          ?.parent_id ?? null;
    }
    return out;
  }

  /** Messages of all completed turns before `idx` (conversation memory for follow-ups). */
  priorMessages(cycleId: string, idx: number): ModelMessage[] {
    return all<{ messages: string }>(
      this.db,
      "SELECT messages FROM turns WHERE cycle_id = ? AND idx < ? ORDER BY idx",
      cycleId,
      idx,
    ).flatMap((r) => parseJson<ModelMessage[]>(r.messages, []));
  }

  list(q: ListQuery): { cycles: Cycle[]; nextCursor: string | null } {
    const where: string[] = [];
    const params: Param[] = [];
    if (q.agent) {
      where.push("c.agent_slug = ?");
      params.push(q.agent);
    }
    if (q.status?.length) {
      where.push(`c.status IN (${q.status.map(() => "?").join(",")})`);
      params.push(...q.status);
    }
    if (q.parent) {
      where.push("c.parent_id = ?");
      params.push(q.parent);
    } else if (q.rootOnly !== false) {
      where.push("c.parent_id IS NULL");
    }
    for (const [k, v] of Object.entries(q.labels ?? {})) {
      where.push("json_extract(c.labels, ?) = ?");
      params.push(`$."${k.replace(/"/g, '""')}"`, v);
    }
    if (q.q) {
      where.push(
        "(c.id LIKE ? OR c.agent_slug LIKE ? OR c.labels LIKE ? OR EXISTS (SELECT 1 FROM turns tt WHERE tt.cycle_id = c.id AND tt.prompt LIKE ?))",
      );
      const like = `%${q.q.replace(/[%_]/g, "")}%`;
      params.push(like, like, like, like);
    }
    if (q.cursor) {
      const [createdAt, id] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
      if (!createdAt || !id) throw badRequest("Invalid cursor");
      where.push("(c.created_at, c.id) < (?, ?)");
      params.push(createdAt, id);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = all<JoinedRow>(
      this.db,
      `${SELECT_JOINED} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      cycles: page.map((r) => this.toDTO(r)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.created_at}|${last.id}`).toString("base64url")
          : null,
    };
  }

  nextQueued(exclude: Set<string>, limit: number): CycleRow[] {
    return all<CycleRow>(
      this.db,
      "SELECT * FROM cycles WHERE status = 'queued' AND parent_id IS NULL ORDER BY updated_at, created_at LIMIT ?",
      limit + exclude.size,
    )
      .filter((r) => !exclude.has(r.id))
      .slice(0, limit);
  }

  counts(): { running: number; queued: number } {
    const r = one<{ running: number; queued: number }>(
      this.db,
      `SELECT SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
       FROM cycles WHERE parent_id IS NULL`,
    );
    return { running: r?.running ?? 0, queued: r?.queued ?? 0 };
  }

  // ------------------------------------------------------------------ writes

  create(p: CreateCycleParams): CycleRow {
    const id = newId("cyc");
    const now = nowIso();
    tx(this.db, () => {
      run(
        this.db,
        `INSERT INTO cycles (id, agent_id, agent_version_id, agent_slug, agent_name, agent_version, parent_id, root_id, depth,
          source, rerun_of, status, model, reasoning, limits, output_schema, labels, webhook_url, system_prompt, turn,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        p.agentId,
        p.agentVersionId,
        p.agentSlug,
        p.agentName,
        p.agentVersion,
        p.parentId,
        p.rootId ?? id,
        p.depth,
        p.source,
        p.rerunOf,
        p.status ?? "queued",
        p.model,
        p.reasoning,
        JSON.stringify(p.limits),
        p.outputSchema ? JSON.stringify(p.outputSchema) : null,
        JSON.stringify(p.labels),
        p.webhookUrl,
        p.systemPrompt,
        now,
        now,
      );
      this.insertTurn(id, 0, p.prompt, p.inputManifest, p.status ?? "queued");
    });
    this.events.append(id, 0, 0, {
      type: "cycle.status",
      data: { status: p.status ?? "queued", error: null },
    });
    this.events.touch(id);
    return this.getRow(id);
  }

  private insertTurn(
    cycleId: string,
    idx: number,
    prompt: string,
    manifest: Manifest,
    status: CycleStatus,
  ): void {
    run(
      this.db,
      "INSERT INTO turns (id, cycle_id, idx, prompt, input_manifest, status) VALUES (?, ?, ?, ?, ?, ?)",
      newId("trn"),
      cycleId,
      idx,
      prompt,
      JSON.stringify(manifest),
      status,
    );
  }

  /** Adds a follow-up turn and puts the cycle back in the queue. */
  addTurn(cycleId: string, prompt: string, manifest: Manifest): CycleRow {
    const row = this.getRow(cycleId);
    const idx = row.turn + 1;
    tx(this.db, () => {
      this.insertTurn(cycleId, idx, prompt, manifest, "queued");
      run(
        this.db,
        `UPDATE cycles SET turn = ?, status = 'queued', error_code = NULL, error_message = NULL, activity = NULL,
          last_paragraph = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
        idx,
        nowIso(),
        cycleId,
      );
    });
    this.events.append(cycleId, idx, row.attempts, {
      type: "cycle.status",
      data: { status: "queued", error: null },
    });
    this.events.touch(cycleId);
    return this.getRow(cycleId);
  }

  markRunning(cycleId: string, turnId: string): void {
    const now = nowIso();
    tx(this.db, () => {
      run(
        this.db,
        "UPDATE cycles SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL, updated_at = ? WHERE id = ?",
        now,
        now,
        cycleId,
      );
      run(
        this.db,
        "UPDATE turns SET status = 'running', started_at = COALESCE(started_at, ?), run_started_at = ? WHERE id = ?",
        now,
        now,
        turnId,
      );
    });
    this.events.touch(cycleId);
  }

  setStartSnapshot(turnId: string, manifest: Manifest): void {
    run(this.db, "UPDATE turns SET start_snapshot = ? WHERE id = ?", JSON.stringify(manifest), turnId);
  }

  saveMessages(turnId: string, messages: ModelMessage[], nudges: number): void {
    run(
      this.db,
      "UPDATE turns SET messages = ?, nudges = ? WHERE id = ?",
      JSON.stringify(messages),
      nudges,
      turnId,
    );
  }

  /** Resets a turn so it can start over (container restart). */
  resetTurnForRetry(turnId: string): void {
    run(
      this.db,
      `UPDATE turns SET status = 'queued', messages = '[]', nudges = 0, answer = NULL, changes = NULL, error_code = NULL,
        error_message = NULL, input_tokens = 0, output_tokens = 0, reasoning_tokens = 0, cached_tokens = 0,
        cost_usd = 0, cost_estimated = 0, steps = 0, elapsed_ms = 0, spent_usd = 0, spent_tokens = 0, last_step = 0,
        resume = NULL WHERE id = ?`,
      turnId,
    );
  }

  setActivity(cycleId: string, activity: string | null, lastParagraph?: string): void {
    if (lastParagraph !== undefined) {
      run(
        this.db,
        "UPDATE cycles SET activity = ?, last_paragraph = ?, updated_at = ? WHERE id = ?",
        activity,
        lastParagraph,
        nowIso(),
        cycleId,
      );
    } else {
      run(
        this.db,
        "UPDATE cycles SET activity = ?, updated_at = ? WHERE id = ?",
        activity,
        nowIso(),
        cycleId,
      );
    }
    this.events.touch(cycleId);
  }

  addUsage(cycleId: string, turnId: string, ancestors: string[], u: StepUsage): void {
    const now = nowIso();
    const est = u.costEstimated ? 1 : 0;
    tx(this.db, () => {
      run(
        this.db,
        `UPDATE cycles SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
          reasoning_tokens = reasoning_tokens + ?, cached_tokens = cached_tokens + ?, cost_usd = cost_usd + ?,
          cost_estimated = MAX(cost_estimated, ?), steps = steps + 1, updated_at = ? WHERE id = ?`,
        u.inputTokens,
        u.outputTokens,
        u.reasoningTokens,
        u.cachedTokens,
        u.costUsd,
        est,
        now,
        cycleId,
      );
      run(
        this.db,
        `UPDATE turns SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
          reasoning_tokens = reasoning_tokens + ?, cached_tokens = cached_tokens + ?, cost_usd = cost_usd + ?,
          cost_estimated = MAX(cost_estimated, ?), steps = steps + 1, spent_usd = spent_usd + ?,
          spent_tokens = spent_tokens + ? WHERE id = ?`,
        u.inputTokens,
        u.outputTokens,
        u.reasoningTokens,
        u.cachedTokens,
        u.costUsd,
        est,
        u.costUsd,
        u.inputTokens + u.outputTokens,
        turnId,
      );
      for (const a of ancestors) {
        run(
          this.db,
          `UPDATE cycles SET sub_input_tokens = sub_input_tokens + ?, sub_output_tokens = sub_output_tokens + ?,
            sub_cost_usd = sub_cost_usd + ?, updated_at = ? WHERE id = ?`,
          u.inputTokens,
          u.outputTokens,
          u.costUsd,
          now,
          a,
        );
        // Sub-agent spending counts toward the limits of the ancestor's running turn.
        run(
          this.db,
          `UPDATE turns SET spent_usd = spent_usd + ?, spent_tokens = spent_tokens + ?
           WHERE cycle_id = ? AND idx = (SELECT turn FROM cycles WHERE id = ?)`,
          u.costUsd,
          u.inputTokens + u.outputTokens,
          a,
          a,
        );
      }
    });
    this.events.touch(cycleId);
    for (const a of ancestors) this.events.touch(a);
  }

  finishTurn(
    turnId: string,
    r: {
      status: CycleStatus;
      answer: Answer | null;
      changes: FileChanges | null;
      endSnapshot: Manifest | null;
      error: CycleError | null;
      /** Running time of all the turn's runs so far (unchanged when left out). */
      elapsedMs?: number;
      lastStep?: number;
    },
  ): void {
    run(
      this.db,
      `UPDATE turns SET status = ?, answer = ?, changes = ?, end_snapshot = COALESCE(?, end_snapshot),
        error_code = ?, error_message = ?, finished_at = ?, elapsed_ms = COALESCE(?, elapsed_ms),
        last_step = COALESCE(?, last_step), resume = NULL WHERE id = ?`,
      r.status,
      r.answer ? JSON.stringify(r.answer) : null,
      r.changes ? JSON.stringify(r.changes) : null,
      r.endSnapshot ? JSON.stringify(r.endSnapshot) : null,
      r.error?.code ?? null,
      r.error?.message ?? null,
      nowIso(),
      r.elapsedMs ?? null,
      r.lastStep ?? null,
      turnId,
    );
  }

  /** Puts a turn that a limit stopped back in the queue, to run on from where it stopped. */
  continueTurn(cycleId: string, turnId: string, limits: Limits, resume: Resume): CycleRow {
    const row = this.getRow(cycleId);
    tx(this.db, () => {
      run(
        this.db,
        `UPDATE turns SET status = 'queued', error_code = NULL, error_message = NULL, finished_at = NULL, resume = ?
         WHERE id = ?`,
        JSON.stringify(resume),
        turnId,
      );
      run(
        this.db,
        `UPDATE cycles SET limits = ?, status = 'queued', error_code = NULL, error_message = NULL, activity = NULL,
          finished_at = NULL, updated_at = ? WHERE id = ?`,
        JSON.stringify(limits),
        nowIso(),
        cycleId,
      );
    });
    this.events.append(cycleId, row.turn, row.attempts, {
      type: "cycle.status",
      data: { status: "queued", error: null },
    });
    this.events.touch(cycleId);
    return this.getRow(cycleId);
  }

  finishCycle(cycleId: string, status: CycleStatus, error: CycleError | null): void {
    const now = nowIso();
    run(
      this.db,
      `UPDATE cycles SET status = ?, error_code = ?, error_message = ?, activity = NULL, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      error?.code ?? null,
      error?.message ?? null,
      now,
      now,
      cycleId,
    );
    this.events.touch(cycleId);
  }

  /** Container-restart recovery: put a running top-level cycle back in the queue. */
  requeueAfterRestart(cycleId: string): CycleRow {
    run(
      this.db,
      "UPDATE cycles SET status = 'queued', attempts = attempts + 1, activity = NULL, updated_at = ? WHERE id = ?",
      nowIso(),
      cycleId,
    );
    return this.getRow(cycleId);
  }

  // ------------------------------------------------------------------ DTOs

  toDTO(
    r: CycleRow & Partial<Omit<JoinedRow, keyof CycleRow>>,
    opts: { withSystemPrompt?: boolean } = {},
  ): Cycle {
    const dto: Cycle = {
      id: r.id,
      status: r.status,
      agent: { slug: r.agent_slug, name: r.agent_name, version: r.agent_version },
      model: r.model,
      reasoning: r.reasoning,
      limits: parseJson<Limits>(r.limits, {}),
      outputSchema: parseJson<JsonSchema | null>(r.output_schema, null),
      labels: parseJson<Record<string, string>>(r.labels, {}),
      webhookUrl: r.webhook_url,
      source: r.source,
      parentId: r.parent_id,
      rootId: r.root_id,
      depth: r.depth,
      rerunOf: r.rerun_of,
      promptPreview: r.p0 ?? "",
      turn: r.turn,
      turns: r.turn + 1,
      progress: { steps: r.t_steps ?? 0, activity: r.activity, lastParagraph: r.last_paragraph },
      usage: rowUsage(r),
      totalUsage: {
        inputTokens: r.input_tokens + r.sub_input_tokens,
        outputTokens: r.output_tokens + r.sub_output_tokens,
        costUsd: r.cost_usd + r.sub_cost_usd,
      },
      limitUsage: limitUsage(
        {
          elapsed_ms: r.t_elapsed_ms ?? 0,
          run_started_at: r.t_run_started_at ?? null,
          spent_usd: r.t_spent_usd ?? 0,
          spent_tokens: r.t_spent_tokens ?? 0,
        },
        r.status === "running",
      ),
      answer: parseJson<Answer | null>(r.t_answer, null),
      files: parseJson<FileChanges | null>(r.t_changes, null),
      error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
      attempts: r.attempts,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
    };
    if (r.t_answer === undefined) {
      // Not a joined row: load the latest turn.
      const t = one<TurnRow>(this.db, "SELECT * FROM turns WHERE cycle_id = ? AND idx = ?", r.id, r.turn);
      dto.answer = parseJson<Answer | null>(t?.answer, null);
      dto.files = parseJson<FileChanges | null>(t?.changes, null);
      dto.progress.steps = t?.steps ?? 0;
      if (t) dto.limitUsage = limitUsage(t, r.status === "running");
      dto.promptPreview =
        one<{ p: string }>(
          this.db,
          "SELECT substr(prompt, 1, 300) AS p FROM turns WHERE cycle_id = ? AND idx = 0",
          r.id,
        )?.p ?? "";
    }
    if (opts.withSystemPrompt) dto.systemPrompt = r.system_prompt;
    return dto;
  }

  turnDTO(t: TurnRow): Turn {
    return {
      index: t.idx,
      prompt: t.prompt,
      inputFiles: Object.keys(parseJson<Manifest>(t.input_manifest, {})).sort(),
      status: t.status,
      answer: parseJson<Answer | null>(t.answer, null),
      files: parseJson<FileChanges | null>(t.changes, null),
      error: t.error_code ? { code: t.error_code, message: t.error_message ?? "" } : null,
      usage: rowUsage(t),
      limitUsage: limitUsage(t, t.status === "running"),
      nudges: t.nudges,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
    };
  }
}
