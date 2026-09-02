import { NextResponse } from "next/server";
import { requirePrincipal, principalActor } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { secretRepository } from "@/repositories/secret-repository";
import { upsertTenantSecretSchema } from "@/schemas/secrets";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:secrets");
    return NextResponse.json({ secrets: await secretRepository.list() });
  } catch (error) {
    return apiError(error);
  }
}

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
