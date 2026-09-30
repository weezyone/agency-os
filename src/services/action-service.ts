import { createHash } from "node:crypto";
import { principalActor } from "@/lib/authorization";
import { actionRepository, type ActionActor } from "@/repositories/action-repository";
import {
  githubCreateRepositoryPayloadSchema,
  githubPublishWorkspacePayloadSchema,
  linearCreateIssuePayloadSchema,
  linearCreateProjectPayloadSchema,
  proposeActionSchema,
  type ActionKind,
  type ActionRecord,
  type ActionRisk,
  type ProposedAction,
} from "@/schemas/actions";
import type { MemberRole, Principal } from "@/schemas/identity";
import { linearAdapter } from "@/integrations/linear/adapter";
import { githubAdapter } from "@/integrations/github/adapter";
import { projectRepository } from "@/repositories/project-repository";
import { publishApprovedWorkspace } from "@/services/workspace-publisher";
import { decisionForAction } from "@/services/policy-service";

function isPrincipal(value: string | Principal): value is Principal {
  return typeof value !== "string";
}

/**
 * Normalizes a requester reference into the actor shape stored on action records.
 * Principals contribute their member identity; plain strings are treated as
 * system or agent actor ids with no principal link.
 *
 * @param value Requesting principal or opaque actor id (e.g. an agent name).
 * @param displayName Display name used when `value` is a plain actor id.
 * @returns The actor identity persisted on the action record.
 */
export function actionActor(value: string | Principal, displayName?: string): ActionActor {
  if (isPrincipal(value)) {
    return {
      actorId: principalActor(value),
      principalId: value.memberId ?? value.id,
      displayName: value.displayName,
    };
  }
  return { actorId: value, principalId: null, displayName: displayName ?? value };
}

function riskForKind(kind: ActionKind): ActionRisk {
  switch (kind) {
    case "linear.createIssue": return "low";
    case "linear.createProject":
    case "github.createRepository": return "medium";
    case "github.publishWorkspace": return "high";
  }
}

function requesterRole(value: string | Principal): MemberRole {
  return isPrincipal(value) ? value.role : "operator";
}

/**
 * Derives a deterministic idempotency key from the action payload so that
 * resubmitting an identical proposal collapses onto the existing action
 * record instead of creating a duplicate external mutation.
 *
 * @param action The validated proposed action.
 * @returns SHA-256 hex digest of the serialized action.
 */
export function defaultIdempotencyKey(action: ProposedAction) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

/**
 * Validates and persists a proposed external action for the current tenant.
 * The policy decision is evaluated at proposal time and snapshotted onto the
 * action so that later approval and execution checks enforce the exact policy
 * version that admitted the action, even if tenant policies change afterwards.
 *
 * @param input Raw proposal payload, parsed against `proposeActionSchema`.
 * @param requestedBy Requesting principal or system actor id.
 * @param suppliedKey Optional idempotency key; defaults to a content hash.
 * @param options Correlation id and display name metadata.
 * @returns The persisted action record in `proposed` status.
 * @throws When the input fails schema validation or the active policy denies the action.
 */
export async function proposeAction(
  input: unknown,
  requestedBy: string | Principal,
  suppliedKey?: string,
  options: { correlationId?: string; displayName?: string } = {},
) {
  const action = proposeActionSchema.parse(input);
  const key = suppliedKey?.trim() || defaultIdempotencyKey(action);
  const risk = riskForKind(action.kind);
  const policyDecision = await decisionForAction({
    actionKind: action.kind,
    risk,
    requesterRole: requesterRole(requestedBy),
  });
  return actionRepository.propose(
    action,
    actionActor(requestedBy, options.displayName),
    key,
    policyDecision,
    risk,
    options.correlationId,
  );
}

/**
 * Records one principal's approval on an action. Approver-role, duplicate,
 * separation-of-duties, and quorum checks are enforced atomically in the
 * repository against the action's snapshotted policy decision, so concurrent
 * approvers cannot over-count quorum and a requester cannot self-approve.
 *
 * @param id Action identifier.
 * @param principal Approving principal.
 * @returns The updated action record, or `null` when the action does not exist.
 * @throws When the action is not approvable from its current status, the
 *   principal's role may not approve, or the principal is the requester and
 *   the policy requires a separate approver.
 */
export async function approveAction(id: string, principal: Principal) {
  return actionRepository.recordApproval(id, {
    principalId: principal.memberId ?? principal.id,
    displayName: principal.displayName,
    role: principal.role,
    approvedAt: new Date(),
  }, principalActor(principal));
}

/**
 * Rejects a proposed or approved action, recording the reason for audit.
 *
 * @param id Action identifier.
 * @param rejectedBy Rejecting principal or system actor id.
 * @param reason Human-readable rejection reason.
 * @returns The action record in `rejected` status.
 * @throws When the action does not exist or is not in `proposed`/`approved` status.
 */
export async function rejectAction(id: string, rejectedBy: string | Principal, reason: string) {
  const actor = actionActor(rejectedBy);
  const action = await actionRepository.transition(
    id,
    ["proposed", "approved"],
    "rejected",
    { approvedBy: actor.principalId, rejectionReason: reason },
    { event: "rejected", actor: actor.actorId, metadata: { reason, displayName: actor.displayName } },
  );
  if (action) return action;
  const current = await actionRepository.get(id);
  if (!current) throw new Error("Action not found");
  throw new Error(`Action cannot be rejected from status ${current.status}`);
}

/**
 * Re-proposes a failed or rejected action. A fresh policy decision is
 * evaluated and snapshotted so retries cannot ride on a stale approval rule
 * set, and all approval/execution state is cleared to restart the lifecycle.
 *
 * @param id Action identifier.
 * @param requestedBy Requesting principal or system actor id.
 * @returns The action record back in `proposed` status (or the current record
 *   when it is already proposed).
 * @throws When the action does not exist, is in a non-retryable status, or the
 *   current policy denies re-proposal.
 */
export async function retryAction(id: string, requestedBy: string | Principal) {
  const actor = actionActor(requestedBy);
  const current = await actionRepository.get(id);
  if (!current) throw new Error("Action not found");
  if (current.status === "proposed") return current;
  if (!["failed", "rejected"].includes(current.status)) {
    throw new Error(`Action cannot be retried from status ${current.status}`);
  }
  const role = requesterRole(requestedBy);
  const policyDecision = await decisionForAction({ actionKind: current.kind, risk: current.risk, requesterRole: role });
  const action = await actionRepository.transition(
    id,
    ["failed", "rejected"],
    "proposed",
    {
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
      approvedAt: null,
      executedAt: null,
    },
    { event: "reproposed", actor: actor.actorId, metadata: { policyId: policyDecision.policyId, policyVersion: policyDecision.policyVersion } },
  );
  if (!action) throw new Error("Action could not be reproposed");
  return action;
}

/**
 * Queues an approved action for asynchronous execution. The executor's role is
 * checked against the snapshotted policy decision, then the status flip and
 * the outbox message are committed in one transaction — the transactional
 * outbox guarantees the external write is eventually delivered exactly once,
 * even if this process crashes between the state change and any network call.
 *
 * @param id Action identifier.
 * @param executedBy Executing principal or system actor id.
 * @returns The action record in `executing` status.
 * @throws When the action does not exist, is not approved, or the executor's
 *   role is not permitted by the snapshotted policy.
 */
export async function executeAction(id: string, executedBy: string | Principal) {
  const current = await actionRepository.get(id);
  if (!current) throw new Error("Action not found");
  if (isPrincipal(executedBy) && !current.policyDecision.executorRoles.includes(executedBy.role)) {
    throw new Error(`Role ${executedBy.role} is not permitted to execute this action by policy ${current.policyDecision.policyId}`);
  }
  const action = await actionRepository.queueExecution(id, actionActor(executedBy));
  if (!action) throw new Error("Action not found");
  return action;
}

async function dispatch(action: ActionRecord): Promise<Record<string, unknown>> {
  switch (action.kind) {
    case "linear.createProject": {
      const payload = linearCreateProjectPayloadSchema.parse(action.payload);
      return linearAdapter.createProject(payload);
    }
    case "linear.createIssue": {
      const payload = linearCreateIssuePayloadSchema.parse(action.payload);
      return linearAdapter.createIssue({ projectId: payload.linearProjectId, title: payload.title, description: payload.description });
    }
    case "github.createRepository": {
      const payload = githubCreateRepositoryPayloadSchema.parse(action.payload);
      return githubAdapter.createRepository(payload);
    }
    case "github.publishWorkspace": {
      const payload = githubPublishWorkspacePayloadSchema.parse(action.payload);
      return publishApprovedWorkspace(payload, "distributed-action-runner");
    }
  }
  throw new Error(`Unsupported action kind: ${String(action.kind)}`);
}

async function applySuccessfulSideEffects(action: ActionRecord, result: Record<string, unknown>, actor: string) {
  if (action.kind !== "github.createRepository") return;
  const payload = githubCreateRepositoryPayloadSchema.parse(action.payload);
  const { url, cloneUrl, fullName, defaultBranch, externalId } = result;
  if (
    typeof url !== "string" || typeof cloneUrl !== "string" || typeof fullName !== "string"
    || typeof defaultBranch !== "string" || typeof externalId !== "string"
  ) throw new Error("GitHub repository result is missing repository binding metadata");

  const project = await projectRepository.bindRepository(payload.projectId, {
    provider: "github",
    url,
    cloneUrl,
    fullName,
    defaultBranch,
    externalId,
    boundBy: actor,
    boundAt: new Date(),
  });
  if (!project) throw new Error("Project no longer exists for repository binding");
}

/**
 * Performs the external side effect for an action in `executing` status via
 * the matching integration adapter, applies any resulting control-plane
 * bindings (e.g. linking a created repository to its project), and marks the
 * action succeeded. Redelivery of an already-succeeded action is a no-op.
 *
 * @param actionId Action identifier from the outbox delivery.
 * @param actor Runner identity recorded on the audit event.
 * @returns The action record in `succeeded` status.
 * @throws When the action does not exist, is not executing, the dispatch fails,
 *   or the completion transition loses a state race.
 */
export async function processActionExecution(actionId: string, actor: string) {
  const action = await actionRepository.get(actionId);
  if (!action) throw new Error("Action not found");
  if (action.status === "succeeded") return action;
  if (action.status !== "executing") throw new Error(`Action execution delivery found status ${action.status}`);

  const result = await dispatch(action);
  await applySuccessfulSideEffects(action, result, actor);
  const completed = await actionRepository.transition(
    action.id,
    "executing",
    "succeeded",
    { result, executedAt: new Date(), error: null },
    { event: "succeeded", actor, metadata: { result } },
  );
  if (!completed) throw new Error("Action execution state changed unexpectedly");
  return completed;
}

/**
 * Marks an executing action as failed after its outbox delivery exhausted
 * retries, so the action does not stay stuck in `executing` forever.
 *
 * @param actionId Action identifier.
 * @param actor Runner or reaper identity recorded on the audit event.
 * @param error Terminal failure message.
 * @returns The updated action record, or `null` when the transition does not apply.
 */
export async function markActionExecutionDeadLetter(actionId: string, actor: string, error: string) {
  return actionRepository.transition(
    actionId,
    "executing",
    "failed",
    { error, executedAt: new Date() },
    { event: "failed", actor, metadata: { error } },
  );
}

/**
 * Records the latest execution error on an in-flight action without changing
 * its status, so operators can see why the current delivery attempt failed.
 *
 * @param actionId Action identifier.
 * @param error Failure message from the delivery attempt.
 * @returns The updated action record, or `null` when the action is not executing.
 */
export async function recordActionExecutionError(actionId: string, error: string) {
  return actionRepository.updateExecutionError(actionId, error);
}
