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

// Only the SHA-256 of a lease token is persisted: anyone with read access to
// the jobs collection (or a leaked backup) cannot steal a live lease and pose
// as the owning runner.
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

/**
 * Tenant-scoped store for distributed execution jobs.
 *
 * Jobs are claimed under short-lived leases identified by a random token
 * (stored hashed) and a monotonically increasing `leaseGeneration`. Every
 * mutation by a runner re-checks owner, token hash, and lease expiry, so a
 * runner whose lease was reaped loses the ability to write — the fencing that
 * prevents two runners from driving the same job after a partition or stall.
 */
export const executionJobRepository = {
  /**
   * Enqueues a run execution job idempotently: one active job per run.
   *
   * The sparse unique index on `(tenantId, activeKey)` enforces single-active
   * execution; terminal states unset `activeKey` to release the slot. A racing
   * enqueue re-reads the winner instead of failing.
   *
   * @param input - Run linkage, scheduling attributes (queue, resource class,
   *   region, priority), admission reservation, and delivery budget.
   * @returns The existing active job or the newly created one.
   */
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

  /**
   * @param id - Job id within the current tenant.
   * @returns The job record, or null when not found.
   */
  async get(id: string) {
    const { jobs } = await collections();
    return jobs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  /**
   * @param id - Job id within the current tenant.
   * @returns The job with its chronological lifecycle events, or null when not found.
   */
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

  /**
   * @returns Per-status counts, derived ready/active totals, and the creation
   *   time of the oldest currently runnable job (queue lag indicator).
   */
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

  /**
   * @param status - Status to filter by.
   * @param limit - Maximum jobs returned, least recently updated first.
   * @returns Tenant jobs in the given status.
   */
  async listByStatus(status: ExecutionJob["status"], limit = 200) {
    const { jobs } = await collections();
    return jobs
      .find(tenantFilter({ status }), { projection: { _id: 0 } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
  },



  /**
   * Cross-tenant variant of {@link executionJobRepository.listByStatus} for platform operators.
   *
   * @param status - Status to filter by.
   * @param limit - Maximum jobs returned, least recently updated first.
   * @returns Jobs in the given status across all tenants.
   */
  async listByStatusAllTenants(status: ExecutionJob["status"], limit = 200) {
    const { jobs } = await collections();
    return jobs.find({ status }, { projection: { _id: 0 } }).sort({ updatedAt: 1 }).limit(limit).toArray();
  },

  /**
   * @returns Cross-tenant counts of runnable and in-flight jobs, used for global admission decisions.
   */
  async globalAdmissionSummary() {
    const { jobs } = await collections();
    const [ready, active] = await Promise.all([
      jobs.countDocuments({ status: { $in: ["queued", "retry_wait"] } }),
      jobs.countDocuments({ status: { $in: ["leased", "running"] } }),
    ]);
    return { ready, active };
  },

  /**
   * @param runId - Run id within the current tenant.
   * @returns The run's active execution job (via its `activeKey` slot), or null.
   */
  async getActiveForRun(runId: string) {
    const { jobs } = await collections();
    return jobs.findOne(tenantFilter({ activeKey: `run:${runId}:execute` }), { projection: { _id: 0 } });
  },

  /**
   * @param runId - Run id within the current tenant.
   * @returns All jobs for the run (newest first) with their chronological events.
   */
  async listForRun(runId: string) {
    const { jobs, events } = await collections();
    const runJobs = await jobs.find(tenantFilter({ runId }), { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    const ids = runJobs.map((job) => job.id);
    const runEvents = ids.length
      ? await events.find(tenantFilter({ jobId: { $in: ids } }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray()
      : [];
    return { jobs: runJobs, jobEvents: runEvents };
  },

  /**
   * @param projectId - Project id within the current tenant.
   * @returns Up to 200 recent project jobs and up to 500 of their latest events.
   */
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

  /**
   * @param projectId - Project id within the current tenant.
   * @returns Count of the project's jobs that are not in a terminal state.
   */
  async countProjectActive(projectId: string) {
    const { jobs } = await collections();
    return jobs.countDocuments(tenantFilter({
      projectId,
      status: { $in: ["queued", "leased", "running", "retry_wait"] },
    }));
  },

  /**
   * Recovers jobs whose lease expired before completion (runner crashed or stalled).
   *
   * Each recovery re-matches on status, `leaseGeneration`, and the still-expired
   * lease, so a heartbeat that raced the scan wins and the job is not yanked
   * from under a healthy runner. Jobs with a pending cancellation are requeued
   * without backoff, ahead of the delivery-budget check, so the next claim can
   * finalize the cancellation; otherwise exhausted jobs go to dead letter and
   * the rest wait `retryDelayMs` before retrying.
   *
   * @param input - Recovery actor, retry backoff delay, and batch limit.
   * @returns The jobs actually recovered by this pass.
   */
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

  /**
   * Atomically claims the highest-priority runnable job matching this runner's
   * region, queues, and resource classes.
   *
   * The claim is a single find-and-modify, so exactly one runner wins even with
   * many pollers. It increments `leaseGeneration` — the fencing token — so any
   * stale write from a previous lease holder fails its generation/owner/token
   * guard instead of corrupting the job.
   *
   * @param input - Runner identity, lease duration, and scheduling constraints.
   * @returns The claimed job with its plaintext lease token (never persisted), or null when empty.
   */
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
        status: { $in: ["queued", "retry_wait"] },
        availableAt: { $lte: now },
        queue: { $in: input.queues },
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

  /**
   * Marks a freshly claimed job as running, fenced by owner, token, expiry, and cancellation state.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token from {@link executionJobRepository.claimNext}.
   * @returns The running job, or null when the lease guard does not hold.
   */
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

  /**
   * Extends a live lease, fenced by owner and token.
   *
   * Refuses to heartbeat cancelled jobs so a runner always learns about
   * cancellation on its next heartbeat.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token.
   * @param leaseMs - Extension duration in milliseconds.
   * @returns The updated job, or null when the lease is no longer valid.
   */
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

  /**
   * Reads a job while verifying lease ownership, without filtering on cancellation.
   *
   * Unlike {@link executionJobRepository.assertLease} this still returns
   * cancellation-pending jobs so callers can observe and acknowledge them.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token.
   * @returns The job when the lease guard holds, otherwise null.
   */
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

  /**
   * Confirms the caller still holds a valid lease on a running, uncancelled job.
   *
   * Runners must call this before any externally visible side effect; a null
   * result means another runner may have taken over and work must stop.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token.
   * @returns The job when still exclusively owned and running, otherwise null.
   */
  async assertLease(id: string, runnerId: string, leaseToken: string) {
    const job = await executionJobRepository.inspectOwnedLease(id, runnerId, leaseToken);
    return job?.status === "running" && !job.cancelRequestedAt ? job : null;
  },

  /**
   * Marks a running job as succeeded and releases its active-run slot.
   *
   * The fenced filter (owner + token + expiry + not cancelled) guarantees only
   * the current lease holder can record the result, so a reaped runner's late
   * completion cannot overwrite a successor's state.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token.
   * @param result - Structured job result stored on the record and audit event.
   * @returns The succeeded job, or null when the lease guard does not hold.
   */
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

  /**
   * Fails a leased job, scheduling a retry while the delivery budget lasts.
   *
   * Retryable failures re-enter the queue after `retryDelayMs` backoff;
   * non-retryable failures, or retries past `maxDeliveries`, become terminal
   * (`failed` vs `dead_letter`) and release the active-run slot. The second
   * update re-matches on `leaseGeneration` so a concurrent lease change
   * between the read and the write aborts the transition.
   *
   * @param input - Job id, lease credentials, error message, retryability, and backoff.
   * @returns The transitioned job, or null when the lease guard does not hold.
   */
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

  /**
   * Confirms a runner observed a cancellation request and stopped the job.
   *
   * @param id - Job id.
   * @param runnerId - Runner holding the lease.
   * @param leaseToken - Plaintext lease token.
   * @returns The cancelled job, or null when no cancellation is pending for this lease.
   */
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

  /**
   * Manually requeues a failed or dead-lettered job with a fresh delivery budget.
   *
   * @param id - Job id within the current tenant.
   * @param actor - Principal requesting the retry.
   * @returns The requeued job, or null when not in a retryable terminal state.
   * @throws {Error} If another job already holds the run's active slot.
   */
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

  /**
   * Cancels a job: immediately when not yet leased, cooperatively when running.
   *
   * Queued/retry-waiting jobs transition straight to "cancelled". Leased or
   * running jobs only get `cancelRequestedAt` set — the owning runner must
   * observe it (via heartbeat/assertLease) and acknowledge, because only the
   * runner can stop the actual workspace work.
   *
   * @param id - Job id within the current tenant.
   * @param actor - Principal requesting cancellation.
   * @param reason - Human-readable cancellation reason.
   * @returns The cancelled/flagged job, the current record when already
   *   cancelling, or null when the job is in a state that cannot be cancelled.
   */
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

/** Registry of runner nodes (identity, liveness, and drain state) for the execution fleet. */
export const runnerRepository = {
  /**
   * Registers (or re-registers on restart) a runner node as online.
   *
   * @param input - Runner identity, version, provider, region, queues, and capacity.
   * @returns The stored runner node.
   */
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

  /**
   * @param id - Runner id.
   * @param activeJobIds - Jobs currently in flight on this runner.
   * @returns The runner marked online with a fresh `lastSeenAt`, or null when unknown.
   */
  async heartbeat(id: string, activeJobIds: string[]) {
    const { runners } = await collections();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "online", activeJobIds, lastSeenAt: new Date(), stoppedAt: null } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  /**
   * Marks a runner as draining so operators can see it is finishing work before shutdown.
   *
   * @param id - Runner id.
   * @param activeJobIds - Jobs still in flight at drain time.
   * @returns The updated runner node, or null when unknown.
   */
  async drain(id: string, activeJobIds: string[]) {
    const { runners } = await collections();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "draining", activeJobIds, lastSeenAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  /**
   * @param id - Runner id.
   * @returns The runner marked offline with an empty active-job list, or null when unknown.
   */
  async stop(id: string) {
    const { runners } = await collections();
    const now = new Date();
    return runners.findOneAndUpdate(
      { id },
      { $set: { status: "offline", activeJobIds: [], lastSeenAt: now, stoppedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  /**
   * @param limit - Maximum runners returned.
   * @returns Runner nodes ordered by most recent heartbeat.
   */
  async listRecent(limit = 50) {
    const { runners } = await collections();
    return runners.find({}, { projection: { _id: 0 } }).sort({ lastSeenAt: -1 }).limit(limit).toArray();
  },
};
