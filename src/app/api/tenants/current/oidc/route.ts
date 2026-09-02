import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { tenantRepository } from "@/repositories/tenant-repository";
import { configureCurrentTenantOidc } from "@/services/tenant-service";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:tenant");
    const connection = await tenantRepository.getOidcForTenant(principal.tenantId);
    return NextResponse.json({ connection });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:tenant");
    const connection = await configureCurrentTenantOidc(await request.json(), principal);
    return NextResponse.json({ connection });
  } catch (error) {
    return apiError(error);
  }
}
