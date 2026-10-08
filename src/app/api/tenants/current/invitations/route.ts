import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { tenantRepository } from "@/repositories/tenant-repository";
import { inviteTenantMember } from "@/services/tenant-service";

/**
 * Invitation management for the caller's tenant. Invitations gate OIDC login:
 * new members must present a valid invitation token to complete sign-in.
 */

/** List pending/issued invitations. Requires `admin:members`. */
export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:members");
    return NextResponse.json({ invitations: await tenantRepository.listInvitations() });
  } catch (error) {
    return apiError(error);
  }
}

/** Invite a new member to the tenant. Requires `admin:members`; returns 201 with the invitation (including token). */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:members");
    const result = await inviteTenantMember(await request.json(), principal);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
