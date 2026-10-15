import type { Limits, LimitUsage } from "@agentcave/client";
import { formatCost, formatDuration, formatTokens } from "./format";

export interface LimitInfo {
  /** "time limit", "money limit"… */
  label: string;
  /** The limit it hit; `null` for the hidden step cap. */
  key: keyof Limits | null;
  used: keyof LimitUsage | null;
  format: (value: number) => string;
}

/** The errors a turn can be continued after, and the limit each one is about. */
export const LIMIT_ERRORS: Record<string, LimitInfo> = {
  limit_time: {
    label: "time limit",
    key: "maxTimeSec",
    used: "timeSec",
    format: (s) => formatDuration(s * 1000),
  },
  limit_money: { label: "money limit", key: "maxCostUsd", used: "costUsd", format: (v) => formatCost(v) },
  limit_tokens: { label: "token limit", key: "maxTokens", used: "tokens", format: formatTokens },
  limit_steps: { label: "step limit", key: null, used: null, format: String },
};

/** The server's rule for continuing: `room` more on top of what was used (or of the limit, if higher). */
export function raisedLimit(key: keyof Limits, max: number, used: number, room: number): number {
  const raised = Math.max(max, used) + room;
  return key === "maxCostUsd" ? Math.round(raised * 1e6) / 1e6 : Math.ceil(raised);
}
