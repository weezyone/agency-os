import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { actionRepository } from "@/repositories/action-repository";

/**
 * Single-action read endpoint, scoped to the caller's tenant.
 */

/** Fetch an action together with its event history. Requires `control:read`; 404 when the action does not exist. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const result = await actionRepository.getWithEvents(id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
