import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { executeAction } from "@/services/action-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:execute");
    const { id } = await context.params;
    const action = await executeAction(id, principal);
    return NextResponse.json({ action }, { status: action.status === "executing" ? 202 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
