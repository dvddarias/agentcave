import { z } from "zod";

export const reasoningSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const positiveOrNull = (max: number) => z.number().positive().max(max).nullable().optional();

export const limitsSchema = z.strictObject({
  maxTimeSec: positiveOrNull(7 * 24 * 3600),
  maxCostUsd: positiveOrNull(100_000),
  maxTokens: z.number().int().positive().nullable().optional(),
});

export const fileInputSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const jsonSchemaSchema = z.record(z.string(), z.unknown());

export const internetSchema = z.strictObject({
  mode: z.enum(["none", "allowlist", "full"]),
  allowlist: z
    .array(z.url({ protocol: /^https?$/ }))
    .max(200)
    .default([]),
});

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, digits and dashes (max 63 chars)");

export const agentInputSchema = z.strictObject({
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(1_000_000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoning: reasoningSchema.optional(),
  internet: internetSchema.optional(),
  javascript: z.boolean().optional(),
  python: z.boolean().optional(),
  limits: limitsSchema.optional(),
  subagents: z.array(slugSchema).max(50).optional(),
  outputSchema: jsonSchemaSchema.nullable().optional(),
  note: z.string().max(500).optional(),
  files: z
    .strictObject({
      upsert: z.array(fileInputSchema).max(2000).optional(),
      remove: z.array(z.string().min(1).max(1024)).max(2000).optional(),
    })
    .optional(),
});

const overridesSchema = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  reasoning: reasoningSchema.optional(),
  limits: limitsSchema.optional(),
});

const labelsSchema = z
  .record(z.string().min(1).max(100), z.string().max(500))
  .refine((l) => Object.keys(l).length <= 50, "At most 50 labels");

export const startCycleSchema = z.strictObject({
  agent: slugSchema,
  agentVersion: z.number().int().positive().optional(),
  prompt: z.string().min(1).max(2_000_000),
  files: z.array(fileInputSchema).max(10_000).optional(),
  overrides: overridesSchema.optional(),
  outputSchema: jsonSchemaSchema.nullable().optional(),
  labels: labelsSchema.optional(),
  webhookUrl: z.url({ protocol: /^https?$/ }).optional(),
  source: z.enum(["api", "ui"]).optional(),
});

export const followUpSchema = z.strictObject({
  prompt: z.string().min(1).max(2_000_000),
  files: z.array(fileInputSchema).max(10_000).optional(),
});

export const rerunSchema = z.strictObject({
  agentVersion: z.number().int().positive().optional(),
  overrides: overridesSchema.optional(),
  outputSchema: jsonSchemaSchema.nullable().optional(),
  labels: labelsSchema.optional(),
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .optional(),
});

export const settingsUpdateSchema = z.strictObject({
  openrouterToken: z.string().max(500).nullable().optional(),
  maxParallel: z.number().int().min(1).max(256).optional(),
  retentionDays: z.number().int().min(0).max(36500).optional(),
  defaultLimits: limitsSchema.optional(),
  hardStepCap: z.number().int().min(1).max(100_000).optional(),
  maxNudges: z.number().int().min(0).max(20).optional(),
  subagentMaxDepth: z.number().int().min(0).max(10).optional(),
  toolOutputCapBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .optional(),
  commandTimeoutSec: z.number().int().min(1).max(3600).optional(),
  contextTrimRatio: z.number().min(0.1).max(0.95).optional(),
  maxRequestMb: z.number().min(1).max(2048).optional(),
  webhookSecret: z.string().max(500).nullable().optional(),
});

export const testTokenSchema = z.strictObject({ token: z.string().max(500).optional() });
