import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { executionRepository } from "@/repositories/execution-repository";
import { artifactRepository } from "@/repositories/artifact-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { publicWorkspace } from "@/services/workspace-public";
import { publicExecutionJob } from "@/services/execution-job-public";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const [activity, workspaceActivity, jobActivity] = await Promise.all([
      executionRepository.listProjectActivity(id),
      workspaceRepository.listProject(id),
      executionJobRepository.listProject(id),
    ]);
    const artifacts = (await Promise.all(activity.runs.map((run) => artifactRepository.listRun(run.id)))).flat();
    return NextResponse.json({
      ...activity,
      ...workspaceActivity,
      ...jobActivity,
      jobs: jobActivity.jobs.map(publicExecutionJob),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        projectId: artifact.projectId,
        taskId: artifact.taskId,
        runId: artifact.runId,
        attemptId: artifact.attemptId,
        workspaceId: artifact.workspaceId,
        kind: artifact.kind,
        contentType: artifact.contentType,
        filename: artifact.filename,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
        downloadUrl: `/api/artifacts/${artifact.id}`,
      })),
      workspaces: workspaceActivity.workspaces.map(publicWorkspace),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
