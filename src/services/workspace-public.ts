import type { WorkspaceRecord } from "@/schemas/workspace";

/** Workspace record with host-local paths and the raw clone URL removed. */
export type PublicWorkspaceRecord = Omit<WorkspaceRecord, "localPath" | "patchPath" | "repositoryUrl">;

/**
 * Strips host-infrastructure details (local checkout path, patch file path,
 * raw clone URL) from a workspace record before it leaves the control plane.
 *
 * @param workspace The stored workspace record.
 * @returns The tenant-safe workspace view.
 */
export function publicWorkspace(workspace: WorkspaceRecord): PublicWorkspaceRecord {
  const { localPath: _localPath, patchPath: _patchPath, repositoryUrl: _repositoryUrl, ...safe } = workspace;
  return safe;
}

/**
 * Applies {@link publicWorkspace} to the workspace embedded in a detail
 * aggregate, leaving the rest of the aggregate untouched.
 *
 * @param detail Aggregate containing a `workspace` record.
 * @returns The aggregate with a tenant-safe workspace view.
 */
export function publicWorkspaceDetail<T extends { workspace: WorkspaceRecord }>(detail: T) {
  return { ...detail, workspace: publicWorkspace(detail.workspace) };
}
