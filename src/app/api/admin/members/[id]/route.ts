import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { updateMember } from "@/services/identity-service";

/**
 * Admin member update endpoint, scoped to the caller's tenant.
 */

/** Update a tenant member (e.g. role or status). Requires `admin:members`. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "admin:members");
    const { id } = await context.params;
    const member = await updateMember(id, await request.json());
    return NextResponse.json({ member });
  } catch (error) {
    return apiError(error);
  }
}
