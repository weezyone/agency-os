import { env } from "@/lib/env";
import { secretRepository } from "@/repositories/secret-repository";

/** Well-known secret names under which tenants store integration credentials. */
export const TENANT_INTEGRATION_SECRET_NAMES = {
  githubToken: "github-token",
  githubOrg: "github-org",
  linearToken: "linear-token",
  linearTeamId: "linear-team-id",
  linearAuthMode: "linear-auth-mode",
} as const;

/**
 * Resolves a tenant-scoped secret by name, falling back to the platform-wide
 * environment value only when global integration fallback is explicitly
 * enabled. Tenant isolation is the default: without the opt-in, one tenant
 * must never silently use the platform's credentials.
 *
 * @param name Secret name (see {@link TENANT_INTEGRATION_SECRET_NAMES}).
 * @param fallback Environment-provided global value used when allowed.
 * @returns The resolved secret value, or `null` when none is available.
 */
export async function tenantSecretOrFallback(name: string, fallback?: string) {
  const tenantValue = await secretRepository.getValueByName(name);
  if (tenantValue) return tenantValue;
  return env().AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK ? fallback ?? null : null;
}

/**
 * Resolves the GitHub token and organization for the current tenant.
 *
 * @returns The GitHub token and (possibly null) organization.
 * @throws When no GitHub token is configured for the tenant.
 */
export async function githubIntegrationConfig() {
  const config = env();
  const [token, org] = await Promise.all([
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubToken, config.GITHUB_TOKEN),
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubOrg, config.GITHUB_ORG),
  ]);
  if (!token) throw new Error("GitHub integration is not configured for this tenant");
  return { token, org };
}

/**
 * Resolves the Linear token, team id, and auth mode for the current tenant.
 *
 * @returns The Linear token, team id, and auth mode (`api_key` or `oauth`).
 * @throws When no Linear token is configured or the auth mode is unrecognized.
 */
export async function linearIntegrationConfig() {
  const config = env();
  const [token, teamId, authMode] = await Promise.all([
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.linearToken, config.LINEAR_API_KEY),
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.linearTeamId, config.LINEAR_TEAM_ID),
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.linearAuthMode, config.LINEAR_AUTH_MODE),
  ]);
  if (!token) throw new Error("Linear integration is not configured for this tenant");
  if (authMode !== "api_key" && authMode !== "oauth") throw new Error("Linear auth mode must be api_key or oauth");
  return { token, teamId, authMode };
}
