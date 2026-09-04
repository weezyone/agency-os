import { beforeAll, describe, expect, it } from "vitest";
import { workspaceFileChangeSchema, type WorkspaceRecord } from "@/schemas/workspace";
import {
  inferGitHubFullName,
  normalizeRepositoryCloneUrl,
  normalizeWorkspacePath,
  sanitizeBranchName,
  selectTrustedValidationScripts,
  validateFileChanges,
} from "@/services/workspace-policy";
import { publicWorkspace } from "@/services/workspace-public";

beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
});

describe("controlled workspace policy", () => {
  it("accepts repository-relative source paths", () => {
    expect(normalizeWorkspacePath("./src/app/page.tsx")).toBe("src/app/page.tsx");
  });

  it("rejects traversal, credentials, CI controls, and hook paths", () => {
    expect(() => normalizeWorkspacePath("../../etc/passwd")).toThrow();
    expect(() => normalizeWorkspacePath(".env.local")).toThrow();
    expect(() => normalizeWorkspacePath(".git/config")).toThrow();
    expect(() => normalizeWorkspacePath("keys/private.pem")).toThrow();
    expect(() => normalizeWorkspacePath(".github/workflows/deploy.yml")).toThrow();
    expect(() => normalizeWorkspacePath(".husky/pre-commit")).toThrow();
    expect(() => normalizeWorkspacePath("Jenkinsfile")).toThrow();
  });

  it("rejects duplicate writes and credential-like content", () => {
    expect(() => validateFileChanges([
      { operation: "create", path: "src/a.ts", content: "export const a = 1", rationale: "Add a" },
      { operation: "update", path: "src/a.ts", content: "export const a = 2", rationale: "Update a" },
    ])).toThrow(/duplicate/i);
    expect(() => validateFileChanges([
      { operation: "create", path: "src/config.ts", content: "const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456'", rationale: "Bad fixture" },
    ])).toThrow(/token/i);
  });

  it("requires content for create and update changes", () => {
    expect(() => workspaceFileChangeSchema.parse({
      operation: "update",
      path: "src/app.ts",
      content: null,
      rationale: "Implement requirement",
    })).toThrow();
  });

  it("normalizes branches and exact GitHub repository URLs", () => {
    expect(sanitizeBranchName("AgencyOS / Task #42")).toBe("agencyos/task-42");
    expect(inferGitHubFullName("https://github.com/pwdesign/agency-os.git")).toBe("pwdesign/agency-os");
    expect(inferGitHubFullName("https://github.com/pwdesign/agency-os/issues")).toBeNull();
    expect(normalizeRepositoryCloneUrl("https://github.com/pwdesign/agency-os/"))
      .toBe("https://github.com/pwdesign/agency-os.git");
    expect(() => normalizeRepositoryCloneUrl("https://github.com/pwdesign/agency-os/issues"))
      .toThrow(/exactly/i);
  });

  it("rejects validation scripts whose definitions changed in the worker patch", () => {
    const selection = selectTrustedValidationScripts({
      requested: ["test", "lint", "test"],
      allowed: ["test", "lint"],
      original: { test: "vitest run", lint: "eslint ." },
      current: { test: "node -e \"process.exit(0)\"", lint: "eslint ." },
    });

    expect(selection.requested).toEqual(["test", "lint"]);
    expect(selection.scripts).toEqual(["lint"]);
    expect(selection.skippedScripts).toEqual(["test"]);
    expect(selection.changedScripts).toEqual(["test"]);
  });

  it("omits server-local paths from public workspace records", () => {
    const now = new Date();
    const workspace: WorkspaceRecord = {
      id: "workspace-1",
      tenantId: "tenant-1",
      runId: "run-1",
      attemptId: "attempt-1",
      projectId: "project-1",
      taskId: "task-1",
      provider: "local-process",
      status: "review_required",
      repositoryUrl: "file:///private/repository",
      repositoryFullName: null,
      baseRef: "main",
      baseSha: "abc123",
      branchName: "agencyos/task-1",
      localPath: "/tmp/private/repository",
      patchPath: "/tmp/private/changes.patch",
      seededFromWorkspaceId: null,
      requestedChanges: [],
      appliedChanges: [],
      changedFiles: ["src/app.ts"],
      additions: 1,
      deletions: 0,
      diff: "diff --git a/src/app.ts b/src/app.ts",
      diffTruncated: false,
      validation: null,
      reviewStatus: "pending",
      reviewedBy: null,
      reviewReason: null,
      reviewedAt: null,
      publishedCommitSha: null,
      pullRequestUrl: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = publicWorkspace(workspace) as Record<string, unknown>;
    expect(result.localPath).toBeUndefined();
    expect(result.patchPath).toBeUndefined();
    expect(result.repositoryUrl).toBeUndefined();
  });
});
