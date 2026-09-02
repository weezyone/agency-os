import { z } from "zod";

export const workspaceProviderSchema = z.enum(["local-process", "docker-isolated", "remote-http"]);

export const workspaceStatusSchema = z.enum([
  "preparing",
  "ready",
  "applying",
  "validating",
  "revision_required",
  "review_required",
  "approved",
  "rejected",
  "failed",
  "cleaned",
]);

export const workspaceReviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
export const workspaceChangeOperationSchema = z.enum(["create", "update", "delete"]);

export const workspaceFileChangeSchema = z.object({
  operation: workspaceChangeOperationSchema,
  path: z.string().min(1).max(500),
  content: z.string().nullable().default(null),
  rationale: z.string().min(1),
}).superRefine((change, context) => {
  if (change.operation === "delete" && change.content !== null && change.content !== "") {
    context.addIssue({ code: "custom", path: ["content"], message: "Delete changes cannot include file content" });
  }
  if (change.operation !== "delete" && change.content === null) {
    context.addIssue({ code: "custom", path: ["content"], message: "Create and update changes require file content" });
  }
});

export const workspaceCommandStatusSchema = z.enum(["running", "succeeded", "failed", "timed_out"]);

export const commandIsolationSchema = z.enum(["trusted", "sandbox"]);

export const sandboxResourceLimitsSchema = z.object({
  cpus: z.number().positive(),
  memoryMb: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  diskBytes: z.number().int().positive(),
  networkMode: z.enum(["none", "bridge"]),
  readOnlyRoot: z.boolean(),
});

export const workspaceCommandSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  workspaceId: z.string(),
  runId: z.string(),
  attemptId: z.string(),
  label: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  isolation: commandIsolationSchema,
  runtimeProvider: workspaceProviderSchema,
  runtimeId: z.string().nullable(),
  resourceLimits: sandboxResourceLimitsSchema.nullable(),
  status: workspaceCommandStatusSchema,
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
  timedOut: z.boolean(),
  quotaExceeded: z.boolean(),
  forcedTeardown: z.boolean(),
  workspacePatchSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  integrityViolation: z.boolean().default(false),
  startedAt: z.date(),
  completedAt: z.date().nullable(),
});

export const workspaceValidationResultSchema = z.object({
  requestedScripts: z.array(z.string()).default([]),
  executedScripts: z.array(z.string()).default([]),
  skippedScripts: z.array(z.string()).default([]),
  changedScripts: z.array(z.string()).default([]),
  passed: z.boolean(),
  summary: z.string().min(1),
  commandIds: z.array(z.string()).default([]),
});

export const workspaceRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  runId: z.string(),
  attemptId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  provider: workspaceProviderSchema,
  status: workspaceStatusSchema,
  repositoryUrl: z.string().url(),
  repositoryFullName: z.string().nullable(),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1).nullable(),
  branchName: z.string().min(1),
  localPath: z.string().min(1),
  patchPath: z.string().min(1).nullable(),
  seededFromWorkspaceId: z.string().nullable(),
  requestedChanges: z.array(workspaceFileChangeSchema).default([]),
  appliedChanges: z.array(workspaceFileChangeSchema).default([]),
  changedFiles: z.array(z.string()).default([]),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  diff: z.string().default(""),
  diffTruncated: z.boolean().default(false),
  validation: workspaceValidationResultSchema.nullable(),
  reviewStatus: workspaceReviewStatusSchema,
  reviewedBy: z.string().nullable(),
  reviewReason: z.string().nullable(),
  reviewedAt: z.date().nullable(),
  publishedCommitSha: z.string().nullable(),
  pullRequestUrl: z.string().url().nullable(),
  failure: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const workspaceEventTypeSchema = z.enum([
  "created",
  "seeded",
  "changes_applied",
  "validation_started",
  "validation_completed",
  "revision_required",
  "review_required",
  "approved",
  "rejected",
  "publish_started",
  "published",
  "publish_failed",
  "failed",
  "cleaned",
]);

export const workspaceEventSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  workspaceId: z.string(),
  runId: z.string(),
  attemptId: z.string(),
  event: workspaceEventTypeSchema,
  actor: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});

export const bindRepositorySchema = z.object({
  provider: z.enum(["github", "git"]).default("github"),
  url: z.string().url(),
  cloneUrl: z.string().url().optional(),
  fullName: z.string().min(1).nullable().optional(),
  defaultBranch: z.string().min(1).default("main"),
  externalId: z.string().min(1).nullable().optional(),
  boundBy: z.string().min(1).default("operator-dashboard"),
});

export const reviewWorkspaceSchema = z.object({
  reviewedBy: z.string().min(1),
  reason: z.string().trim().min(1).optional(),
});

export const proposeWorkspacePublishSchema = z.object({
  requestedBy: z.string().min(1).default("operator-dashboard"),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  draft: z.boolean().default(true),
});

export type WorkspaceFileChange = z.infer<typeof workspaceFileChangeSchema>;
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export type WorkspaceValidationResult = z.infer<typeof workspaceValidationResultSchema>;
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type BindRepositoryInput = z.infer<typeof bindRepositorySchema>;
