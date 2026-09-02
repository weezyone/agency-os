import { env } from "@/lib/env";
import { usageRepository } from "@/repositories/usage-repository";
import { tokenUsageSchema, upsertPriceCatalogSchema, type TokenUsage } from "@/schemas/usage";
import type { Principal } from "@/schemas/identity";
import { principalActor } from "@/lib/authorization";

function finiteInteger(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  }
  return 0;
}

function usageCandidate(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") return record.usage as Record<string, unknown>;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const last = steps.at(-1);
  if (last && typeof last === "object" && (last as Record<string, unknown>).usage) {
    return (last as Record<string, unknown>).usage as Record<string, unknown>;
  }
  return null;
}

export function extractTokenUsage(result: unknown): TokenUsage | null {
  const candidate = usageCandidate(result);
  if (!candidate) return null;
  const inputTokens = finiteInteger(candidate.inputTokens, candidate.promptTokens, candidate.inputTokenCount);
  const outputTokens = finiteInteger(candidate.outputTokens, candidate.completionTokens, candidate.outputTokenCount);
  const cachedInputTokens = finiteInteger(candidate.cachedInputTokens, candidate.cacheReadInputTokens, candidate.cachedPromptTokens);
  const reasoningTokens = finiteInteger(candidate.reasoningTokens, candidate.reasoningTokenCount);
  const totalTokens = finiteInteger(candidate.totalTokens, inputTokens + outputTokens);
  if (inputTokens + outputTokens + cachedInputTokens + reasoningTokens + totalTokens === 0) return null;
  return tokenUsageSchema.parse({ inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens });
}

function splitModel(model: string) {
  const [provider, ...rest] = model.split("/");
  return rest.length ? { provider, model: rest.join("/") } : { provider: "unknown", model };
}

export function estimateUsageCostMicros(usage: TokenUsage, price: {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  reasoningMicrosPerMillion: number;
}) {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const numerator = uncachedInput * price.inputMicrosPerMillion
    + usage.cachedInputTokens * price.cachedInputMicrosPerMillion
    + usage.outputTokens * price.outputMicrosPerMillion
    + usage.reasoningTokens * price.reasoningMicrosPerMillion;
  return Math.ceil(numerator / 1_000_000);
}

export async function recordGenerationUsage(input: {
  result: unknown;
  model: string;
  agent: string;
  operation: string;
  requestId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  attemptId?: string | null;
}) {
  const usage = extractTokenUsage(input.result);
  if (!usage) return null;
  const identity = splitModel(input.model);
  const price = await usageRepository.activePrice(identity.provider, identity.model);
  return usageRepository.record({
    provider: identity.provider,
    model: identity.model,
    agent: input.agent,
    operation: input.operation,
    requestId: input.requestId ?? null,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    attemptId: input.attemptId ?? null,
    usage,
    estimatedCostMicros: price ? estimateUsageCostMicros(usage, price) : null,
    priceVersion: price?.version ?? null,
  });
}

export async function configurePrice(input: unknown, principal: Principal) {
  return usageRepository.upsertPrice(upsertPriceCatalogSchema.parse(input), principalActor(principal));
}

export function configuredModels() {
  const config = env();
  return {
    pm: config.AGENCY_MODEL,
    worker: config.AGENCY_WORKER_MODEL,
    qa: config.AGENCY_QA_MODEL,
    memory: config.AGENCY_MEMORY_MODEL,
  };
}
