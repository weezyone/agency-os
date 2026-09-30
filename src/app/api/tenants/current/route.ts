import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { tenantRepository } from "@/repositories/tenant-repository";
import { updateCurrentTenant } from "@/services/tenant-service";

/**
 * Current-tenant endpoints: read or update the tenant of the authenticated caller.
 */

/** Get the caller's tenant. Requires `control:read`; 404 when the tenant record is missing. */
export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "control:read");
    const tenant = await tenantRepository.getCurrent();
    if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ tenant });
  } catch (error) {
    return apiError(error);
  }
}

/** Update the caller's tenant settings. Requires `admin:tenant`; 404 when the tenant record is missing. */
export async function PATCH(request: Request) {
  try {
    await requirePrincipal(request, "admin:tenant");
    const tenant = await updateCurrentTenant(await request.json());
    if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ tenant });
  } catch (error) {
    return apiError(error);
  }
}
