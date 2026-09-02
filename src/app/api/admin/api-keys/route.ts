import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { issueApiKey, listApiKeys } from "@/services/identity-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:keys");
    const memberId = new URL(request.url).searchParams.get("memberId") ?? undefined;
    return NextResponse.json({ keys: await listApiKeys(memberId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:keys");
    const result = await issueApiKey(await request.json(), principal);
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
