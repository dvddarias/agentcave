import type { AgentInternet, ImageNotShown, JsonSchema, TurnImage } from "@agentcave/client";
import type { UserContent } from "ai";
import type { Manifest } from "../blobs.js";
import { userImagePart, VIEWABLE_FORMATS } from "./images.js";

export interface SubagentInfo {
  slug: string;
  toolName: string;
  name: string;
  description: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  /** One-line usage, e.g. `get_order_status --orderId <string>`. */
  usage: string;
}

export interface PromptOptions {
  agentPrompt: string;
  internet: AgentInternet;
  javascript: boolean;
  python: boolean;
  /** The model can see images (it gets the `view_image` tool). */
  vision: boolean;
  agentFiles: string[];
  subagents: SubagentInfo[];
  /** HTTP commands of the cycle. */
  commands: CommandInfo[];
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
  if (o.vision) {
    lines.push(
      `- You can see images. Image files the user sends with a message are shown to you with it. To look at any other image (${VIEWABLE_FORMATS}), such as one you made or found, use the \`view_image\` tool.`,
    );
  }
  lines.push(
    "- Very long command output is shortened. When that happens, the full output is saved under `/tmp/agentcave/` so you can `grep` or `sed -n` through it.",
  );

  if (o.commands.length > 0) {
    lines.push(
      "",
      "## Commands for this task",
      "",
      "These commands reach the user's own systems for you (no internet access needed):",
      "",
    );
    for (const c of o.commands) {
      lines.push(`- \`${c.usage}\`: ${c.description.trim().replace(/\s*\n\s*/g, " ")}`);
    }
    lines.push(
      "",
      "Run `<name> --help` for a command's flags and an example. A command prints the endpoint's response on stdout. Exit code 1 means the call failed (the reason is on stderr); exit code 2 means the arguments were wrong and nothing was sent. They work with pipes, loops and redirects like any other command (`… | jq`, `for … do … done`, `> file`). A whole command line, loop included, has one time limit, so for many calls save each result to a file as you go.",
    );
  }

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

/** Image files of a turn's input: the ones shown to the model, and why the others were not. */
export interface PromptImages {
  shown: TurnImage[];
  notShown: ImageNotShown[];
}

/**
 * The user message for a turn: the prompt, an AgentCave notice (if any) and a list of the files it
 * brought. Images shown to the model come first, each after a line naming its file.
 */
export function buildUserMessage(
  prompt: string,
  files: Manifest,
  notice?: string | null,
  images?: PromptImages,
): UserContent {
  let text = notice ? `${prompt}\n\n---\n${notice}` : prompt;
  const paths = Object.keys(files).sort();
  if (paths.length > 0) {
    const shown = new Map(images?.shown.map((i) => [i.path, i]));
    const notShown = new Map(images?.notShown.map((i) => [i.path, i.reason]));
    const line = (p: string) => {
      const abs = `/workspace/${p}`;
      const img = shown.get(abs);
      const why = notShown.get(abs);
      const note = img
        ? `, image shown above at ${img.width}×${img.height}`
        : why
          ? `, image not shown: ${why}`
          : "";
      return `- ${abs} (${formatSize(files[p].size)}${note})`;
    };
    const listed = paths.slice(0, 200).map(line);
    const more = paths.length > 200 ? `\n- … and ${paths.length - 200} more` : "";
    text = `${text}\n\n---\nFiles provided in /workspace (${paths.length}):\n${listed.join("\n")}${more}`;
  }
  if (!images?.shown.length) return text;
  return [
    ...images.shown.flatMap((img) => [{ type: "text" as const, text: `${img.path}:` }, userImagePart(img)]),
    { type: "text" as const, text },
  ];
}

function joinWords(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The user message that resumes a turn a limit stopped. */
export function buildContinueMessage(o: {
  /** Why the previous run stopped, e.g. "Time limit reached (600s)". */
  reason: string;
  /** What is left under each limit (see `roomLeft`). */
  room: string[];
  /** Steps this run may take, when the previous run hit the step cap. */
  steps: number | null;
  /** The turn's earlier steps were not saved (turns that stopped before AgentCave kept them). */
  historyLost: boolean;
  note?: string;
}): string {
  const room = [...o.room, ...(o.steps ? [`up to ${o.steps} more steps`] : [])];
  const lines = [
    `You were stopped before you finished. ${o.reason}. The user gave you more room to finish: ${room.length ? `you now have ${joinWords(room)}` : "there is no time, money or token limit now"}.`,
    "",
    o.historyLost
      ? "Your notes from earlier in this task were not kept, so first look at `/workspace` to see what is already done, then carry on from there instead of starting over."
      : "Carry on from where you left off; do not start over. Anything that was still running when you were stopped (a command or a sub-agent) may not have finished, so check its result before you rely on it.",
    "Finish the task and call `submit_answer` before you run out again.",
  ];
  if (o.note?.trim()) lines.push("", "Message from the user:", o.note.trim());
  return lines.join("\n");
}
