import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { rejectAction } from "@/services/action-service";

const bodySchema = z.object({ reason: z.string().trim().min(1) });

/**
 * Action rejection endpoint for the caller's tenant.
 */

/** Reject a pending action with a mandatory reason. Requires `action:approve` (reviewer authority). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "action:approve");
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const action = await rejectAction(id, principal, body.reason);
    return NextResponse.json({ action });
  } catch (error) {
    return apiError(error);
  }
}
