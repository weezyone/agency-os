import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { policyRepository } from "@/repositories/policy-repository";

/**
 * Policy activation endpoint: makes a policy version the active one for the
 * caller's tenant.
 */

/** Activate a policy version. Requires `admin:policies`; 404 when the policy does not exist. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "admin:policies");
    const { id } = await context.params;
    const policy = await policyRepository.activate(id);
    if (!policy) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ policy });
  } catch (error) {
    return apiError(error);
  }
}
