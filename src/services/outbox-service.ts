import { createHmac } from "node:crypto";
import { env } from "@/lib/env";
import { unrefTimer } from "@/lib/timers";
import { withTenantContext } from "@/lib/tenant-context";
import { outboxRepository } from "@/repositories/outbox-repository";
import type { ClaimedOutboxMessage, OutboxMessage } from "@/schemas/outbox";
import {
  markActionExecutionDeadLetter,
  processActionExecution,
  recordActionExecutionError,
} from "@/services/action-service";

async function deliverWebhook(message: OutboxMessage) {
  const config = env();
  if (!config.AGENCY_EVENT_WEBHOOK_URL) return { delivered: false, reason: "webhook_not_configured" };
  if (!config.AGENCY_EVENT_WEBHOOK_SECRET) throw new Error("Event webhook secret is not configured");
  const body = JSON.stringify({
    id: message.id,
    topic: message.topic,
    tenantId: message.tenantId,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    correlationId: message.correlationId,
    payload: message.payload,
    createdAt: message.createdAt,
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", config.AGENCY_EVENT_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  const response = await fetch(config.AGENCY_EVENT_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agency-event-id": message.id,
      "x-agency-event-timestamp": timestamp,
      "x-agency-event-signature": `sha256=${signature}`,
      "idempotency-key": message.idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Event webhook returned HTTP ${response.status}`);
  return { delivered: true };
}

async function processClaimedOutboxMessageInTenant(claimed: ClaimedOutboxMessage, runnerId: string) {
  const config = env();
  const heartbeat = setInterval(() => {
    void outboxRepository.heartbeat(
      claimed.message.id,
      runnerId,
      claimed.leaseToken,
      config.AGENCY_OUTBOX_LEASE_MS,
    ).catch(() => undefined);
  }, Math.max(1_000, Math.floor(config.AGENCY_OUTBOX_LEASE_MS / 3)));
  unrefTimer(heartbeat);

  try {
    const active = await outboxRepository.assertLease(claimed.message.id, runnerId, claimed.leaseToken);
    if (!active) return null;
    try {
      if (active.topic === "action.execute") {
        const actionId = typeof active.payload.actionId === "string" ? active.payload.actionId : active.aggregateId;
        await processActionExecution(actionId, `runner:${runnerId}`);
      } else {
        await deliverWebhook(active);
      }
      return outboxRepository.complete(active.id, runnerId, claimed.leaseToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown outbox delivery failure";
      if (active.topic === "action.execute") {
        await recordActionExecutionError(active.aggregateId, message).catch(() => undefined);
      }
      const failed = await outboxRepository.fail({
        id: active.id,
        runnerId,
        leaseToken: claimed.leaseToken,
        error: message,
        retryDelayMs: config.AGENCY_OUTBOX_RETRY_DELAY_MS,
      });
      if (failed?.status === "dead_letter" && active.topic === "action.execute") {
        await markActionExecutionDeadLetter(active.aggregateId, `runner:${runnerId}`, message).catch(() => undefined);
      }
      return failed;
    }
  } finally {
    clearInterval(heartbeat);
  }
}


/**
 * Delivers one claimed outbox message under the message's tenant context.
 * `action.execute` messages drive the referenced action through its external
 * side effect; all other topics are delivered to the configured event webhook
 * with an HMAC signature. The lease is heartbeated for the duration and
 * re-asserted before work begins, because only the lease holder may mark a
 * message complete or failed. Delivery failures are retried by the repository
 * and, once dead-lettered, propagate failure onto the referenced action.
 *
 * @param claimed The claimed message including its lease token.
 * @param runnerId Runner identity owning the lease.
 * @returns The terminal message record, or `null` when the lease was lost
 *   before processing could start.
 */
export async function processClaimedOutboxMessage(claimed: ClaimedOutboxMessage, runnerId: string) {
  return withTenantContext({
    tenantId: claimed.message.tenantId,
    source: "runner",
    principalId: `runner:${runnerId}`,
  }, () => processClaimedOutboxMessageInTenant(claimed, runnerId));
}

/**
 * Reaps outbox messages whose delivery leases expired. Messages that end up
 * dead-lettered `action.execute` deliveries also fail their referenced action
 * so actions never remain stuck in `executing` after their delivery died.
 *
 * @param actor Reaper identity recorded on audit events.
 * @param limit Maximum number of expired messages to reap in one pass.
 * @returns The messages whose leases were reaped.
 */
export async function recoverExpiredOutboxMessages(actor: string, limit = 200) {
  const recovered = await outboxRepository.reapExpired(limit);
  for (const message of recovered) {
    if (message.status !== "dead_letter" || message.topic !== "action.execute") continue;
    await withTenantContext({ tenantId: message.tenantId, source: "runner", principalId: actor }, () =>
      markActionExecutionDeadLetter(
        message.aggregateId,
        actor,
        message.lastError ?? "External action delivery lease expired",
      ),
    ).catch(() => undefined);
  }
  return recovered;
}
