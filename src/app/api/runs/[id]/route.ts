import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { getExecutionDetail } from "@/services/execution-service";
import { listRunArtifacts } from "@/services/artifact-service";
import { publicExecutionJob } from "@/services/execution-job-public";

/**
 * Run detail endpoint, scoped to the caller's tenant. Returns execution detail
 * plus sanitized jobs and run artifacts.
 */

/** Get a run's detail, jobs, and artifacts. Requires `control:read`; 404 when the run does not exist. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const [detail, jobActivity, artifacts] = await Promise.all([
      getExecutionDetail(id),
      executionJobRepository.listForRun(id),
      listRunArtifacts(id),
    ]);
    if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ...detail, ...jobActivity, jobs: jobActivity.jobs.map(publicExecutionJob), artifacts }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
