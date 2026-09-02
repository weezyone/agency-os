import { describe, expect, it } from "vitest";
import { defaultIdempotencyKey } from "@/services/action-service";
import { proposeActionSchema } from "@/schemas/actions";

describe("controlled actions", () => {
  it("accepts a private GitHub repository proposal", () => {
    const action = proposeActionSchema.parse({
      kind: "github.createRepository",
      payload: {
        name: "agency-client-acme",
        description: "Acme delivery repository",
        private: true,
        projectId: "project-1",
      },
    });
    expect(action.kind).toBe("github.createRepository");
  });

  it("rejects unsafe repository names", () => {
    expect(() =>
      proposeActionSchema.parse({
        kind: "github.createRepository",
        payload: {
          name: "bad repo name",
          description: "",
          private: true,
          projectId: "project-1",
        },
      }),
    ).toThrow();
  });

  it("generates a deterministic idempotency key", () => {
    const action = proposeActionSchema.parse({
      kind: "linear.createProject",
      payload: {
        name: "Acme redesign",
        description: "Website redesign",
        projectId: "project-1",
      },
    });
    expect(defaultIdempotencyKey(action)).toBe(defaultIdempotencyKey(action));
    expect(defaultIdempotencyKey(action)).toHaveLength(64);
  });

  it("validates a human-gated workspace publish proposal", () => {
    const action = proposeActionSchema.parse({
      kind: "github.publishWorkspace",
      payload: {
        projectId: "project-1",
        runId: "run-1",
        workspaceId: "workspace-1",
        patchArtifactId: "artifact-1",
        patchSha256: "a".repeat(64),
        baseSha: "abcdef1234567890",
        repositoryFullName: "pwdesign/agency-os",
        repositoryCloneUrl: "https://github.com/pwdesign/agency-os.git",
        baseBranch: "main",
        branchName: "agencyos/task-1",
        title: "AgencyOS: implement task",
        body: "Verified patch",
        draft: true,
      },
    });
    expect(action.kind).toBe("github.publishWorkspace");
  });
});
