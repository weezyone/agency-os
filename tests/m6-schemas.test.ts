import { describe, expect, it } from "vitest";
import { actionRecordSchema } from "@/schemas/actions";
import { runnerNodeSchema } from "@/schemas/execution-job";

const now = new Date();

describe("M6 control-plane contracts", () => {
  it("records named approvals and quorum requirements", () => {
    const action = actionRecordSchema.parse({
      id: "action-1",
      tenantId: "agency-default",
      correlationId: "correlation-1",
      kind: "github.createRepository",
      risk: "medium",
      status: "approved",
      payload: { projectId: "project-1" },
      idempotencyKey: "key-1",
      requestedBy: "user:operator-1",
      requestedByPrincipalId: "operator-1",
      requestedByDisplayName: "Operator",
      requiredApprovals: 1,
      policyDecision: {
        policyId: "policy-1",
        policyVersion: 1,
        policyChecksum: "a".repeat(64),
        matchedRuleId: null,
        denied: false,
        requiredApprovals: 1,
        requireSeparateApprover: true,
        approverRoles: ["reviewer", "admin", "owner"],
        executorRoles: ["operator", "admin", "owner"],
      },
      approvals: [{ principalId: "reviewer-1", displayName: "Reviewer", role: "reviewer", approvedAt: now }],
      approvedBy: "reviewer-1",
      rejectionReason: null,
      result: null,
      error: null,
      executionDeliveryId: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: now,
      executedAt: null,
    });

    expect(action.approvals[0]?.displayName).toBe("Reviewer");
  });

  it("advertises runner scheduling capabilities", () => {
    const runner = runnerNodeSchema.parse({
      id: "runner-1",
      hostname: "runner.example",
      pid: 42,
      version: "0.7.0",
      provider: "docker-isolated",
      region: "us-west",
      queues: ["workspace", "external-actions"],
      resourceClasses: ["standard"],
      labels: ["docker", "github"],
      maxConcurrency: 2,
      status: "online",
      activeJobIds: [],
      startedAt: now,
      lastSeenAt: now,
      stoppedAt: null,
    });

    expect(runner.queues).toContain("external-actions");
  });
});
