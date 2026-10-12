import type { ReasoningEffort, TokenCheck } from "@agentcave/client";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export interface ModelRequest {
  modelId: string;
  reasoning: ReasoningEffort;
  /** From the model catalog. `false` → no reasoning settings are sent at all. Unknown → sent. */
  supportsReasoning?: boolean;
  token: string | null;
}

/** Creates the language model for a run. Tests inject a fake one. */
export type ModelFactory = (req: ModelRequest) => LanguageModel;

/** Whether this factory needs an OpenRouter token (the default one does; test fakes don't). */
export type TokenRequirement = { requiresToken: boolean };

export const openRouterModelFactory: ModelFactory & TokenRequirement = Object.assign(
  (req: ModelRequest): LanguageModel => {
    if (!req.token) throw new Error("OpenRouter token is not set");
    const provider = createOpenRouter({
      apiKey: req.token,
      compatibility: "strict",
      appName: "AgentCave",
    });
    return provider.chat(req.modelId, {
      usage: { include: true },
      ...(req.supportsReasoning === false
        ? {}
        : { reasoning: req.reasoning === "off" ? { effort: "none" as const } : { effort: req.reasoning } }),
    });
  },
  { requiresToken: true },
);

export async function checkOpenRouterToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenCheck> {
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        label: null,
        limit: null,
        usage: null,
        limitRemaining: null,
        isFreeTier: null,
        error: `OpenRouter answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const body = (await res.json()) as {
      data?: {
        label?: string;
        limit?: number | null;
        usage?: number;
        limit_remaining?: number | null;
        is_free_tier?: boolean;
      };
    };
    const d = body.data ?? {};
    return {
      ok: true,
      label: d.label ?? null,
      limit: d.limit ?? null,
      usage: d.usage ?? null,
      limitRemaining: d.limit_remaining ?? null,
      isFreeTier: d.is_free_tier ?? null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      label: null,
      limit: null,
      usage: null,
      limitRemaining: null,
      isFreeTier: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
