/**
 * Serving AgentCave under a path prefix (`BASE_PATH`, e.g. `/cave` behind a reverse proxy).
 *
 * The prefix is decided at runtime, so one Docker image works under any prefix: the UI is built
 * with relative asset URLs, and the server tells it the prefix when it serves index.html.
 */

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** `"cave"`, `"/cave/"` → `"/cave"`; `""`, `"/"`, unset → `""` (served at the root). */
export function normalizeBasePath(value: string | null | undefined): string {
  const segments = (value ?? "").trim().split("/").filter(Boolean);
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === "." || s === "..") {
      throw new Error(
        `Invalid BASE_PATH ${JSON.stringify(value)}: use a path like "/cave" (letters, digits, ".", "_", "~", "-")`,
      );
    }
  }
  return segments.length ? `/${segments.join("/")}` : "";
}

/**
 * The request path with `base` dropped from its start. A proxy may strip the prefix before
 * forwarding or keep it, so both `/cave/api/v1/health` and `/api/v1/health` route the same.
 */
export function stripBasePath(path: string, base: string): string {
  if (!base) return path;
  if (path === base) return "/";
  if (path.startsWith(`${base}/`)) return path.slice(base.length);
  return path;
}

/**
 * index.html with the base: `<base href>` makes its relative asset URLs (`./assets/…`) load from
 * any client route, and `window.__AGENTCAVE_BASE__` tells the app (router, API client) the prefix.
 */
export function injectBasePath(html: string, base: string): string {
  const tags = `<base href="${base}/" /><script>window.__AGENTCAVE_BASE__=${JSON.stringify(base)}</script>`;
  // Right after <head>: <base> must come before any element with a relative URL.
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (m) => `${m}${tags}`) : `${tags}${html}`;
}
