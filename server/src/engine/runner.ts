import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentConfig,
  Answer,
  CycleError,
  CycleEventPayload,
  CycleStatus,
  FileChanges,
  Limits,
  StepUsage,
} from "@agentcave/client";
import {
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  type TextStreamPart,
  type Tool,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import { diffManifests, type Manifest } from "../blobs.js";
import type { Ctx } from "../context.js";
import { newCycleParams } from "../cycle-factory.js";
import { type CycleRow, rowUsage, type TurnRow } from "../cycle-store.js";
import { parseJson } from "../db.js";
import { log } from "../log.js";
import type { InternalSettings } from "../settings.js";
import { prepareAnswerSchema } from "./answer-schema.js";
import { Budget, RunAbort, RunError } from "./budget.js";
import { ParagraphChunker } from "./chunker.js";
import { buildUserMessage, subagentToolName } from "./prompt.js";
import { createSandbox } from "./sandbox.js";
import { maybeTrim } from "./trim.js";

export const NUDGE_MESSAGE =
  "You stopped without calling the `submit_answer` tool. The task is not finished until you call it. To finish, call `submit_answer` now with your complete final answer (or keep working first if you are not done).";

export interface RunOptions {
  signal: AbortSignal;
  parentBudget?: Budget;
}

export interface TurnOutcome {
  status: CycleStatus;
  answer: Answer | null;
  error: CycleError | null;
  changes: FileChanges | null;
  /** The process is shutting down: the cycle was left `running` so it restarts on next boot. */
  shutdown?: boolean;
}

interface LoopCtx {
  cycle: CycleRow;
  turn: TurnRow;
  settings: InternalSettings;
  workspace: string;
  inputManifest: Manifest;
  ac: AbortController;
  budget: Budget;
  ancestors: string[];
  emit: (p: CycleEventPayload) => void;
  state: { steps: number; nudges: number };
}

const EMPTY_CHANGES: FileChanges = { added: [], modified: [], deleted: [] };

/** Runs one turn of a cycle: sandbox + ToolLoopAgent + submit_answer nudges + limits + events. */
export class Runner {
  constructor(private readonly ctx: Ctx) {}

  workspaceDir(cycleId: string): string {
    return path.join(this.ctx.dataDir, "cycles", cycleId, "workspace");
  }

  /** Runs the latest turn of `cycleId` to the end. Never throws. */
  async runTurn(cycleId: string, opts: RunOptions): Promise<TurnOutcome> {
    const { cycles, events, blobs } = this.ctx;
    const cycle = cycles.getRow(cycleId);
    const turn = cycles.latestTurn(cycleId);
    const attempt = cycle.attempts;
    const emit = (p: CycleEventPayload) => {
      events.append(cycle.id, turn.idx, attempt, p);
    };
    const settings = this.ctx.settings.get();
    const workspace = this.workspaceDir(cycle.id);
    const inputManifest = parseJson<Manifest>(turn.input_manifest, {});
    let startSnapshot = parseJson<Manifest | null>(turn.start_snapshot, null);

    cycles.markRunning(cycle.id, turn.id);
    emit({ type: "cycle.status", data: { status: "running", error: null } });

    const ac = new AbortController();
    const onParentAbort = () => ac.abort(opts.signal.reason);
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });

    const limits = parseJson<Limits>(cycle.limits, {});
    const budget = new Budget(limits, opts.parentBudget ?? null);
    const timer = limits.maxTimeSec
      ? setTimeout(
          () => ac.abort(new RunAbort("limit_time", `Time limit reached (${limits.maxTimeSec}s)`)),
          limits.maxTimeSec * 1000,
        )
      : null;

    let answer: Answer | null = null;
    let status: CycleStatus = "failed";
    let error: CycleError | null = null;

    try {
      if (this.ctx.modelFactory.requiresToken && !settings.openrouterToken) {
        throw new RunError("no_token", "The OpenRouter token is not set. Add it in Settings.");
      }
      await fs.mkdir(workspace, { recursive: true });
      if (startSnapshot) {
        // Restart: put the workspace back exactly as it was when this turn first started.
        await blobs.materialize(workspace, startSnapshot, { clean: true });
      } else {
        await blobs.materialize(workspace, inputManifest);
        startSnapshot = await blobs.snapshotDir(workspace);
        cycles.setStartSnapshot(turn.id, startSnapshot);
      }
      emit({
        type: "turn.start",
        data: {
          prompt: turn.prompt,
          files: Object.keys(inputManifest).sort(),
          systemPrompt: cycle.system_prompt,
          model: cycle.model,
          reasoning: cycle.reasoning,
        },
      });
      answer = await this.loop({
        cycle,
        turn,
        settings,
        workspace,
        inputManifest,
        ac,
        budget,
        ancestors: cycles.ancestorIds(cycle),
        emit,
        state: { steps: 0, nudges: 0 },
      });
      status = "completed";
    } catch (err) {
      const reason = ac.signal.aborted ? ac.signal.reason : err;
      error = toCycleError(reason);
      if (error.code === "shutdown") {
        if (timer) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onParentAbort);
        return { status: "running", answer: null, error: null, changes: null, shutdown: true };
      }
      status = error.code === "stopped" ? "stopped" : "failed";
      if (error.code === "internal")
        log.error("Cycle failed with an internal error", { cycle: cycle.id, err });
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onParentAbort);
    }

    let endSnapshot: Manifest | null = null;
    let changes: FileChanges | null = null;
    try {
      endSnapshot = await blobs.snapshotDir(workspace);
      changes = startSnapshot ? diffManifests(startSnapshot, endSnapshot) : null;
    } catch (err) {
      log.warn("Could not snapshot workspace", { cycle: cycle.id, err });
    }

    cycles.finishTurn(turn.id, { status, answer, changes, endSnapshot, error });
    cycles.finishCycle(cycle.id, status, error);
    if (answer) emit({ type: "answer", data: { answer, files: changes ?? EMPTY_CHANGES } });
    if (error) emit({ type: "error", data: error });
    emit({
      type: "turn.end",
      data: { status, usage: rowUsage(cycles.turn(cycle.id, turn.idx)), files: changes },
    });
    emit({ type: "cycle.status", data: { status, error } });

    this.ctx.webhooks.enqueue(
      cycles.get(cycle.id),
      status === "completed" ? "cycle.completed" : status === "stopped" ? "cycle.stopped" : "cycle.failed",
    );
    return { status, answer, error, changes };
  }

  // ---------------------------------------------------------------------------

  private async loop(c: LoopCtx): Promise<Answer> {
    const { cycle, turn, settings, ac, budget, emit, state } = c;
    const { agents, models, cycles } = this.ctx;

    const version = agents.getVersionById(cycle.agent_version_id);
    const config = agents.config(version);
    const agentFilesDir = await agents.materializeFiles(version.id);
    await models.ensureLoaded();
    const contextLength = models.get(cycle.model)?.contextLength || 128_000;

    const sandbox = await createSandbox({
      workspaceDir: c.workspace,
      agentFilesDir,
      internet: config.internet,
      javascript: config.javascript,
      python: config.python,
      commandTimeoutMs: settings.commandTimeoutSec * 1000,
      outputCapBytes: settings.toolOutputCapBytes,
      signal: ac.signal,
    });

    const answerSchema = prepareAnswerSchema(parseJson(cycle.output_schema, null));
    let submitted: Answer | null = null;
    const submit_answer = tool({
      description:
        "Submit your final answer. Call this exactly once, when you are completely done. The task ends when this is called.",
      inputSchema: jsonSchema<Record<string, unknown>>(answerSchema.toolSchema as JSONSchema7, {
        validate: (value) => {
          const r = answerSchema.validate(value);
          return r.ok
            ? { success: true, value: value as Record<string, unknown> }
            : {
                success: false,
                error: new Error(`Your answer does not match the required schema: ${r.message}`),
              };
        },
      }),
      execute: async (input) => {
        const r = answerSchema.validate(input);
        if (!r.ok) throw new Error(`Your answer does not match the required schema: ${r.message}`);
        submitted = r.answer;
        return { accepted: true, message: "Answer received. You are done; do not call any more tools." };
      },
    });

    const tools: ToolSet = { ...sandbox.tools, submit_answer, ...this.subagentTools(c, config) };
    const model = this.ctx.modelFactory({
      modelId: cycle.model,
      reasoning: cycle.reasoning,
      supportsReasoning: models.get(cycle.model)?.supportsReasoning,
      token: settings.openrouterToken,
      sessionId: cycle.root_id,
    });

    const agent = new ToolLoopAgent({
      model,
      instructions: cycle.system_prompt,
      tools,
      maxRetries: 2,
      stopWhen: [
        () => submitted !== null,
        () => state.steps >= settings.hardStepCap,
        () => budget.exceeded() !== null,
      ],
      prepareStep: ({ messages }) => {
        const r = maybeTrim(messages, {
          contextLength,
          ratio: settings.contextTrimRatio,
          systemChars: cycle.system_prompt.length,
        });
        if (!r) return undefined;
        emit({
          type: "trim",
          data: { trimmedOutputs: r.trimmed, estimatedTokens: r.estimatedTokens, contextLength },
        });
        return { messages: r.messages };
      },
    });

    const prior = cycles.priorMessages(cycle.id, turn.idx);
    const turnMessages: ModelMessage[] = [
      { role: "user", content: buildUserMessage(turn.prompt, c.inputManifest) },
    ];
    cycles.saveMessages(turn.id, turnMessages, state.nudges);

    for (;;) {
      const result = await agent.stream({ messages: [...prior, ...turnMessages], abortSignal: ac.signal });
      const streamError = await this.consume(result.fullStream, c);
      if (ac.signal.aborted) throw ac.signal.reason;

      const response = await settle(result.responseMessages, 10_000);
      if (response) turnMessages.push(...response);
      cycles.saveMessages(turn.id, turnMessages, state.nudges);

      if (submitted) return submitted;
      if (streamError) throw modelError(streamError);
      const hit = budget.exceeded();
      if (hit) throw new RunError(hit.code, hit.message);
      if (state.steps >= settings.hardStepCap) {
        throw new RunError("limit_steps", `Step limit reached (${settings.hardStepCap} steps)`);
      }
      if (state.nudges >= settings.maxNudges) {
        throw new RunError(
          "no_submit",
          `The agent stopped without calling submit_answer (after ${state.nudges} reminder${state.nudges === 1 ? "" : "s"}).`,
        );
      }
      state.nudges++;
      turnMessages.push({ role: "user", content: NUDGE_MESSAGE });
      cycles.saveMessages(turn.id, turnMessages, state.nudges);
      emit({ type: "nudge", data: { count: state.nudges, message: NUDGE_MESSAGE } });
    }
  }

  /** Turns the AI SDK stream into AgentCave events. Returns the stream error, if any. */
  private async consume(stream: AsyncIterable<TextStreamPart<ToolSet>>, c: LoopCtx): Promise<unknown> {
    const { cycles } = this.ctx;
    const chunkers = new Map<string, ParagraphChunker>();
    const toolStarted = new Map<string, number>();
    let streamError: unknown = null;
    let step = c.state.steps;
    let reasoningChars = 0;

    const chunker = (kind: "r" | "t", id: string): ParagraphChunker => {
      const key = `${kind}:${id}`;
      let ch = chunkers.get(key);
      if (!ch) {
        const blockId = `s${step}-${kind}${id}`;
        const stepNo = step;
        ch =
          kind === "r"
            ? new ParagraphChunker((text) =>
                c.emit({ type: "reasoning", data: { step: stepNo, blockId, text } }),
              )
            : new ParagraphChunker((text) => {
                c.emit({ type: "text", data: { step: stepNo, blockId, text } });
                if (text.trim()) cycles.setActivity(c.cycle.id, "writing…", text.trim().slice(0, 2000));
              });
        chunkers.set(key, ch);
      }
      return ch;
    };
    const end = (kind: "r" | "t", id: string) => {
      const key = `${kind}:${id}`;
      chunkers.get(key)?.flush();
      chunkers.delete(key);
    };
    const flushAll = () => {
      for (const ch of chunkers.values()) ch.flush();
      chunkers.clear();
    };

    try {
      for await (const part of stream) {
        switch (part.type) {
          case "start-step":
            step = ++c.state.steps;
            reasoningChars = 0;
            c.emit({ type: "step.start", data: { step } });
            cycles.setActivity(c.cycle.id, "thinking…");
            break;
          case "reasoning-start":
            chunker("r", part.id);
            break;
          case "reasoning-delta":
            reasoningChars += part.text.length;
            chunker("r", part.id).push(part.text);
            break;
          case "reasoning-end":
            end("r", part.id);
            break;
          case "text-start":
            chunker("t", part.id);
            break;
          case "text-delta":
            chunker("t", part.id).push(part.text);
            break;
          case "text-end":
            end("t", part.id);
            break;
          case "tool-call":
            flushAll();
            toolStarted.set(part.toolCallId, Date.now());
            c.emit({
              type: "tool.call",
              data: { step, callId: part.toolCallId, tool: part.toolName, input: part.input },
            });
            cycles.setActivity(c.cycle.id, describeTool(part.toolName, part.input));
            break;
          case "tool-result": {
            const out = part.output as { exitCode?: unknown; truncated?: unknown } | null;
            c.emit({
              type: "tool.result",
              data: {
                step,
                callId: part.toolCallId,
                tool: part.toolName,
                output: part.output,
                error: null,
                exitCode: typeof out?.exitCode === "number" ? out.exitCode : null,
                truncated: out?.truncated === true,
                ms: Date.now() - (toolStarted.get(part.toolCallId) ?? Date.now()),
              },
            });
            break;
          }
          case "tool-error":
            c.emit({
              type: "tool.result",
              data: {
                step,
                callId: part.toolCallId,
                tool: part.toolName,
                output: null,
                error: errorMessage(part.error),
                exitCode: null,
                truncated: false,
                ms: Date.now() - (toolStarted.get(part.toolCallId) ?? Date.now()),
              },
            });
            break;
          case "finish-step":
            flushAll();
            this.accountStep(c, step, part, reasoningChars);
            break;
          case "error":
            streamError = part.error;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      flushAll();
      if (c.ac.signal.aborted) throw c.ac.signal.reason;
      streamError = err;
    }
    flushAll();
    return streamError;
  }

  private accountStep(
    c: LoopCtx,
    step: number,
    part: Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>,
    reasoningChars: number,
  ): void {
    const u = part.usage;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const reasoningTokens = u.outputTokenDetails?.reasoningTokens ?? 0;
    const cachedTokens = u.inputTokenDetails?.cacheReadTokens ?? 0;
    const orUsage = (part.providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage;
    let costUsd: number;
    let costEstimated = false;
    if (typeof orUsage?.cost === "number") {
      costUsd = orUsage.cost;
    } else {
      const m = this.ctx.models.get(c.cycle.model);
      const uncached = Math.max(0, inputTokens - cachedTokens);
      costUsd = m
        ? uncached * m.pricing.prompt +
          cachedTokens * (m.pricing.cacheRead ?? m.pricing.prompt) +
          outputTokens * m.pricing.completion
        : 0;
      costEstimated = true;
    }
    if (reasoningTokens > 0 && reasoningChars === 0) {
      c.emit({
        type: "reasoning",
        data: { step, blockId: `s${step}-hidden`, text: "", hidden: true, tokens: reasoningTokens },
      });
    }
    c.budget.add(costUsd, inputTokens + outputTokens);
    const stepUsage: StepUsage = {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      costUsd,
      costEstimated,
    };
    this.ctx.cycles.addUsage(c.cycle.id, c.turn.id, c.ancestors, stepUsage);
    c.emit({
      type: "usage",
      data: {
        step,
        stepUsage,
        turnUsage: rowUsage(this.ctx.cycles.turn(c.cycle.id, c.turn.idx)),
        cycleUsage: rowUsage(this.ctx.cycles.getRow(c.cycle.id)),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sub-agents

  private subagentTools(c: LoopCtx, config: AgentConfig): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const slug of config.subagents) {
      let sub: ReturnType<Ctx["agents"]["get"]>;
      try {
        sub = this.ctx.agents.get(slug);
      } catch {
        continue;
      }
      if (sub.archived) continue;
      tools[subagentToolName(slug)] = tool({
        description: `Delegate a task to the "${sub.config.name}" agent.${sub.config.description ? ` ${sub.config.description}` : ""} It works on a copy of your /workspace and returns its answer; files it creates or changes are copied to /workspace/.subagents/.`,
        inputSchema: z.object({
          prompt: z.string().describe("A clear, self-contained task for the sub-agent."),
        }),
        execute: async ({ prompt }, { toolCallId, abortSignal }) =>
          this.runSubagent(c, slug, prompt, toolCallId, abortSignal),
      });
    }
    return tools;
  }

  private async runSubagent(
    c: LoopCtx,
    slug: string,
    prompt: string,
    callId: string,
    toolSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const { cycles, blobs, registry } = this.ctx;
    if (c.cycle.depth + 1 > c.settings.subagentMaxDepth) {
      return {
        status: "failed",
        error: `Sub-agent depth limit (${c.settings.subagentMaxDepth}) reached. Do this work yourself.`,
      };
    }
    const snapshot = await blobs.snapshotDir(c.workspace, {
      exclude: (rel) => rel === ".subagents" || rel.startsWith(".subagents/"),
    });
    const params = await newCycleParams(this.ctx, {
      agent: slug,
      prompt,
      inputManifest: snapshot,
      source: "subagent",
      parent: c.cycle,
      labels: {},
    });
    const child = cycles.create(params);
    c.emit({ type: "subagent.start", data: { callId, childId: child.id, agent: slug, prompt } });
    cycles.setActivity(c.cycle.id, `waiting for sub-agent ${slug}`);

    const controller = registry.registerChild(child.id, [c.ac.signal, toolSignal]);
    let outcome: TurnOutcome;
    try {
      outcome = await this.runTurn(child.id, { signal: controller.signal, parentBudget: c.budget });
    } finally {
      registry.delete(child.id);
    }

    let filesCopiedTo: string | null = null;
    const changed = [...(outcome.changes?.added ?? []), ...(outcome.changes?.modified ?? [])];
    if (changed.length > 0 && !outcome.shutdown) {
      const destRel = `.subagents/${slug}-${await nextSubagentIndex(c.workspace, slug)}`;
      const childWorkspace = this.workspaceDir(child.id);
      for (const rel of changed) {
        const dest = path.join(c.workspace, destRel, ...rel.split("/"));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(childWorkspace, ...rel.split("/")), dest).catch(() => {});
      }
      filesCopiedTo = `/workspace/${destRel}/`;
    }
    const childDto = cycles.get(child.id);
    c.emit({
      type: "subagent.end",
      data: {
        callId,
        childId: child.id,
        agent: slug,
        status: outcome.status,
        costUsd: childDto.totalUsage.costUsd,
      },
    });
    return {
      status: outcome.status,
      answer: outcome.answer
        ? outcome.answer.format === "markdown"
          ? outcome.answer.text
          : outcome.answer.data
        : null,
      error: outcome.error?.message ?? null,
      filesCopiedTo,
      changes: outcome.changes,
    };
  }
}

// -----------------------------------------------------------------------------

async function nextSubagentIndex(workspace: string, slug: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(workspace, ".subagents"));
  } catch {
    return 1;
  }
  let max = 0;
  for (const n of names) {
    const m = new RegExp(`^${slug.replace(/[-]/g, "\\-")}-(\\d+)$`).exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Resolves a PromiseLike, or gives up after `ms` (some failed streams never settle). */
async function settle<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const clip = (s: unknown) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 120);
  if (name === "bash") return `running bash: ${clip(i.command)}`;
  if (name === "readFile") return `reading ${clip(i.path)}`;
  if (name === "writeFile") return `writing ${clip(i.path)}`;
  if (name === "submit_answer") return "submitting the answer";
  if (name.startsWith("ask_")) return `asking sub-agent ${name.slice(4)}`;
  return `using ${name}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { statusCode?: number; responseBody?: string };
    let msg = e.message;
    if (e.statusCode) msg = `${msg} (HTTP ${e.statusCode})`;
    if (e.responseBody && !msg.includes(e.responseBody.slice(0, 50)))
      msg = `${msg}: ${e.responseBody.slice(0, 500)}`;
    return msg;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function modelError(err: unknown): RunError {
  const msg = errorMessage(err);
  if (
    /context length|context window|too long|maximum context|prompt is too long|too many tokens/i.test(msg)
  ) {
    return new RunError("context_overflow", msg);
  }
  return new RunError("model_error", msg);
}

function toCycleError(reason: unknown): CycleError {
  if (reason instanceof RunAbort || reason instanceof RunError)
    return { code: reason.code, message: reason.message };
  if (reason instanceof Error && reason.name === "AbortError") return { code: "stopped", message: "Stopped" };
  return { code: "internal", message: errorMessage(reason) };
}
