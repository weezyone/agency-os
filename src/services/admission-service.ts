import { env } from "@/lib/env";
import { admissionRepository } from "@/repositories/admission-repository";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import type { ExecutionRun } from "@/schemas/execution";

function unitsForRun(run: ExecutionRun) {
  return run.executionMode === "workspace"
    ? env().AGENCY_WORKSPACE_RUN_COST_UNITS
    : env().AGENCY_ARTIFACT_RUN_COST_UNITS;
}

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

export async function settleExecutionAdmission(reservationId: string | null, outcome: "consumed" | "released") {
  if (!reservationId) return null;
  return admissionRepository.settle(reservationId, outcome);
}
