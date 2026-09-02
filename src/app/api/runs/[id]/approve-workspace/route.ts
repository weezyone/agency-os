import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { approveWorkspaceRun } from "@/services/execution-service";

const bodySchema = z.object({ reason: z.string().trim().min(1).optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "workspace:review");
    const { id } = await context.params;
    const input = bodySchema.parse(await request.json().catch(() => ({})));
    const detail = await approveWorkspaceRun(id, principalActor(principal), input.reason);
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}
