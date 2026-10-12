import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation } from "react-router";
import { api, keys } from "../lib/api";
import { useCycleFeed } from "../lib/live";
import { IconAgents, IconAlert, IconBook, IconChart, IconCycles, IconFlask, IconSettings } from "./icons";
import { cx } from "./ui";

const NAV = [
  { to: "/cycles", label: "Cycles", icon: IconCycles },
  { to: "/playground", label: "Playground", icon: IconFlask },
  { to: "/agents", label: "Agents", icon: IconAgents },
  { to: "/usage", label: "Usage", icon: IconChart },
  { to: "/docs", label: "API Docs", icon: IconBook },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M6 54 C8 30 19 12 32 12 C45 12 56 30 58 54 Z" fill="#2a241c" />
      <path d="M19 54 C20 39 25.5 28 32 28 C38.5 28 44 39 45 54 Z" fill="#0b0c0f" />
      <path
        className="animate-flicker"
        d="M32 33 C28.5 37.5 28 41 32 45.5 C36 41 35.5 37.5 32 33 Z"
        fill="#f59e0b"
      />
      <path d="M32 38 C30.6 40 30.6 41.6 32 43.2 C33.4 41.6 33.4 40 32 38 Z" fill="#fde68a" />
    </svg>
  );
}

export function Layout() {
  const health = useQuery({ queryKey: keys.health, queryFn: () => api.health(), refetchInterval: 10_000 });
  const live = useCycleFeed();
  const location = useLocation();
  const fullBleed = /^\/(cycles\/[^/]+|agents\/[^/]+)/.test(location.pathname);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-cave-800 bg-cave-950 md:w-56 md:border-r md:border-b-0">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="torch-glow rounded-xl">
            <Logo />
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-cave-100">AgentCave</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cave-500">agent runtime</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-cave-800 text-cave-100 shadow-[inset_2px_0_0_var(--color-torch-500)]"
                    : "text-cave-400 hover:bg-cave-850 hover:text-cave-200",
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2 p-3 md:block">
          {health.data && !health.data.tokenSet ? (
            <NavLink
              to="/settings"
              className="flex items-start gap-2 rounded-lg border border-torch-700/50 bg-torch-500/10 p-2.5 text-xs text-torch-200 hover:bg-torch-500/15"
            >
              <IconAlert size={14} className="mt-0.5 shrink-0" />
              Add your OpenRouter token in Settings to run agents.
            </NavLink>
          ) : null}
          <div className="rounded-lg border border-cave-800 bg-cave-900/60 p-2.5 text-[11px] text-cave-400">
            <div className="flex items-center justify-between">
              <span>Queue</span>
              <span
                className={cx("size-1.5 rounded-full", live ? "bg-emerald-400" : "bg-cave-600")}
                title={live ? "Live" : "Reconnecting…"}
              />
            </div>
            <div className="mt-1 font-mono text-cave-200">
              {health.data
                ? `${health.data.queue.running}/${health.data.queue.maxParallel} running · ${health.data.queue.queued} queued`
                : "…"}
            </div>
            <div className="mt-1 text-cave-500">v{health.data?.version ?? "…"}</div>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={cx(fullBleed ? "h-full" : "mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8")}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
