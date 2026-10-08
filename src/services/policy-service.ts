import { principalActor } from "@/lib/authorization";
import { policyRepository, policyChecksum } from "@/repositories/policy-repository";
import { actionPolicyDocumentSchema, createActionPolicySchema, type ActionPolicyDecision, type ActionPolicyDocument } from "@/schemas/policy";
import type { ActionKind, ActionRisk } from "@/schemas/actions";
import type { MemberRole, Principal } from "@/schemas/identity";

/**
 * Built-in fail-safe action policy used when a tenant has not activated its
 * own: external mutations need one separate approver by default, high-risk
 * ones need two, and view-only members cannot request mutations at all.
 */
export const DEFAULT_ACTION_POLICY: ActionPolicyDocument = actionPolicyDocumentSchema.parse({
  apiVersion: "agencyos/v1",
  kind: "ActionPolicy",
  defaultEffect: {
    deny: false,
    requiredApprovals: 1,
    requireSeparateApprover: true,
    approverRoles: ["reviewer", "admin", "owner"],
    executorRoles: ["operator", "admin", "owner"],
  },
  rules: [
    {
      id: "high-risk-two-person",
      description: "High-risk external mutations require two distinct qualified approvers.",
      match: { risks: ["high"] },
      effect: {
        deny: false,
        requiredApprovals: 2,
        requireSeparateApprover: true,
        approverRoles: ["reviewer", "admin", "owner"],
        executorRoles: ["operator", "admin", "owner"],
      },
    },
    {
      id: "viewer-cannot-request",
      description: "View-only members cannot request external mutations.",
      match: { requesterRoles: ["viewer"] },
      effect: {
        deny: true,
        requiredApprovals: 1,
        requireSeparateApprover: true,
        approverRoles: ["admin", "owner"],
        executorRoles: ["admin", "owner"],
      },
    },
  ],
});

function matches(input: { actionKind: ActionKind; risk: ActionRisk; requesterRole: MemberRole }, match: ActionPolicyDocument["rules"][number]["match"]) {
  return (!match.actionKinds || match.actionKinds.includes(input.actionKind))
    && (!match.risks || match.risks.includes(input.risk))
    && (!match.requesterRoles || match.requesterRoles.includes(input.requesterRole));
}

/**
 * Evaluates a policy document for one action request. The first matching deny
 * rule wins over any permissive match; otherwise the first matching rule
 * applies, falling back to the document's default effect. The returned
 * decision carries the policy id, version, and document checksum so consumers
 * can snapshot exactly which policy text produced it.
 *
 * @param input Policy identity/document plus the action kind, risk, and
 *   requester role to evaluate.
 * @returns The decision to snapshot onto the action record.
 */
export function evaluateActionPolicy(input: {
  policyId: string;
  policyVersion: number;
  document: ActionPolicyDocument;
  actionKind: ActionKind;
  risk: ActionRisk;
  requesterRole: MemberRole;
}): ActionPolicyDecision {
  const matchingRules = input.document.rules.filter((candidate) => matches(input, candidate.match));
  // A matching deny rule always wins. This prevents an earlier permissive rule
  // from bypassing a later role- or action-specific prohibition.
  const rule = matchingRules.find((candidate) => candidate.effect.deny) ?? matchingRules[0];
  const effect = rule?.effect ?? input.document.defaultEffect;
  return {
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    policyChecksum: policyChecksum(input.document),
    matchedRuleId: rule?.id ?? null,
    denied: effect.deny,
    requiredApprovals: effect.requiredApprovals,
    requireSeparateApprover: effect.requireSeparateApprover,
    approverRoles: effect.approverRoles,
    executorRoles: effect.executorRoles,
  };
}

/**
 * Loads the tenant's active action policy, falling back to the built-in safe
 * default so the control plane is never without an enforceable policy.
 *
 * @returns The active policy record (tenant-owned or built-in).
 */
export async function activeActionPolicy() {
  const active = await policyRepository.getActive();
  if (active) return active;
  return {
    id: "builtin-default",
    tenantId: "builtin",
    name: "Built-in safe default",
    version: 1,
    status: "active" as const,
    document: DEFAULT_ACTION_POLICY,
    checksum: policyChecksum(DEFAULT_ACTION_POLICY),
    createdBy: "system",
    createdAt: new Date(0),
    activatedAt: new Date(0),
    retiredAt: null,
  };
}

/**
 * Evaluates the currently active policy for an action request and enforces
 * denials eagerly, so a denied action never even enters the approval queue.
 *
 * @param input Action kind, risk tier, and requester role to evaluate.
 * @returns The policy decision to snapshot onto the action record.
 * @throws When the active policy denies the action for this requester role.
 */
export async function decisionForAction(input: { actionKind: ActionKind; risk: ActionRisk; requesterRole: MemberRole }) {
  const policy = await activeActionPolicy();
  const decision = evaluateActionPolicy({
    policyId: policy.id,
    policyVersion: policy.version,
    document: policy.document,
    actionKind: input.actionKind,
    risk: input.risk,
    requesterRole: input.requesterRole,
  });
  if (decision.denied) throw new Error(`Active tenant policy denies ${input.actionKind} for role ${input.requesterRole}`);
  return decision;
}

/**
 * Creates a new versioned action policy document for the current tenant.
 *
 * @param input Raw policy payload, parsed against `createActionPolicySchema`.
 * @param principal Principal recorded as the policy author.
 * @returns The persisted policy record.
 * @throws When the input fails schema validation.
 */
export async function createActionPolicy(input: unknown, principal: Principal) {
  const parsed = createActionPolicySchema.parse(input);
  return policyRepository.create({ ...parsed, createdBy: principalActor(principal) });
}
