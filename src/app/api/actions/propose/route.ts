import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeAction } from "@/services/action-service";

const bodySchema = z.object({ action: z.unknown() });

/**
 * Action proposal endpoint. Creates a pending action for the caller's tenant;
 * the action must subsequently be approved before it can execute.
 */

/** Propose a new action. Requires `action:propose`; honors the `idempotency-key` header. Returns 201 with the created action. */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "action:propose");
    const body = bodySchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
    const action = await proposeAction(body.action, principal, idempotencyKey);
    return NextResponse.json({ action }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
