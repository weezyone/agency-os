import { z } from "zod";
import { workspaceFileChangeSchema } from "@/schemas/workspace";

export const agentRoleSchema = z.enum([
  "tech-lead",
  "research",
  "design",
  "frontend",
  "backend",
  "qa",
]);

export const executionRunStatusSchema = z.enum([
  "queued",
  "running",
  "qa_review",
  "revision_requested",
  "approval_required",
  "passed",
  "failed",
  "cancelled",
]);

export const executionModeSchema = z.enum(["artifact", "workspace"]);

export const artifactTypeSchema = z.enum([
  "plan",
  "research",
  "design",
  "code",
  "test",
  "document",
  "other",
]);

export const workerArtifactSchema = z.object({
  type: artifactTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  content: z.string().default(""),
  path: z.string().min(1).nullable().default(null),
  url: z.string().url().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const workerOutputSchema = z.object({
  summary: z.string().min(1),
  artifacts: z.array(workerArtifactSchema).max(20).default([]),
  fileChanges: z.array(workspaceFileChangeSchema).max(50).default([]),
  requestedValidationScripts: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/)).max(10).default([]),
  blockers: z.array(z.string()).default([]),
  completionNotes: z.array(z.string()).default([]),
  handoff: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const qaCriterionResultSchema = z.object({
  criterion: z.string().min(1),
  passed: z.boolean(),
  evidence: z.string().min(1),
});

export const qaResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: z.enum(["pass", "revise", "fail"]),
  summary: z.string().min(1),
  criteria: z.array(qaCriterionResultSchema).min(1),
  findings: z.array(z.string()).default([]),
  revisionInstructions: z.array(z.string()).default([]),
});

export const executionRunSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  projectId: z.string(),
  taskId: z.string(),
  assignedRole: agentRoleSchema,
  executionMode: executionModeSchema,
  status: executionRunStatusSchema,
  requestedBy: z.string().min(1),
  currentAttempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().min(1).max(10),
  minQaScore: z.number().int().min(0).max(100),
  lastWorkerOutput: workerOutputSchema.nullable(),
  lastQa: qaResultSchema.nullable(),
  lastError: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  workspaceId: z.string().nullable(),
  activeKey: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
});

export const executionAttemptSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  runId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  number: z.number().int().min(1),
  agentRole: agentRoleSchema,
  executionMode: executionModeSchema,
  workspaceId: z.string().nullable(),
  workerOutput: workerOutputSchema.nullable(),
  qa: qaResultSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.date(),
  workerCompletedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});

export const executionEventTypeSchema = z.enum([
  "queued",
  "started",
  "workspace_created",
  "worker_completed",
  "qa_started",
  "qa_passed",
  "revision_requested",
  "approval_required",
  "workspace_approved",
  "workspace_rejected",
  "failed",
  "cancelled",
  "interrupted",
]);

export const executionEventSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  runId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  event: executionEventTypeSchema,
  actor: z.string().min(1),
  attemptNumber: z.number().int().min(1).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});

export const queueTaskRunSchema = z.object({
  requestedBy: z.string().min(1).default("project-manager-agent"),
  assignedRole: agentRoleSchema.optional(),
  executionMode: executionModeSchema.optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  minQaScore: z.number().int().min(0).max(100).optional(),
});

export type AgentRole = z.infer<typeof agentRoleSchema>;
export type ExecutionRunStatus = z.infer<typeof executionRunStatusSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type WorkerOutput = z.infer<typeof workerOutputSchema>;
export type QaResult = z.infer<typeof qaResultSchema>;
export type ExecutionRun = z.infer<typeof executionRunSchema>;
export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type QueueTaskRunInput = z.infer<typeof queueTaskRunSchema>;
