# AgentCave

A small, self-hosted container that runs **AI agents defined in Markdown**.

- You create **agents** in a web UI: a Markdown system prompt, an OpenRouter model, a default reasoning effort and a few switches.
- Other products call the **HTTP API** to start an **agent cycle** with a prompt and files.
- Each cycle runs in its own **bash sandbox** ([just-bash](https://github.com/vercel-labs/just-bash)), driven by the [AI SDK](https://ai-sdk.dev) `ToolLoopAgent`.
- Callers can **poll**, **stream** (SSE), **stop**, send **follow-ups**, **re-run**, and download the **answer and changed files**. Webhooks fire when a turn ends.
- The UI shows every cycle **live**: thinking and answer text arrive one paragraph at a time, bash commands appear as compact cards, and sub-agents get their own cards.

> ⚠️ **No authentication is built in.** Whoever deploys AgentCave puts it behind their own proxy, VPN or firewall. Anyone who can reach the port can use your OpenRouter credit.

---

## Quick start (Docker)

```bash
docker run -d --name agentcave -p 127.0.0.1:7420:7420 -v agentcave-data:/data ghcr.io/dvddarias/agentcave:latest
```

Or build it yourself:

```bash
docker build -t agentcave .
docker run -d --name agentcave -p 127.0.0.1:7420:7420 -v agentcave-data:/data agentcave
```

1. Open <http://localhost:7420>.
2. **Settings** → paste your OpenRouter token ([openrouter.ai/keys](https://openrouter.ai/keys)) → **Test** → **Save**.
3. **Agents** → **New agent** → write the system prompt, pick a model → **Create agent**.
4. Try it in the **Playground**, or call the API:

```bash
curl -X POST http://localhost:7420/api/v1/cycles \
  -H 'content-type: application/json' \
  -d '{ "agent": "my-agent", "prompt": "Summarise notes.md", "files": [{ "path": "notes.md", "content": "# Notes\n…" }] }'
```

## Try it without a token (demo mode)

```bash
npm install
npm run demo        # → http://localhost:7420
```

Demo mode uses a scripted fake model ($0). It creates two sample agents (a code reviewer that delegates to a test writer) and starts a cycle, so you can watch the streaming UI right away.

---

## How it works

| Word | Meaning |
|---|---|
| **Agent** | A versioned config: Markdown system prompt, model, reasoning effort, internet mode, JS/Python switches, default limits, allowed sub-agents, default answer schema, its own reference files. Every save creates a new version. |
| **Cycle** | One run started by a caller. It has one sandbox and one or more **turns**. |
| **Turn** | One prompt → work → `submit_answer`. The first prompt is turn 0; each follow-up adds a turn. |
| **Step** | One model call inside a turn (thinking, text and/or tool calls). |

**The sandbox.** `/workspace` holds the caller's files; whatever the agent creates or changes there is returned. `/agent` holds the agent's own reference files (changes there are thrown away), and `/tmp` is scratch space. Internet access is per agent: none, an allow list of URL prefixes, or full. JavaScript (`js-exec`) and Python (`python3`) can be switched on per agent. just-bash is a simulated bash, not a VM, so the container is the real security boundary.

**Finishing.** The agent must call the `submit_answer` tool. If it stops without calling it, AgentCave sends it a reminder and the loop continues (3 reminders by default, then `no_submit`). With a JSON Schema (agent default or per call), `submit_answer` only accepts a matching object. Invalid answers go back to the model as tool errors.

**Limits.** Time, money and tokens, per turn, with sub-agents included. Hitting one ends the turn with `limit_time`, `limit_money` or `limit_tokens`. Money is checked after each step, so it can go over by at most one step. A hidden step cap (500) is the last safety net.

**Long cycles.** When the prompt goes over 60% of the model's context, old tool outputs are cut down to short previews. A single command's output is always capped (30 KB). The full text is saved under `/tmp/agentcave/` so the agent can still `grep` it.

**Sub-agents.** An agent can call agents from its allow list as tools (`ask_<slug>`). The sub-agent works on a copy of the workspace, and its changed files come back under `/workspace/.subagents/<slug>-<n>/`. Its cost counts toward the caller's limits. Stopping the parent stops the children.

**Restarts.** If the container stops while cycles are running, they restart from the beginning of the interrupted turn on the next boot (the workspace is restored from a snapshot).

---

## API

Base URL `http://<host>:7420/api/v1`. The UI has a full **API Docs** page (curl recipes, every endpoint, the TypeScript types). The OpenAPI spec is at `/api/v1/openapi.json`.

| | |
|---|---|
| `POST /cycles` | start: `{ agent, prompt, files?, overrides?, outputSchema?, labels?, webhookUrl? }` |
| `GET /cycles/:id` | poll: status, progress, usage, answer, error |
| `GET /cycles/:id/events` | live SSE (or `?format=json`) |
| `POST /cycles/:id/stop` | stop (sub-agents too) |
| `POST /cycles/:id/messages` | follow-up `{ prompt, files? }` |
| `POST /cycles/:id/rerun` | same input as a new cycle, optional overrides |
| `GET /cycles/:id/files[/path]`, `/files.zip` | workspace files (`?changed=true`) |
| `GET /cycles?agent=&status=&label.k=v` | list |
| `/agents…` | create, update (new version), versions, restore, export/import `.md`/`.zip` |
| `/settings`, `/models`, `/stats`, `/health` | the rest |

**Webhooks.** At the end of every turn: `POST webhookUrl` with `{ event: "cycle.completed" | "cycle.failed" | "cycle.stopped", turn, sentAt, cycle }`. Failed deliveries are retried 5 times with backoff. If you set a signing secret in Settings, each call has `X-AgentCave-Signature: sha256=<hmac of the body>`.

**TypeScript client** ([client/](client/README.md)), with zero dependencies. Install it in another project straight from the GitHub Releases (no npm account needed):

```bash
# a fixed version (recommended: it never changes under you)
npm install https://github.com/dvddarias/agentcave/releases/download/v0.1.0/agentcave-client-0.1.0.tgz
# or the build of the latest push to main
npm install https://github.com/dvddarias/agentcave/releases/download/client-latest/agentcave-client.tgz
```

```ts
import { AgentCave } from "@agentcave/client";
const cave = new AgentCave({ baseUrl: "http://localhost:7420" });
const { id } = await cave.cycles.start({ agent: "code-reviewer", prompt: "Review this", files });
for await (const e of cave.cycles.events(id)) if (e.type === "text") process.stdout.write(e.data.text);
const done = await cave.cycles.wait(id);
```

---

## Configuration

Environment variables (everything else is in the **Settings** page and stored in SQLite):

| Variable | Default | |
|---|---|---|
| `PORT` | `7420` | HTTP port (UI + API) |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `/data` (Docker), `./data` (local) | SQLite DB, file store, workspaces |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `WEB_DIST` | auto | folder with the built UI |

`/data` contains `agentcave.db` (SQLite, WAL), `blobs/` (content-addressed files), `cycles/<id>/workspace/` and `agents/<version>/`. Back up the whole folder. Finished cycles are deleted after *N* days (Settings; 0 = keep forever).

## Development

npm workspaces: `client/` (API types + client), `server/` (Hono, node:sqlite, AI SDK 7, just-bash), `web/` (React 19 + Vite + Tailwind 4).

```bash
npm install
npm run dev:server     # API on :7420 (tsx watch)
npm run dev:web        # UI on :5173, proxies /api to :7420
npm test               # server tests with a fake model ($0)
npm run typecheck && npm run lint
npm run build          # client → web → server bundle
```

A real OpenRouter smoke test runs when `OPENROUTER_TOKEN_TEST` is set: `npm run test:smoke -w @agentcave/server`.

See [PLAN.md](PLAN.md) for the design and the decisions behind it.
