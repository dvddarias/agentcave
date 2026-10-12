import type { ErrorCode, Limits } from "@agentcave/client";

export interface LimitHit {
  code: Extract<ErrorCode, "limit_money" | "limit_tokens">;
  message: string;
}

/**
 * Tracks spending for one turn. Sub-agent turns get a child budget: their spending also counts
 * against every ancestor, and an ancestor's limit stops the child too.
 */
export class Budget {
  costUsd = 0;
  tokens = 0;

  constructor(
    readonly limits: Limits,
    readonly parent: Budget | null = null,
  ) {}

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
