import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { env } from "@/lib/env";
import { decryptTenantValue, encryptTenantValue } from "@/lib/secret-crypto";
import { withTenantContext } from "@/lib/tenant-context";
import { validateOidcIssuer } from "@/lib/oidc-policy";
import { principalActor } from "@/lib/authorization";
import { withMongoTransaction } from "@/lib/transactions";
import { identityRepository } from "@/repositories/identity-repository";
import { secretRepository } from "@/repositories/secret-repository";
import { tenantRepository } from "@/repositories/tenant-repository";
import {
  configureOidcConnectionSchema,
  createTenantInvitationSchema,
  createTenantSchema,
  updateTenantSchema,
} from "@/schemas/tenant";
import type { Principal } from "@/schemas/identity";
import { encryptedEnvelopeSchema } from "@/schemas/secrets";

function transientCiphertext(tenantId: string, name: string, value: string) {
  return JSON.stringify(encryptTenantValue(tenantId, name, value));
}

function openTransient(tenantId: string, name: string, value: string) {
  return decryptTenantValue(tenantId, name, encryptedEnvelopeSchema.parse(JSON.parse(value)));
}

function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function emailDomain(email: string) {
  return email.split("@").at(-1)?.toLowerCase() ?? "";
}

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? null;
}

/**
 * Creates a tenant, its owner membership, and the initial owner API key in a
 * single MongoDB transaction so a tenant can never exist without an owner who
 * can authenticate. The plaintext key token is returned exactly once; only
 * its hash is persisted.
 *
 * @param input Raw tenant payload, parsed against `createTenantSchema`.
 * @param principal Platform principal performing the provisioning.
 * @param owner Email and display name of the initial tenant owner.
 * @returns The tenant, owner membership, and the one-time initial API key.
 * @throws When the input fails schema validation or the transaction aborts.
 */
export async function createTenant(input: unknown, principal: Principal, owner: { email: string; displayName: string }) {
  const parsed = createTenantSchema.parse(input);
  const actor = principalActor(principal);
  return withMongoTransaction(async (session) => {
    const tenant = await tenantRepository.create(parsed, actor, session);
    const initialized = await withTenantContext(
      { tenantId: tenant.id, principalId: principal.memberId ?? principal.id, source: "request" },
      async () => {
        const membership = await identityRepository.createOwnerMember({
          tenantId: tenant.id,
          email: owner.email,
          displayName: owner.displayName,
          createdBy: actor,
        }, session);
        const issued = await identityRepository.createInitialTenantApiKey(membership, {
          name: "Initial tenant owner key",
          createdBy: actor,
        }, session);
        return { membership, issued };
      },
    );
    return {
      tenant,
      owner: initialized.membership,
      initialApiKey: {
        key: {
          id: initialized.issued.record.id,
          memberId: initialized.issued.record.memberId,
          name: initialized.issued.record.name,
          prefix: initialized.issued.record.prefix,
          createdAt: initialized.issued.record.createdAt,
          expiresAt: initialized.issued.record.expiresAt,
        },
        token: initialized.issued.token,
        warning: "This initial owner API key is shown once. Store it in a secure secret manager and rotate it after OIDC is configured.",
      },
    };
  });
}

/**
 * Updates mutable settings of the current tenant.
 *
 * @param input Raw update payload, parsed against `updateTenantSchema`.
 * @returns The updated tenant record.
 * @throws When the input fails schema validation.
 */
export async function updateCurrentTenant(input: unknown) {
  return tenantRepository.updateCurrent(updateTenantSchema.parse(input));
}

/**
 * Invites a new member to the current tenant by email. The response carries
 * the plaintext invitation token and a ready-to-share accept URL; only the
 * token hash is persisted.
 *
 * @param input Raw invitation payload, parsed against `createTenantInvitationSchema`.
 * @param principal Principal recorded as the inviter.
 * @returns The invitation (without its token hash), the accept URL, and the token.
 * @throws When the input is invalid or the email already belongs to a member.
 */
export async function inviteTenantMember(input: unknown, principal: Principal) {
  const invitationInput = createTenantInvitationSchema.parse(input);
  const existing = await identityRepository.getMemberByEmail(invitationInput.email);
  if (existing) throw new Error("This email is already a member of the tenant");
  const { invitation, token } = await tenantRepository.createInvitation(invitationInput, principalActor(principal));
  return {
    invitation: { ...invitation, tokenHash: undefined },
    acceptUrl: `${env().APP_URL}/auth/invite?token=${encodeURIComponent(token)}`,
    token,
  };
}

/**
 * Configures OIDC single sign-on for the current tenant. The issuer is
 * validated against SSRF/allowlist policy, and the client secret is stored in
 * the tenant secret vault — the connection record keeps only its reference id.
 *
 * @param input Raw connection payload, parsed against `configureOidcConnectionSchema`.
 * @param principal Principal recorded as the configurer.
 * @returns The updated tenant OIDC connection.
 * @throws When the input or issuer fails validation.
 */
export async function configureCurrentTenantOidc(input: unknown, principal: Principal) {
  const parsed = configureOidcConnectionSchema.parse(input);
  const issuer = validateOidcIssuer(parsed.issuer);
  const secretName = "oidc-client-secret";
  const secret = await secretRepository.upsert({
    name: secretName,
    purpose: "oidc_client_secret",
    value: parsed.clientSecret,
  }, principalActor(principal));
  return tenantRepository.configureOidc({
    issuer,
    clientId: parsed.clientId,
    clientSecretId: secret.id,
    scopes: parsed.scopes,
  }, principalActor(principal));
}

/**
 * Starts an OIDC authorization-code-with-PKCE login for a tenant. The PKCE
 * verifier and nonce are stored encrypted in a short-lived transaction record
 * — never in the browser — and an optional invitation token is bound to the
 * transaction so the callback can only accept that invitation.
 *
 * @param input Tenant slug, optional invitation token, and post-login return path.
 * @returns The provider redirect URL, tenant, and transaction expiry.
 * @throws When the tenant, invitation, or OIDC configuration is missing or invalid.
 */
export async function beginOidcLogin(input: {
  tenantSlug: string;
  invitationToken?: string | null;
  returnTo?: string | null;
}) {
  const tenant = await tenantRepository.getBySlug(input.tenantSlug);
  if (!tenant) throw new Error("Tenant not found or unavailable");
  const invitation = input.invitationToken
    ? await tenantRepository.verifyInvitation(input.invitationToken)
    : null;
  if (input.invitationToken && (!invitation || invitation.tenantId !== tenant.id)) {
    throw new Error("Invitation is invalid, expired, or belongs to another tenant");
  }
  const connection = await tenantRepository.getOidcForTenant(tenant.id);
  if (!connection) throw new Error("OIDC is not configured for this tenant");
  const issuer = validateOidcIssuer(connection.issuer);
  const clientSecret = await secretRepository.getValue(connection.clientSecretId, tenant.id);
  if (!clientSecret) throw new Error("OIDC client secret is unavailable");

  const config = await oidc.discovery(new URL(issuer), connection.clientId, clientSecret);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const redirectUri = `${env().APP_URL}/api/auth/oidc/callback`;
  const expiresAt = new Date(Date.now() + env().AGENCY_OIDC_TRANSACTION_TTL_MINUTES * 60 * 1_000);

  await tenantRepository.createOidcTransaction({
    tenantId: tenant.id,
    connectionId: connection.id,
    state,
    codeVerifierCiphertext: transientCiphertext(tenant.id, `oidc-code:${state}`, codeVerifier),
    nonceCiphertext: transientCiphertext(tenant.id, `oidc-nonce:${state}`, nonce),
    invitationId: invitation?.id ?? null,
    returnTo: safeReturnTo(input.returnTo),
    expiresAt,
  });

  const redirect = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: connection.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { redirect, tenant, expiresAt };
}

/**
 * Completes an OIDC login from the provider callback: consumes the stored
 * transaction exactly once, verifies state/nonce/PKCE against the token
 * response, enforces the tenant's email-domain allowlist and (when enabled)
 * verified-email requirement, and creates or refreshes the member from the
 * claims before issuing a browser session. Invited identities must match the
 * invitation's email, so an invitation cannot be claimed by a different person.
 *
 * @param request The incoming callback request from the OIDC provider.
 * @returns The new browser session, tenant, member, and sanitized return path.
 * @throws When the transaction, claims, invitation, or membership checks fail.
 */
export async function completeOidcLogin(request: Request) {
  const currentUrl = new URL(request.url);
  const state = currentUrl.searchParams.get("state");
  if (!state) throw new Error("OIDC callback is missing state");
  const transaction = await tenantRepository.consumeOidcTransaction(state);
  if (!transaction) throw new Error("OIDC transaction is invalid, expired, or already consumed");

  return withTenantContext(
    { tenantId: transaction.tenantId, principalId: null, source: "request" },
    async () => {
      const [tenant, connection] = await Promise.all([
        tenantRepository.getActiveById(transaction.tenantId),
        tenantRepository.getOidcForTenant(transaction.tenantId),
      ]);
      if (!tenant || !connection || connection.id !== transaction.connectionId) {
        throw new Error("OIDC tenant configuration changed during authentication");
      }
      const issuer = validateOidcIssuer(connection.issuer);
      const clientSecret = await secretRepository.getValue(connection.clientSecretId, transaction.tenantId);
      if (!clientSecret) throw new Error("OIDC client secret is unavailable");
      const config = await oidc.discovery(new URL(issuer), connection.clientId, clientSecret);
      const codeVerifier = openTransient(transaction.tenantId, `oidc-code:${state}`, transaction.codeVerifierCiphertext);
      const nonce = openTransient(transaction.tenantId, `oidc-nonce:${state}`, transaction.nonceCiphertext);
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error("OIDC provider did not return a subject claim");
      const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
      if (!email) throw new Error("OIDC provider did not return an email claim");
      if (env().AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL && claims.email_verified !== true) {
        throw new Error("OIDC provider did not return a verified email claim");
      }
      if (tenant.allowedEmailDomains.length && !tenant.allowedEmailDomains.includes(emailDomain(email))) {
        throw new Error("OIDC email domain is not allowed for this tenant");
      }

      let member = await identityRepository.getMemberByEmail(email, tenant.id);
      if (transaction.invitationId) {
        const invitations = await tenantRepository.listInvitations();
        const invitation = invitations.find((candidate) => candidate.id === transaction.invitationId);
        if (!invitation || invitation.email !== email || invitation.acceptedAt || invitation.revokedAt) {
          throw new Error("OIDC identity does not match the pending invitation");
        }
        member = await identityRepository.createOidcMember({
          tenantId: tenant.id,
          email,
          displayName: typeof claims.name === "string" ? claims.name : email,
          role: invitation.role,
          subject: claims.sub,
          createdBy: `invite:${invitation.id}`,
        });
        if (!member) throw new Error("Tenant membership could not be created");
        await tenantRepository.acceptInvitation(invitation.id, member.id);
      } else if (!member) {
        throw new Error("No tenant membership or invitation exists for this identity");
      } else {
        member = await identityRepository.createOidcMember({
          tenantId: tenant.id,
          email,
          displayName: typeof claims.name === "string" ? claims.name : member.displayName,
          role: member.role,
          subject: claims.sub,
          createdBy: member.createdBy,
        });
      }

      if (!member || member.status !== "active") throw new Error("Tenant membership is disabled");
      const session = await identityRepository.createBrowserSession(member, {
        userAgent: request.headers.get("user-agent"),
        ip: requestIp(request),
      });
      return { ...session, tenant, member, returnTo: safeReturnTo(transaction.returnTo) };
    },
  );
}

/**
 * Generates a fresh 256-bit tenant encryption key, base64-encoded for storage
 * in platform configuration.
 *
 * @returns A base64-encoded 32-byte random key.
 */
export function randomTenantEncryptionKey() {
  return randomBytes(32).toString("base64");
}
