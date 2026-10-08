import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { requestRunCancellation } from "@/services/execution-job-service";
import { publicExecutionJob } from "@/services/execution-job-public";

const bodySchema = z.object({ reason: z.string().trim().min(1) });

/**
 * Run cancellation endpoint, scoped to the caller's tenant.
 */

/** Request cancellation of a run. Requires `run:cancel` and a non-empty reason; returns 202 while the active job is still leased/running, otherwise 200. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:cancel");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const result = await requestRunCancellation(id, principalActor(principal), body.reason);
    return NextResponse.json({ ...result, job: result.job ? publicExecutionJob(result.job) : null }, {
      status: result.job?.status === "running" || result.job?.status === "leased" ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
