import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { enterTenantContext } from "@/lib/tenant-context";
import { identityRepository } from "@/repositories/identity-repository";
import { tenantRepository } from "@/repositories/tenant-repository";
import type { MemberRole, Permission, Principal } from "@/schemas/identity";

export class AuthenticationRequiredError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = "Permission denied") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class CsrfValidationError extends Error {
  constructor(message = "CSRF validation failed") {
    super(message);
    this.name = "CsrfValidationError";
  }
}

const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  owner: [
    "control:read", "project:write", "run:dispatch", "run:cancel", "workspace:review",
    "action:propose", "action:approve", "action:execute", "artifact:read", "metrics:read", "usage:read",
    "admin:members", "admin:keys", "admin:tenant", "admin:secrets", "admin:policies", "admin:pricing",
  ],
  admin: [
    "control:read", "project:write", "run:dispatch", "run:cancel", "workspace:review",
    "action:propose", "action:approve", "action:execute", "artifact:read", "metrics:read", "usage:read",
    "admin:members", "admin:keys", "admin:tenant", "admin:secrets", "admin:policies", "admin:pricing",
  ],
  operator: [
    "control:read", "project:write", "run:dispatch", "run:cancel", "action:propose",
    "action:execute", "artifact:read", "metrics:read", "usage:read",
  ],
  reviewer: ["control:read", "workspace:review", "action:approve", "artifact:read", "metrics:read", "usage:read"],
  viewer: ["control:read", "artifact:read"],
};

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantEqual(left: string, right: string) {
  return timingSafeEqual(digest(left), digest(right));
}

function parseCookies(request: Request) {
  return Object.fromEntries(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function apiTokenFromRequest(request: Request) {
  const explicit = request.headers.get("x-agency-api-key")?.trim()
    ?? request.headers.get("x-agency-operator-token")?.trim();
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

function sessionTokenFromRequest(request: Request) {
  return parseCookies(request)[env().AGENCY_SESSION_COOKIE_NAME] ?? null;
}

function activatePrincipal(principal: Principal) {
  enterTenantContext({
    tenantId: principal.tenantId,
    principalId: principal.memberId ?? principal.id,
    source: "request",
  });
  return principal;
}

async function assertTenantActive(tenantId: string) {
  const tenant = await tenantRepository.getActiveById(tenantId);
  if (!tenant) throw new AuthenticationRequiredError("Tenant is suspended or unavailable");
}

export function permissionsForRole(role: MemberRole) {
  return [...ROLE_PERMISSIONS[role]];
}

export function principalActor(principal: Principal) {
  return principal.memberId
    ? `tenant:${principal.tenantId}:user:${principal.memberId}`
    : `tenant:${principal.tenantId}:bootstrap:${principal.id}`;
}

export function publicPrincipal(principal: Principal) {
  return {
    id: principal.id,
    tenantId: principal.tenantId,
    memberId: principal.memberId,
    email: principal.email,
    displayName: principal.displayName,
    role: principal.role,
    permissions: principal.permissions,
    authMethod: principal.authMethod,
  };
}

export async function authenticateRequest(request: Request): Promise<Principal> {
  const config = env();
  if (config.AGENCY_AUTH_MODE === "disabled") {
    await tenantRepository.ensureBootstrapTenant();
    return activatePrincipal({
      id: "development-owner",
      tenantId: config.AGENCY_TENANT_ID,
      memberId: null,
      email: null,
      displayName: "Development Owner",
      role: "owner",
      permissions: permissionsForRole("owner"),
      authMethod: "disabled",
      keyId: null,
      sessionId: null,
    });
  }

  const apiToken = apiTokenFromRequest(request);
  if (apiToken) {
    const bootstrapToken = config.AGENCY_BOOTSTRAP_OWNER_TOKEN ?? config.AGENCY_OPERATOR_TOKEN;
    if (bootstrapToken && bootstrapToken.length >= 32 && constantEqual(apiToken, bootstrapToken)) {
      await tenantRepository.ensureBootstrapTenant();
      return activatePrincipal({
        id: "bootstrap-owner",
        tenantId: config.AGENCY_TENANT_ID,
        memberId: null,
        email: config.AGENCY_BOOTSTRAP_OWNER_EMAIL ?? null,
        displayName: config.AGENCY_BOOTSTRAP_OWNER_NAME,
        role: "owner",
        permissions: permissionsForRole("owner"),
        authMethod: "bootstrap",
        keyId: null,
        sessionId: null,
      });
    }

    const authenticated = await identityRepository.authenticateApiKey(apiToken);
    if (!authenticated) throw new AuthenticationRequiredError("Invalid, expired, or revoked API key");
    await assertTenantActive(authenticated.member.tenantId);
    return activatePrincipal({
      id: authenticated.member.id,
      tenantId: authenticated.member.tenantId,
      memberId: authenticated.member.id,
      email: authenticated.member.email,
      displayName: authenticated.member.displayName,
      role: authenticated.member.role,
      permissions: permissionsForRole(authenticated.member.role),
      authMethod: "api_key",
      keyId: authenticated.key.id,
      sessionId: null,
    });
  }

  const sessionToken = sessionTokenFromRequest(request);
  if (sessionToken) {
    const authenticated = await identityRepository.authenticateBrowserSession(sessionToken);
    if (!authenticated) throw new AuthenticationRequiredError("Invalid, expired, or revoked browser session");
    await assertTenantActive(authenticated.member.tenantId);
    return activatePrincipal({
      id: authenticated.member.id,
      tenantId: authenticated.member.tenantId,
      memberId: authenticated.member.id,
      email: authenticated.member.email,
      displayName: authenticated.member.displayName,
      role: authenticated.member.role,
      permissions: permissionsForRole(authenticated.member.role),
      authMethod: "session",
      keyId: null,
      sessionId: authenticated.session.id,
    });
  }

  throw new AuthenticationRequiredError();
}

async function assertCsrf(request: Request, principal: Principal) {
  if (principal.authMethod !== "session" || !principal.sessionId) return;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const cookies = parseCookies(request);
  const cookieToken = cookies[`${env().AGENCY_SESSION_COOKIE_NAME}_csrf`];
  const headerToken = request.headers.get("x-agency-csrf-token")?.trim();
  if (!cookieToken || !headerToken || !constantEqual(cookieToken, headerToken)) {
    throw new CsrfValidationError();
  }
  if (!await identityRepository.verifyCsrf(principal.sessionId, headerToken)) {
    throw new CsrfValidationError();
  }
}

export async function requirePrincipal(request: Request, permission?: Permission) {
  const principal = await authenticateRequest(request);
  await assertCsrf(request, principal);
  if (permission && !principal.permissions.includes(permission)) {
    throw new PermissionDeniedError(`Role ${principal.role} lacks ${permission}`);
  }
  return principal;
}
