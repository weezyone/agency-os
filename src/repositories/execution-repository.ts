import { randomUUID } from "node:crypto";
import type { UpdateFilter } from "mongodb";
import { env } from "@/lib/env";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import type {
  ExecutionAttempt,
  ExecutionEvent,
  ExecutionRun,
  ExecutionRunStatus,
  QaResult,
  WorkerOutput,
} from "@/schemas/execution";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const runs = db.collection<ExecutionRun>("execution_runs");
  const attempts = db.collection<ExecutionAttempt>("execution_attempts");
  const events = db.collection<ExecutionEvent>("execution_events");

  await Promise.all([
    runs.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID, executionMode: "artifact", workspaceId: null } },
    ),
    attempts.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID, executionMode: "artifact", workspaceId: null } },
    ),
    events.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID } },
    ),
  ]);

  await Promise.all([
    runs.createIndex({ id: 1 }, { unique: true }),
    runs.createIndex({ tenantId: 1, activeKey: 1 }, { unique: true, sparse: true }),
    runs.createIndex({ tenantId: 1, projectId: 1, updatedAt: -1 }),
    runs.createIndex({ tenantId: 1, taskId: 1, updatedAt: -1 }),
    runs.createIndex({ tenantId: 1, status: 1, updatedAt: -1 }),
    attempts.createIndex({ id: 1 }, { unique: true }),
    attempts.createIndex({ tenantId: 1, runId: 1, number: 1 }, { unique: true }),
    events.createIndex({ tenantId: 1, runId: 1, createdAt: 1 }),
    events.createIndex({ tenantId: 1, projectId: 1, createdAt: -1 }),
  ]);

  return { runs, attempts, events };
});

async function appendEvent(input: Omit<ExecutionEvent, "id" | "tenantId" | "createdAt">) {
  const { events } = await collections();
  const event: ExecutionEvent = {
    id: randomUUID(),
    tenantId: currentTenantId(),
    ...input,
    createdAt: new Date(),
  };
  await events.insertOne(event);
  return event;
}

/**
 * Tenant-scoped store for execution runs, attempts, and their audit events.
 *
 * A run has at most one active slot per task, enforced by the sparse unique
 * index on `(tenantId, activeKey)`; terminal transitions unset `activeKey`.
 */
export const executionRepository = {
  /**
   * Queues a run idempotently: returns the existing active run for the task when present.
   *
   * @param input - Run fields except server-managed status, attempt, and timestamp state.
   * @returns The existing active run or the newly created one.
   */
  async queue(input: Omit<ExecutionRun, "id" | "tenantId" | "status" | "currentAttempt" | "lastWorkerOutput" | "lastQa" | "lastError" | "cancellationReason" | "workspaceId" | "createdAt" | "updatedAt" | "completedAt" | "activeKey">) {
    const { runs } = await collections();
    const tenantId = currentTenantId();
    const activeKey = `task:${input.taskId}:active`;
    const existing = await runs.findOne({ tenantId, activeKey }, { projection: { _id: 0 } });
    if (existing) return existing;

    const now = new Date();
    const run: ExecutionRun = {
      id: randomUUID(),
      tenantId,
      ...input,
      status: "queued",
      currentAttempt: 0,
      lastWorkerOutput: null,
      lastQa: null,
      lastError: null,
      cancellationReason: null,
      workspaceId: null,
      activeKey,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    try {
      await runs.insertOne(run);
    } catch (error) {
      const duplicate = await runs.findOne({ tenantId, activeKey }, { projection: { _id: 0 } });
      if (duplicate) return duplicate;
      throw error;
    }

    await appendEvent({
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      event: "queued",
      actor: run.requestedBy,
      attemptNumber: null,
      metadata: { assignedRole: run.assignedRole, executionMode: run.executionMode, maxAttempts: run.maxAttempts, minQaScore: run.minQaScore },
    });
    return run;
  },

  /**
   * @param id - Run id within the current tenant.
   * @returns The run record, or null when not found.
   */
  async get(id: string) {
    const { runs } = await collections();
    return runs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  /**
   * @param id - Run id within the current tenant.
   * @returns The run with its attempts (by number) and chronological events, or null when not found.
   */
  async getDetail(id: string) {
    const { runs, attempts, events } = await collections();
    const run = await runs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!run) return null;
    const [runAttempts, runEvents] = await Promise.all([
      attempts.find(tenantFilter({ runId: id }), { projection: { _id: 0 } }).sort({ number: 1 }).toArray(),
      events.find(tenantFilter({ runId: id }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    ]);
    return { run, attempts: runAttempts, events: runEvents };
  },

  /**
   * @param projectId - Project id within the current tenant.
   * @returns Up to 100 recent project runs with their latest attempts and events.
   */
  async listProjectActivity(projectId: string) {
    const { runs, attempts, events } = await collections();
    const projectRuns = await runs
      .find(tenantFilter({ projectId }), { projection: { _id: 0 } })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
    if (!projectRuns.length) return { runs: [], attempts: [], events: [] };

    const runIds = projectRuns.map((run) => run.id);
    const [projectAttempts, projectEvents] = await Promise.all([
      attempts
        .find(tenantFilter({ runId: { $in: runIds } }), { projection: { _id: 0 } })
        .sort({ startedAt: -1 })
        .limit(300)
        .toArray(),
      events
        .find(tenantFilter({ runId: { $in: runIds } }), { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray(),
    ]);

    return { runs: projectRuns, attempts: projectAttempts, events: projectEvents };
  },

  /**
   * Starts the next attempt of a queued or revision-requested run.
   *
   * The atomic status guard plus the `maxAttempts` pre-check ensure attempts
   * are handed out sequentially and never beyond the configured budget.
   *
   * @param id - Run id within the current tenant.
   * @param actor - Entity claiming the run (for the audit event).
   * @returns The running run with incremented `currentAttempt`, or null when
   *   not claimable (missing, wrong status, or attempts exhausted).
   */
  async claim(id: string, actor: string) {
    const { runs } = await collections();
    const current = await runs.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!current) return null;
    if (current.currentAttempt >= current.maxAttempts) return null;

    const claimed = await runs.findOneAndUpdate(
      tenantFilter({ id, status: { $in: ["queued", "revision_requested"] } }),
      {
        $set: { status: "running", updatedAt: new Date(), lastError: null },
        $inc: { currentAttempt: 1 },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );

    if (claimed) {
      await appendEvent({
        runId: claimed.id,
        projectId: claimed.projectId,
        taskId: claimed.taskId,
        event: "started",
        actor,
        attemptNumber: claimed.currentAttempt,
        metadata: { assignedRole: claimed.assignedRole, executionMode: claimed.executionMode },
      });
    }
    return claimed;
  },

  /**
   * Creates the attempt record matching the run's current attempt number.
   *
   * @param run - The run just claimed; its `currentAttempt` becomes the attempt number.
   * @returns The inserted attempt.
   */
  async createAttempt(run: ExecutionRun) {
    const { attempts } = await collections();
    const attempt: ExecutionAttempt = {
      id: randomUUID(),
      tenantId: run.tenantId,
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      number: run.currentAttempt,
      agentRole: run.assignedRole,
      executionMode: run.executionMode,
      workspaceId: null,
      workerOutput: null,
      qa: null,
      error: null,
      startedAt: new Date(),
      workerCompletedAt: null,
      completedAt: null,
    };
    await attempts.insertOne(attempt);
    return attempt;
  },

  /**
   * Links a provisioned workspace to a running run and its current attempt.
   *
   * @param runId - Run id within the current tenant.
   * @param attemptId - Attempt to attach; only updated while still workspace-less.
   * @param workspaceId - Workspace id to record.
   * @param actor - Entity performing the attach (for the audit event).
   * @returns The updated run, or null when it is no longer running.
   */
  async attachWorkspace(runId: string, attemptId: string, workspaceId: string, actor: string) {
    const { runs, attempts } = await collections();
    const now = new Date();
    await attempts.updateOne(
      tenantFilter({ id: attemptId, runId, workspaceId: null }),
      { $set: { workspaceId } },
    );
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: runId, status: "running" }),
      { $set: { workspaceId, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "workspace_created",
        actor,
        attemptNumber: run.currentAttempt,
        metadata: { workspaceId, phase: "workspace_attached" },
      });
    }
    return run;
  },

  /**
   * Records worker output on the attempt and advances the run to QA review.
   *
   * @param runId - Run id within the current tenant.
   * @param attemptId - Attempt that produced the output.
   * @param output - Structured worker result (artifacts, blockers, summary).
   * @param actor - Entity reporting completion (for the audit event).
   * @returns The run now in "qa_review", or null when it is no longer running.
   */
  async markWorkerCompleted(runId: string, attemptId: string, output: WorkerOutput, actor: string) {
    const { runs, attempts } = await collections();
    const now = new Date();
    await attempts.updateOne(
      tenantFilter({ id: attemptId, runId }),
      { $set: { workerOutput: output, workerCompletedAt: now } },
    );
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: runId, status: "running" }),
      { $set: { status: "qa_review", lastWorkerOutput: output, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "worker_completed",
        actor,
        attemptNumber: run.currentAttempt,
        metadata: { artifactCount: output.artifacts.length, blockerCount: output.blockers.length },
      });
    }
    return run;
  },

  /**
   * Appends the "qa_started" audit event for a run.
   *
   * @param run - Run entering QA review.
   * @param actor - Entity starting QA (for the audit event).
   * @returns The inserted event.
   */
  async markQaStarted(run: ExecutionRun, actor: string) {
    return appendEvent({
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      event: "qa_started",
      actor,
      attemptNumber: run.currentAttempt,
      metadata: { minQaScore: run.minQaScore },
    });
  },

  /**
   * Closes an attempt with its QA result and moves the run to the matching status.
   *
   * Only a run still in "qa_review" can transition; terminal outcomes
   * ("passed"/"failed") release the task's active-run slot.
   *
   * @param input - Run/attempt ids, QA verdict, target status, and actor.
   * @returns The updated run, or null when the run left "qa_review" concurrently.
   */
  async finishAttempt(input: {
    runId: string;
    attemptId: string;
    qa: QaResult;
    status: "approval_required" | "passed" | "revision_requested" | "failed";
    actor: string;
  }) {
    const { runs, attempts } = await collections();
    const now = new Date();
    await attempts.updateOne(
      tenantFilter({ id: input.attemptId, runId: input.runId }),
      { $set: { qa: input.qa, completedAt: now } },
    );

    const terminal = input.status === "passed" || input.status === "failed";
    const update: UpdateFilter<ExecutionRun> = {
      $set: {
        status: input.status,
        lastQa: input.qa,
        lastError: input.status === "failed" ? input.qa.summary : null,
        updatedAt: now,
        completedAt: terminal ? now : null,
      },
    };
    if (terminal) update.$unset = { activeKey: "" };

    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: input.runId, status: "qa_review" }),
      update,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!run) return null;

    const event = input.status === "passed"
      ? "qa_passed"
      : input.status === "approval_required"
        ? "approval_required"
        : input.status === "revision_requested"
          ? "revision_requested"
          : "failed";

    await appendEvent({
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      event,
      actor: input.actor,
      attemptNumber: run.currentAttempt,
      metadata: { score: input.qa.score, verdict: input.qa.verdict, summary: input.qa.summary },
    });
    return run;
  },

  /**
   * Approves a run awaiting workspace review, marking it passed.
   *
   * The `workspaceId` in the guard proves the reviewer approved the exact
   * workspace they inspected, not a later replacement.
   *
   * @param id - Run id within the current tenant.
   * @param actor - Approving principal.
   * @param workspaceId - Workspace under review.
   * @returns The passed run, or null when not awaiting that workspace's approval.
   */
  async approveWorkspace(id: string, actor: string, workspaceId: string) {
    const { runs } = await collections();
    const now = new Date();
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id, status: "approval_required", workspaceId }),
      {
        $set: { status: "passed", updatedAt: now, completedAt: now, lastError: null },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "workspace_approved",
        actor,
        attemptNumber: run.currentAttempt,
        metadata: { workspaceId },
      });
    }
    return run;
  },

  /**
   * Rejects a workspace under review, requesting revision while attempts remain.
   *
   * @param id - Run id within the current tenant.
   * @param actor - Rejecting principal.
   * @param workspaceId - Workspace under review.
   * @param reason - Human-readable rejection reason.
   * @returns The run in "revision_requested" (or terminally "failed" when the
   *   attempt budget is exhausted), or null when not awaiting that workspace.
   */
  async rejectWorkspace(id: string, actor: string, workspaceId: string, reason: string) {
    const { runs } = await collections();
    const current = await runs.findOne(tenantFilter({ id, status: "approval_required", workspaceId }), { projection: { _id: 0 } });
    if (!current) return null;
    const retry = current.currentAttempt < current.maxAttempts;
    const now = new Date();
    const update: UpdateFilter<ExecutionRun> = {
      $set: {
        status: retry ? "revision_requested" : "failed",
        lastError: retry ? null : reason,
        updatedAt: now,
        completedAt: retry ? null : now,
      },
    };
    if (!retry) update.$unset = { activeKey: "" };
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id, status: "approval_required", workspaceId }),
      update,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "workspace_rejected",
        actor,
        attemptNumber: run.currentAttempt,
        metadata: { workspaceId, reason, nextStatus: run.status },
      });
    }
    return run;
  },


  /**
   * Interrupts the in-flight attempt after an infrastructure failure (e.g. lost lease).
   *
   * `expectedAttemptNumber` makes the operation safe against races with the
   * worker: if the run already advanced to a new attempt, nothing is
   * interrupted. While attempts remain the run goes back to
   * "revision_requested"; otherwise it fails terminally.
   *
   * @param input - Run id, actor, error description, and optional attempt fence.
   * @returns The current run and whether an interruption was applied.
   */
  async interruptCurrentAttempt(input: {
    runId: string;
    actor: string;
    error: string;
    expectedAttemptNumber?: number;
  }) {
    const { runs, attempts } = await collections();
    const current = await runs.findOne(
      tenantFilter({
        id: input.runId,
        status: { $in: ["running", "qa_review"] },
        ...(input.expectedAttemptNumber === undefined
          ? {}
          : { currentAttempt: input.expectedAttemptNumber }),
      }),
      { projection: { _id: 0 } },
    );
    if (!current) {
      return {
        run: await runs.findOne(tenantFilter({ id: input.runId }), { projection: { _id: 0 } }),
        interrupted: false,
      };
    }

    const now = new Date();
    await attempts.updateOne(
      tenantFilter({ runId: current.id, number: current.currentAttempt, completedAt: null }),
      { $set: { error: input.error, completedAt: now } },
    );
    const retry = current.currentAttempt < current.maxAttempts;
    const update: UpdateFilter<ExecutionRun> = {
      $set: {
        status: retry ? "revision_requested" : "failed",
        lastError: input.error,
        updatedAt: now,
        completedAt: retry ? null : now,
      },
    };
    if (!retry) update.$unset = { activeKey: "" };
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: current.id, status: current.status, currentAttempt: current.currentAttempt }),
      update,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "interrupted",
        actor: input.actor,
        attemptNumber: run.currentAttempt,
        metadata: { error: input.error, nextStatus: run.status },
      });
    }
    return {
      run: run ?? await runs.findOne(tenantFilter({ id: input.runId }), { projection: { _id: 0 } }),
      interrupted: Boolean(run),
    };
  },

  /**
   * Fails a running/qa_review run outright and closes the attempt with an error.
   *
   * @param input - Run id, attempt id, actor, and error description.
   * @returns The failed run, or null when it is no longer in flight.
   */
  async failAttempt(input: { runId: string; attemptId: string; actor: string; error: string }) {
    const { runs, attempts } = await collections();
    const now = new Date();
    await attempts.updateOne(
      tenantFilter({ id: input.attemptId, runId: input.runId }),
      { $set: { error: input.error, completedAt: now } },
    );
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: input.runId, status: { $in: ["running", "qa_review"] } }),
      {
        $set: { status: "failed", lastError: input.error, updatedAt: now, completedAt: now },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "failed",
        actor: input.actor,
        attemptNumber: run.currentAttempt,
        metadata: { error: input.error },
      });
    }
    return run;
  },

  /**
   * Cancels a run from the control plane, guarded by allowed statuses and an
   * optional attempt fence so a stale cancel cannot kill a newer attempt.
   *
   * @param input - Run id, actor, reason, allowed current statuses, and optional
   *   attempt fence.
   * @returns The current run and whether the cancellation was applied.
   */
  async cancelFromControl(input: {
    runId: string;
    actor: string;
    reason: string;
    allowedStatuses: ExecutionRunStatus[];
    expectedAttemptNumber?: number;
  }) {
    const { runs, attempts } = await collections();
    const current = await runs.findOne(
      tenantFilter({
        id: input.runId,
        status: { $in: input.allowedStatuses },
        ...(input.expectedAttemptNumber === undefined
          ? {}
          : { currentAttempt: input.expectedAttemptNumber }),
      }),
      { projection: { _id: 0 } },
    );
    if (!current) {
      return {
        run: await runs.findOne(tenantFilter({ id: input.runId }), { projection: { _id: 0 } }),
        cancelled: false,
      };
    }

    const now = new Date();
    if (current.status === "running" || current.status === "qa_review") {
      await attempts.updateOne(
        tenantFilter({ runId: current.id, number: current.currentAttempt, completedAt: null }),
        { $set: { error: `Execution cancelled: ${input.reason}`, completedAt: now } },
      );
    }

    const run = await runs.findOneAndUpdate(
      tenantFilter({ id: current.id, status: current.status, currentAttempt: current.currentAttempt }),
      {
        $set: {
          status: "cancelled",
          cancellationReason: input.reason,
          lastError: null,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "cancelled",
        actor: input.actor,
        attemptNumber: run.currentAttempt || null,
        metadata: { reason: input.reason, previousStatus: current.status },
      });
    }
    return {
      run: run ?? await runs.findOne(tenantFilter({ id: input.runId }), { projection: { _id: 0 } }),
      cancelled: Boolean(run),
    };
  },

  /**
   * Cancels a run that has not started executing (queued, revision requested,
   * or awaiting approval).
   *
   * @param id - Run id within the current tenant.
   * @param actor - Cancelling principal.
   * @param reason - Human-readable cancellation reason.
   * @returns The cancelled run, or null when its status cannot be cancelled here.
   */
  async cancel(id: string, actor: string, reason: string) {
    const { runs } = await collections();
    const now = new Date();
    const run = await runs.findOneAndUpdate(
      tenantFilter({ id, status: { $in: ["queued", "revision_requested", "approval_required"] } }),
      {
        $set: {
          status: "cancelled",
          cancellationReason: reason,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { activeKey: "" },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (run) {
      await appendEvent({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        event: "cancelled",
        actor,
        attemptNumber: run.currentAttempt || null,
        metadata: { reason },
      });
    }
    return run;
  },

  /**
   * @param status - Run status to filter by.
   * @param limit - Maximum runs returned, most recently updated first.
   * @returns Tenant runs in the given status.
   */
  async listByStatus(status: ExecutionRunStatus, limit = 50) {
    const { runs } = await collections();
    return runs.find(tenantFilter({ status }), { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
  },
};
