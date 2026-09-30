import { env } from "@/lib/env";
import { admissionRepository } from "@/repositories/admission-repository";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import type { ExecutionRun } from "@/schemas/execution";

function unitsForRun(run: ExecutionRun) {
  return run.executionMode === "workspace"
    ? env().AGENCY_WORKSPACE_RUN_COST_UNITS
    : env().AGENCY_ARTIFACT_RUN_COST_UNITS;
}

/**
 * Admits an execution attempt into the runner queue by reserving daily budget
 * units. Global, tenant, and project concurrency limits are checked before
 * reserving so a single tenant or project cannot starve the shared fleet, and
 * the reservation key is derived from run id plus attempt number to keep
 * duplicate enqueues for the same attempt idempotent.
 *
 * @param run The queued execution run requesting admission.
 * @param targetAttemptNumber Attempt number the reservation will cover.
 * @returns The admission reservation (status may be `reserved` or a terminal state).
 * @throws When any global, tenant, or project concurrency limit is reached.
 */
export async function admitExecutionRun(run: ExecutionRun, targetAttemptNumber: number) {
  const config = env();
  const [tenantSummary, globalSummary, projectActive] = await Promise.all([
    executionJobRepository.summary(),
    executionJobRepository.globalAdmissionSummary(),
    executionJobRepository.countProjectActive(run.projectId),
  ]);
  if (globalSummary.ready >= config.AGENCY_ADMISSION_MAX_GLOBAL_READY_JOBS) {
    throw new Error("Execution queue admission is closed because the platform ready-job limit was reached");
  }
  if (globalSummary.active >= config.AGENCY_ADMISSION_MAX_GLOBAL_ACTIVE_JOBS) {
    throw new Error("Execution queue admission is closed because the platform active-job limit was reached");
  }
  if (tenantSummary.ready >= config.AGENCY_ADMISSION_MAX_READY_JOBS) {
    throw new Error("Execution queue admission is closed because the tenant ready-job limit was reached");
  }
  if (tenantSummary.active >= config.AGENCY_ADMISSION_MAX_ACTIVE_JOBS) {
    throw new Error("Execution queue admission is closed because the tenant active-job limit was reached");
  }
  if (projectActive >= config.AGENCY_ADMISSION_MAX_PROJECT_ACTIVE_JOBS) {
    throw new Error("Project execution concurrency limit was reached");
  }
  return admissionRepository.reserve({
    key: `run:${run.id}:attempt:${targetAttemptNumber}`,
    runId: run.id,
    projectId: run.projectId,
    executionMode: run.executionMode,
    units: unitsForRun(run),
  });
}

/**
 * Settles an admission reservation once the job it funded reaches a terminal
 * state: `consumed` charges the reserved units against the daily budget, while
 * `released` returns them (e.g. the job was cancelled before delivery).
 *
 * @param reservationId Reservation to settle; `null` is tolerated for jobs
 *   that predate admission control.
 * @param outcome Whether the reserved units were consumed or released.
 * @returns The settled reservation, or `null` when no reservation id was given.
 */
export async function settleExecutionAdmission(reservationId: string | null, outcome: "consumed" | "released") {
  if (!reservationId) return null;
  return admissionRepository.settle(reservationId, outcome);
}
