import type { AgentInternet } from "@agentcave/client";
import { createBashTool } from "bash-tool";
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash";

export interface SandboxOptions {
  workspaceDir: string;
  agentFilesDir: string | null;
  internet: AgentInternet;
  javascript: boolean;
  python: boolean;
  commandTimeoutMs: number;
  outputCapBytes: number;
  signal: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

const STDERR_CAP = 8 * 1024;
type Method = "GET" | "HEAD" | "POST";

/** Builds the per-turn just-bash sandbox and the bash-tool tools (`bash`, `readFile`, `writeFile`). */
export async function createSandbox(o: SandboxOptions) {
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount("/workspace", new ReadWriteFs({ root: o.workspaceDir }));
  if (o.agentFilesDir) {
    // Copy-on-write: the agent can scribble on /agent, but changes stay in memory and the real files never change.
    // (A `readOnly` overlay makes the whole command throw on a write, losing the output of earlier commands.)
    fs.mount("/agent", new OverlayFs({ root: o.agentFilesDir, mountPoint: "/" }));
  }

  const network =
    o.internet.mode === "full"
      ? { dangerouslyAllowFullInternetAccess: true }
      : o.internet.mode === "allowlist"
        ? { allowedUrlPrefixes: o.internet.allowlist, allowedMethods: ["GET", "HEAD", "POST"] as Method[] }
        : undefined;

  const bash = new Bash({
    fs,
    cwd: "/workspace",
    env: { HOME: "/workspace", USER: "agent", TMPDIR: "/tmp", LANG: "C.UTF-8" },
    network,
    javascript: o.javascript,
    python: o.python,
    executionLimits: { maxExecutionTimeMs: o.commandTimeoutMs },
  });
  await bash.exec("mkdir -p /tmp/agentcave");

  let outputCounter = 0;
  const cap = o.outputCapBytes;

  async function capResult(r: { stdout: string; stderr: string; exitCode: number }): Promise<CommandResult> {
    if (r.stdout.length + r.stderr.length <= cap) return r;
    const n = ++outputCounter;
    const fullOutputPath = `/tmp/agentcave/out-${n}.txt`;
    const full = r.stderr ? `${r.stdout}\n--- stderr ---\n${r.stderr}` : r.stdout;
    await bash.fs.writeFile(fullOutputPath, full).catch(() => {});
    return {
      stdout: shorten(r.stdout, cap - Math.min(r.stderr.length, STDERR_CAP), fullOutputPath),
      stderr: shorten(r.stderr, STDERR_CAP, fullOutputPath),
      exitCode: r.exitCode,
      truncated: true,
      fullOutputPath,
    };
  }

  const adapter = {
    async executeCommand(command: string): Promise<CommandResult> {
      try {
        const r = await bash.exec(command, { signal: o.signal });
        return await capResult({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
      } catch (err) {
        if (o.signal.aborted) throw err;
        return { stdout: "", stderr: errorText(err), exitCode: 1 };
      }
    },
    async readFile(path: string): Promise<string> {
      const text = await bash.fs.readFile(path);
      if (text.length <= cap) return text;
      return `${text.slice(0, cap)}\n\n[file is ${text.length} characters; only the first ${cap} are shown. Use bash (head, sed -n, grep) to read the rest.]`;
    },
    async writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
      for (const f of files) {
        const dir = f.path.slice(0, f.path.lastIndexOf("/"));
        if (dir) await bash.fs.mkdir(dir, { recursive: true }).catch(() => {});
        await bash.fs.writeFile(
          f.path,
          typeof f.content === "string" ? f.content : f.content.toString("utf8"),
        );
      }
    },
  };

  const { tools } = await createBashTool({
    sandbox: adapter,
    destination: "/workspace",
    maxOutputLength: cap * 2,
  });
  return { bash, tools, adapter };
}

function shorten(text: string, max: number, savedAt: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.floor(max * 0.3);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[… ${omitted} characters omitted. Full output saved to ${savedAt} …]\n\n${text.slice(-tail)}`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name === "Error" ? "" : `${err.name}: `}${err.message}`;
  return String(err);
}
