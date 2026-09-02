import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { retryExecutionJob } from "@/services/execution-job-service";
import { publicExecutionJob } from "@/services/execution-job-public";

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
