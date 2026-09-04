import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getDb } from "@/lib/mongodb";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { lazyAsync } from "@/lib/lazy-async";
import type {
  ClaimedExecutionJob,
  ExecutionJob,
  ExecutionJobEvent,
  ExecutionJobResult,
  RunnerNode,
} from "@/schemas/execution-job";

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const collections = lazyAsync(async () => {
  const db = await getDb();
  const jobs = db.collection<ExecutionJob>("execution_jobs");
  const events = db.collection<ExecutionJobEvent>("execution_job_events");
  const runners = db.collection<RunnerNode>("runner_nodes");

  await Promise.all([
    jobs.updateMany(
      { $or: [{ targetAttemptNumber: { $exists: false } }, { tenantId: { $exists: false } }] },
      [{
        $set: {
          targetAttemptNumber: { $ifNull: ["$targetAttemptNumber", 1] },
          tenantId: { $ifNull: ["$tenantId", env().AGENCY_TENANT_ID] },
          correlationId: { $ifNull: ["$correlationId", "$id"] },
          queue: { $ifNull: ["$queue", "artifact"] },
          resourceClass: { $ifNull: ["$resourceClass", "standard"] },
          regionPreference: { $ifNull: ["$regionPreference", null] },
          admissionReservationId: { $ifNull: ["$admissionReservationId", null] },
        },
      }],
    ),
    events.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID } },
    ),
  ]);

  await Promise.all([
    jobs.createIndex({ id: 1 }, { unique: true }),
    jobs.createIndex({ tenantId: 1, activeKey: 1 }, { unique: true, sparse: true }),
    jobs.createIndex({ status: 1, queue: 1, resourceClass: 1, availableAt: 1, priority: -1, createdAt: 1 }),
    jobs.createIndex({ tenantId: 1, status: 1, updatedAt: -1 }),
    jobs.createIndex({ leaseExpiresAt: 1, status: 1 }),
    jobs.createIndex({ tenantId: 1, runId: 1, createdAt: -1 }),
    jobs.createIndex({ tenantId: 1, projectId: 1, updatedAt: -1 }),
    events.createIndex({ id: 1 }, { unique: true }),
    events.createIndex({ tenantId: 1, jobId: 1, createdAt: 1 }),
    events.createIndex({ tenantId: 1, projectId: 1, createdAt: -1 }),
    runners.createIndex({ id: 1 }, { unique: true }),
    runners.createIndex({ lastSeenAt: -1 }),
  ]);

  return { jobs, events, runners };
});

async function appendEvent(input: Omit<ExecutionJobEvent, "id" | "tenantId" | "createdAt"> & { tenantId?: string }) {
  const { jobs, events } = await collections();
  const source = input.tenantId ? null : await jobs.findOne({ id: input.jobId }, { projection: { _id: 0, tenantId: 1 } });
  const { tenantId: suppliedTenantId, ...rest } = input;
  const event: ExecutionJobEvent = {
    id: randomUUID(),
    tenantId: suppliedTenantId ?? source?.tenantId ?? currentTenantId(),
    ...rest,
    createdAt: new Date(),
  };
  await events.insertOne(event);
  return event;
}

function clearLease() {
  return {
    leaseOwner: null,
    leaseTokenHash: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
  };
}

export const executionJobRepository = {
  async enqueue(input: {
    runId: string;
    projectId: string;
    taskId: string;
    tenantId: string;
    correlationId: string;
    requestedBy: string;
    targetAttemptNumber: number;
    priority: number;
    queue: "artifact" | "workspace";
    resourceClass: string;
    regionPreference: string | null;
    admissionReservationId: string | null;
    maxDeliveries: number;
  }) {
    const { jobs } = await collections();
    const activeKey = `run:${input.runId}:execute`;
    const existing = await jobs.findOne({ tenantId: input.tenantId, activeKey }, { projection: { _id: 0 } });
    if (existing) return existing;

    const now = new Date();
    const job: ExecutionJob = {
      id: randomUUID(),
      kind: "execute_run",
      ...input,
      status: "queued",
      deliveryCount: 0,
      availableAt: now,
      activeKey,
      leaseOwner: null,
      leaseTokenHash: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      cancelRequestedAt: null,
      cancellationReason: null,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };

    try {
      await jobs.insertOne(job);
    } catch (error) {
      const duplicate = await jobs.findOne({ tenantId: input.tenantId, activeKey }, { projection: { _id: 0 } });
      if (duplicate) return duplicate;
      throw error;
    }

    await appendEvent({
      jobId: job.id,
      runId: job.runId,
      projectId: job.projectId,
      taskId: job.taskId,
      event: "queued",
      actor: input.requestedBy,
      leaseGeneration: null,
      metadata: {
        priority: job.priority,
        maxDeliveries: job.maxDeliveries,
        targetAttemptNumber: job.targetAttemptNumber,
      },
    });
    return job;
  },

  async get(id: string) {
    const { jobs } = await collections();
    return jobs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  async getDetail(id: string) {
    const { jobs, events } = await collections();
    const job = await jobs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!job) return null;
    const jobEvents = await events
      .find(tenantFilter({ jobId: id }), { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    return { job, events: jobEvents };
  },

  async summary() {
    const { jobs } = await collections();
    const statuses = ["queued", "leased", "running", "retry_wait", "succeeded", "failed", "dead_letter", "cancelled"] as const;
    const counts = Object.fromEntries(await Promise.all(
      statuses.map(async (status) => [status, await jobs.countDocuments(tenantFilter({ status }))]),
    )) as Record<(typeof statuses)[number], number>;
    const oldestReady = await jobs.findOne(
      tenantFilter({ status: { $in: ["queued", "retry_wait"] }, availableAt: { $lte: new Date() } }),
      { projection: { _id: 0, createdAt: 1 }, sort: { priority: -1, createdAt: 1 } },
    );
    return {
      counts,
      ready: counts.queued + counts.retry_wait,
      active: counts.leased + counts.running,
      oldestReadyAt: oldestReady?.createdAt ?? null,
    };
  },

  async listByStatus(status: ExecutionJob["status"], limit = 200) {
    const { jobs } = await collections();
    return jobs
      .find(tenantFilter({ status }), { projection: { _id: 0 } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
  },



  async listByStatusAllTenants(status: ExecutionJob["status"], limit = 200) {
    const { jobs } = await collections();
    return jobs.find({ status }, { projection: { _id: 0 } }).sort({ updatedAt: 1 }).limit(limit).toArray();
  },

  async globalAdmissionSummary() {
    const { jobs } = await collections();
    const [ready, active] = await Promise.all([
      jobs.countDocuments({ status: { $in: ["queued", "retry_wait"] } }),
      jobs.countDocuments({ status: { $in: ["leased", "running"] } }),
    ]);
    return { ready, active };
  },

  async getActiveForRun(runId: string) {
    const { jobs } = await collections();
    return jobs.findOne(tenantFilter({ activeKey: `run:${runId}:execute` }), { projection: { _id: 0 } });
  },

  async listForRun(runId: string) {
    const { jobs, events } = await collections();
    const runJobs = await jobs.find(tenantFilter({ runId }), { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    const ids = runJobs.map((job) => job.id);
    const runEvents = ids.length
      ? await events.find(tenantFilter({ jobId: { $in: ids } }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray()
      : [];
    return { jobs: runJobs, jobEvents: runEvents };
  },

  async listProject(projectId: string) {
    const { jobs, events } = await collections();
    const projectJobs = await jobs
      .find(tenantFilter({ projectId }), { projection: { _id: 0 } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .toArray();
    const ids = projectJobs.map((job) => job.id);
    const projectEvents = ids.length
      ? await events
          .find(tenantFilter({ jobId: { $in: ids } }), { projection: { _id: 0 } })
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray()
      : [];
    return { jobs: projectJobs, jobEvents: projectEvents };
  },

  async countProjectActive(projectId: string) {
    const { jobs } = await collections();
    return jobs.countDocuments(tenantFilter({
      projectId,
      status: { $in: ["queued", "leased", "running", "retry_wait"] as ExecutionJob["status"][] },
    }));
  },

  async reapExpiredLeases(input: { actor: string; retryDelayMs: number; limit?: number }) {
    const { jobs } = await collections();
    const now = new Date();
    const expired = await jobs
      .find(
        {
          status: { $in: ["leased", "running"] },
          leaseExpiresAt: { $lte: now },
        },
        { projection: { _id: 0 } },
      )
      .sort({ leaseExpiresAt: 1 })
      .limit(input.limit ?? 50)
      .toArray();

    const recovered: ExecutionJob[] = [];
    for (const candidate of expired) {
      const cancelled = candidate.cancelRequestedAt !== null;
      const exhausted = candidate.deliveryCount >= candidate.maxDeliveries;
      const availableAt = new Date(now.getTime() + input.retryDelayMs);
      const updated = await jobs.findOneAndUpdate(
        {
          id: candidate.id,
          status: candidate.status,
          leaseGeneration: candidate.leaseGeneration,
          leaseExpiresAt: { $lte: now },
        },
        cancelled
          ? {
              $set: {
                status: "retry_wait",
                ...clearLease(),
                lastError: "Runner lease expired while cancellation was pending",
                availableAt: now,
                updatedAt: now,
              },
            }
          : exhausted
            ? {
                $set: {
                  status: "dead_letter",
                  ...clearLease(),
                  lastError: "Runner lease expired and the delivery budget was exhausted",
                  updatedAt: now,
                  completedAt: now,
                },
                $unset: { activeKey: "" },
              }
            : {
                $set: {
                  status: "retry_wait",
                  ...clearLease(),
                  lastError: "Runner lease expired before job completion",
                  availableAt,
                  updatedAt: now,
                },
              },
        { returnDocument: "after", projection: { _id: 0 } },
      );
      if (!updated) continue;
      recovered.push(updated);
      await appendEvent({
        jobId: updated.id,
        runId: updated.runId,
        projectId: updated.projectId,
        taskId: updated.taskId,
        event: "lease_expired",
        actor: input.actor,
        leaseGeneration: candidate.leaseGeneration,
        metadata: { previousOwner: candidate.leaseOwner, nextStatus: updated.status },
      });
      await appendEvent({
        jobId: updated.id,
        runId: updated.runId,
        projectId: updated.projectId,
        taskId: updated.taskId,
        event: cancelled ? "retry_scheduled" : exhausted ? "dead_letter" : "retry_scheduled",
        actor: input.actor,
        leaseGeneration: candidate.leaseGeneration,
        metadata: cancelled
          ? { reason: updated.cancellationReason, cancellationPending: true, availableAt: now }
          : exhausted
            ? { deliveries: updated.deliveryCount }
            : { availableAt },
      });
    }
    return recovered;
  },

  async claimNext(input: {
    runnerId: string;
    leaseMs: number;
    region: string;
    queues: string[];
    resourceClasses: string[];
  }): Promise<ClaimedExecutionJob | null> {
    const { jobs } = await collections();
    const now = new Date();
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    const job = await jobs.findOneAndUpdate(
      {
        status: { $in: ["queued", "retry_wait"] as ExecutionJob["status"][] },
        availableAt: { $lte: now },
        queue: { $in: input.queues as ExecutionJob["queue"][] },
        resourceClass: { $in: input.resourceClasses },
        $and: [
          {
            $or: [
              { cancelRequestedAt: { $ne: null } },
              { $expr: { $lt: ["$deliveryCount", "$maxDeliveries"] } },
            ],
          },
          {
            $or: [
              { regionPreference: null },
              { regionPreference: input.region },
            ],
          },
        ],
      },
      {
        $set: {
          status: "leased",
          leaseOwner: input.runnerId,
          leaseTokenHash: tokenHash(leaseToken),
          leaseExpiresAt,
          lastHeartbeatAt: now,
          lastError: null,
          updatedAt: now,
        },
        $inc: { deliveryCount: 1, leaseGeneration: 1 },
      },
      {
        sort: { priority: -1, createdAt: 1 },
        returnDocument: "after",
        projection: { _id: 0 },
      },
    );
    if (!job) return null;

    await appendEvent({
      jobId: job.id,
      runId: job.runId,
      projectId: job.projectId,
      taskId: job.taskId,
      event: "claimed",
      actor: input.runnerId,
      leaseGeneration: job.leaseGeneration,
      metadata: { leaseExpiresAt, deliveryCount: job.deliveryCount, queue: job.queue, resourceClass: job.resourceClass, region: input.region },
    });
    return { job, leaseToken };
  },

  async start(id: string, runnerId: string, leaseToken: string) {
    const { jobs } = await collections();
    const now = new Date();
    const job = await jobs.findOneAndUpdate(
      {
        id,
        status: "leased",
        leaseOwner: runnerId,
        leaseTokenHash: tokenHash(leaseToken),
        leaseExpiresAt: { $gt: now },
        cancelRequestedAt: null,
      },
      { $set: { status: "running", startedAt: now, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (job) {
      await appendEvent({
        jobId: job.id,
        runId: job.runId,
        projectId: job.projectId,
        taskId: job.taskId,
        event: "started",
        actor: runnerId,
        leaseGeneration: job.leaseGeneration,
        metadata: {},
      });
    }
    return job;
  },

  async heartbeat(id: string, runnerId: string, leaseToken: string, leaseMs: number) {
    const { jobs } = await collections();
    const now = new Date();
    return jobs.findOneAndUpdate(
      {
        id,
        status: { $in: ["leased", "running"] },
        leaseOwner: runnerId,
        leaseTokenHash: tokenHash(leaseToken),
        leaseExpiresAt: { $gt: now },
        cancelRequestedAt: null,
      },
      {
        $set: {
          lastHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          updatedAt: now,
        },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async inspectOwnedLease(id: string, runnerId: string, leaseToken: string) {
    const { jobs } = await collections();
    const now = new Date();
    return jobs.findOne(
      {
        id,
        status: { $in: ["leased", "running"] },
        leaseOwner: runnerId,
        leaseTokenHash: tokenHash(leaseToken),
        leaseExpiresAt: { $gt: now },
      },
      { projection: { _id: 0 } },
    );
  },

  async assertLease(id: string, runnerId: string, leaseToken: string) {
    const job = await executionJobRepository.inspectOwnedLease(id, runnerId, leaseToken);
    return job?.status === "running" && !job.cancelRequestedAt ? job : null;
  },

  async complete(id: string, runnerId: string, leaseToken: string, result: ExecutionJobResult) {
    const { jobs } = await collections();
    const now = new Date();
    const job = await jobs.findOneAndUpdate(
      {
        id,
        status: "running",
        leaseOwner: runnerId,
        leaseTokenHash: tokenHash(leaseToken),
        leaseExpiresAt: { $gt: now },
        cancelRequestedAt: null,
      },
      {
        $set: {
          status: "succeeded",
          ...clearLease(),
          result,
          lastError: null,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (job) {
      await appendEvent({
        jobId: job.id,
        runId: job.runId,
        projectId: job.projectId,
        taskId: job.taskId,
        event: "succeeded",
        actor: runnerId,
        leaseGeneration: job.leaseGeneration,
        metadata: result,
      });
    }
    return job;
  },

  async fail(input: {
    id: string;
    runnerId: string;
    leaseToken: string;
    error: string;
    retryable: boolean;
    retryDelayMs: number;
  }) {
    const { jobs } = await collections();
    const now = new Date();
    const current = await jobs.findOne(
      {
        id: input.id,
        status: { $in: ["leased", "running"] },
        leaseOwner: input.runnerId,
        leaseTokenHash: tokenHash(input.leaseToken),
        leaseExpiresAt: { $gt: now },
      },
      { projection: { _id: 0 } },
    );
    if (!current) return null;

    const retry = input.retryable && current.deliveryCount < current.maxDeliveries;
    const terminalStatus: ExecutionJob["status"] = input.retryable ? "dead_letter" : "failed";
    const job = await jobs.findOneAndUpdate(
      {
        id: current.id,
        status: current.status,
        leaseGeneration: current.leaseGeneration,
        leaseOwner: input.runnerId,
        leaseTokenHash: tokenHash(input.leaseToken),
        leaseExpiresAt: { $gt: now },
      },
      retry
        ? {
            $set: {
              status: "retry_wait",
              ...clearLease(),
              lastError: input.error,
              availableAt: new Date(now.getTime() + input.retryDelayMs),
              updatedAt: now,
            },
          }
        : {
            $set: {
              status: terminalStatus,
              ...clearLease(),
              lastError: input.error,
              updatedAt: now,
              completedAt: now,
            },
            $unset: { activeKey: "" },
          },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!job) return null;

    await appendEvent({
      jobId: job.id,
      runId: job.runId,
      projectId: job.projectId,
      taskId: job.taskId,
      event: retry ? "retry_scheduled" : terminalStatus === "dead_letter" ? "dead_letter" : "failed",
      actor: input.runnerId,
      leaseGeneration: current.leaseGeneration,
      metadata: {
        error: input.error,
        availableAt: retry ? job.availableAt : null,
        deliveryCount: job.deliveryCount,
      },
    });
    return job;
  },

  async acknowledgeCancellation(id: string, runnerId: string, leaseToken: string) {
    const { jobs } = await collections();
    const now = new Date();
    const job = await jobs.findOneAndUpdate(
      {
        id,
        status: { $in: ["leased", "running"] },
        leaseOwner: runnerId,
        leaseTokenHash: tokenHash(leaseToken),
        cancelRequestedAt: { $ne: null },
      },
      {
        $set: { status: "cancelled", ...clearLease(), updatedAt: now, completedAt: now },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (job) {
      await appendEvent({
        jobId: job.id,
        runId: job.runId,
        projectId: job.projectId,
        taskId: job.taskId,
        event: "cancelled",
        actor: runnerId,
        leaseGeneration: job.leaseGeneration,
        metadata: { reason: job.cancellationReason },
      });
    }
    return job;
  },

  async retry(id: string, actor: string) {
    const { jobs } = await collections();
    const current = await jobs.findOne(
      tenantFilter({ id, status: { $in: ["failed", "dead_letter"] } }),
      { projection: { _id: 0 } },
    );
    if (!current) return null;

    const activeKey = `run:${current.runId}:execute`;
    const conflict = await jobs.findOne(tenantFilter({ activeKey }), { projection: { _id: 0 } });
    if (conflict && conflict.id !== current.id) {
      throw new Error("Another execution job is already active for this run");
    }

    const now = new Date();
    const job = await jobs.findOneAndUpdate(
      tenantFilter({ id: current.id, status: current.status }),
      {
        $set: {
          status: "retry_wait",
          activeKey,
          deliveryCount: 0,
          availableAt: now,
          ...clearLease(),
          cancelRequestedAt: null,
          cancellationReason: null,
          lastError: null,
          result: null,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
        },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (job) {
      await appendEvent({
        jobId: job.id,
        runId: job.runId,
        projectId: job.projectId,
        taskId: job.taskId,
        event: "retry_scheduled",
        actor,
        leaseGeneration: job.leaseGeneration || null,
        metadata: { explicit: true, previousStatus: current.status, availableAt: now },
      });
    }
    return job;
  },

  async requestCancellation(id: string, actor: string, reason: string) {
    const { jobs } = await collections();
    const now = new Date();
    const immediate = await jobs.findOneAndUpdate(
      tenantFilter({ id, status: { $in: ["queued", "retry_wait"] } }),
      {
        $set: {
          status: "cancelled",
          cancelRequestedAt: now,
          cancellationReason: reason,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (immediate) {
      await appendEvent({
        jobId: immediate.id,
        runId: immediate.runId,
        projectId: immediate.projectId,
        taskId: immediate.taskId,
        event: "cancelled",
        actor,
        leaseGeneration: immediate.leaseGeneration || null,
        metadata: { reason },
      });
      return immediate;
    }

    const requested = await jobs.findOneAndUpdate(
      tenantFilter({ id, status: { $in: ["leased", "running"] }, cancelRequestedAt: null }),
      { $set: { cancelRequestedAt: now, cancellationReason: reason, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (requested) {
      await appendEvent({
        jobId: requested.id,
        runId: requested.runId,
        projectId: requested.projectId,
        taskId: requested.taskId,
        event: "cancel_requested",
        actor,
        leaseGeneration: requested.leaseGeneration,
        metadata: { reason },
      });
      return requested;
    }

    const current = await jobs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (current?.status === "cancelled" || (
      current?.cancelRequestedAt && ["leased", "running", "retry_wait"].includes(current.status)
    )) return current;
    return null;
  },
};

export const runnerRepository = {
  async register(input: Omit<RunnerNode, "status" | "activeJobIds" | "startedAt" | "lastSeenAt" | "stoppedAt">) {
    const { runners } = await collections();
    const now = new Date();
    const node: RunnerNode = {
      ...input,
      status: "online",
      activeJobIds: [],
      startedAt: now,
      lastSeenAt: now,
      stoppedAt: null,
    };
    await runners.updateOne(
      { id: node.id },
      { $set: node },
      { upsert: true },
    );
    return node;
  },

  async heartbeat(id: string, activeJobIds: string[]) {
    const { runners } = await collections();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "online", activeJobIds, lastSeenAt: new Date(), stoppedAt: null } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async drain(id: string, activeJobIds: string[]) {
    const { runners } = await collections();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "draining", activeJobIds, lastSeenAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async stop(id: string) {
    const { runners } = await collections();
    const now = new Date();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "offline", activeJobIds: [], lastSeenAt: now, stoppedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async listRecent(limit = 50) {
    const { runners } = await collections();
    return runners.find({}, { projection: { _id: 0 } }).sort({ lastSeenAt: -1 }).limit(limit).toArray();
  },
};
