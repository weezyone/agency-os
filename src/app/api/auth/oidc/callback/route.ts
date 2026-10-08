import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { csrfCookieOptions, sessionCookieNames, sessionCookieOptions } from "@/lib/session-cookies";
import { completeOidcLogin } from "@/services/tenant-service";

export const runtime = "nodejs";

/**
 * OIDC redirect/callback handler (public — allowlisted in src/proxy.ts).
 * Exchanges the authorization code, creates the server-side session, then
 * sets the HttpOnly session cookie and the double-submit CSRF cookie.
 */

/** Complete the OIDC flow and redirect (302) to the post-login `returnTo` URL with session cookies set. */
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
