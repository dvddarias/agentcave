import { z } from "zod";
import {
  agentInputSchema,
  continueSchema,
  followUpSchema,
  rerunSchema,
  settingsUpdateSchema,
  startCycleSchema,
  testTokenSchema,
} from "../schemas.js";

interface Param {
  name: string;
  in: "path" | "query";
  description: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

interface RouteDoc {
  method: "get" | "post" | "put" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params?: Param[];
  body?: z.ZodType;
  rawBody?: string;
  /** TypeScript type name from @agentcave/client (see the API docs page). */
  returns: string;
  status?: number;
  example?: unknown;
}

const id: Param = { name: "id", in: "path", required: true, description: "Cycle id (`cyc_…`)" };
const slug: Param = { name: "slug", in: "path", required: true, description: "Agent slug" };

const exampleCycle = {
  id: "cyc_01JA2B3C4D5E6F7G8H9J0K1M2N",
  status: "running",
  agent: { slug: "code-reviewer", name: "Code Reviewer", version: 7 },
  model: "openai/gpt-5.2",
  reasoning: "high",
  turn: 0,
  progress: {
    steps: 5,
    activity: "running bash: grep -rn TODO src/",
    lastParagraph: "I found three suspicious…",
  },
  usage: {
    inputTokens: 48211,
    outputTokens: 2210,
    reasoningTokens: 1800,
    cachedTokens: 0,
    costUsd: 0.0412,
    costEstimated: false,
    steps: 5,
  },
  answer: null,
  files: null,
  error: null,
  labels: { customer: "123" },
};

export const ROUTES: RouteDoc[] = [
  // Cycles
  {
    method: "post",
    path: "/cycles",
    tag: "Cycles",
    summary: "Start a cycle",
    description:
      'Queues an agentic cycle. Files go inside the JSON (`encoding: "base64"` for binary). Returns immediately with status `queued`.',
    body: startCycleSchema,
    returns: "Cycle",
    status: 202,
    example: { ...exampleCycle, status: "queued" },
  },
  {
    method: "get",
    path: "/cycles",
    tag: "Cycles",
    summary: "List cycles",
    params: [
      { name: "agent", in: "query", description: "Filter by agent slug" },
      { name: "status", in: "query", description: "Comma-separated statuses" },
      { name: "label.<key>", in: "query", description: "Filter by label value, e.g. `label.customer=123`" },
      { name: "parent", in: "query", description: "Only sub-agent cycles of this cycle" },
      { name: "rootOnly", in: "query", description: "`false` to include sub-agent cycles (default true)" },
      { name: "q", in: "query", description: "Search id, agent, labels and prompts" },
      { name: "limit", in: "query", description: "Page size (max 200, default 50)" },
      { name: "cursor", in: "query", description: "`nextCursor` from the previous page" },
    ],
    returns: "CycleList",
  },
  {
    method: "get",
    path: "/cycles/{id}",
    tag: "Cycles",
    summary: "Get a cycle (poll this)",
    params: [id],
    returns: "Cycle",
    example: exampleCycle,
  },
  {
    method: "get",
    path: "/cycles/{id}/answer",
    tag: "Cycles",
    summary: "Get only the answer",
    description: "409 while the cycle is still queued or running.",
    params: [id],
    returns: "{ status, answer: Answer | null, files: FileChanges | null, error: CycleError | null }",
  },
  {
    method: "get",
    path: "/cycles/{id}/events",
    tag: "Cycles",
    summary: "Live events (Server-Sent Events)",
    description:
      "Replays stored events, then streams new ones. Each `data:` line is a JSON `CycleEvent`. The stream ends after the final `cycle.status` unless `follow=true`. Resume with `after` or the `Last-Event-ID` header. `format=json` returns stored events as JSON instead.",
    params: [
      id,
      { name: "after", in: "query", description: "Only events with seq > after" },
      { name: "follow", in: "query", description: "`true` keeps the stream open (follow-ups)" },
      { name: "format", in: "query", description: "`json` for a paged JSON list" },
      { name: "limit", in: "query", description: "Page size for format=json (max 5000)" },
    ],
    returns: "text/event-stream of CycleEvent",
  },
  {
    method: "post",
    path: "/cycles/{id}/stop",
    tag: "Cycles",
    summary: "Stop a cycle (and its sub-agents)",
    params: [id],
    returns: "Cycle",
  },
  {
    method: "post",
    path: "/cycles/{id}/messages",
    tag: "Cycles",
    summary: "Send a follow-up message",
    description:
      "Starts a new turn with the same memory and sandbox files. Only when the cycle is finished (409 otherwise).",
    params: [id],
    body: followUpSchema,
    returns: "Cycle",
    status: 202,
  },
  {
    method: "post",
    path: "/cycles/{id}/continue",
    tag: "Cycles",
    summary: "Continue a turn that a limit stopped, with more room",
    description:
      "For a cycle that failed with limit_time, limit_money, limit_tokens or limit_steps: the same turn runs on from its last finished step, with the same memory and files, and its usage so far still counts. With an empty body, every limit with no room left gets +50% of itself. `limits` sets new totals for the turn (they stay for later turns); `extendPercent` changes the +50%; `message` adds instructions for the agent. The webhook fires again when the turn ends. 409 if the turn did not end on a limit, 400 `no_room` if the new limits leave no room.",
    params: [id],
    body: continueSchema,
    returns: "Cycle",
    status: 202,
  },
  {
    method: "post",
    path: "/cycles/{id}/rerun",
    tag: "Cycles",
    summary: "Re-run the first prompt as a new cycle",
    description: "Same input files and prompt; optionally another agent version, model, reasoning or limits.",
    params: [id],
    body: rerunSchema,
    returns: "Cycle",
    status: 202,
  },
  {
    method: "get",
    path: "/cycles/{id}/turns",
    tag: "Cycles",
    summary: "List turns",
    params: [id],
    returns: "{ turns: Turn[] }",
  },
  {
    method: "get",
    path: "/cycles/{id}/children",
    tag: "Cycles",
    summary: "List sub-agent cycles",
    params: [id],
    returns: "{ cycles: Cycle[] }",
  },
  {
    method: "get",
    path: "/cycles/{id}/files",
    tag: "Files",
    summary: "List workspace files",
    description: "Status is relative to the cycle's input files (or to the start of turn `turn`).",
    params: [
      id,
      { name: "changed", in: "query", description: "`true` for only added/modified/deleted files" },
      { name: "turn", in: "query", description: "Compare with the start of this turn" },
    ],
    returns: "{ files: WorkspaceFile[] }",
  },
  {
    method: "get",
    path: "/cycles/{id}/files/{path}",
    tag: "Files",
    summary: "Download one file",
    params: [
      id,
      { name: "path", in: "path", required: true, description: "File path inside /workspace" },
      { name: "download", in: "query", description: "`true` for an attachment instead of inline" },
    ],
    returns: "file bytes",
  },
  {
    method: "get",
    path: "/cycles/{id}/files.zip",
    tag: "Files",
    summary: "Download the workspace as a zip",
    params: [id, { name: "changed", in: "query", description: "`true` for only added/modified files" }],
    returns: "application/zip",
  },
  {
    method: "get",
    path: "/cycles/{id}/webhooks",
    tag: "Cycles",
    summary: "Webhook deliveries",
    params: [id],
    returns: "{ deliveries: WebhookDelivery[] }",
  },
  {
    method: "delete",
    path: "/cycles/{id}",
    tag: "Cycles",
    summary: "Delete a finished cycle",
    params: [id],
    returns: "204",
    status: 204,
  },
  // Agents
  {
    method: "get",
    path: "/agents",
    tag: "Agents",
    summary: "List agents",
    params: [{ name: "archived", in: "query", description: "`true` includes archived agents" }],
    returns: "{ agents: Agent[] }",
  },
  {
    method: "post",
    path: "/agents",
    tag: "Agents",
    summary: "Create an agent (version 1)",
    body: agentInputSchema,
    returns: "Agent",
    status: 201,
  },
  {
    method: "get",
    path: "/agents/{slug}",
    tag: "Agents",
    summary: "Get an agent",
    params: [slug],
    returns: "Agent",
  },
  {
    method: "put",
    path: "/agents/{slug}",
    tag: "Agents",
    summary: "Save an agent (creates a new version)",
    description: "Fields you leave out keep their value. Files: `files.upsert` / `files.remove`.",
    params: [slug],
    body: agentInputSchema,
    returns: "Agent",
  },
  {
    method: "delete",
    path: "/agents/{slug}",
    tag: "Agents",
    summary: "Archive an agent",
    params: [slug],
    returns: "204",
    status: 204,
  },
  {
    method: "post",
    path: "/agents/{slug}/unarchive",
    tag: "Agents",
    summary: "Unarchive an agent",
    params: [slug],
    returns: "Agent",
  },
  {
    method: "get",
    path: "/agents/{slug}/versions",
    tag: "Agents",
    summary: "Version history",
    params: [slug],
    returns: "{ versions: AgentVersion[] }",
  },
  {
    method: "get",
    path: "/agents/{slug}/versions/{n}",
    tag: "Agents",
    summary: "One version",
    params: [slug, { name: "n", in: "path", required: true, description: "Version number" }],
    returns: "AgentVersion",
  },
  {
    method: "post",
    path: "/agents/{slug}/versions/{n}/restore",
    tag: "Agents",
    summary: "Roll back (copies version n as a new version)",
    params: [slug, { name: "n", in: "path", required: true, description: "Version number" }],
    returns: "Agent",
  },
  {
    method: "get",
    path: "/agents/{slug}/files/{path}",
    tag: "Agents",
    summary: "Read one of the agent's own files",
    params: [
      slug,
      { name: "path", in: "path", required: true, description: "File path" },
      { name: "version", in: "query", description: "Version (default current)" },
    ],
    returns: "file bytes",
  },
  {
    method: "get",
    path: "/agents/{slug}/export",
    tag: "Agents",
    summary: "Export as .md (or .zip with files)",
    params: [slug],
    returns: "text/markdown or application/zip",
  },
  {
    method: "post",
    path: "/agents/import",
    tag: "Agents",
    summary: "Import a .md or .zip export",
    description:
      "Send the raw file (content-type text/markdown or application/zip). An existing slug gets a new version.",
    rawBody: "text/markdown | application/zip",
    returns: "Agent",
    status: 201,
  },
  // System
  {
    method: "get",
    path: "/models",
    tag: "System",
    summary: "OpenRouter models that support tools (cached 1 h)",
    params: [{ name: "refresh", in: "query", description: "`true` to refetch now" }],
    returns: "ModelList",
  },
  {
    method: "get",
    path: "/settings",
    tag: "System",
    summary: "Get settings (token masked)",
    returns: "Settings",
  },
  {
    method: "put",
    path: "/settings",
    tag: "System",
    summary: "Update settings",
    body: settingsUpdateSchema,
    returns: "Settings",
  },
  {
    method: "post",
    path: "/settings/test-token",
    tag: "System",
    summary: "Check an OpenRouter token and its credit",
    body: testTokenSchema,
    returns: "TokenCheck",
  },
  {
    method: "get",
    path: "/stats",
    tag: "System",
    summary: "Usage totals by day, agent and model",
    params: [
      { name: "from", in: "query", description: "ISO date (default 30 days ago)" },
      { name: "to", in: "query", description: "ISO date (default now)" },
    ],
    returns: "Stats",
  },
  {
    method: "get",
    path: "/events",
    tag: "System",
    summary: "Global feed of cycle changes (SSE)",
    returns: "text/event-stream of CycleUpdate",
  },
  {
    method: "post",
    path: "/maintenance/cleanup",
    tag: "System",
    summary: "Run the retention cleanup now",
    returns: "{ deletedCycles, deletedBlobs }",
  },
  { method: "get", path: "/health", tag: "System", summary: "Health and queue size", returns: "Health" },
];

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: "object" };
  }
}

export function buildOpenApi(version: string, basePath = ""): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const op: Record<string, unknown> = {
      tags: [r.tag],
      summary: r.summary,
      description: [
        r.description,
        `Returns: \`${r.returns}\` (see the TypeScript types in the API docs page).`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      parameters: (r.params ?? []).map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required ?? p.in === "path",
        description: p.description,
        schema: p.schema ?? { type: "string" },
      })),
      responses: {
        [String(r.status ?? 200)]: {
          description: r.returns,
          ...(r.example ? { content: { "application/json": { example: r.example } } } : {}),
        },
        default: {
          description: "Error: `{ error: { code, message, details? } }`",
        },
      },
    };
    if (r.body) {
      op.requestBody = { required: true, content: { "application/json": { schema: jsonSchemaOf(r.body) } } };
    } else if (r.rawBody) {
      op.requestBody = {
        required: true,
        content: Object.fromEntries(r.rawBody.split(" | ").map((t) => [t, {}])),
      };
    }
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method]: op };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "AgentCave API",
      version,
      description:
        "Start agentic cycles, poll or stream them, stop them, send follow-ups and download results. No authentication is built in: put your own proxy in front.",
    },
    servers: [{ url: `${basePath}/api/v1` }],
    paths,
  };
}
