import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import type { PriceCatalogRecord, ProviderUsageEvent, TokenUsage, UpsertPriceCatalogInput } from "@/schemas/usage";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const usage = db.collection<ProviderUsageEvent>("provider_usage_events");
  const prices = db.collection<PriceCatalogRecord>("provider_price_catalog");
  await Promise.all([
    usage.createIndex({ id: 1 }, { unique: true }),
    usage.createIndex({ tenantId: 1, occurredAt: -1 }),
    usage.createIndex({ tenantId: 1, projectId: 1, occurredAt: -1 }),
    usage.createIndex({ tenantId: 1, runId: 1, occurredAt: -1 }),
    usage.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    prices.createIndex({ id: 1 }, { unique: true }),
    prices.createIndex({ tenantId: 1, provider: 1, model: 1, version: 1 }, { unique: true }),
    prices.createIndex({ tenantId: 1, provider: 1, model: 1, active: 1 }),
  ]);
  return { usage, prices };
});

export const usageRepository = {
  async activePrice(provider: string, model: string, at = new Date()) {
    const { prices } = await collections();
    return prices.findOne(
      tenantFilter({ provider, model, active: true, effectiveAt: { $lte: at } }),
      { projection: { _id: 0 }, sort: { version: -1 } },
    );
  },

  async upsertPrice(input: UpsertPriceCatalogInput, actor: string) {
    const { prices } = await collections();
    const tenantId = currentTenantId();
    const latest = await prices.find({ tenantId, provider: input.provider, model: input.model }, { projection: { _id: 0, version: 1 } })
      .sort({ version: -1 }).limit(1).next();
    const now = new Date();
    await prices.updateMany(
      { tenantId, provider: input.provider, model: input.model, active: true },
      { $set: { active: false, retiredAt: now } },
    );
    const record: PriceCatalogRecord = {
      id: randomUUID(),
      tenantId,
      provider: input.provider,
      model: input.model,
      version: (latest?.version ?? 0) + 1,
      currency: "USD",
      inputMicrosPerMillion: input.inputMicrosPerMillion,
      outputMicrosPerMillion: input.outputMicrosPerMillion,
      cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion,
      reasoningMicrosPerMillion: input.reasoningMicrosPerMillion,
      effectiveAt: input.effectiveAt,
      active: true,
      createdBy: actor,
      createdAt: now,
      retiredAt: null,
    };
    await prices.insertOne(record);
    return record;
  },

  async listPrices() {
    const { prices } = await collections();
    return prices.find(tenantFilter(), { projection: { _id: 0 } }).sort({ provider: 1, model: 1, version: -1 }).toArray();
  },

  async record(input: {
    provider: string;
    model: string;
    agent: string;
    operation: string;
    requestId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    runId?: string | null;
    attemptId?: string | null;
    usage: TokenUsage;
    estimatedCostMicros: number | null;
    priceVersion: number | null;
  }) {
    const { usage } = await collections();
    const now = new Date();
    const event: ProviderUsageEvent = {
      id: randomUUID(),
      tenantId: currentTenantId(),
      requestId: null,
      projectId: null,
      taskId: null,
      runId: null,
      attemptId: null,
      ...input,
      occurredAt: now,
      expiresAt: new Date(now.getTime() + env().AGENCY_USAGE_RETENTION_DAYS * 86_400_000),
    };
    await usage.insertOne(event);
    return event;
  },

  async list(limit = 200, filters: { projectId?: string; runId?: string } = {}) {
    const { usage } = await collections();
    return usage.find(tenantFilter({
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.runId ? { runId: filters.runId } : {}),
    }), { projection: { _id: 0 } }).sort({ occurredAt: -1 }).limit(Math.min(Math.max(limit, 1), 1_000)).toArray();
  },

  async summary(since = new Date(Date.now() - 30 * 86_400_000)) {
    const { usage } = await collections();
    const rows = await usage.aggregate<{
      _id: { provider: string; model: string };
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      estimatedCostMicros: number;
      unpricedEvents: number;
      events: number;
    }>([
      { $match: tenantFilter({ occurredAt: { $gte: since } }) },
      { $group: {
        _id: { provider: "$provider", model: "$model" },
        inputTokens: { $sum: "$usage.inputTokens" },
        outputTokens: { $sum: "$usage.outputTokens" },
        cachedInputTokens: { $sum: "$usage.cachedInputTokens" },
        reasoningTokens: { $sum: "$usage.reasoningTokens" },
        totalTokens: { $sum: "$usage.totalTokens" },
        estimatedCostMicros: { $sum: { $ifNull: ["$estimatedCostMicros", 0] } },
        unpricedEvents: { $sum: { $cond: [{ $eq: ["$estimatedCostMicros", null] }, 1, 0] } },
        events: { $sum: 1 },
      } },
      { $sort: { "_id.provider": 1, "_id.model": 1 } },
    ]).toArray();
    return { since, rows };
  },
};
