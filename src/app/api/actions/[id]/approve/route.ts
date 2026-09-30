import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { approveAction } from "@/services/action-service";

/**
 * Action approval endpoint for the caller's tenant.
 */

/** Approve a pending action. Requires `action:approve`; 404 when the action does not exist. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:approve");
    const { id } = await context.params;
    const action = await approveAction(id, principal);
    if (!action) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ action });
  } catch (error) {
    return apiError(error);
  }
}
