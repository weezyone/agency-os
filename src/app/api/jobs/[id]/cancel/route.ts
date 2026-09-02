import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { requestRunCancellation } from "@/services/execution-job-service";
import { publicExecutionJob } from "@/services/execution-job-public";

const bodySchema = z.object({ reason: z.string().trim().min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:cancel");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const current = await executionJobRepository.get(id);
    if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const active = await executionJobRepository.getActiveForRun(current.runId);
    if (!active || active.id !== current.id) {
      throw new Error("Execution job cannot be cancelled because it is not the currently active delivery");
    }
    const result = await requestRunCancellation(current.runId, principalActor(principal), body.reason);
    const job = result.job ?? await executionJobRepository.get(id);
    if (!job) throw new Error("Execution job disappeared during cancellation");
    return NextResponse.json({ run: result.run, job: publicExecutionJob(job) }, {
      status: job.status === "leased" || job.status === "running" ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
