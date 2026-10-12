import { AgentCave, AgentCaveError } from "@agentcave/client";
import { QueryClient } from "@tanstack/react-query";

declare global {
  interface Window {
    /** Set by the server in index.html (`BASE_PATH`); absent in Vite development. */
    __AGENTCAVE_BASE__?: string;
  }
}

/** Path prefix the UI and API are published under (e.g. `/cave`), or `""` at the root. */
export const basePath = (window.__AGENTCAVE_BASE__ ?? "").replace(/\/+$/, "");

/** Absolute URL of this AgentCave (e.g. `https://example.com/cave`), for examples people copy. */
export const publicUrl = `${window.location.origin}${basePath}`;

/** Same origin: the UI is served by AgentCave itself (Vite proxies /api in development). */
export const api = new AgentCave({ baseUrl: basePath });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof AgentCaveError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

export const keys = {
  agents: (archived = false) => ["agents", archived] as const,
  agent: (slug: string) => ["agent", slug] as const,
  versions: (slug: string) => ["agent", slug, "versions"] as const,
  cycles: (q: object) => ["cycles", q] as const,
  cycle: (id: string) => ["cycle", id] as const,
  children: (id: string) => ["cycle", id, "children"] as const,
  turns: (id: string) => ["cycle", id, "turns"] as const,
  files: (id: string) => ["cycle", id, "files"] as const,
  webhooks: (id: string) => ["cycle", id, "webhooks"] as const,
  models: ["models"] as const,
  settings: ["settings"] as const,
  health: ["health"] as const,
  stats: (days: number) => ["stats", days] as const,
  openapi: ["openapi"] as const,
};

export function errorText(err: unknown): string {
  if (err instanceof AgentCaveError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
