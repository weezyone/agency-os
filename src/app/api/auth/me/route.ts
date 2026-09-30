import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { publicPrincipal, requirePrincipal } from "@/lib/authorization";

/**
 * Returns the authenticated principal (sanitized) for the current request.
 */

/** Get the caller's principal. Requires `control:read`. */
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request, "control:read");
    return NextResponse.json({ principal: publicPrincipal(principal) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
