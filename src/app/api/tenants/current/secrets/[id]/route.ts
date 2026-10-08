import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { secretRepository } from "@/repositories/secret-repository";

/**
 * Tenant-secret revocation endpoint, scoped to the caller's tenant.
 */

/** Revoke (soft-delete) a tenant secret. Requires `admin:secrets`; 404 when the secret does not exist. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "admin:secrets");
    const { id } = await context.params;
    const secret = await secretRepository.revoke(id);
    if (!secret) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ secret });
  } catch (error) {
    return apiError(error);
  }
}
