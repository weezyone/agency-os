import { NextResponse } from "next/server";
import { intakeRequestSchema } from "@/schemas/intake";
import { runIntake } from "@/services/intake-service";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";

/**
 * Client-intake endpoint: kicks off the intake pipeline that turns a request
 * brief into a project for the caller's tenant.
 */

/** Run intake for a validated request body. Requires `project:write`; returns 201 with the intake result. */
export async function POST(request: Request) {
  try {
    await requirePrincipal(request, "project:write");
    const body = intakeRequestSchema.parse(await request.json());
    const result = await runIntake(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
