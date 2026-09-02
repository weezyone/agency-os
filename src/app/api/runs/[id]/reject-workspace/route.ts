import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { rejectWorkspaceRun } from "@/services/execution-service";

const bodySchema = z.object({ reason: z.string().trim().min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "workspace:review");
    const { id } = await context.params;
    const input = bodySchema.parse(await request.json());
    const detail = await rejectWorkspaceRun(id, principalActor(principal), input.reason);
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}
