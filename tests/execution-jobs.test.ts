import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, resetEnvForTests } from "@/lib/env";
import { executionJobSchema } from "@/schemas/execution-job";
import { publicExecutionJob } from "@/services/execution-job-public";

const originalEnv = { ...process.env };

function baseEnv() {
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
  process.env.AGENCY_RUNNER_LEASE_MS = "90000";
  process.env.AGENCY_RUNNER_HEARTBEAT_MS = "20000";
  process.env.AGENCY_RUNNER_CONTROL_POLL_MS = "2000";
}

describe.sequential("durable execution jobs", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    baseEnv();
    resetEnvForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it("validates a leased job and strips lease secrets from public output", () => {
    const now = new Date();
    const job = executionJobSchema.parse({
      id: "job-1",
      tenantId: "agency-default",
      correlationId: "correlation-1",
      kind: "execute_run",
      runId: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      status: "leased",
      priority: 10,
      queue: "workspace",
      resourceClass: "standard",
      regionPreference: null,
      admissionReservationId: "reservation-1",
      requestedBy: "operator",
      targetAttemptNumber: 1,
      deliveryCount: 1,
      maxDeliveries: 3,
      availableAt: now,
      activeKey: "run:run-1:execute",
      leaseOwner: "runner-1",
      leaseTokenHash: "secret-hash",
      leaseGeneration: 1,
      leaseExpiresAt: new Date(now.getTime() + 90_000),
      lastHeartbeatAt: now,
      cancelRequestedAt: null,
      cancellationReason: null,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    });

    const publicJob = publicExecutionJob(job) as Record<string, unknown>;
    expect(publicJob.id).toBe("job-1");
    expect(publicJob.leaseTokenHash).toBeUndefined();
    expect(publicJob.activeKey).toBeUndefined();
  });

  it("requires heartbeat and control polling to stay inside the lease", () => {
    process.env.AGENCY_RUNNER_HEARTBEAT_MS = "90000";
    resetEnvForTests();
    expect(() => env()).toThrow(/heartbeat/i);

    process.env.AGENCY_RUNNER_HEARTBEAT_MS = "20000";
    process.env.AGENCY_RUNNER_CONTROL_POLL_MS = "90000";
    resetEnvForTests();
    expect(() => env()).toThrow(/control polling/i);
  });
});
