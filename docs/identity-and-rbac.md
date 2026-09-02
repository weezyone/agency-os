# Identity and RBAC

M6 replaces the single shared operator token with named members and revocable API keys.

## Authentication modes

### `disabled`

Local development only. Every request receives a synthetic owner principal named `Development Owner`.

### `bootstrap`

Requests authenticate with `AGENCY_BOOTSTRAP_OWNER_TOKEN` or the legacy `AGENCY_OPERATOR_TOKEN`. The principal has owner permissions and can create members and issue API keys.

### `database`

Requests authenticate through API keys stored in MongoDB. A configured bootstrap token is still accepted as break-glass access.

Production rejects `disabled` mode.

## Credential format and storage

Issued credentials use this form:

```text
aos_<credential-uuid>_<random-secret>
```

MongoDB stores:

- the credential ID;
- a display prefix;
- SHA-256 of the full token;
- member ownership;
- creation, expiry, last-use, and revocation timestamps.

The clear token is returned only once. API responses never return `tokenHash`.

## Roles

| Role | Permissions |
|---|---|
| owner | all permissions |
| admin | all operational and administration permissions |
| operator | read control plane, mutate projects, dispatch/cancel, propose/execute actions, read artifacts/metrics |
| reviewer | read control plane, review workspaces, approve actions, read artifacts/metrics |
| viewer | read control plane and artifacts |

The concrete permission matrix lives in `src/lib/authorization.ts`.

## Bootstrap procedure

1. Set `AGENCY_AUTH_MODE=bootstrap`.
2. Generate a minimum 32-character random token.
3. Start the web application.
4. Create at least one admin/operator and one reviewer.
5. Issue API keys.
6. Verify each key using `GET /api/auth/me`.
7. Set `AGENCY_AUTH_MODE=database`.
8. Retain the bootstrap token only as intentionally controlled break-glass access.

Create a member:

```bash
curl -sS http://localhost:3000/api/admin/members \
  -H "x-agency-api-key: $AGENCY_BOOTSTRAP_OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"reviewer@example.com","displayName":"Review Lead","role":"reviewer"}'
```

Issue a key:

```bash
curl -sS http://localhost:3000/api/admin/api-keys \
  -H "x-agency-api-key: $AGENCY_BOOTSTRAP_OWNER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"memberId":"<member-id>","name":"reviewer-laptop","expiresAt":null}'
```

Revoke a key:

```bash
curl -sS -X POST http://localhost:3000/api/admin/api-keys/<key-id>/revoke \
  -H "x-agency-api-key: $AGENCY_BOOTSTRAP_OWNER_TOKEN"
```

## Approval identity

Action proposals store:

- requester principal ID when available;
- immutable requester display name;
- action risk;
- approval quorum;
- each approver's principal ID, display name, role, and timestamp.

When `AGENCY_REQUIRE_SEPARATE_APPROVER=true`, a requester cannot approve the same external action. Duplicate approvals from one principal do not increase quorum.

High-risk actions use `AGENCY_HIGH_RISK_APPROVALS`. In M6, `github.publishWorkspace` is high risk.

Workspace review also enforces requester/reviewer separation when configured.

## Operator dashboard

The dashboard stores the provided API key in browser `sessionStorage`, not durable local storage. It resolves the principal through `GET /api/auth/me` and hides controls not granted by the principal's permission list.

This is an API-key operator console, not a complete browser identity product. M6 does not yet implement SSO, sessions, invites, password recovery, or MFA.

## Emergency and lifecycle rules

- Persisted owner records cannot be demoted or disabled through the ordinary member endpoint.
- API keys can expire or be revoked independently.
- Disabled members cannot authenticate even when a key itself is active.
- A key's `lastUsedAt` and its member's `lastAuthenticatedAt` update after successful authentication.
- Bootstrap tokens and API keys are bearer secrets and must be stored in a secret manager.
