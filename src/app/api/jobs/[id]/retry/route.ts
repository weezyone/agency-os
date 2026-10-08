import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { retryExecutionJob } from "@/services/execution-job-service";
import { publicExecutionJob } from "@/services/execution-job-public";

/**
 * Execution-job retry endpoint, scoped to the caller's tenant.
 */

/** Retry a failed execution job. Requires `run:dispatch`; returns 202 with a `location` header pointing at the new job. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:dispatch");
    const { id } = await context.params;
    const result = await retryExecutionJob(id, principalActor(principal));
    return NextResponse.json({ run: result.run, job: publicExecutionJob(result.job) }, {
      status: 202,
      headers: {
        location: `/api/jobs/${result.job.id}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
