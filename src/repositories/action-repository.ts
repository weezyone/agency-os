import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import { env } from "@/lib/env";
import { getDb, listCollectionIndexes } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { withMongoTransaction } from "@/lib/transactions";
import { outboxRepository } from "@/repositories/outbox-repository";
import type {
  ActionApproval,
  ActionEvent,
  ActionRecord,
  ActionStatus,
  ProposedAction,
} from "@/schemas/actions";
import type { ActionPolicyDecision } from "@/schemas/policy";

export type ActionActor = {
  actorId: string;
  principalId: string | null;
  displayName: string;
};

const LEGACY_POLICY_DECISION: ActionPolicyDecision = {
  policyId: "legacy-migration",
  policyVersion: 1,
  policyChecksum: "0".repeat(64),
  matchedRuleId: null,
  denied: false,
  requiredApprovals: 1,
  requireSeparateApprover: true,
  approverRoles: ["reviewer", "admin", "owner"],
  executorRoles: ["operator", "admin", "owner"],
};

const collections = lazyAsync(async () => {
  const db = await getDb();
  const actions = db.collection<ActionRecord>("actions");
  const events = db.collection<ActionEvent>("action_events");

  await Promise.all([
    actions.updateMany(
      { tenantId: { $exists: false } },
      [{
        $set: {
          tenantId: env().AGENCY_TENANT_ID,
          correlationId: { $ifNull: ["$correlationId", "$id"] },
          risk: { $ifNull: ["$risk", "medium"] },
          requestedByPrincipalId: { $ifNull: ["$requestedByPrincipalId", null] },
          requestedByDisplayName: { $ifNull: ["$requestedByDisplayName", "$requestedBy"] },
          requiredApprovals: { $ifNull: ["$requiredApprovals", 1] },
          policyDecision: { $ifNull: ["$policyDecision", LEGACY_POLICY_DECISION] },
          approvals: { $ifNull: ["$approvals", []] },
          executionDeliveryId: { $ifNull: ["$executionDeliveryId", null] },
        },
      }],
    ),
    events.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID } },
    ),
  ]);

  const indexes = await listCollectionIndexes(actions);
  const legacyIdempotency = indexes.find((index) => index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1);
  if (legacyIdempotency && legacyIdempotency.name !== "_id_") {
    await actions.dropIndex(legacyIdempotency.name).catch(() => undefined);
  }

  await Promise.all([
    actions.createIndex({ id: 1 }, { unique: true }),
    actions.createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
    actions.createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
    actions.createIndex({ tenantId: 1, "payload.projectId": 1, createdAt: -1 }),
    events.createIndex({ tenantId: 1, actionId: 1, createdAt: 1 }),
  ]);
  return { actions, events };
});

async function appendEvent(
  action: ActionRecord,
  event: ActionEvent["event"],
  actor: string,
  metadata: Record<string, unknown> = {},
  session?: ClientSession,
) {
  const { events } = await collections();
  const record: ActionEvent = {
    id: randomUUID(),
    tenantId: action.tenantId,
    actionId: action.id,
    event,
    actor,
    metadata,
    createdAt: new Date(),
  };
  await events.insertOne(record, { session });
  await outboxRepository.append({
    tenantId: action.tenantId,
    topic: "domain.event",
    aggregateType: "action",
    aggregateId: action.id,
    idempotencyKey: `action-event:${record.id}`,
    correlationId: action.correlationId,
    payload: {
      eventId: record.id,
      event: record.event,
      actor: record.actor,
      actionId: action.id,
      actionKind: action.kind,
      actionStatus: action.status,
      projectId: typeof action.payload.projectId === "string" ? action.payload.projectId : null,
      metadata: record.metadata,
      occurredAt: record.createdAt.toISOString(),
    },
  }, session);
  return record;
}

export const actionRepository = {
  async propose(
    input: ProposedAction,
    actor: ActionActor,
    idempotencyKey: string,
    policyDecision: ActionPolicyDecision,
    risk: ActionRecord["risk"],
    correlationId?: string,
  ) {
    const { actions } = await collections();
    const tenantId = currentTenantId();
    const existing = await actions.findOne({ tenantId, idempotencyKey }, { projection: { _id: 0 } });
    if (existing) return existing;

    return withMongoTransaction(async (session) => {
      const now = new Date();
      const candidate: ActionRecord = {
        id: randomUUID(),
        tenantId,
        correlationId: correlationId ?? randomUUID(),
        kind: input.kind,
        risk,
        status: "proposed",
        payload: input.payload,
        idempotencyKey,
        requestedBy: actor.actorId,
        requestedByPrincipalId: actor.principalId,
        requestedByDisplayName: actor.displayName,
        requiredApprovals: policyDecision.requiredApprovals,
        policyDecision,
        approvals: [],
        approvedBy: null,
        rejectionReason: null,
        result: null,
        error: null,
        executionDeliveryId: null,
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
        executedAt: null,
      };
      const record = await actions.findOneAndUpdate(
        { tenantId, idempotencyKey },
        { $setOnInsert: candidate },
        { upsert: true, returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (!record) throw new Error("Action proposal could not be persisted");
      if (record.id === candidate.id) {
        await appendEvent(record, "proposed", actor.actorId, {
          kind: record.kind,
          risk: record.risk,
          requiredApprovals: record.requiredApprovals,
          requestedByDisplayName: record.requestedByDisplayName,
          policyId: policyDecision.policyId,
          policyVersion: policyDecision.policyVersion,
          policyChecksum: policyDecision.policyChecksum,
          matchedRuleId: policyDecision.matchedRuleId,
        }, session);
      }
      return record;
    });
  },

  async get(id: string) {
    const { actions } = await collections();
    return actions.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  async getWithEvents(id: string) {
    const { actions, events } = await collections();
    const action = await actions.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!action) return null;
    const history = await events.find(tenantFilter({ actionId: id }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
    return { action, events: history };
  },

  async list(limit = 50, status?: ActionStatus) {
    const { actions } = await collections();
    return actions.find(tenantFilter(status ? { status } : {}), { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  },

  async summary() {
    const { actions } = await collections();
    const statuses: ActionStatus[] = ["proposed", "approved", "rejected", "executing", "succeeded", "failed"];
    const counts = Object.fromEntries(await Promise.all(
      statuses.map(async (status) => [status, await actions.countDocuments(tenantFilter({ status }))]),
    )) as Record<ActionStatus, number>;
    const awaitingApproval = await actions.countDocuments(tenantFilter({
      status: "proposed",
      $expr: { $lt: [{ $size: "$approvals" }, "$requiredApprovals"] },
    }));
    return { counts, awaitingApproval };
  },

  async listProjectActivity(projectId: string) {
    const { actions, events } = await collections();
    const projectActions = await actions.find(
      tenantFilter({ "payload.projectId": projectId }),
      { projection: { _id: 0 } },
    ).sort({ createdAt: -1 }).toArray();
    if (!projectActions.length) return { actions: [], events: [] };
    const projectEvents = await events
      .find(tenantFilter({ actionId: { $in: projectActions.map((action) => action.id) } }), { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return { actions: projectActions, events: projectEvents };
  },

  async recordApproval(id: string, approval: ActionApproval, actorId = `user:${approval.principalId}`) {
    const { actions } = await collections();
    return withMongoTransaction(async (session) => {
      const current = await actions.findOne(tenantFilter({ id }), { projection: { _id: 0 }, session });
      if (!current) return null;
      if (current.status === "approved" || current.status === "succeeded" || current.status === "executing") return current;
      if (current.status !== "proposed") throw new Error(`Action cannot be approved from status ${current.status}`);
      if (!current.policyDecision.approverRoles.includes(approval.role)) {
        throw new Error(`Role ${approval.role} is not permitted to approve this action by policy ${current.policyDecision.policyId}`);
      }
      if (current.policyDecision.requireSeparateApprover && current.requestedByPrincipalId === approval.principalId) {
        throw new Error("Separation of duties prevents the requester from approving this action");
      }
      if (current.approvals.some((item) => item.principalId === approval.principalId)) return current;

      const approvals = [...current.approvals, approval];
      const quorumReached = approvals.length >= current.requiredApprovals;
      const now = new Date();
      const updated = await actions.findOneAndUpdate(
        tenantFilter({ id, status: "proposed", "approvals.principalId": { $ne: approval.principalId } }),
        {
          $set: {
            approvals,
            status: quorumReached ? "approved" : "proposed",
            approvedBy: quorumReached ? approval.principalId : null,
            approvedAt: quorumReached ? now : null,
            rejectionReason: null,
            updatedAt: now,
          },
        },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (!updated) return actions.findOne(tenantFilter({ id }), { projection: { _id: 0 }, session });
      await appendEvent(updated, "approval_recorded", actorId, {
        displayName: approval.displayName,
        role: approval.role,
        approvalCount: approvals.length,
        requiredApprovals: updated.requiredApprovals,
      }, session);
      if (quorumReached) {
        await appendEvent(updated, "approved", actorId, {
          approvalCount: approvals.length,
          requiredApprovals: updated.requiredApprovals,
        }, session);
      }
      return updated;
    });
  },

  async transition(
    id: string,
    from: ActionStatus | ActionStatus[],
    to: ActionStatus,
    patch: Partial<ActionRecord>,
    audit: { event: ActionEvent["event"]; actor: string; metadata?: Record<string, unknown> },
  ) {
    const { actions } = await collections();
    const allowed = Array.isArray(from) ? from : [from];
    return withMongoTransaction(async (session) => {
      const result = await actions.findOneAndUpdate(
        tenantFilter({ id, status: { $in: allowed } }),
        { $set: { ...patch, status: to, updatedAt: new Date() } },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (result) await appendEvent(result, audit.event, audit.actor, audit.metadata ?? {}, session);
      return result;
    });
  },

  async updateExecutionError(id: string, error: string) {
    const { actions } = await collections();
    return actions.findOneAndUpdate(
      tenantFilter({ id, status: "executing" }),
      { $set: { error, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async queueExecution(id: string, actor: ActionActor) {
    const { actions } = await collections();
    return withMongoTransaction(async (session) => {
      const current = await actions.findOne(tenantFilter({ id }), { projection: { _id: 0 }, session });
      if (!current) return null;
      if (current.status === "executing" || current.status === "succeeded") return current;
      if (current.status !== "approved") throw new Error(`Action must be approved before execution; current status is ${current.status}`);
      const delivery = await outboxRepository.append({
        tenantId: current.tenantId,
        topic: "action.execute",
        aggregateType: "action",
        aggregateId: current.id,
        idempotencyKey: `action-execution:${current.id}:${current.approvedAt?.toISOString() ?? "approved"}`,
        correlationId: current.correlationId,
        queue: "external-actions",
        payload: {
          actionId: current.id,
          executedBy: actor.actorId,
          executedByDisplayName: actor.displayName,
        },
      }, session);
      const updated = await actions.findOneAndUpdate(
        tenantFilter({ id, status: "approved" }),
        { $set: { status: "executing", executionDeliveryId: delivery.id, error: null, updatedAt: new Date() } },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (updated) await appendEvent(updated, "execution_queued", actor.actorId, { deliveryId: delivery.id }, session);
      return updated;
    });
  },
};
