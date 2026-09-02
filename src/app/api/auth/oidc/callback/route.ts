import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { csrfCookieOptions, sessionCookieNames, sessionCookieOptions } from "@/lib/session-cookies";
import { completeOidcLogin } from "@/services/tenant-service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const result = await completeOidcLogin(request);
    const response = NextResponse.redirect(new URL(result.returnTo, request.url), { status: 302 });
    const names = sessionCookieNames();
    response.cookies.set(names.session, result.token, sessionCookieOptions(result.session.expiresAt));
    response.cookies.set(names.csrf, result.csrfToken, csrfCookieOptions(result.session.expiresAt));
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
