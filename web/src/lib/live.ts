import type { Cycle, CycleEvent, CycleList } from "@agentcave/client";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, keys } from "./api";

/**
 * All events of a cycle: replays history, then follows live (including follow-up turns).
 * Reconnects with `after=<last seq>` if the connection drops.
 */
export function useCycleEvents(cycleId: string | undefined): { events: CycleEvent[]; connected: boolean } {
  const [events, setEvents] = useState<CycleEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);
  const qc = useQueryClient();

  useEffect(() => {
    if (!cycleId) return;
    setEvents([]);
    lastSeq.current = 0;
    const ac = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void qc.invalidateQueries({ queryKey: keys.cycle(cycleId) });
      }, 400);
    };

    (async () => {
      let backoff = 500;
      while (!ac.signal.aborted) {
        try {
          const stream = api.cycles.events(cycleId, {
            after: lastSeq.current,
            follow: true,
            signal: ac.signal,
          });
          setConnected(true);
          let buffer: CycleEvent[] = [];
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const flush = () => {
            flushTimer = null;
            const batch = buffer;
            buffer = [];
            if (batch.length) setEvents((prev) => [...prev, ...batch]);
          };
          for await (const e of stream) {
            if (e.seq <= lastSeq.current) continue;
            lastSeq.current = e.seq;
            buffer.push(e);
            if (!flushTimer) flushTimer = setTimeout(flush, 60);
            if (
              e.type === "cycle.status" ||
              e.type === "usage" ||
              e.type === "answer" ||
              e.type === "turn.end"
            ) {
              refresh();
            }
            if (e.type === "subagent.start" || e.type === "subagent.end") {
              void qc.invalidateQueries({ queryKey: keys.children(cycleId) });
            }
            backoff = 500;
          }
          flush();
        } catch {
          // fall through to reconnect
        }
        if (ac.signal.aborted) break;
        setConnected(false);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    })();

    return () => {
      ac.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [cycleId, qc]);

  return { events, connected };
}

/** Keeps cycle lists and details fresh from the global change feed. */
export function useCycleFeed(onUpdate?: (cycle: Cycle) => void): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const cb = useRef(onUpdate);
  cb.current = onUpdate;

  useEffect(() => {
    const ac = new AbortController();
    // Throttled refreshes for things that only need to be roughly up to date.
    const throttled = new Map<string, number>();
    const refreshSoon = (key: readonly unknown[], ms: number) => {
      const id = JSON.stringify(key);
      if (throttled.has(id)) return;
      throttled.set(
        id,
        window.setTimeout(() => {
          throttled.delete(id);
          void qc.invalidateQueries({ queryKey: key });
        }, ms),
      );
    };

    (async () => {
      let backoff = 1000;
      while (!ac.signal.aborted) {
        try {
          const stream = api.updates(ac.signal);
          setConnected(true);
          for await (const u of stream) {
            backoff = 1000;
            if (u.cycle) {
              const cycle = u.cycle;
              qc.setQueryData(keys.cycle(u.id), (old: Cycle | undefined) =>
                old ? { ...cycle, systemPrompt: old.systemPrompt } : old,
              );
              // Update rows already shown in lists in place; refetch lists only for new cycles.
              let found = false;
              let statusChanged = false;
              qc.setQueriesData<InfiniteData<CycleList>>({ queryKey: ["cycles"] }, (data) => {
                if (!data?.pages) return data;
                return {
                  ...data,
                  pages: data.pages.map((page) => ({
                    ...page,
                    cycles: page.cycles.map((c) => {
                      if (c.id !== cycle.id) return c;
                      found = true;
                      if (c.status !== cycle.status) statusChanged = true;
                      return cycle;
                    }),
                  })),
                };
              });
              // New cycles appear, and status filters stay correct.
              if ((!found || statusChanged) && !cycle.parentId) refreshSoon(["cycles"], 300);
              if (cycle.status !== "running") refreshSoon(["agents"], 2000);
              cb.current?.(cycle);
            } else {
              refreshSoon(["cycles"], 300);
            }
            refreshSoon(keys.health, 2000);
          }
        } catch {
          // reconnect
        }
        if (ac.signal.aborted) break;
        setConnected(false);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    })();
    return () => {
      ac.abort();
      for (const t of throttled.values()) clearTimeout(t);
    };
  }, [qc]);

  return connected;
}

/** Re-renders every `ms` (live timers). */
export function useNow(ms = 1000, active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}
