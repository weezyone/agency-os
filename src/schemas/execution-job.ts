import { z } from "zod";

export const executionJobStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
]);

export const executionJobKindSchema = z.literal("execute_run");

export const executionJobResultSchema = z.object({
  runStatus: z.string().min(1),
  workspaceId: z.string().nullable().default(null),
  artifactIds: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export const executionJobSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  kind: executionJobKindSchema,
  runId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  status: executionJobStatusSchema,
  priority: z.number().int().min(-100).max(100),
  queue: z.enum(["artifact", "workspace"]),
  resourceClass: z.string().min(1),
  regionPreference: z.string().nullable(),
  admissionReservationId: z.string().nullable(),
  requestedBy: z.string().min(1),
  targetAttemptNumber: z.number().int().min(1),
  deliveryCount: z.number().int().nonnegative(),
  maxDeliveries: z.number().int().min(1).max(20),
  availableAt: z.date(),
  activeKey: z.string().optional(),
  leaseOwner: z.string().nullable(),
  leaseTokenHash: z.string().nullable(),
  leaseGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: z.date().nullable(),
  lastHeartbeatAt: z.date().nullable(),
  cancelRequestedAt: z.date().nullable(),
  cancellationReason: z.string().nullable(),
  lastError: z.string().nullable(),
  result: executionJobResultSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});

export const executionJobEventTypeSchema = z.enum([
  "queued",
  "claimed",
  "started",
  "heartbeat",
  "lease_expired",
  "retry_scheduled",
  "succeeded",
  "failed",
  "dead_letter",
  "cancel_requested",
  "cancelled",
]);

export const executionJobEventSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  jobId: z.string(),
  runId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  event: executionJobEventTypeSchema,
  actor: z.string().min(1),
  leaseGeneration: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});

export const enqueueExecutionJobSchema = z.object({
  requestedBy: z.string().min(1).default("operator-dashboard"),
  priority: z.number().int().min(-100).max(100).default(0),
  maxDeliveries: z.number().int().min(1).max(20).optional(),
});

export const runnerNodeSchema = z.object({
  id: z.string(),
  hostname: z.string().min(1),
  pid: z.number().int().positive(),
  version: z.string().min(1),
  provider: z.string().min(1),
  region: z.string().min(1),
  queues: z.array(z.string().min(1)).min(1),
  resourceClasses: z.array(z.string().min(1)).min(1),
  labels: z.array(z.string().min(1)).default([]),
  maxConcurrency: z.number().int().min(1),
  status: z.enum(["online", "draining", "offline"]),
  activeJobIds: z.array(z.string()).default([]),
  startedAt: z.date(),
  lastSeenAt: z.date(),
  stoppedAt: z.date().nullable(),
});

export type ExecutionJob = z.infer<typeof executionJobSchema>;
export type ExecutionJobStatus = z.infer<typeof executionJobStatusSchema>;
export type ExecutionJobResult = z.infer<typeof executionJobResultSchema>;
export type ExecutionJobEvent = z.infer<typeof executionJobEventSchema>;
export type EnqueueExecutionJobInput = z.infer<typeof enqueueExecutionJobSchema>;
export type RunnerNode = z.infer<typeof runnerNodeSchema>;

export type ClaimedExecutionJob = {
  job: ExecutionJob;
  leaseToken: string;
};
