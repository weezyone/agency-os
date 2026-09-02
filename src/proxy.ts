import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_API_PREFIXES = [
  "/api/auth/oidc/start",
  "/api/auth/oidc/callback",
];

/**
 * Optimistic gate only. Every sensitive route still performs a database-backed
 * tenant and permission check through requirePrincipal(). Proxy avoids obvious
 * anonymous traffic without pretending to be the authorization boundary.
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health" && request.nextUrl.searchParams.get("deep") !== "1") {
    return NextResponse.next();
  }
  if (PUBLIC_API_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const authMode = process.env.AGENCY_AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "bootstrap" : "disabled");
  if (authMode === "disabled") return NextResponse.next();

  const sessionCookie = process.env.AGENCY_SESSION_COOKIE_NAME || "agency_session";
  const present = Boolean(
    request.headers.get("x-agency-api-key")
      ?? request.headers.get("x-agency-operator-token")
      ?? request.headers.get("authorization")
      ?? request.cookies.get(sessionCookie)?.value,
  );
  if (present) return NextResponse.next();

  return NextResponse.json(
    { error: "unauthorized", message: "Authentication required" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export const config = {
  matcher: "/api/:path*",
};
