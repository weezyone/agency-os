import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { issueApiKey, listApiKeys } from "@/services/identity-service";

/**
 * Admin API-key management for the caller's tenant. Keys are used for
 * automation/auth headless access; issuance returns the plaintext secret once.
 */

/** List issued API keys, optionally filtered by `?memberId=`. Requires `admin:keys`. */
export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:keys");
    const memberId = new URL(request.url).searchParams.get("memberId") ?? undefined;
    return NextResponse.json({ keys: await listApiKeys(memberId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

/** Issue a new API key for a tenant member. Requires `admin:keys`; returns 201 with the one-time secret. */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:keys");
    const result = await issueApiKey(await request.json(), principal);
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
