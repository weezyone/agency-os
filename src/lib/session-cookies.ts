import { env } from "@/lib/env";

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export function csrfCookieOptions(expiresAt: Date) {
  return {
    httpOnly: false,
    secure: env().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export function sessionCookieNames() {
  const session = env().AGENCY_SESSION_COOKIE_NAME;
  return { session, csrf: `${session}_csrf` };
}
