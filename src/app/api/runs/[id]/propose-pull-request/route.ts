import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeWorkspacePublish } from "@/services/workspace-review-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const { id } = await context.params;
    const action = await proposeWorkspacePublish(id, await request.json().catch(() => ({})), principal);
    return NextResponse.json({ action }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
