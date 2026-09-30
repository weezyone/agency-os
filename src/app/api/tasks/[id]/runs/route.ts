import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { queueTaskRunSchema } from "@/schemas/execution";
import { queueTaskRun } from "@/services/execution-service";

/**
 * Task run creation endpoint: queues a new run for a task of the caller's tenant.
 */

/** Queue a run for a task. Requires `run:dispatch`; the actor is always taken from the authenticated principal, never the request body. Returns 201. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:dispatch");
    const { id } = await context.params;
    const body = queueTaskRunSchema.omit({ requestedBy: true }).parse(await request.json().catch(() => ({})));
    const run = await queueTaskRun(id, { ...body, requestedBy: principalActor(principal) });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
