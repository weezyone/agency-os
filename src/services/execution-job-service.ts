import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { currentTenantId, withTenantContext } from "@/lib/tenant-context";
import { unrefTimer } from "@/lib/timers";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { admissionRepository } from "@/repositories/admission-repository";
import { executionRepository } from "@/repositories/execution-repository";
import { projectRepository } from "@/repositories/project-repository";
import { enqueueExecutionJobSchema, type ClaimedExecutionJob } from "@/schemas/execution-job";
import type { ExecutionRun } from "@/schemas/execution";
import { persistExecutionArtifacts } from "@/services/artifact-service";
import { admitExecutionRun, settleExecutionAdmission } from "@/services/admission-service";
import { ExecutionLeaseLostError, type ExecutionGuard } from "@/services/execution-guard";
import { executeRun } from "@/services/execution-service";
import { terminateWorkspaceRuntime } from "@/workspaces/provider";
import { workspaceRepository } from "@/repositories/workspace-repository";

const FINISHED_RUN_STATUSES = new Set<ExecutionRun["status"]>([
  "approval_required",
  "passed",
  "failed",
  "cancelled",
]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown execution job failure";
}

function deliveryCanRetry(run: ExecutionRun | null) {
  // Attempt-level failures are already converted into revision/failed run states.
  // Retrying the durable delivery lets a replacement runner finish reconciliation
  // and artifact persistence without silently rerunning a terminal attempt.
  return run?.status !== "cancelled";
}

function jobResult(run: ExecutionRun, artifactIds: string[], summary: string) {
  return {
    runStatus: run.status,
    workspaceId: run.workspaceId,
    artifactIds,
    summary,
  };
}

async function refreshTaskAfterInterruption(run: ExecutionRun | null) {
  if (!run) return;
  await projectRepository.transitionTask(
    run.taskId,
    ["backlog", "todo", "in_progress", "review", "blocked"],
    run.status === "revision_requested" ? "in_progress" : "blocked",
    { activeRunId: run.status === "revision_requested" ? run.id : null },
  );
  await projectRepository.refreshProjectStatus(run.projectId);
}

async function recoverAbandonedAttempt(run: ExecutionRun, actor: string) {
  if (run.status !== "running" && run.status !== "qa_review") return run;
  const interruption = await executionRepository.interruptCurrentAttempt({
    runId: run.id,
    actor,
    error: "Recovered an execution attempt abandoned by a previous runner lease",
    expectedAttemptNumber: run.currentAttempt,
  });
  if (interruption.interrupted) await refreshTaskAfterInterruption(interruption.run);
  return interruption.run ?? run;
}

async function finalizeRunCancellation(
  runId: string,
  actor: string,
  reason: string,
  options: { allowTerminalRace?: boolean } = {},
) {
  let run = await executionRepository.get(runId);
  if (!run) return null;

  if (run.workspaceId) {
    await terminateWorkspaceRuntime(run.workspaceId).catch(() => undefined);
  }

  const allowedStatuses: ExecutionRun["status"][] = [
    "queued",
    "running",
    "qa_review",
    "revision_requested",
    "approval_required",
  ];
  if (options.allowTerminalRace) allowedStatuses.push("passed", "failed");

  const cancellation = await executionRepository.cancelFromControl({
    runId,
    actor,
    reason,
    allowedStatuses,
    expectedAttemptNumber: run.status === "running" || run.status === "qa_review"
      ? run.currentAttempt
      : undefined,
  });
  run = cancellation.run;

  if (cancellation.cancelled && run?.workspaceId) {
    await workspaceRepository.fail(run.workspaceId, actor, `Execution cancelled: ${reason}`).catch(() => undefined);
  }

  if (run?.status === "cancelled") {
    await projectRepository.transitionTask(
      run.taskId,
      ["backlog", "todo", "in_progress", "review", "blocked", "done"],
      "todo",
      { activeRunId: null, completedRunId: null },
    );
    await projectRepository.refreshProjectStatus(run.projectId);
  }
  return run;
}

function startLeaseControl(input: {
  claimed: ClaimedExecutionJob;
  controller: AbortController;
}) {
  const config = env();
  let stopped = false;
  let heartbeatInFlight = false;
  let controlPollInFlight = false;

  const heartbeat = async () => {
    if (stopped || heartbeatInFlight || input.controller.signal.aborted) return;
    heartbeatInFlight = true;
    try {
      const lease = await executionJobRepository.heartbeat(
        input.claimed.job.id,
        input.claimed.job.leaseOwner!,
        input.claimed.leaseToken,
        config.AGENCY_RUNNER_LEASE_MS,
      );
      if (!lease) input.controller.abort(new ExecutionLeaseLostError("heartbeat"));
    } catch (error) {
      input.controller.abort(error instanceof Error ? error : new Error("Execution job heartbeat failed"));
    } finally {
      heartbeatInFlight = false;
    }
  };

  const pollControlState = async () => {
    if (stopped || controlPollInFlight || input.controller.signal.aborted) return;
    controlPollInFlight = true;
    try {
      const lease = await executionJobRepository.inspectOwnedLease(
        input.claimed.job.id,
        input.claimed.job.leaseOwner!,
        input.claimed.leaseToken,
      );
      if (!lease) {
        input.controller.abort(new ExecutionLeaseLostError("control-poll"));
      } else if (lease.cancelRequestedAt) {
        input.controller.abort(new Error(lease.cancellationReason ?? "Execution cancelled by operator"));
      }
    } catch (error) {
      input.controller.abort(error instanceof Error ? error : new Error("Execution job control polling failed"));
    } finally {
      controlPollInFlight = false;
    }
  };

  const heartbeatTimer = setInterval(() => void heartbeat(), config.AGENCY_RUNNER_HEARTBEAT_MS);
  const controlTimer = setInterval(() => void pollControlState(), config.AGENCY_RUNNER_CONTROL_POLL_MS);
  unrefTimer(heartbeatTimer);
  unrefTimer(controlTimer);

  return () => {
    stopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(controlTimer);
  };
}

function createGuard(claimed: ClaimedExecutionJob, controller: AbortController): ExecutionGuard {
  return {
    signal: controller.signal,
    async assertActive(stage: string) {
      if (controller.signal.aborted) throw new ExecutionLeaseLostError(stage);
      const active = await executionJobRepository.assertLease(
        claimed.job.id,
        claimed.job.leaseOwner!,
        claimed.leaseToken,
      );
      if (!active) {
        controller.abort(new ExecutionLeaseLostError(stage));
        throw new ExecutionLeaseLostError(stage);
      }
    },
  };
}

export async function recoverExpiredExecutionJobs(actor: string, limit = 200) {
  const recovered = await executionJobRepository.reapExpiredLeases({
    actor,
    retryDelayMs: env().AGENCY_RUNNER_RETRY_DELAY_MS,
    limit,
  });

  for (const job of recovered) {
    if (job.status !== "dead_letter") continue;
    await withTenantContext({ tenantId: job.tenantId, source: "runner", principalId: actor }, () =>
      settleExecutionAdmission(job.admissionReservationId, "consumed"),
    ).catch(() => undefined);
  }

  const deadLetters = await executionJobRepository.listByStatusAllTenants("dead_letter", limit);
  for (const job of deadLetters) {
    await withTenantContext({ tenantId: job.tenantId, source: "runner", principalId: actor }, async () => {
      const run = await executionRepository.get(job.runId).catch(() => null);
      if (!run || (run.status !== "running" && run.status !== "qa_review")) return;
      const interruption = await executionRepository.interruptCurrentAttempt({
        runId: run.id,
        actor,
        error: "Runner lease expired and the durable delivery budget was exhausted",
        expectedAttemptNumber: run.currentAttempt,
      });
      if (interruption.interrupted) await refreshTaskAfterInterruption(interruption.run);
    });
  }

  return recovered;
}

export async function retryExecutionJob(jobId: string, actor: string) {
  const current = await executionJobRepository.get(jobId);
  if (!current) throw new Error("Execution job not found");
  const run = await executionRepository.get(current.runId);
  if (!run) throw new Error("Execution run not found");
  if (run.status === "cancelled") throw new Error("Cancelled execution runs cannot be retried");
  const history = await executionJobRepository.listForRun(current.runId);
  if (history.jobs[0]?.id !== current.id) {
    throw new Error("This durable delivery was superseded by a newer execution job");
  }
  if (run.currentAttempt > current.targetAttemptNumber) {
    throw new Error("This durable delivery targets an execution attempt that has already been superseded");
  }

  const job = await executionJobRepository.retry(jobId, actor);
  if (!job) throw new Error(`Execution job cannot be retried from status ${current.status}`);
  return { run, job };
}

export async function enqueueExecutionRun(runId: string, rawInput: unknown = {}) {
  const input = enqueueExecutionJobSchema.parse(rawInput);
  const run = await executionRepository.get(runId);
  if (!run) throw new Error("Execution run not found");
  if (run.status !== "queued" && run.status !== "revision_requested") {
    throw new Error(`Execution run cannot be enqueued from status ${run.status}`);
  }

  const targetAttemptNumber = run.currentAttempt + 1;
  const reservation = await admitExecutionRun(run, targetAttemptNumber);
  if (reservation.status !== "reserved") {
    throw new Error(`Execution admission for attempt ${targetAttemptNumber} was already ${reservation.status}`);
  }

  let persistedJob = false;
  try {
    const job = await executionJobRepository.enqueue({
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      tenantId: currentTenantId(),
      correlationId: randomUUID(),
      requestedBy: input.requestedBy,
      targetAttemptNumber,
      priority: input.priority,
      queue: run.executionMode,
      resourceClass: "standard",
      regionPreference: null,
      admissionReservationId: reservation.id,
      maxDeliveries: input.maxDeliveries ?? env().AGENCY_RUNNER_MAX_DELIVERIES,
    });
    persistedJob = true;
    if (job.admissionReservationId !== reservation.id) {
      await settleExecutionAdmission(reservation.id, "released").catch(() => undefined);
      return { run, job };
    }
    const attached = await admissionRepository.attachJob(reservation.id, job.id);
    if (!attached) throw new Error("Admission reservation could not be attached to the execution job");
    return { run, job };
  } catch (error) {
    // Once a job references this reservation, keep the budget fenced even when
    // attaching the reverse job link fails. A retry can repair the metadata,
    // while the runner can still settle the reservation by its id.
    if (!persistedJob) {
      await settleExecutionAdmission(reservation.id, "released").catch(() => undefined);
    }
    throw error;
  }
}

export async function requestRunCancellation(runId: string, actor: string, reason: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = await executionRepository.get(runId);
    if (!run) throw new Error("Execution run not found");
    if (run.status === "passed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Execution run cannot be cancelled from terminal status ${run.status}`);
    }

    const activeJob = await executionJobRepository.getActiveForRun(runId);
    if (!activeJob) {
      const cancelledRun = await finalizeRunCancellation(runId, actor, reason);
      if (cancelledRun?.status !== "cancelled") {
        throw new Error(`Execution run cannot be cancelled from status ${cancelledRun?.status ?? run.status}`);
      }
      return { run: cancelledRun, job: null };
    }

    const job = await executionJobRepository.requestCancellation(activeJob.id, actor, reason);
    if (!job) continue;
    if (job.status === "cancelled") {
      const cancelledRun = await finalizeRunCancellation(runId, actor, reason, { allowTerminalRace: true });
      if (cancelledRun?.status !== "cancelled") {
        throw new Error(`Execution run cannot be cancelled from status ${cancelledRun?.status ?? run.status}`);
      }
      await settleExecutionAdmission(job.admissionReservationId, job.deliveryCount > 0 ? "consumed" : "released").catch(() => undefined);
      return { run: cancelledRun, job };
    }

    return { run, job };
  }

  throw new Error("Execution run state changed while cancellation was being requested; retry the request");
}

async function processClaimedExecutionJobInTenant(
  claimed: ClaimedExecutionJob,
  options: { shutdownSignal?: AbortSignal } = {},
) {
  const runnerId = claimed.job.leaseOwner;
  if (!runnerId) throw new Error("Claimed execution job is missing its runner owner");

  const started = await executionJobRepository.start(claimed.job.id, runnerId, claimed.leaseToken);
  if (!started) {
    const current = await executionJobRepository.get(claimed.job.id);
    if (current?.cancelRequestedAt) {
      await finalizeRunCancellation(
        current.runId,
        runnerId,
        current.cancellationReason ?? "Cancelled by operator",
        { allowTerminalRace: true },
      );
      const acknowledged = await executionJobRepository.acknowledgeCancellation(
        claimed.job.id,
        runnerId,
        claimed.leaseToken,
      );
      if (acknowledged) {
        await settleExecutionAdmission(acknowledged.admissionReservationId, "released").catch(() => undefined);
      }
      return acknowledged;
    }
    return current;
  }

  const controller = new AbortController();
  const forwardShutdown = () => controller.abort(new ExecutionLeaseLostError("runner-shutdown", "Runner is shutting down"));
  if (options.shutdownSignal?.aborted) forwardShutdown();
  else options.shutdownSignal?.addEventListener("abort", forwardShutdown, { once: true });
  const stopLeaseControl = startLeaseControl({ claimed: { ...claimed, job: started }, controller });
  const guard = createGuard({ ...claimed, job: started }, controller);

  try {
    await guard.assertActive("job-start");
    let run: ExecutionRun | null = await executionRepository.get(started.runId);
    if (!run) throw new Error("Execution run not found");

    run = await recoverAbandonedAttempt(run, runnerId);
    await guard.assertActive("after-abandoned-attempt-recovery");

    const targetReached = run.currentAttempt >= started.targetAttemptNumber;
    if (!targetReached && !FINISHED_RUN_STATUSES.has(run.status)) {
      if (run.status !== "queued" && run.status !== "revision_requested") {
        throw new Error(`Execution run cannot be processed from status ${run.status}`);
      }
      const detail = await executeRun(run.id, `runner:${runnerId}`, guard);
      run = detail?.run ?? await executionRepository.get(run.id);
      if (!run) throw new Error("Execution run disappeared after execution");
    }

    if (run.currentAttempt < started.targetAttemptNumber && !FINISHED_RUN_STATUSES.has(run.status)) {
      throw new Error(
        `Execution delivery did not reach target attempt ${started.targetAttemptNumber}; current attempt is ${run.currentAttempt}`,
      );
    }

    await guard.assertActive("before-artifact-persistence");
    const artifacts = await persistExecutionArtifacts(run.id, runnerId);
    await guard.assertActive("before-job-completion");
    const completed = await executionJobRepository.complete(
      started.id,
      runnerId,
      claimed.leaseToken,
      jobResult(run, artifacts.map((artifact) => artifact.id), `Execution reached ${run.status}`),
    );
    if (!completed) throw new ExecutionLeaseLostError("job-completion");
    await settleExecutionAdmission(completed.admissionReservationId, "consumed").catch(() => undefined);
    return completed;
  } catch (error) {
    const currentJob = await executionJobRepository.get(started.id).catch(() => null);
    const cancelled = Boolean(currentJob?.cancelRequestedAt);

    if (cancelled) {
      controller.abort(error instanceof Error ? error : undefined);
      await finalizeRunCancellation(
        started.runId,
        runnerId,
        currentJob?.cancellationReason ?? "Cancelled by operator",
        { allowTerminalRace: true },
      );
      const acknowledged = await executionJobRepository.acknowledgeCancellation(started.id, runnerId, claimed.leaseToken);
      if (acknowledged) {
        await settleExecutionAdmission(acknowledged.admissionReservationId, "consumed").catch(() => undefined);
      }
      return acknowledged;
    }

    const leaseLost = error instanceof ExecutionLeaseLostError || controller.signal.aborted;
    if (leaseLost) {
      const stillOwned = await executionJobRepository.assertLease(
        started.id,
        runnerId,
        claimed.leaseToken,
      ).catch(() => null);
      if (!stillOwned) return currentJob;
      const interruptedRun = await executionRepository.get(started.runId).catch(() => null);
      const failed = await executionJobRepository.fail({
        id: started.id,
        runnerId,
        leaseToken: claimed.leaseToken,
        error: errorMessage(controller.signal.reason ?? error),
        retryable: deliveryCanRetry(interruptedRun),
        retryDelayMs: env().AGENCY_RUNNER_RETRY_DELAY_MS,
      });
      if (failed && ["failed", "dead_letter"].includes(failed.status)) {
        await settleExecutionAdmission(failed.admissionReservationId, "consumed").catch(() => undefined);
      }
      return failed;
    }

    const run = await executionRepository.get(started.runId).catch(() => null);
    const retryable = deliveryCanRetry(run);
    const failed = await executionJobRepository.fail({
      id: started.id,
      runnerId,
      leaseToken: claimed.leaseToken,
      error: errorMessage(error),
      retryable,
      retryDelayMs: env().AGENCY_RUNNER_RETRY_DELAY_MS,
    });
    if (failed && ["failed", "dead_letter"].includes(failed.status)) {
      await settleExecutionAdmission(failed.admissionReservationId, "consumed").catch(() => undefined);
    }
    return failed;
  } finally {
    stopLeaseControl();
    options.shutdownSignal?.removeEventListener("abort", forwardShutdown);
  }
}

export async function processClaimedExecutionJob(
  claimed: ClaimedExecutionJob,
  options: { shutdownSignal?: AbortSignal } = {},
) {
  return withTenantContext({
    tenantId: claimed.job.tenantId,
    source: "runner",
    principalId: `runner:${claimed.job.leaseOwner ?? "unassigned"}`,
  }, () => processClaimedExecutionJobInTenant(claimed, options));
}
