import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { queueTaskRunSchema } from "@/schemas/execution";
import { queueTaskRun } from "@/services/execution-service";

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
