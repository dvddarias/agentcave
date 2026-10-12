import type {
  Agent,
  AgentInput,
  AgentVersion,
  ApiErrorBody,
  Cycle,
  CycleEvent,
  CycleList,
  CycleStatus,
  CycleUpdate,
  FileInput,
  FollowUpRequest,
  Health,
  ModelList,
  RerunRequest,
  Settings,
  SettingsUpdate,
  StartCycleRequest,
  Stats,
  TokenCheck,
  Turn,
  WebhookDelivery,
  WorkspaceFile,
} from "./types.js";
import { FINAL_STATUSES } from "./types.js";

export * from "./types.js";

export class AgentCaveError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentCaveError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface AgentCaveOptions {
  /** e.g. `http://localhost:7420`. Use `""` in a browser served by AgentCave itself. */
  baseUrl: string;
  /** Extra headers on every request (e.g. for your own proxy auth). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface ListCyclesQuery {
  agent?: string;
  status?: CycleStatus | CycleStatus[];
  labels?: Record<string, string>;
  parent?: string;
  /** Only top-level cycles (no sub-agent cycles). Default true. */
  rootOnly?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface EventsOptions {
  /** Resume after this event sequence number. */
  after?: number;
  /** Keep the stream open after the cycle reaches a final state (e.g. to see follow-ups). */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface WaitOptions {
  pollMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Encode bytes or text as a `FileInput` (base64 for binary). */
export function fileInput(path: string, content: string | Uint8Array): FileInput {
  if (typeof content === "string") return { path, content };
  let bin = "";
  for (let i = 0; i < content.length; i += 0x8000) {
    bin += String.fromCharCode(...content.subarray(i, i + 0x8000));
  }
  return { path, content: btoa(bin), encoding: "base64" };
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export class AgentCave {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentCaveOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  async raw(method: string, path: string, body?: unknown, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
    if (!res.ok) {
      let parsed: ApiErrorBody | null = null;
      try {
        parsed = (await res.json()) as ApiErrorBody;
      } catch {
        // not JSON
      }
      throw new AgentCaveError(
        res.status,
        parsed?.error?.code ?? "http_error",
        parsed?.error?.message ?? `${method} ${path} failed with ${res.status}`,
        parsed?.error?.details,
      );
    }
    return res;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // -------------------------------------------------------------------------

  readonly agents = {
    list: (opts: { archived?: boolean } = {}) =>
      this.request<{ agents: Agent[] }>("GET", `/agents${opts.archived ? "?archived=true" : ""}`).then(
        (r) => r.agents,
      ),
    get: (slug: string) => this.request<Agent>("GET", `/agents/${encodeURIComponent(slug)}`),
    create: (input: AgentInput & { slug: string; name: string }) =>
      this.request<Agent>("POST", "/agents", input),
    update: (slug: string, input: AgentInput) =>
      this.request<Agent>("PUT", `/agents/${encodeURIComponent(slug)}`, input),
    archive: (slug: string) => this.request<void>("DELETE", `/agents/${encodeURIComponent(slug)}`),
    unarchive: (slug: string) => this.request<Agent>("POST", `/agents/${encodeURIComponent(slug)}/unarchive`),
    versions: (slug: string) =>
      this.request<{ versions: AgentVersion[] }>("GET", `/agents/${encodeURIComponent(slug)}/versions`).then(
        (r) => r.versions,
      ),
    version: (slug: string, version: number) =>
      this.request<AgentVersion>("GET", `/agents/${encodeURIComponent(slug)}/versions/${version}`),
    restore: (slug: string, version: number) =>
      this.request<Agent>("POST", `/agents/${encodeURIComponent(slug)}/versions/${version}/restore`),
    fileText: async (slug: string, path: string, version?: number) => {
      const q = version ? `?version=${version}` : "";
      const res = await this.raw("GET", `/agents/${encodeURIComponent(slug)}/files/${encodePath(path)}${q}`);
      return res.text();
    },
    exportUrl: (slug: string) => this.url(`/agents/${encodeURIComponent(slug)}/export`),
    export: async (slug: string) => {
      const res = await this.raw("GET", `/agents/${encodeURIComponent(slug)}/export`);
      return {
        contentType: res.headers.get("content-type") ?? "",
        data: new Uint8Array(await res.arrayBuffer()),
      };
    },
    /** Import a `.md` (text) or `.zip` (bytes) export. */
    import: async (content: string | Uint8Array) => {
      const isZip = typeof content !== "string";
      const res = await this.raw("POST", "/agents/import", undefined, {
        headers: { ...this.headers, "content-type": isZip ? "application/zip" : "text/markdown" },
        body: content as unknown as RequestInit["body"],
      });
      return (await res.json()) as Agent;
    },
  };

  readonly cycles = {
    start: (req: StartCycleRequest) => this.request<Cycle>("POST", "/cycles", req),
    get: (id: string) => this.request<Cycle>("GET", `/cycles/${id}`),
    list: (query: ListCyclesQuery = {}) => {
      const params = new URLSearchParams();
      if (query.agent) params.set("agent", query.agent);
      if (query.status) params.set("status", [query.status].flat().join(","));
      if (query.parent) params.set("parent", query.parent);
      if (query.rootOnly === false) params.set("rootOnly", "false");
      if (query.q) params.set("q", query.q);
      if (query.limit) params.set("limit", String(query.limit));
      if (query.cursor) params.set("cursor", query.cursor);
      for (const [k, v] of Object.entries(query.labels ?? {})) params.set(`label.${k}`, v);
      const qs = params.toString();
      return this.request<CycleList>("GET", `/cycles${qs ? `?${qs}` : ""}`);
    },
    children: (id: string) =>
      this.request<{ cycles: Cycle[] }>("GET", `/cycles/${id}/children`).then((r) => r.cycles),
    turns: (id: string) => this.request<{ turns: Turn[] }>("GET", `/cycles/${id}/turns`).then((r) => r.turns),
    answer: (id: string) =>
      this.request<Pick<Cycle, "answer" | "files" | "status">>("GET", `/cycles/${id}/answer`),
    stop: (id: string) => this.request<Cycle>("POST", `/cycles/${id}/stop`),
    followUp: (id: string, req: FollowUpRequest) =>
      this.request<Cycle>("POST", `/cycles/${id}/messages`, req),
    rerun: (id: string, req: RerunRequest = {}) => this.request<Cycle>("POST", `/cycles/${id}/rerun`, req),
    delete: (id: string) => this.request<void>("DELETE", `/cycles/${id}`),
    files: (id: string, opts: { changed?: boolean; turn?: number } = {}) => {
      const params = new URLSearchParams();
      if (opts.changed) params.set("changed", "true");
      if (opts.turn !== undefined) params.set("turn", String(opts.turn));
      const qs = params.toString();
      return this.request<{ files: WorkspaceFile[] }>("GET", `/cycles/${id}/files${qs ? `?${qs}` : ""}`).then(
        (r) => r.files,
      );
    },
    fileUrl: (id: string, path: string) => this.url(`/cycles/${id}/files/${encodePath(path)}`),
    downloadFile: async (id: string, path: string) => {
      const res = await this.raw("GET", `/cycles/${id}/files/${encodePath(path)}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    zipUrl: (id: string, opts: { changedOnly?: boolean } = {}) =>
      this.url(`/cycles/${id}/files.zip${opts.changedOnly ? "?changed=true" : ""}`),
    downloadZip: async (id: string, opts: { changedOnly?: boolean } = {}) => {
      const res = await this.raw("GET", `/cycles/${id}/files.zip${opts.changedOnly ? "?changed=true" : ""}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    webhooks: (id: string) =>
      this.request<{ deliveries: WebhookDelivery[] }>("GET", `/cycles/${id}/webhooks`).then(
        (r) => r.deliveries,
      ),
    /** Stored events as JSON (paged). */
    eventLog: (id: string, opts: { after?: number; limit?: number } = {}) =>
      this.request<{ events: CycleEvent[] }>(
        "GET",
        `/cycles/${id}/events?format=json&after=${opts.after ?? 0}&limit=${opts.limit ?? 1000}`,
      ).then((r) => r.events),
    /** Live events (SSE). Ends when the cycle reaches a final state unless `follow` is set. */
    events: (id: string, opts: EventsOptions = {}): AsyncGenerator<CycleEvent> => {
      const params = new URLSearchParams();
      if (opts.after) params.set("after", String(opts.after));
      if (opts.follow) params.set("follow", "true");
      const qs = params.toString();
      return this.sse<CycleEvent>(`/cycles/${id}/events${qs ? `?${qs}` : ""}`, opts.signal);
    },
    /** Poll until the cycle is in a final state. */
    wait: async (id: string, opts: WaitOptions = {}): Promise<Cycle> => {
      const pollMs = opts.pollMs ?? 2000;
      const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
      for (;;) {
        const cycle = await this.cycles.get(id);
        if (FINAL_STATUSES.includes(cycle.status)) return cycle;
        if (Date.now() + pollMs > deadline)
          throw new AgentCaveError(408, "timeout", `Cycle ${id} still ${cycle.status}`);
        if (opts.signal?.aborted) throw new AgentCaveError(499, "aborted", "Wait aborted");
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };

  readonly settings = {
    get: () => this.request<Settings>("GET", "/settings"),
    update: (update: SettingsUpdate) => this.request<Settings>("PUT", "/settings", update),
    testToken: (token?: string) => this.request<TokenCheck>("POST", "/settings/test-token", { token }),
  };

  models(refresh = false) {
    return this.request<ModelList>("GET", `/models${refresh ? "?refresh=true" : ""}`);
  }

  stats(query: { from?: string; to?: string } = {}) {
    const params = new URLSearchParams(query as Record<string, string>);
    const qs = params.toString();
    return this.request<Stats>("GET", `/stats${qs ? `?${qs}` : ""}`);
  }

  health() {
    return this.request<Health>("GET", "/health");
  }

  /** Global feed of cycle changes (used by dashboards). */
  updates(signal?: AbortSignal): AsyncGenerator<CycleUpdate> {
    return this.sse<CycleUpdate>("/events", signal);
  }

  private async *sse<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
    const res = await this.raw("GET", path, undefined, {
      headers: { ...this.headers, accept: "text/event-stream" },
      signal,
    });
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) yield JSON.parse(data) as T;
          idx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
      await res.body.cancel().catch(() => {});
    }
  }
}
