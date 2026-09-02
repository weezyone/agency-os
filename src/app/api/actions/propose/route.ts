import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { proposeAction } from "@/services/action-service";

const bodySchema = z.object({ action: z.unknown() });

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
