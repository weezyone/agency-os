import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationRequiredError,
  authenticateRequest,
  permissionsForRole,
  requirePrincipal,
} from "@/lib/authorization";
import { resetEnvForTests } from "@/lib/env";

const originalEnv = { ...process.env };
const token = "bootstrap-owner-token-with-more-than-thirty-two-characters";

function baseEnv() {
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
  process.env.AGENCY_RUNNER_LEASE_MS = "90000";
  process.env.AGENCY_RUNNER_HEARTBEAT_MS = "20000";
  process.env.AGENCY_RUNNER_CONTROL_POLL_MS = "2000";
}

describe.sequential("identity-backed authorization", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    baseEnv();
    resetEnvForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it("keeps reviewer approval authority separate from operator execution authority", () => {
    expect(permissionsForRole("reviewer")).toContain("action:approve");
    expect(permissionsForRole("reviewer")).not.toContain("action:execute");
    expect(permissionsForRole("operator")).toContain("action:execute");
    expect(permissionsForRole("operator")).not.toContain("action:approve");
  });

  it("authenticates the bootstrap owner with exact token matching", async () => {
    process.env.AGENCY_AUTH_MODE = "bootstrap";
    process.env.AGENCY_BOOTSTRAP_OWNER_TOKEN = token;
    process.env.AGENCY_BOOTSTRAP_OWNER_NAME = "Paul";
    resetEnvForTests();

    const principal = await authenticateRequest(new Request("http://localhost/api/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(principal.role).toBe("owner");
    expect(principal.displayName).toBe("Paul");
    expect(principal.authMethod).toBe("bootstrap");
  });

  it("rejects missing credentials when bootstrap authentication is active", async () => {
    process.env.AGENCY_AUTH_MODE = "bootstrap";
    process.env.AGENCY_BOOTSTRAP_OWNER_TOKEN = token;
    resetEnvForTests();

    await expect(requirePrincipal(new Request("http://localhost/api/projects"), "control:read"))
      .rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});
