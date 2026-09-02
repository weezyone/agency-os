import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { enqueueExecutionRun } from "@/services/execution-job-service";
import { publicExecutionJob } from "@/services/execution-job-public";

const bodySchema = z.object({
  priority: z.number().int().min(-100).max(100).default(0),
  maxDeliveries: z.number().int().min(1).max(20).optional(),
});

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:dispatch");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const result = await enqueueExecutionRun(id, { ...body, requestedBy: principalActor(principal) });
    return NextResponse.json({ ...result, job: publicExecutionJob(result.job) }, {
      status: result.job.status === "queued" ? 202 : 200,
      headers: {
        location: `/api/jobs/${result.job.id}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
