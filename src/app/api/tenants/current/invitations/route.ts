import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { tenantRepository } from "@/repositories/tenant-repository";
import { inviteTenantMember } from "@/services/tenant-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:members");
    return NextResponse.json({ invitations: await tenantRepository.listInvitations() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:members");
    const result = await inviteTenantMember(await request.json(), principal);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
