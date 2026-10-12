import type { Limits, Settings, SettingsUpdate } from "@agentcave/client";
import { all, type DB, run, tx } from "./db.js";
import { randomSecret } from "./ids.js";

export interface InternalSettings {
  openrouterToken: string | null;
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
  webhookSecret: string | null;
}

export const DEFAULT_SETTINGS: InternalSettings = {
  openrouterToken: null,
  maxParallel: 4,
  retentionDays: 30,
  defaultLimits: { maxTimeSec: 900, maxCostUsd: 1, maxTokens: 2_000_000 },
  hardStepCap: 500,
  maxNudges: 3,
  subagentMaxDepth: 3,
  toolOutputCapBytes: 30 * 1024,
  commandTimeoutSec: 60,
  contextTrimRatio: 0.6,
  maxRequestMb: 50,
  webhookSecret: null,
};

type Listener = (s: InternalSettings) => void;

export class SettingsService {
  private cache: InternalSettings | null = null;
  private listeners: Listener[] = [];

  constructor(private readonly db: DB) {}

  get(): InternalSettings {
    if (this.cache) return this.cache;
    const rows = all<{ key: string; value: string }>(this.db, "SELECT key, value FROM settings");
    const s: InternalSettings = structuredClone(DEFAULT_SETTINGS);
    for (const row of rows) {
      if (row.key in s) {
        try {
          (s as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
        } catch {
          // ignore corrupt values, keep default
        }
      }
    }
    this.cache = s;
    return s;
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }

  update(update: SettingsUpdate): InternalSettings {
    const patch: Partial<InternalSettings> = {};
    const u = update as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof InternalSettings)[]) {
      if (u[key] !== undefined) (patch as Record<string, unknown>)[key] = u[key];
    }
    if (update.webhookSecret === "generate") patch.webhookSecret = randomSecret();
    if (typeof patch.openrouterToken === "string") {
      patch.openrouterToken = patch.openrouterToken.trim() || null;
    }
    tx(this.db, () => {
      for (const [key, value] of Object.entries(patch)) {
        run(
          this.db,
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          JSON.stringify(value),
        );
      }
    });
    this.cache = null;
    const next = this.get();
    for (const l of this.listeners) l(next);
    return next;
  }

  toDTO(s: InternalSettings = this.get()): Settings {
    const token = s.openrouterToken;
    return {
      openrouterToken: {
        set: !!token,
        masked: token ? `${token.slice(0, 8)}…${token.slice(-4)}` : null,
      },
      maxParallel: s.maxParallel,
      retentionDays: s.retentionDays,
      defaultLimits: s.defaultLimits,
      hardStepCap: s.hardStepCap,
      maxNudges: s.maxNudges,
      subagentMaxDepth: s.subagentMaxDepth,
      toolOutputCapBytes: s.toolOutputCapBytes,
      commandTimeoutSec: s.commandTimeoutSec,
      contextTrimRatio: s.contextTrimRatio,
      maxRequestMb: s.maxRequestMb,
      webhookSecret: s.webhookSecret,
    };
  }
}

/** Merges limit layers; later layers win. An explicit `null` means "no limit". */
export function mergeLimits(...layers: (Limits | null | undefined)[]): Limits {
  const out: Limits = { maxTimeSec: null, maxCostUsd: null, maxTokens: null };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of ["maxTimeSec", "maxCostUsd", "maxTokens"] as const) {
      if (layer[key] !== undefined) out[key] = layer[key];
    }
  }
  return out;
}
