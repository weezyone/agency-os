import { NextResponse } from "next/server";
import { z } from "zod";
import { PermissionDeniedError, requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { createTenant } from "@/services/tenant-service";

const bodySchema = z.object({
  tenant: z.unknown(),
  owner: z.object({ email: z.string().email(), displayName: z.string().trim().min(1).max(120) }),
});

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:tenant");
    if (!['bootstrap', 'disabled'].includes(principal.authMethod)) {
      throw new PermissionDeniedError("Tenant creation requires platform bootstrap authority");
    }
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await createTenant(body.tenant, principal, body.owner), {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
