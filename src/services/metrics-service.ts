import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";
import { artifactStore } from "@/artifacts/provider";
import { actionRepository } from "@/repositories/action-repository";
import { admissionRepository } from "@/repositories/admission-repository";
import { artifactRepository } from "@/repositories/artifact-repository";
import { executionJobRepository, runnerRepository } from "@/repositories/execution-job-repository";
import { outboxRepository } from "@/repositories/outbox-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";

export async function operationsSnapshot(options: { probeArtifactStore?: boolean } = {}) {
  const config = env();
  const [jobs, outbox, admission, runners, actions, artifacts, workspaces] = await Promise.all([
    executionJobRepository.summary(),
    outboxRepository.summary(),
    admissionRepository.currentSummary(),
    runnerRepository.listRecent(100),
    actionRepository.summary(),
    artifactRepository.summary(),
    workspaceRepository.summary(),
  ]);

  const now = Date.now();
  const staleThresholdMs = Math.max(config.AGENCY_RUNNER_LEASE_MS, config.AGENCY_RUNNER_HEARTBEAT_MS * 3);
  // Runner identities, hostnames, and labels are platform-infrastructure details.
  // Tenant-scoped operations endpoints expose only coarse fleet capacity.
  const runnerNodes = runners.map((runner) => ({
    provider: runner.provider,
    region: runner.region,
    maxConcurrency: runner.maxConcurrency,
    activeJobs: runner.activeJobIds.length,
    status: runner.status,
    stale: now - runner.lastSeenAt.getTime() > staleThresholdMs,
  }));
  const onlineRunners = runnerNodes.filter((runner) => runner.status === "online" && !runner.stale).length;
  const capacity = runnerNodes
    .filter((runner) => runner.status === "online" && !runner.stale)
    .reduce((total, runner) => total + runner.maxConcurrency, 0);

  const store = artifactStore();
  const storage = options.probeArtifactStore && store.health
    ? await store.health()
    : { provider: store.name, available: null, message: "Probe not requested" };

  return {
    checkedAt: new Date(),
    tenantId: currentTenantId(),
    jobs,
    outbox,
    admission,
    actions,
    artifacts,
    workspaces,
    runners: {
      online: onlineRunners,
      capacity,
      active: runnerNodes.reduce((total, runner) => total + runner.activeJobs, 0),
      stale: runnerNodes.filter((runner) => runner.stale).length,
      nodes: runnerNodes,
    },
    storage,
  };
}

function metric(name: string, value: number, help: string, labels?: Record<string, string>) {
  const suffix = labels
    ? `{${Object.entries(labels).map(([key, item]) => `${key}=${JSON.stringify(item)}`).join(",")}}`
    : "";
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${suffix} ${value}`].join("\n");
}

export async function prometheusMetrics() {
  const snapshot = await operationsSnapshot();
  const lines: string[] = [];
  for (const [status, value] of Object.entries(snapshot.jobs.counts)) {
    lines.push(metric("agencyos_execution_jobs", Number(value), "Execution jobs by status", { status }));
  }
  for (const [status, value] of Object.entries(snapshot.actions.counts)) {
    lines.push(metric("agencyos_actions", Number(value), "External actions by status", { status }));
  }
  lines.push(metric("agencyos_outbox_pending", snapshot.outbox.pending, "Pending outbox messages"));
  lines.push(metric("agencyos_outbox_leased", snapshot.outbox.leased, "Leased outbox messages"));
  lines.push(metric("agencyos_outbox_retry_wait", snapshot.outbox.retryWait, "Outbox messages waiting to retry"));
  lines.push(metric("agencyos_outbox_dead_letter", snapshot.outbox.deadLetter, "Dead-letter outbox messages"));
  lines.push(metric("agencyos_runners_online", snapshot.runners.online, "Healthy online runners"));
  lines.push(metric("agencyos_runner_capacity", snapshot.runners.capacity, "Advertised runner concurrency"));
  lines.push(metric("agencyos_runner_active_work", snapshot.runners.active, "Active work across runners"));
  lines.push(metric("agencyos_admission_reserved_units", snapshot.admission.reservedUnits, "Reserved daily execution budget units"));
  lines.push(metric("agencyos_admission_consumed_units", snapshot.admission.consumedUnits, "Consumed daily execution budget units"));
  lines.push(metric("agencyos_admission_limit_units", snapshot.admission.limitUnits, "Daily execution budget unit limit"));
  lines.push(metric("agencyos_artifacts_active", snapshot.artifacts.activeCount, "Active execution artifacts"));
  lines.push(metric("agencyos_artifact_bytes", snapshot.artifacts.activeBytes, "Bytes in active execution artifacts"));
  lines.push(metric("agencyos_workspace_reviews_pending", snapshot.workspaces.reviewPending, "Workspaces awaiting human review"));
  return `${lines.join("\n")}\n`;
}
