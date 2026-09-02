import { z } from "zod";

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
});

export const providerUsageEventSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  agent: z.string().min(1),
  operation: z.string().min(1),
  requestId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  attemptId: z.string().nullable(),
  usage: tokenUsageSchema,
  estimatedCostMicros: z.number().int().nonnegative().nullable(),
  priceVersion: z.number().int().positive().nullable(),
  occurredAt: z.date(),
  expiresAt: z.date(),
});

export const priceCatalogRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  version: z.number().int().positive(),
  currency: z.literal("USD"),
  inputMicrosPerMillion: z.number().int().nonnegative(),
  outputMicrosPerMillion: z.number().int().nonnegative(),
  cachedInputMicrosPerMillion: z.number().int().nonnegative(),
  reasoningMicrosPerMillion: z.number().int().nonnegative(),
  effectiveAt: z.date(),
  active: z.boolean(),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  retiredAt: z.date().nullable(),
});

export const upsertPriceCatalogSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160),
  inputMicrosPerMillion: z.number().int().nonnegative(),
  outputMicrosPerMillion: z.number().int().nonnegative(),
  cachedInputMicrosPerMillion: z.number().int().nonnegative().default(0),
  reasoningMicrosPerMillion: z.number().int().nonnegative().default(0),
  effectiveAt: z.coerce.date().default(() => new Date()),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ProviderUsageEvent = z.infer<typeof providerUsageEventSchema>;
export type PriceCatalogRecord = z.infer<typeof priceCatalogRecordSchema>;
export type UpsertPriceCatalogInput = z.infer<typeof upsertPriceCatalogSchema>;
