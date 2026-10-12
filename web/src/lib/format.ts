export function formatCost(usd: number | null | undefined, estimated = false): string {
  if (usd === null || usd === undefined) return "—";
  const prefix = estimated ? "~" : "";
  if (usd === 0) return `${prefix}$0`;
  if (usd < 0.01) return `${prefix}$${usd.toFixed(4)}`;
  if (usd < 10) return `${prefix}$${usd.toFixed(3)}`;
  return `${prefix}$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const diff = now - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** USD per token → USD per million tokens. */
export function perMillion(perToken: number): string {
  const v = perToken * 1_000_000;
  if (v === 0) return "free";
  return `$${v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 2 : 1)}`;
}

export function pct(value: number, max: number | null | undefined): number | null {
  if (!max) return null;
  return Math.min(100, (value / max) * 100);
}
