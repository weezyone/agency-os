import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { publicWorkspaceDetail } from "@/services/workspace-public";

/**
 * Workspace detail endpoint, scoped to the caller's tenant; the response is
 * sanitized via publicWorkspaceDetail.
 */

/** Get a workspace's detail. Requires `control:read`; 404 when the workspace does not exist. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const detail = await workspaceRepository.getDetail(id);
    if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(publicWorkspaceDetail(detail), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
