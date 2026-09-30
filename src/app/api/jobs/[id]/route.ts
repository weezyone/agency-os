import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { publicExecutionJob } from "@/services/execution-job-public";

/**
 * Execution-job read endpoint, scoped to the caller's tenant. The job payload
 * is sanitized via publicExecutionJob before being returned.
 */

/** Get an execution job's detail. Requires `control:read`; 404 when the job does not exist. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const detail = await executionJobRepository.getDetail(id);
    if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ...detail, job: publicExecutionJob(detail.job) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
