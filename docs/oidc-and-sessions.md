# OIDC and browser sessions

## Flow

M7 implements an invite-gated OpenID Connect Authorization Code flow with PKCE:

1. An administrator configures the tenant issuer, client ID, client secret, and scopes.
2. The OIDC client secret is stored in the encrypted tenant secret collection.
3. `/api/auth/oidc/start` resolves the tenant by slug and validates an optional invitation token.
4. AgencyOS creates PKCE verifier/challenge, state, and nonce values.
5. Only encrypted verifier and nonce values are persisted, with a short expiry.
6. The identity provider redirects to `/api/auth/oidc/callback`.
7. The callback consumes the one-time transaction, validates state, PKCE, nonce, issuer configuration, subject, email, email verification, allowed domain, and invitation membership.
8. AgencyOS creates a server-side browser session and returns an `HttpOnly` session cookie plus a readable CSRF cookie.


## Discovery and account-linking controls

Before any discovery request, AgencyOS validates the issuer URL. Production requires HTTPS, a verified-email claim, and an exact hostname match in `AGENCY_OIDC_ALLOWED_ISSUER_HOSTS`. URLs with credentials, query strings, fragments, obvious loopback/private IPs, or unapproved hosts are rejected. Treat this as an application guard and still enforce web-tier DNS and egress policy.

Membership linking checks both the normalized verified email and the provider subject. If those values resolve to different tenant memberships, login fails rather than merging identities. The tenant/subject index is partial so invitation records that do not yet have a subject remain valid.

## First-owner setup

Tenant creation returns a one-time initial owner API key. Use that key to configure the OIDC connection and invitation policy. After a successful browser login, issue a replacement key and revoke the initial credential.

## Invite-only membership

OIDC authentication does not create arbitrary tenant members. A new subject must present a valid, unexpired invitation whose normalized email exactly matches the verified identity email. Existing active members may sign in without a new invitation.

## Session storage

The browser receives a random opaque token. MongoDB stores only its SHA-256 hash. Sessions include tenant, member, expiry, last-seen time, revocation state, and optional hashed user-agent/IP signals.

## CSRF

Session-authenticated state-changing requests require:

- The CSRF cookie
- The matching `x-agency-csrf-token` header
- A successful comparison against the session's stored CSRF hash

API-key requests do not use cookie authentication and therefore do not require the browser CSRF token.

## Deployment checklist

- Register the exact callback URL: `<APP_URL>/api/auth/oidc/callback`.
- Use HTTPS in staging and production.
- Set `AGENCY_OIDC_ALLOWED_ISSUER_HOSTS` to the exact provider hostnames allowed for discovery.
- Keep `AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL=true` in production.
- Set the session cookie name once and do not rotate it casually.
- Keep OIDC transactions short-lived.
- Require `openid`, `email`, and `profile` scopes unless the provider maps equivalent claims.
- Restrict allowed email domains where appropriate.
- Revoke disabled members' active sessions.
- Keep the tenant secret encryption key outside the database.
