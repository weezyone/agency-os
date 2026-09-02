import { isIP } from "node:net";
import { env } from "@/lib/env";

function configuredHosts() {
  return new Set(
    env().AGENCY_OIDC_ALLOWED_ISSUER_HOSTS
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function obviouslyLocalHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 0;
  }
  if (version === 6) {
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

/**
 * Validates a tenant-configured OIDC discovery issuer before any network call.
 * Production requires HTTPS and an exact platform-owned hostname allowlist.
 * This is a control-plane guard; the deployment should still apply outbound
 * network policy and DNS protections to the web tier.
 */
export function validateOidcIssuer(value: string) {
  const config = env();
  const issuer = new URL(value);
  if (issuer.username || issuer.password) throw new Error("OIDC issuer URLs cannot contain credentials");
  if (issuer.search || issuer.hash) throw new Error("OIDC issuer URLs cannot contain a query string or fragment");
  if (issuer.protocol !== "https:") {
    if (config.NODE_ENV === "production" || !config.AGENCY_OIDC_ALLOW_INSECURE_HTTP) {
      throw new Error("OIDC issuer URLs must use HTTPS");
    }
  }
  if (obviouslyLocalHost(issuer.hostname) && !config.AGENCY_OIDC_ALLOW_PRIVATE_ISSUERS) {
    throw new Error("OIDC issuer host is local or private and is not allowed");
  }

  const allowed = configuredHosts();
  if (config.NODE_ENV === "production" && allowed.size === 0) {
    throw new Error("Production OIDC configuration requires AGENCY_OIDC_ALLOWED_ISSUER_HOSTS");
  }
  if (allowed.size > 0 && !allowed.has(issuer.hostname.toLowerCase())) {
    throw new Error(`OIDC issuer host ${issuer.hostname} is not in the platform allowlist`);
  }
  return issuer.toString();
}
