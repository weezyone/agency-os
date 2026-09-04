import { describe, expect, it } from "vitest";
import type { Task } from "@/schemas/domain";
import { qaResultSchema, workerOutputSchema } from "@/schemas/execution";
import { decideQaOutcome, evaluateTaskReadiness, normalizeQaResult, resolveAgentRole, resolveExecutionMode } from "@/services/execution-policy";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: "task-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    title: "Build dashboard",
    description: "Implement the operator dashboard",
    ownerRole: "Frontend Engineer",
    status: "backlog",
    priority: "high",
    estimateHours: 8,
    dependencies: [],
    acceptanceCriteria: ["Dashboard renders"],
    activeRunId: null,
    completedRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("execution orchestration", () => {
  it("routes free-form owner roles to a specialist", () => {
    expect(resolveAgentRole("Senior React / Next.js Engineer")).toBe("frontend");
    expect(resolveAgentRole("UX Researcher")).toBe("research");
    expect(resolveAgentRole("API and database engineer")).toBe("backend");
    expect(resolveAgentRole("Unclassified owner")).toBe("tech-lead");
  });

  it("uses controlled workspaces for implementation roles", () => {
    expect(resolveExecutionMode(task(), "frontend")).toBe("workspace");
    expect(resolveExecutionMode(task({ title: "Write architecture decision", description: "Document tradeoffs" }), "tech-lead")).toBe("artifact");
    expect(resolveExecutionMode(task({ title: "Implement repository contract" }), "tech-lead")).toBe("workspace");
    expect(resolveExecutionMode(task({ ownerRole: "UX Researcher" }), "research")).toBe("artifact");
  });

  it("requires both a pass verdict and the configured score", () => {
    const qa = qaResultSchema.parse({
      score: 89,
      verdict: "pass",
      summary: "Close but below the quality threshold.",
      criteria: [{ criterion: "Dashboard renders", passed: true, evidence: "The artifact includes the dashboard component." }],
      findings: [],
      revisionInstructions: ["Add missing evidence"],
    });

    const normalized = normalizeQaResult(qa, 90);
    expect(normalized.verdict).toBe("revise");
    expect(normalized.revisionInstructions[0]).toContain("at least 90");
    expect(decideQaOutcome({ qa: normalized, minQaScore: 90, currentAttempt: 1, maxAttempts: 3 })).toBe("revision_requested");
    expect(decideQaOutcome({ qa: normalized, minQaScore: 90, currentAttempt: 3, maxAttempts: 3 })).toBe("failed");
  });

  it("only releases tasks whose dependencies are complete", () => {
    const dependency = task({ id: "task-a", title: "Architecture", status: "done" });
    const ready = task({ id: "task-b", dependencies: ["Architecture"] });
    const blocked = task({ id: "task-c", dependencies: ["Missing task"] });

    expect(evaluateTaskReadiness(ready, [dependency, ready]).ready).toBe(true);
    expect(evaluateTaskReadiness(blocked, [dependency, blocked])).toEqual({
      ready: false,
      reasons: ["Dependency is unresolved: Missing task"],
    });
  });

  it("validates structured worker artifacts", () => {
    const output = workerOutputSchema.parse({
      summary: "Implemented the route contract.",
      artifacts: [{
        type: "code",
        title: "Route implementation",
        description: "TypeScript route handler",
        content: "export async function POST() {}",
      }],
      blockers: [],
      completionNotes: ["Add integration tests after credentials are available"],
      handoff: "QA should verify the error path.",
      confidence: 0.82,
    });

    expect(output.artifacts[0]?.path).toBeNull();
    expect(output.artifacts[0]?.url).toBeNull();
    expect(output.fileChanges).toEqual([]);
    expect(output.requestedValidationScripts).toEqual([]);
  });
});
