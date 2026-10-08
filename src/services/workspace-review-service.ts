import { artifactRepository } from "@/repositories/artifact-repository";
import { executionRepository } from "@/repositories/execution-repository";
import { projectRepository } from "@/repositories/project-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { proposeWorkspacePublishSchema } from "@/schemas/workspace";
import type { Principal } from "@/schemas/identity";
import { proposeAction } from "@/services/action-service";
import { workspaceFingerprint } from "@/services/workspace-service";

/**
 * Proposes a `github.publishWorkspace` action for a passed run's approved
 * workspace, pinning the immutable patch artifact id, its SHA-256 digest, and
 * the workspace's base/branch coordinates into the payload so the eventual
 * publish step can verify it reproduces exactly the reviewed change set. The
 * idempotency key embeds the workspace fingerprint and patch digest, so
 * re-proposal collapses unless the reviewed content actually changed.
 *
 * @param runId Execution run whose workspace should be published.
 * @param rawInput Raw overrides (title, body, draft), parsed against
 *   `proposeWorkspacePublishSchema`.
 * @param requestedBy Requesting principal or system actor id.
 * @returns The proposed action record.
 * @throws When the run, workspace, repository binding, or patch artifact is
 *   missing or not in an approved/passed state.
 */
export async function proposeWorkspacePublish(
  runId: string,
  rawInput: unknown = {},
  requestedBy: string | Principal = "operator-dashboard",
) {
  const input = proposeWorkspacePublishSchema.parse(rawInput);
  const run = await executionRepository.get(runId);
  if (!run) throw new Error("Execution run not found");
  if (run.status !== "passed" || !run.workspaceId) {
    throw new Error("Execution run must have a human-approved workspace before publishing can be proposed");
  }

  const [workspace, context] = await Promise.all([
    workspaceRepository.get(run.workspaceId),
    projectRepository.getTaskContext(run.taskId),
  ]);
  if (!workspace) throw new Error("Workspace not found");
  if (!context) throw new Error("Task or project context no longer exists");
  if (workspace.status !== "approved" || workspace.reviewStatus !== "approved") {
    throw new Error("Workspace must be human-approved before publishing can be proposed");
  }
  if (!workspace.baseSha) throw new Error("Workspace base commit is required before publishing");
  const repositoryFullName = workspace.repositoryFullName ?? context.project.repository?.fullName;
  const repositoryCloneUrl = context.project.repository?.cloneUrl ?? workspace.repositoryUrl;
  if (!repositoryFullName) throw new Error("GitHub repository full name is required before publishing");
  if (!repositoryCloneUrl) throw new Error("Repository clone URL is required before publishing");

  const patchArtifact = await artifactRepository.getKind(run.id, workspace.attemptId, "workspace_patch");
  if (!patchArtifact) throw new Error("Durable workspace patch artifact is required before publishing");

  const validationLines = workspace.validation
    ? [
        `Validation: ${workspace.validation.summary}`,
        `Executed scripts: ${workspace.validation.executedScripts.join(", ") || "none"}`,
        `Changed validator definitions: ${(workspace.validation.changedScripts ?? []).join(", ") || "none"}`,
      ]
    : ["Validation evidence was not recorded."];
  const defaultBody = [
    "## AgencyOS workspace",
    "",
    `Task: ${context.task.title}`,
    `Run: ${run.id}`,
    `Workspace: ${workspace.id}`,
    `Base: ${workspace.baseRef} @ ${workspace.baseSha}`,
    `Changes: ${workspace.changedFiles.length} file(s), +${workspace.additions}/-${workspace.deletions}`,
    `Patch SHA-256: ${patchArtifact.sha256}`,
    "",
    "### Acceptance criteria",
    ...context.task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "### Validation",
    ...validationLines.map((line) => `- ${line}`),
    "",
    "### QA",
    `- Score: ${run.lastQa?.score ?? "not recorded"}`,
    `- Summary: ${run.lastQa?.summary ?? "not recorded"}`,
    "",
    "This pull request was reconstructed from an immutable, human-approved AgencyOS patch artifact. Merge remains a human decision.",
  ].join("\n");

  return proposeAction(
    {
      kind: "github.publishWorkspace",
      payload: {
        projectId: run.projectId,
        runId: run.id,
        workspaceId: workspace.id,
        patchArtifactId: patchArtifact.id,
        patchSha256: patchArtifact.sha256,
        baseSha: workspace.baseSha,
        repositoryFullName,
        repositoryCloneUrl,
        baseBranch: workspace.baseRef,
        branchName: workspace.branchName,
        title: input.title ?? `AgencyOS: ${context.task.title}`,
        body: input.body ?? defaultBody,
        draft: input.draft,
      },
    },
    requestedBy,
    `workspace:${workspace.id}:publish:${workspaceFingerprint(workspace)}:${patchArtifact.sha256}`,
  );
}
