import { NextResponse } from "next/server";
import { requirePrincipal, principalActor } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { secretRepository } from "@/repositories/secret-repository";
import { upsertTenantSecretSchema } from "@/schemas/secrets";

/**
 * Encrypted tenant-secret management for the caller's tenant. Stored values are
 * encrypted at rest; list/read responses contain metadata, not plaintext.
 */

/** List secret metadata for the tenant. Requires `admin:secrets`. */
export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:secrets");
    return NextResponse.json({ secrets: await secretRepository.list() });
  } catch (error) {
    return apiError(error);
  }
}

/** Create or rotate a tenant secret. Requires `admin:secrets`. */
export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:secrets");
    const input = upsertTenantSecretSchema.parse(await request.json());
    const secret = await secretRepository.upsert(input, principalActor(principal));
    return NextResponse.json({ secret });
  } catch (error) {
    return apiError(error);
  }
}
