import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeLinearTaskSync } from "@/services/provisioning-service";

const bodySchema = z.object({ linearProjectActionId: z.string().min(1) });

/**
 * Linear task-sync proposal endpoint: creates an approval-gated action that
 * syncs Linear issues into project tasks once approved and executed.
 */

/** Propose a Linear task sync for a project. Requires `action:propose`; body must reference the Linear project action id. Returns 201. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const result = await proposeLinearTaskSync(id, body.linearProjectActionId, principal);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
