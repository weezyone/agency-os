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

export function defaultIdempotencyKey(action: ProposedAction) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

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

export async function approveAction(id: string, principal: Principal) {
  return actionRepository.recordApproval(id, {
    principalId: principal.memberId ?? principal.id,
    displayName: principal.displayName,
    role: principal.role,
    approvedAt: new Date(),
  }, principalActor(principal));
}

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

export async function markActionExecutionDeadLetter(actionId: string, actor: string, error: string) {
  return actionRepository.transition(
    actionId,
    "executing",
    "failed",
    { error, executedAt: new Date() },
    { event: "failed", actor, metadata: { error } },
  );
}

export async function recordActionExecutionError(actionId: string, error: string) {
  return actionRepository.updateExecutionError(actionId, error);
}
