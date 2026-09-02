import { NextResponse } from "next/server";
import { actionRepository } from "@/repositories/action-repository";
import { actionStatusSchema } from "@/schemas/actions";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "control:read");
    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status");
    const status = rawStatus ? actionStatusSchema.parse(rawStatus) : undefined;
    const actions = await actionRepository.list(50, status);
    return NextResponse.json({ actions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
