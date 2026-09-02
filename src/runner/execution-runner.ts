import "@/lib/load-env";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import packageJson from "../../package.json";
import { env } from "@/lib/env";
import { unrefTimer } from "@/lib/timers";
import { executionJobRepository, runnerRepository } from "@/repositories/execution-job-repository";
import { outboxRepository } from "@/repositories/outbox-repository";
import { processClaimedExecutionJob, recoverExpiredExecutionJobs } from "@/services/execution-job-service";
import { processClaimedOutboxMessage, recoverExpiredOutboxMessages } from "@/services/outbox-service";
import { cleanupExpiredArtifacts } from "@/services/artifact-service";
import { cleanupOrphanedWorkspaceRuntimes, workspaceProcessProvider } from "@/workspaces/provider";
import { shutdownTelemetry, startTelemetry } from "@/observability/sdk";
import { withTelemetrySpan } from "@/observability/telemetry";

function csv(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    unrefTimer(timer);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function main() {
  await startTelemetry();
  const config = env();
  const once = process.argv.includes("--once");
  const runnerId = config.AGENCY_RUNNER_ID
    ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const region = config.AGENCY_RUNNER_REGION;
  const queues = csv(config.AGENCY_RUNNER_QUEUES);
  const executionQueues = queues.filter((queue): queue is "artifact" | "workspace" =>
    queue === "artifact" || queue === "workspace");
  const outboxQueues = queues.filter((queue) => queue === "external-actions" || queue === "events");
  const resourceClasses = csv(config.AGENCY_RUNNER_RESOURCE_CLASSES);
  const labels = csv(config.AGENCY_RUNNER_LABELS);
  const shutdown = new AbortController();
  const active = new Map<string, Promise<void>>();
  let draining = false;
  let preferOutbox = true;

  const activeIds = () => [...active.keys()];
  const requestShutdown = () => {
    if (draining) return;
    draining = true;
    shutdown.abort(new Error("Runner shutdown requested"));
    void runnerRepository.drain(runnerId, activeIds());
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  await runnerRepository.register({
    id: runnerId,
    hostname: hostname(),
    pid: process.pid,
    version: packageJson.version,
    provider: workspaceProcessProvider().name,
    region,
    queues,
    resourceClasses,
    labels,
    maxConcurrency: config.AGENCY_RUNNER_CONCURRENCY,
  });

  await Promise.all([
    recoverExpiredExecutionJobs(runnerId, 200),
    recoverExpiredOutboxMessages(`runner:${runnerId}`, 200),
  ]);
  await cleanupOrphanedWorkspaceRuntimes().catch((error) => {
    console.error("[runner] orphan cleanup failed", error);
  });
  await cleanupExpiredArtifacts().catch((error) => {
    console.error("[runner] artifact cleanup failed", error);
  });

  const nodeHeartbeat = setInterval(() => {
    void runnerRepository.heartbeat(runnerId, activeIds()).catch((error) => {
      console.error("[runner] node heartbeat failed", error);
    });
  }, config.AGENCY_RUNNER_HEARTBEAT_MS);
  unrefTimer(nodeHeartbeat);
  const artifactCleanup = setInterval(() => {
    void cleanupExpiredArtifacts().catch((error) => {
      console.error("[runner] artifact cleanup failed", error);
    });
  }, config.AGENCY_ARTIFACT_GC_INTERVAL_MS);
  unrefTimer(artifactCleanup);

  async function claimOne() {
    const tryOutbox = async () => {
      if (!outboxQueues.length) return false;
      const claimed = await outboxRepository.claimNext({
        runnerId,
        queues: outboxQueues,
        leaseMs: config.AGENCY_OUTBOX_LEASE_MS,
      });
      if (!claimed) return false;
      const key = `outbox:${claimed.message.id}`;
      const promise = withTelemetrySpan("agencyos.outbox.delivery", {
        "agencyos.outbox.id": claimed.message.id,
        "agencyos.outbox.topic": claimed.message.topic,
        "agencyos.tenant.id": claimed.message.tenantId,
      }, () => processClaimedOutboxMessage(claimed, runnerId))
        .then(() => undefined)
        .catch((error) => console.error(`[runner] outbox ${claimed.message.id} failed`, error))
        .finally(() => active.delete(key));
      active.set(key, promise);
      return true;
    };

    const tryExecution = async () => {
      if (!executionQueues.length) return false;
      const claimed = await executionJobRepository.claimNext({
        runnerId,
        leaseMs: config.AGENCY_RUNNER_LEASE_MS,
        region,
        queues: executionQueues,
        resourceClasses,
      });
      if (!claimed) return false;
      const key = `job:${claimed.job.id}`;
      const promise = withTelemetrySpan("agencyos.execution.job", {
        "agencyos.job.id": claimed.job.id,
        "agencyos.run.id": claimed.job.runId,
        "agencyos.tenant.id": claimed.job.tenantId,
        "agencyos.queue": claimed.job.queue,
      }, () => processClaimedExecutionJob(claimed, { shutdownSignal: shutdown.signal }))
        .then(() => undefined)
        .catch((error) => console.error(`[runner] job ${claimed.job.id} failed`, error))
        .finally(() => active.delete(key));
      active.set(key, promise);
      return true;
    };

    const claimed = preferOutbox
      ? await tryOutbox() || await tryExecution()
      : await tryExecution() || await tryOutbox();
    preferOutbox = !preferOutbox;
    return claimed;
  }

  try {
    while (!draining) {
      await Promise.all([
        recoverExpiredExecutionJobs(runnerId, 200),
        recoverExpiredOutboxMessages(`runner:${runnerId}`, 200),
      ]);
      let claimedAny = false;
      while (!draining && active.size < config.AGENCY_RUNNER_CONCURRENCY) {
        const claimed = await claimOne();
        if (!claimed) break;
        claimedAny = true;
        if (once) {
          draining = true;
          break;
        }
      }

      await runnerRepository.heartbeat(runnerId, activeIds());
      if (once && active.size === 0) break;
      if (!claimedAny || active.size >= config.AGENCY_RUNNER_CONCURRENCY) {
        await Promise.race([
          sleep(Math.min(config.AGENCY_RUNNER_POLL_MS, config.AGENCY_OUTBOX_POLL_MS), shutdown.signal),
          ...active.values(),
        ]);
      }
    }
  } finally {
    clearInterval(nodeHeartbeat);
    clearInterval(artifactCleanup);
    await runnerRepository.drain(runnerId, activeIds()).catch(() => undefined);
    if (active.size) {
      await Promise.race([
        Promise.allSettled(active.values()),
        sleep(config.AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS),
      ]);
    }
    await cleanupOrphanedWorkspaceRuntimes().catch(() => undefined);
    await runnerRepository.stop(runnerId).catch(() => undefined);
    await shutdownTelemetry().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[runner] fatal error", error);
  process.exitCode = 1;
});
