import type { AgentInternet, JsonSchema } from "@agentcave/client";
import type { Manifest } from "../blobs.js";

export interface SubagentInfo {
  slug: string;
  toolName: string;
  name: string;
  description: string;
}

export interface PromptOptions {
  agentPrompt: string;
  internet: AgentInternet;
  javascript: boolean;
  python: boolean;
  agentFiles: string[];
  subagents: SubagentInfo[];
  outputSchema: JsonSchema | null;
  isSubagent: boolean;
}

export function subagentToolName(slug: string): string {
  return `ask_${slug.replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 64);
}

/** The exact system prompt sent to the model: the agent's Markdown + an AgentCave environment section. */
export function buildSystemPrompt(o: PromptOptions): string {
  const lines: string[] = [];
  lines.push(o.agentPrompt.trimEnd(), "", "---", "", "# AgentCave environment", "");
  lines.push(
    "You work inside an isolated bash sandbox (a simulated bash with common Unix tools such as ls, cat, grep, sed, awk, find, jq, sqlite3, diff and tar).",
    "",
    "- Your working directory is `/workspace`. The user's files are there. Files you create or change in `/workspace` are returned to the user.",
  );
  if (o.agentFiles.length > 0) {
    const shown = o.agentFiles.slice(0, 50).map((p) => `\`/agent/${p}\``);
    const more = o.agentFiles.length > 50 ? ` and ${o.agentFiles.length - 50} more` : "";
    lines.push(
      `- \`/agent\` holds your own reference files (treat them as read-only; changes there are not kept): ${shown.join(", ")}${more}.`,
    );
  }
  lines.push("- `/tmp` is scratch space and is thrown away.");
  if (o.internet.mode === "none") {
    lines.push("- There is no internet access (`curl` is not available).");
  } else if (o.internet.mode === "full") {
    lines.push("- You have internet access through `curl`.");
  } else {
    const urls = o.internet.allowlist.map((u) => `\`${u}\``).join(", ");
    lines.push(`- You can use \`curl\` (GET, HEAD, POST) only for URLs starting with: ${urls}.`);
  }
  if (o.javascript) {
    lines.push(
      '- You can run JavaScript/TypeScript with `js-exec` (e.g. `js-exec -c "console.log(1)"` or `js-exec file.js`).',
    );
  }
  if (o.python) lines.push("- You can run Python with `python3`.");
  lines.push(
    "- Very long command output is shortened. When that happens, the full output is saved under `/tmp/agentcave/` so you can `grep` or `sed -n` through it.",
  );

  if (o.subagents.length > 0) {
    lines.push(
      "",
      "## Sub-agents",
      "",
      "You can delegate work to these agents by calling their tool with a clear, self-contained prompt. Each sub-agent works on a copy of your current `/workspace` (without `.subagents/`). Files it creates or changes are copied back into `/workspace/.subagents/<name>-<n>/`, and you get its answer as the tool result.",
      "",
    );
    for (const s of o.subagents) {
      lines.push(`- \`${s.toolName}\` — **${s.name}**${s.description ? `: ${s.description}` : ""}`);
    }
  }

  lines.push(
    "",
    "## Finishing",
    "",
    "When you are done, call the `submit_answer` tool exactly once with your final answer. Writing the answer as plain text is not enough: the task only ends when `submit_answer` is called.",
  );
  if (o.outputSchema) {
    lines.push(
      "The input of `submit_answer` must match the required JSON Schema exactly. If it is rejected, read the error and call it again with a corrected value.",
    );
  } else {
    lines.push("Put your complete final answer, in Markdown, in the `answer` field.");
  }
  if (o.isSubagent) {
    lines.push(
      "",
      "You were called as a sub-agent by another agent: answer its request directly and completely.",
    );
  }
  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The user message for a turn: the prompt plus a list of the files it brought. */
export function buildUserMessage(prompt: string, files: Manifest): string {
  const paths = Object.keys(files).sort();
  if (paths.length === 0) return prompt;
  const shown = paths.slice(0, 200).map((p) => `- /workspace/${p} (${formatSize(files[p].size)})`);
  const more = paths.length > 200 ? `\n- … and ${paths.length - 200} more` : "";
  return `${prompt}\n\n---\nFiles provided in /workspace (${paths.length}):\n${shown.join("\n")}${more}`;
}
