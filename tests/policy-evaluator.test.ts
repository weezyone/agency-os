import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_POLICY, evaluateActionPolicy } from "@/services/policy-service";

describe("tenant action policy evaluation", () => {
  it("requires two approvals for high-risk publication", () => {
    const decision = evaluateActionPolicy({
      policyId: "policy-1",
      policyVersion: 3,
      document: DEFAULT_ACTION_POLICY,
      actionKind: "github.publishWorkspace",
      risk: "high",
      requesterRole: "operator",
    });

    expect(decision.matchedRuleId).toBe("high-risk-two-person");
    expect(decision.requiredApprovals).toBe(2);
    expect(decision.requireSeparateApprover).toBe(true);
    expect(decision.executorRoles).toContain("operator");
  });

  it("denies external mutations requested by viewers", () => {
    const decision = evaluateActionPolicy({
      policyId: "policy-1",
      policyVersion: 3,
      document: DEFAULT_ACTION_POLICY,
      actionKind: "github.publishWorkspace",
      risk: "high",
      requesterRole: "viewer",
    });

    expect(decision.matchedRuleId).toBe("viewer-cannot-request");
    expect(decision.denied).toBe(true);
  });
});
