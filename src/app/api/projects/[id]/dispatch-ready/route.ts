import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { queueReadyTasks } from "@/services/execution-service";

/**
 * Dispatch endpoint that queues all ready tasks of a project for execution.
 */

/** Queue ready tasks for a project. Requires `run:dispatch`; returns 201 with the dispatch result. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "run:dispatch");
    const { id } = await context.params;
    const result = await queueReadyTasks(id, principalActor(principal));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
