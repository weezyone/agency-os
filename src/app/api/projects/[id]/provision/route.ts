import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeProjectProvisioning } from "@/services/provisioning-service";

/**
 * Project provisioning endpoint: creates a provisioning proposal (an
 * approval-gated action) rather than provisioning directly.
 */

/** Propose provisioning for a project. Requires `action:propose`; returns 201 with the proposed action. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const { id } = await context.params;
    const result = await proposeProjectProvisioning(id, principal);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
