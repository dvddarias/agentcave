import type { ContinueRequest, ErrorCode, Limits, LimitUsage } from "@agentcave/client";
import { ApiError } from "../errors.js";
import { mergeLimits } from "../settings.js";

export interface LimitHit {
  code: Extract<ErrorCode, "limit_money" | "limit_tokens">;
  message: string;
}

/** Error codes after which a turn can be continued (`CONTINUABLE_ERRORS` in the client types). */
export const CONTINUABLE: readonly string[] = ["limit_time", "limit_money", "limit_tokens", "limit_steps"];

/**
 * Tracks spending for one turn. Sub-agent turns get a child budget: their spending also counts
 * against every ancestor, and an ancestor's limit stops the child too.
 */
export class Budget {
  costUsd: number;
  tokens: number;

  constructor(
    readonly limits: Limits,
    readonly parent: Budget | null = null,
    /** What the turn already spent in earlier runs (a continued turn). */
    spent: { costUsd: number; tokens: number } = { costUsd: 0, tokens: 0 },
  ) {
    this.costUsd = spent.costUsd;
    this.tokens = spent.tokens;
  }

  add(costUsd: number, tokens: number): void {
    this.costUsd += costUsd;
    this.tokens += tokens;
    this.parent?.add(costUsd, tokens);
  }

  exceeded(): LimitHit | null {
    const { maxCostUsd, maxTokens } = this.limits;
    if (maxCostUsd != null && this.costUsd > maxCostUsd) {
      return {
        code: "limit_money",
        message: `Money limit reached: spent $${this.costUsd.toFixed(4)} of $${maxCostUsd}`,
      };
    }
    if (maxTokens != null && this.tokens > maxTokens) {
      return {
        code: "limit_tokens",
        message: `Token limit reached: used ${this.tokens} of ${maxTokens} tokens`,
      };
    }
    return this.parent?.exceeded() ?? null;
  }
}

const LIMITS = [
  { key: "maxTimeSec", used: "timeSec", name: "time" },
  { key: "maxCostUsd", used: "costUsd", name: "money" },
  { key: "maxTokens", used: "tokens", name: "token" },
] as const;

type LimitKey = (typeof LIMITS)[number]["key"];

/** "5m 30s", "$0.25", "120,000 tokens". */
export function describeLimit(key: LimitKey, value: number): string {
  if (key === "maxCostUsd") return `$${value >= 0.01 ? value.toFixed(2) : Number(value.toFixed(4))}`;
  if (key === "maxTokens") return `${Math.round(value).toLocaleString("en-US")} tokens`;
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The limits a continued turn runs with: `req.limits` merged over the current ones, and every other
 * limit with no room left raised by `extendPercent` (default 50) of itself, on top of what was used.
 * Throws a 400 when a limit would still leave no room.
 */
export function limitsForContinue(
  current: Limits,
  used: LimitUsage,
  req: Pick<ContinueRequest, "limits" | "extendPercent">,
): Limits {
  const out = mergeLimits(current, req.limits);
  const extra = (req.extendPercent ?? 50) / 100;
  for (const l of LIMITS) {
    const max = current[l.key];
    if (req.limits?.[l.key] !== undefined || max == null || used[l.used] < max) continue;
    const raised = Math.max(max, used[l.used]) + max * extra;
    out[l.key] = l.key === "maxCostUsd" ? Math.round(raised * 1e6) / 1e6 : Math.ceil(raised);
  }
  for (const l of LIMITS) {
    const max = out[l.key];
    if (max != null && used[l.used] >= max) {
      throw new ApiError(
        400,
        "no_room",
        `The ${l.name} limit (${describeLimit(l.key, max)}) leaves no room: this turn already used ${describeLimit(l.key, used[l.used])}`,
      );
    }
  }
  return out;
}

/** What is left under each limit, e.g. ["5m more time", "$0.5 more to spend"]. */
export function roomLeft(limits: Limits, used: LimitUsage): string[] {
  const out: string[] = [];
  for (const l of LIMITS) {
    const max = limits[l.key];
    if (max == null) continue;
    const left = describeLimit(l.key, max - used[l.used]);
    out.push(
      l.key === "maxTimeSec"
        ? `${left} more time`
        : l.key === "maxCostUsd"
          ? `${left} more to spend`
          : left.replace(" tokens", " more tokens"),
    );
  }
  return out;
}

/** Abort reason used for every intentional cancellation of a run. */
export class RunAbort extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunAbort";
  }
}

/** Error that ends a turn with a specific error code. */
export class RunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}
