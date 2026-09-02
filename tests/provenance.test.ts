import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/lib/env";
import { canonicalJson, createProvenanceAttestation } from "@/services/provenance-service";

const originalEnv = { ...process.env };

function baseEnv() {
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
  process.env.AGENCY_RUNNER_LEASE_MS = "90000";
  process.env.AGENCY_RUNNER_HEARTBEAT_MS = "20000";
  process.env.AGENCY_RUNNER_CONTROL_POLL_MS = "2000";
  process.env.AGENCY_PROVENANCE_HMAC_SECRET = "provenance-secret-with-at-least-thirty-two-characters";
  process.env.AGENCY_PROVENANCE_KEY_ID = "test-key";
}

describe.sequential("execution provenance", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    baseEnv();
    resetEnvForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it("canonicalizes object keys recursively", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 }))
      .toBe('{"a":0,"nested":{"a":1,"b":2},"z":1}');
  });

  it("emits an HMAC-attested statement tied to the runner and artifact digest", () => {
    const attestation = createProvenanceAttestation({
      runId: "run-1",
      attemptId: "attempt-1",
      projectId: "project-1",
      taskId: "task-1",
      runnerId: "runner-west-1",
      sandboxImage: "agency-os-sandbox:0.6.0",
      subjects: [{ name: "workspace.patch", sha256: "a".repeat(64), bytes: 42, kind: "workspace_patch" }],
    });

    expect(attestation?.signature.algorithm).toBe("hmac-sha256");
    expect(attestation?.signature.keyId).toBe("test-key");
    expect(attestation?.signature.value.length).toBeGreaterThan(32);
    expect(attestation?.statement.predicate.runnerId).toBe("runner-west-1");
  });
});
