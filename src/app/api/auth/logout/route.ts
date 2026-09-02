import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { sessionCookieNames } from "@/lib/session-cookies";
import { identityRepository } from "@/repositories/identity-repository";

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    if (principal.sessionId) await identityRepository.revokeBrowserSession(principal.sessionId);
    const response = NextResponse.json({ signedOut: true });
    const names = sessionCookieNames();
    response.cookies.delete(names.session);
    response.cookies.delete(names.csrf);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
