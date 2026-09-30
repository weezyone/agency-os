import { z } from "zod";

/**
 * Transactional outbox contracts.
 *
 * Messages are written in the same transaction as the state change that
 * produced them, then leased and delivered with bounded retries until they
 * succeed or dead-letter. Persisted by the outbox repository; the
 * `action.execute` topic drives external action execution.
 */
export const outboxTopicSchema = z.enum(["action.execute", "domain.event"]);
export const outboxStatusSchema = z.enum([
  "pending",
  "leased",
  "retry_wait",
  "succeeded",
  "dead_letter",
]);

export const outboxMessageSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  topic: outboxTopicSchema,
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  status: outboxStatusSchema,
  queue: z.string().min(1),
  deliveryCount: z.number().int().nonnegative(),
  maxDeliveries: z.number().int().min(1).max(20),
  availableAt: z.date(),
  leaseOwner: z.string().nullable(),
  leaseTokenHash: z.string().nullable(),
  leaseExpiresAt: z.date().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
});

export type OutboxTopic = z.infer<typeof outboxTopicSchema>;
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;
export type OutboxMessage = z.infer<typeof outboxMessageSchema>;
/** A leased message plus the raw lease token the holder needs to complete or release it. */
export type ClaimedOutboxMessage = { message: OutboxMessage; leaseToken: string };
