import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { retryAction } from "@/services/action-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const { id } = await context.params;
    const action = await retryAction(id, principal);
    return NextResponse.json({ action });
  } catch (error) {
    return apiError(error);
  }
}
