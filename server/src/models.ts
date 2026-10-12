import type { ModelInfo, ModelList } from "@agentcave/client";
import { type DB, nowIso, one, run } from "./db.js";
import { log } from "./log.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = "openrouter_models";

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  top_provider?: { max_completion_tokens?: number | null; context_length?: number | null };
  supported_parameters?: string[];
}

function num(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function toModelInfo(m: RawModel): ModelInfo {
  const params = m.supported_parameters ?? [];
  return {
    id: m.id,
    name: m.name ?? m.id,
    description: m.description ?? "",
    contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
    maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
    pricing: {
      prompt: num(m.pricing?.prompt),
      completion: num(m.pricing?.completion),
      cacheRead: m.pricing?.input_cache_read !== undefined ? num(m.pricing.input_cache_read) : null,
    },
    supportsReasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    supportsImages: (m.architecture?.input_modalities ?? []).includes("image"),
    created: m.created ?? 0,
  };
}

/** Cached OpenRouter model catalog (only models that support tool calling). */
export class ModelCatalog {
  private models: ModelInfo[] | null = null;
  private byId = new Map<string, ModelInfo>();
  private fetchedAt: number | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly db: DB,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const cached = one<{ value: string }>(this.db, "SELECT value FROM kv WHERE key = ?", CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached.value) as { fetchedAt: number; models: ModelInfo[] };
        this.set(parsed.models, parsed.fetchedAt);
      } catch {
        // ignore
      }
    }
  }

  private set(models: ModelInfo[], fetchedAt: number): void {
    this.models = models;
    this.byId = new Map(models.map((m) => [m.id, m]));
    this.fetchedAt = fetchedAt;
  }

  get(id: string): ModelInfo | undefined {
    return this.byId.get(id);
  }

  async list(opts: { refresh?: boolean } = {}): Promise<ModelList> {
    const stale = !this.fetchedAt || Date.now() - this.fetchedAt > TTL_MS;
    if (opts.refresh || !this.models) {
      await this.refresh().catch((err) => log.warn("Model catalog refresh failed", { err }));
    } else if (stale) {
      void this.refresh().catch((err) => log.warn("Model catalog refresh failed", { err }));
    }
    return {
      models: this.models ?? [],
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      stale: !this.fetchedAt || Date.now() - this.fetchedAt > TTL_MS,
    };
  }

  /** Loads the catalog once if it was never fetched (used before runs to know context sizes / prices). */
  async ensureLoaded(): Promise<void> {
    if (this.models) return;
    await this.refresh().catch((err) => log.warn("Model catalog refresh failed", { err }));
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const res = await this.fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
      const body = (await res.json()) as { data: RawModel[] };
      const models = body.data
        .filter((m) => (m.supported_parameters ?? []).includes("tools"))
        .map(toModelInfo)
        .sort((a, b) => a.name.localeCompare(b.name));
      const fetchedAt = Date.now();
      this.set(models, fetchedAt);
      run(
        this.db,
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        CACHE_KEY,
        JSON.stringify({ fetchedAt, models }),
        nowIso(),
      );
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
