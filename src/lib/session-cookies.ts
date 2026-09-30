import { env } from "@/lib/env";

/**
 * Cookie attributes for the server-side session token. `httpOnly` keeps the
 * token out of reach of injected scripts; `sameSite: lax` plus the CSRF
 * cookie/header pair covers cross-site mutation attempts.
 *
 * @param expiresAt - Absolute expiry mirrored from the server session record.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/**
 * Cookie attributes for the CSRF token. Deliberately not `httpOnly`: client
 * code must read the value and echo it in the `x-agency-csrf-token` header to
 * satisfy double-submit validation.
 *
 * @param expiresAt - Absolute expiry matching the owning session.
 */
export function csrfCookieOptions(expiresAt: Date) {
  return {
    httpOnly: false,
    secure: env().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** Returns the configured session cookie name and its derived CSRF cookie name. */
export function sessionCookieNames() {
  const session = env().AGENCY_SESSION_COOKIE_NAME;
  return { session, csrf: `${session}_csrf` };
}
