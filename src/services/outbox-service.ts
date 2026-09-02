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


export async function processClaimedOutboxMessage(claimed: ClaimedOutboxMessage, runnerId: string) {
  return withTenantContext({
    tenantId: claimed.message.tenantId,
    source: "runner",
    principalId: `runner:${runnerId}`,
  }, () => processClaimedOutboxMessageInTenant(claimed, runnerId));
}

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
