import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeLinearTaskSync } from "@/services/provisioning-service";

const bodySchema = z.object({ linearProjectActionId: z.string().min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const result = await proposeLinearTaskSync(id, body.linearProjectActionId, principal);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
