import type { WorkspaceRecord } from "@/schemas/workspace";

export type PublicWorkspaceRecord = Omit<WorkspaceRecord, "localPath" | "patchPath" | "repositoryUrl">;

export function publicWorkspace(workspace: WorkspaceRecord): PublicWorkspaceRecord {
  const { localPath: _localPath, patchPath: _patchPath, repositoryUrl: _repositoryUrl, ...safe } = workspace;
  return safe;
}

export function publicWorkspaceDetail<T extends { workspace: WorkspaceRecord }>(detail: T) {
  return { ...detail, workspace: publicWorkspace(detail.workspace) };
}
