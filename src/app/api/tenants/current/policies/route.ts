import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { policyRepository } from "@/repositories/policy-repository";
import { createActionPolicy } from "@/services/policy-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:policies");
    return NextResponse.json({ policies: await policyRepository.list() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:policies");
    const policy = await createActionPolicy(await request.json(), principal);
    return NextResponse.json({ policy }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
