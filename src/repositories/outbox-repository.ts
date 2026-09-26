import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import { env } from "@/lib/env";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb, listCollectionIndexes } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import type { ClaimedOutboxMessage, OutboxMessage, OutboxTopic } from "@/schemas/outbox";

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const collections = lazyAsync(async () => {
  const db = await getDb();
  const outbox = db.collection<OutboxMessage>("outbox_events");
  await outbox.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId: env().AGENCY_TENANT_ID } },
  );
  const indexes = await listCollectionIndexes(outbox);
  const legacyIdempotency = indexes.find((index) => index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1);
  if (legacyIdempotency?.name && legacyIdempotency.name !== "_id_") {
    await outbox.dropIndex(legacyIdempotency.name).catch(() => undefined);
  }
  await Promise.all([
    outbox.createIndex({ id: 1 }, { unique: true }),
    outbox.createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
    outbox.createIndex({ status: 1, queue: 1, availableAt: 1, createdAt: 1 }),
    outbox.createIndex({ tenantId: 1, aggregateType: 1, aggregateId: 1, createdAt: 1 }),
    outbox.createIndex({ leaseExpiresAt: 1, status: 1 }),
  ]);
  return { outbox };
});

export const outboxRepository = {
  async append(input: {
    tenantId?: string;
    topic: OutboxTopic;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    correlationId: string;
    payload: Record<string, unknown>;
    queue?: string;
    maxDeliveries?: number;
  }, session?: ClientSession) {
    const { outbox } = await collections();
    const now = new Date();
    const tenantId = input.tenantId ?? currentTenantId();
    const candidate: OutboxMessage = {
      id: randomUUID(),
      tenantId,
      topic: input.topic,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      payload: input.payload,
      status: "pending",
      queue: input.queue ?? (input.topic === "action.execute" ? "external-actions" : "events"),
      deliveryCount: 0,
      maxDeliveries: input.maxDeliveries ?? env().AGENCY_OUTBOX_MAX_DELIVERIES,
      availableAt: now,
      leaseOwner: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const message = await outbox.findOneAndUpdate(
      { tenantId, idempotencyKey: input.idempotencyKey },
      { $setOnInsert: candidate },
      { upsert: true, returnDocument: "after", projection: { _id: 0 }, session },
    );
    if (!message) throw new Error("Outbox message could not be persisted");
    return message;
  },

  async claimNext(input: { runnerId: string; queues: string[]; leaseMs: number }): Promise<ClaimedOutboxMessage | null> {
    const { outbox } = await collections();
    const now = new Date();
    const leaseToken = randomBytes(32).toString("base64url");
    const message = await outbox.findOneAndUpdate(
      {
        status: { $in: ["pending", "retry_wait"] },
        queue: { $in: input.queues },
        availableAt: { $lte: now },
        $expr: { $lt: ["$deliveryCount", "$maxDeliveries"] },
      },
      {
        $set: {
          status: "leased",
          leaseOwner: input.runnerId,
          leaseTokenHash: hashToken(leaseToken),
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          updatedAt: now,
        },
        $inc: { deliveryCount: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after", projection: { _id: 0 } },
    );
    return message ? { message, leaseToken } : null;
  },

  async heartbeat(id: string, runnerId: string, leaseToken: string, leaseMs: number) {
    const { outbox } = await collections();
    const now = new Date();
    return outbox.findOneAndUpdate(
      {
        id,
        status: "leased",
        leaseOwner: runnerId,
        leaseTokenHash: hashToken(leaseToken),
        leaseExpiresAt: { $gt: now },
      },
      { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async assertLease(id: string, runnerId: string, leaseToken: string) {
    const { outbox } = await collections();
    return outbox.findOne({
      id,
      status: "leased",
      leaseOwner: runnerId,
      leaseTokenHash: hashToken(leaseToken),
      leaseExpiresAt: { $gt: new Date() },
    }, { projection: { _id: 0 } });
  },

  async complete(id: string, runnerId: string, leaseToken: string) {
    const { outbox } = await collections();
    const now = new Date();
    return outbox.findOneAndUpdate(
      { id, status: "leased", leaseOwner: runnerId, leaseTokenHash: hashToken(leaseToken), leaseExpiresAt: { $gt: now } },
      {
        $set: {
          status: "succeeded",
          leaseOwner: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
          completedAt: now,
        },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async fail(input: { id: string; runnerId: string; leaseToken: string; error: string; retryDelayMs: number }) {
    const { outbox } = await collections();
    const current = await outbox.findOne({
      id: input.id,
      status: "leased",
      leaseOwner: input.runnerId,
      leaseTokenHash: hashToken(input.leaseToken),
      leaseExpiresAt: { $gt: new Date() },
    }, { projection: { _id: 0 } });
    if (!current) return null;
    const retry = current.deliveryCount < current.maxDeliveries;
    const now = new Date();
    return outbox.findOneAndUpdate(
      { id: current.id, status: "leased", leaseOwner: input.runnerId, leaseTokenHash: hashToken(input.leaseToken), leaseExpiresAt: { $gt: now } },
      retry
        ? { $set: { status: "retry_wait", availableAt: new Date(now.getTime() + input.retryDelayMs), leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastError: input.error, updatedAt: now } }
        : { $set: { status: "dead_letter", leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastError: input.error, updatedAt: now, completedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async reapExpired(limit = 100) {
    const { outbox } = await collections();
    const now = new Date();
    const expired = await outbox
      .find({ status: "leased", leaseExpiresAt: { $lte: now } }, { projection: { _id: 0 } })
      .sort({ leaseExpiresAt: 1 })
      .limit(limit)
      .toArray();
    const recovered: OutboxMessage[] = [];
    for (const message of expired) {
      const retry = message.deliveryCount < message.maxDeliveries;
      const updated = await outbox.findOneAndUpdate(
        { id: message.id, status: "leased", leaseExpiresAt: { $lte: now } },
        retry
          ? { $set: { status: "retry_wait", availableAt: now, leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastError: "Outbox lease expired", updatedAt: now } }
          : { $set: { status: "dead_letter", leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastError: "Outbox lease expired and delivery budget was exhausted", updatedAt: now, completedAt: now } },
        { returnDocument: "after", projection: { _id: 0 } },
      );
      if (updated) recovered.push(updated);
    }
    return recovered;
  },

  async summary() {
    const { outbox } = await collections();
    const [pending, leased, retryWait, deadLetter] = await Promise.all([
      outbox.countDocuments(tenantFilter({ status: "pending" })),
      outbox.countDocuments(tenantFilter({ status: "leased" })),
      outbox.countDocuments(tenantFilter({ status: "retry_wait" })),
      outbox.countDocuments(tenantFilter({ status: "dead_letter" })),
    ]);
    return { pending, leased, retryWait, deadLetter };
  },
};
