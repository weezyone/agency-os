import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { beginOidcLogin } from "@/services/tenant-service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const tenantSlug = url.searchParams.get("tenant")?.trim();
    if (!tenantSlug) return NextResponse.json({ error: "validation_error", message: "tenant is required" }, { status: 400 });
    const result = await beginOidcLogin({
      tenantSlug,
      invitationToken: url.searchParams.get("invitation"),
      returnTo: url.searchParams.get("returnTo"),
    });
    return NextResponse.redirect(result.redirect, { status: 302 });
  } catch (error) {
    return apiError(error);
  }
}
