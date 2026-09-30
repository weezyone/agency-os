import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { actionRepository } from "@/repositories/action-repository";

/**
 * Project action-activity feed, scoped to the caller's tenant.
 */

/** List action activity for a project. Requires `control:read`. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const result = await actionRepository.listProjectActivity(id);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
