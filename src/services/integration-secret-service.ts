import { env } from "@/lib/env";
import { secretRepository } from "@/repositories/secret-repository";

export const TENANT_INTEGRATION_SECRET_NAMES = {
  githubToken: "github-token",
  githubOrg: "github-org",
  linearToken: "linear-token",
  linearTeamId: "linear-team-id",
  linearAuthMode: "linear-auth-mode",
} as const;

export async function tenantSecretOrFallback(name: string, fallback?: string) {
  const tenantValue = await secretRepository.getValueByName(name);
  if (tenantValue) return tenantValue;
  return env().AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK ? fallback ?? null : null;
}

export async function githubIntegrationConfig() {
  const config = env();
  const [token, org] = await Promise.all([
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubToken, config.GITHUB_TOKEN),
    tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubOrg, config.GITHUB_ORG),
  ]);
  if (!token) throw new Error("GitHub integration is not configured for this tenant");
  return { token, org };
}

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
