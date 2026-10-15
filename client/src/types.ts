/**
 * AgentCave HTTP API types (v1).
 *
 * This file is the single source of truth for the API contract: the server, the web UI
 * and the published client all import these types.
 */

export type JsonSchema = Record<string, unknown>;

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export type InternetMode = "none" | "allowlist" | "full";

/** Safety caps. `null` (or missing) means "no limit". */
export interface Limits {
  /** Max wall-clock seconds for one turn (sub-agents included). */
  maxTimeSec?: number | null;
  /** Max USD spent on OpenRouter in one turn (sub-agents included). */
  maxCostUsd?: number | null;
  /** Max input+output tokens in one turn (sub-agents included). */
  maxTokens?: number | null;
}

/** A file sent inside JSON. `content` is UTF-8 text unless `encoding` is `"base64"`. */
export interface FileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentInternet {
  mode: InternetMode;
  /** URL prefixes (scheme + host + optional path) used when mode is `allowlist`. */
  allowlist: string[];
}

/** The editable configuration of an agent. Every save creates a new version. */
export interface AgentConfig {
  name: string;
  description: string;
  /** Markdown system prompt. */
  systemPrompt: string;
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-5.5`. */
  model: string;
  reasoning: ReasoningEffort;
  internet: AgentInternet;
  javascript: boolean;
  python: boolean;
  limits: Limits;
  /** Slugs of agents this agent may call as sub-agents. */
  subagents: string[];
  /** Default answer JSON Schema. `null` = free Markdown answer. */
  outputSchema: JsonSchema | null;
}

export interface AgentFileInfo {
  path: string;
  size: number;
  sha256: string;
}

export interface AgentVersion extends AgentConfig {
  version: number;
  note: string | null;
  files: AgentFileInfo[];
  createdAt: string;
}

export interface AgentStats {
  cycles: number;
  running: number;
  costUsd: number;
  lastRunAt: string | null;
}

export interface Agent {
  id: string;
  slug: string;
  archived: boolean;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  /** The current version's full configuration. */
  config: AgentVersion;
  stats: AgentStats;
}

/** Body of `POST /agents` and `PUT /agents/:slug`. Missing fields keep their current value (on update). */
export interface AgentInput {
  /** Only used on create. Lowercase letters, digits and dashes. */
  slug?: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  reasoning?: ReasoningEffort;
  internet?: AgentInternet;
  javascript?: boolean;
  python?: boolean;
  limits?: Limits;
  subagents?: string[];
  outputSchema?: JsonSchema | null;
  /** Optional note stored with the new version ("tightened the tone"). */
  note?: string;
  /** Changes to the agent's own (read-only, mounted at /agent) files. */
  files?: {
    upsert?: FileInput[];
    remove?: string[];
  };
}

// ---------------------------------------------------------------------------
// Models / settings / stats
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  /** USD per token. */
  pricing: { prompt: number; completion: number; cacheRead: number | null };
  supportsReasoning: boolean;
  supportsImages: boolean;
  created: number;
}

export interface ModelList {
  models: ModelInfo[];
  fetchedAt: string | null;
  stale: boolean;
}

export interface Settings {
  openrouterToken: { set: boolean; masked: string | null };
  maxParallel: number;
  retentionDays: number;
  defaultLimits: Limits;
  hardStepCap: number;
  maxNudges: number;
  subagentMaxDepth: number;
  toolOutputCapBytes: number;
  commandTimeoutSec: number;
  contextTrimRatio: number;
  maxRequestMb: number;
  /** Shown in full: receivers need it to verify `X-AgentCave-Signature`. */
  webhookSecret: string | null;
}

export interface SettingsUpdate {
  /** `null` clears the token. */
  openrouterToken?: string | null;
  maxParallel?: number;
  retentionDays?: number;
  defaultLimits?: Limits;
  hardStepCap?: number;
  maxNudges?: number;
  subagentMaxDepth?: number;
  toolOutputCapBytes?: number;
  commandTimeoutSec?: number;
  contextTrimRatio?: number;
  maxRequestMb?: number;
  /** A string sets it, `null` clears it, `"generate"` creates a random one. */
  webhookSecret?: string | null;
}

export interface TokenCheck {
  ok: boolean;
  label: string | null;
  limit: number | null;
  usage: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean | null;
  error: string | null;
}

export interface StatsRow {
  key: string;
  label: string;
  cycles: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Stats {
  from: string;
  to: string;
  totals: { cycles: number; inputTokens: number; outputTokens: number; costUsd: number };
  byDay: StatsRow[];
  byAgent: StatsRow[];
  byModel: StatsRow[];
}

export interface Health {
  ok: boolean;
  version: string;
  uptimeSec: number;
  queue: { running: number; queued: number; maxParallel: number };
  tokenSet: boolean;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

export type CycleStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export const FINAL_STATUSES: readonly CycleStatus[] = ["completed", "failed", "stopped"];

export type CycleSource = "api" | "ui" | "subagent" | "rerun";

export type ErrorCode =
  | "limit_time"
  | "limit_money"
  | "limit_tokens"
  | "limit_steps"
  | "no_submit"
  | "no_token"
  | "model_error"
  | "context_overflow"
  | "interrupted"
  | "stopped"
  | "internal";

export interface CycleError {
  code: ErrorCode | string;
  message: string;
}

/** Errors after which the turn can be continued with `POST /cycles/:id/continue`. */
export const CONTINUABLE_ERRORS: readonly ErrorCode[] = [
  "limit_time",
  "limit_money",
  "limit_tokens",
  "limit_steps",
];

/** What a turn has used, counted the way `Limits` count it (sub-agents included). */
export interface LimitUsage {
  /** Running time; time spent waiting in the queue or stopped does not count. */
  timeSec: number;
  costUsd: number;
  /** Input + output tokens. */
  tokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** True when at least one step's cost was computed from catalog prices (provider sent no cost). */
  costEstimated: boolean;
  steps: number;
}

export type Answer = { format: "markdown"; text: string } | { format: "json"; data: unknown };

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface StartCycleRequest {
  /** Agent slug. */
  agent: string;
  /** Pin a specific agent version (default: current). */
  agentVersion?: number;
  prompt: string;
  files?: FileInput[];
  overrides?: { model?: string; reasoning?: ReasoningEffort; limits?: Limits };
  /** Answer JSON Schema for this cycle. `undefined` = agent default, `null` = force Markdown. */
  outputSchema?: JsonSchema | null;
  labels?: Record<string, string>;
  /** Called on turn/cycle completion. */
  webhookUrl?: string;
  /** Set by the web UI; API callers can leave it out. */
  source?: "api" | "ui";
}

export interface FollowUpRequest {
  prompt: string;
  files?: FileInput[];
}

export interface RerunRequest {
  agentVersion?: number;
  overrides?: { model?: string; reasoning?: ReasoningEffort; limits?: Limits };
  outputSchema?: JsonSchema | null;
  labels?: Record<string, string>;
  webhookUrl?: string | null;
}

/**
 * Body of `POST /cycles/:id/continue`: resume a turn that a limit stopped (see `CONTINUABLE_ERRORS`),
 * from where it stopped, with the same memory and files. Its usage so far keeps counting.
 */
export interface ContinueRequest {
  /**
   * New limits, merged over the current ones (`null` removes a limit). They are totals for the whole
   * turn, so they must be above what it already used (`Cycle.limitUsage`). They stay for later turns.
   */
  limits?: Limits;
  /**
   * Every limit that has no room left and is not set in `limits` (normally the one that stopped the
   * turn) gets this percentage of itself as new room. Default 50.
   */
  extendPercent?: number;
  /** Extra instructions for the agent, added to the message that tells it to continue. */
  message?: string;
}

export interface CycleProgress {
  steps: number;
  /** Short human text: "running bash: grep -rn TODO src/". */
  activity: string | null;
  /** The most recent answer-text paragraph. */
  lastParagraph: string | null;
}

export interface Cycle {
  id: string;
  status: CycleStatus;
  agent: { slug: string; name: string; version: number };
  model: string;
  reasoning: ReasoningEffort;
  limits: Limits;
  outputSchema: JsonSchema | null;
  labels: Record<string, string>;
  webhookUrl: string | null;
  source: CycleSource;
  parentId: string | null;
  rootId: string;
  depth: number;
  rerunOf: string | null;
  /** First 300 characters of the first prompt. */
  promptPreview: string;
  /** Index of the latest turn (0 = first prompt). */
  turn: number;
  turns: number;
  progress: CycleProgress;
  /** This cycle's own usage, all turns. */
  usage: Usage;
  /** Own usage + every sub-agent below it. */
  totalUsage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** What the latest turn has used against `limits`. */
  limitUsage: LimitUsage;
  /** Latest turn's answer. */
  answer: Answer | null;
  /** Latest turn's file changes. */
  files: FileChanges | null;
  error: CycleError | null;
  /** How many times the cycle was restarted after a container restart. */
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  /** Only on `GET /cycles/:id`: the exact system prompt sent to the model. */
  systemPrompt?: string;
}

export interface Turn {
  index: number;
  prompt: string;
  /** Files added by this turn's request. */
  inputFiles: string[];
  status: CycleStatus;
  answer: Answer | null;
  files: FileChanges | null;
  error: CycleError | null;
  usage: Usage;
  /** What this turn has used against the limits. */
  limitUsage: LimitUsage;
  nudges: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CycleList {
  cycles: Cycle[];
  nextCursor: string | null;
}

export type FileStatus = "added" | "modified" | "deleted" | "unchanged";

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  status: FileStatus;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Events (SSE `GET /cycles/:id/events`)
// ---------------------------------------------------------------------------

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  costEstimated: boolean;
}

export type CycleEventPayload =
  | { type: "cycle.status"; data: { status: CycleStatus; error: CycleError | null } }
  | {
      type: "turn.start";
      data: {
        prompt: string;
        files: string[];
        systemPrompt: string;
        model: string;
        reasoning: ReasoningEffort;
      };
    }
  /**
   * A turn stopped by a limit runs again from where it stopped (`POST /cycles/:id/continue`).
   * `used` is what the turn had used before this run; `message` is what the agent was told.
   */
  | {
      type: "turn.continue";
      data: { after: CycleError; limits: Limits; used: LimitUsage; message: string };
    }
  | { type: "step.start"; data: { step: number } }
  /** A slice of thinking. Concatenate all slices with the same `blockId` to get the full text. */
  | {
      type: "reasoning";
      data: { step: number; blockId: string; text: string; hidden?: boolean; tokens?: number };
    }
  /** A slice (about one paragraph) of answer text. Concatenate slices with the same `blockId`. */
  | { type: "text"; data: { step: number; blockId: string; text: string } }
  | { type: "tool.call"; data: { step: number; callId: string; tool: string; input: unknown } }
  | {
      type: "tool.result";
      data: {
        step: number;
        callId: string;
        tool: string;
        output: unknown;
        error: string | null;
        exitCode: number | null;
        truncated: boolean;
        ms: number;
      };
    }
  | { type: "subagent.start"; data: { callId: string; childId: string; agent: string; prompt: string } }
  | {
      type: "subagent.end";
      data: { callId: string; childId: string; agent: string; status: CycleStatus; costUsd: number };
    }
  | { type: "nudge"; data: { count: number; message: string } }
  | { type: "trim"; data: { trimmedOutputs: number; estimatedTokens: number; contextLength: number } }
  | { type: "usage"; data: { step: number; stepUsage: StepUsage; turnUsage: Usage; cycleUsage: Usage } }
  | { type: "answer"; data: { answer: Answer; files: FileChanges } }
  | { type: "error"; data: CycleError }
  | { type: "turn.end"; data: { status: CycleStatus; usage: Usage; files: FileChanges | null } }
  | { type: "restart"; data: { attempt: number; reason: string } };

export type CycleEventType = CycleEventPayload["type"];

export type CycleEvent = CycleEventPayload & {
  seq: number;
  cycleId: string;
  turn: number;
  attempt: number;
  ts: string;
};

/** Event sent on the global feed `GET /events`. */
export interface CycleUpdate {
  type: "cycle.updated" | "cycle.deleted";
  cycle: Cycle | null;
  id: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface WebhookPayload {
  /** Sent at the end of every turn (the first prompt and each follow-up). */
  event: "cycle.completed" | "cycle.failed" | "cycle.stopped";
  /** Index of the turn that just ended. */
  turn: number;
  sentAt: string;
  cycle: Cycle;
}
