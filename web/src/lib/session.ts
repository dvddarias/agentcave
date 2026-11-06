import { useQuery } from "@tanstack/react-query";
import { api, keys } from "./api";

/** What this browser may see: the view scope a proxy set (`X-AgentCave-Scope`), or null for everything. */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => api.session(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * True in a scoped view: only the scope's cycles, nothing can be changed, and agents, settings and
 * models are off limits. Layout waits for the session before it renders a page.
 */
export function useReadOnly(): boolean {
  return !!useSession().data?.scope;
}
