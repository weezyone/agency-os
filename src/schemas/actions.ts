import { z } from "zod";
import { memberRoleSchema } from "@/schemas/identity";

export const actionKindSchema = z.enum([
  "linear.createProject",
  "linear.createIssue",
  "github.createRepository",
  "github.publishWorkspace",
]);

export const actionRiskSchema = z.enum(["low", "medium", "high"]);

export const actionStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "executing",
  "succeeded",
  "failed",
]);

export const linearCreateProjectPayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  projectId: z.string().min(1),
});

export const linearCreateIssuePayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  projectId: z.string().min(1),
  linearProjectId: z.string().min(1),
});

export const githubCreateRepositoryPayloadSchema = z.object({
  name: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  description: z.string().default(""),
  private: z.boolean().default(true),
  projectId: z.string().min(1),
});

export const githubPublishWorkspacePayloadSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  patchArtifactId: z.string().min(1),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseSha: z.string().min(7),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  repositoryCloneUrl: z.string().url(),
  baseBranch: z.string().min(1),
  branchName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(""),
  draft: z.boolean().default(true),
});

export const actionPayloadSchemas = {
  "linear.createProject": linearCreateProjectPayloadSchema,
  "linear.createIssue": linearCreateIssuePayloadSchema,
  "github.createRepository": githubCreateRepositoryPayloadSchema,
  "github.publishWorkspace": githubPublishWorkspacePayloadSchema,
} as const;

export const proposeActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear.createProject"), payload: linearCreateProjectPayloadSchema }),
  z.object({ kind: z.literal("linear.createIssue"), payload: linearCreateIssuePayloadSchema }),
  z.object({ kind: z.literal("github.createRepository"), payload: githubCreateRepositoryPayloadSchema }),
  z.object({ kind: z.literal("github.publishWorkspace"), payload: githubPublishWorkspacePayloadSchema }),
]);


export const actionPolicySnapshotSchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.number().int().min(1),
  policyChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  matchedRuleId: z.string().nullable(),
  denied: z.boolean(),
  requiredApprovals: z.number().int().min(1).max(5),
  requireSeparateApprover: z.boolean(),
  approverRoles: z.array(memberRoleSchema).min(1),
  executorRoles: z.array(memberRoleSchema).min(1),
});

export const actionApprovalSchema = z.object({
  principalId: z.string().min(1),
  displayName: z.string().min(1),
  role: memberRoleSchema,
  approvedAt: z.date(),
});

export const actionRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  kind: actionKindSchema,
  risk: actionRiskSchema,
  status: actionStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
  requestedBy: z.string().min(1),
  requestedByPrincipalId: z.string().nullable(),
  requestedByDisplayName: z.string().min(1),
  requiredApprovals: z.number().int().min(1).max(5),
  policyDecision: actionPolicySnapshotSchema,
  approvals: z.array(actionApprovalSchema),
  approvedBy: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  executionDeliveryId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  approvedAt: z.date().nullable(),
  executedAt: z.date().nullable(),
});

export type ActionKind = z.infer<typeof actionKindSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ActionStatus = z.infer<typeof actionStatusSchema>;
export type ActionApproval = z.infer<typeof actionApprovalSchema>;
export type ActionRecord = z.infer<typeof actionRecordSchema>;
export type ProposedAction = z.infer<typeof proposeActionSchema>;

export const actionEventSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  actionId: z.string(),
  event: z.enum([
    "proposed",
    "reproposed",
    "approval_recorded",
    "approved",
    "rejected",
    "execution_queued",
    "execution_started",
    "succeeded",
    "failed",
  ]),
  actor: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});

export type ActionEvent = z.infer<typeof actionEventSchema>;
