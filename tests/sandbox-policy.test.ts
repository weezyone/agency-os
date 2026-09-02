import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/lib/env";
import { buildDockerRunArguments } from "@/workspaces/docker-isolated-provider";
import type { CommandRequest } from "@/workspaces/contracts";

const originalEnv = { ...process.env };
const workspaceRoot = "/tmp/agency-os/workspaces";

function setSandboxEnv() {
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "must-not-enter-sandbox";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
  process.env.AGENCY_WORKSPACE_PROVIDER = "docker-isolated";
  process.env.AGENCY_WORKSPACE_ROOT = workspaceRoot;
  process.env.AGENCY_SANDBOX_HOST_WORKSPACE_ROOT = "/srv/agency-os/workspaces";
  process.env.AGENCY_SANDBOX_NETWORK = "none";
  process.env.AGENCY_SANDBOX_READ_ONLY = "true";
  process.env.AGENCY_SANDBOX_DROP_CAPABILITIES = "true";
  process.env.AGENCY_SANDBOX_NO_NEW_PRIVILEGES = "true";
  process.env.AGENCY_RUNNER_LEASE_MS = "90000";
  process.env.AGENCY_RUNNER_HEARTBEAT_MS = "20000";
  process.env.AGENCY_RUNNER_CONTROL_POLL_MS = "2000";
}

function command(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    label: "Validate: test",
    executable: "npm",
    args: ["run", "test"],
    cwd: `${workspaceRoot}/project-1/run-1/repo`,
    mountRoot: `${workspaceRoot}/project-1/run-1/repo`,
    timeoutMs: 180_000,
    outputLimitBytes: 262_144,
    isolation: "sandbox",
    scopeId: "workspace-1",
    ...overrides,
  };
}

describe.sequential("Docker sandbox policy", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    setSandboxEnv();
    resetEnvForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it("builds a deny-by-default, quota-bound container invocation", () => {
    const { args, mounted, limits } = buildDockerRunArguments(command(), "agencyos-test", 2_000_000_000);
    const joined = args.join(" ");

    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(joined).toContain("--network none");
    expect(joined).toContain("--ipc none");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges=true");
    expect(joined).toContain("--memory 1024m");
    expect(joined).toContain("--pids-limit 128");
    expect(joined).not.toContain("must-not-enter-sandbox");
    expect(mounted.source).toBe("/srv/agency-os/workspaces/project-1/run-1/repo");
    expect(mounted.gitSource).toBe("/srv/agency-os/workspaces/project-1/run-1/repo/.git");
    expect(joined).toContain("dst=/workspace/.git,readonly");
    expect(joined).toContain("/home/runner:rw,nosuid,nodev,noexec,size=64m,mode=1777");
    expect(limits.networkMode).toBe("none");
  });

  it("rejects shell access and mount roots outside the workspace boundary", () => {
    expect(() => buildDockerRunArguments(command({ executable: "bash" }), "agencyos-test", 2_000_000_000))
      .toThrow(/not allowed/i);
    expect(() => buildDockerRunArguments(command({ mountRoot: "/etc" }), "agencyos-test", 2_000_000_000))
      .toThrow(/escapes/i);
  });
});
