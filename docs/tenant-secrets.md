# Tenant secrets

## Storage model

Tenant integration credentials are encrypted with AES-256-GCM. The encryption key is supplied through `AGENCY_SECRET_ENCRYPTION_KEY`; it is not stored in MongoDB. Each envelope records a key ID, nonce, ciphertext, and authentication tag.

Associated data binds ciphertext to:

```text
agency-os:v1:<tenant-id>:<secret-name>
```

A ciphertext copied to another tenant or secret name fails authentication.

## Supported integration names

The runtime currently resolves these tenant secrets:

- `github-token`
- `github-org`
- `linear-token`
- `linear-team-id`
- `linear-auth-mode`
- `oidc-client-secret`

Deployment-wide environment variables are available only when `AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK=true`. Production configuration rejects that flag; production tenants must use the encrypted store.

## API behavior

Secret write responses return metadata only. List/read endpoints do not return plaintext. Revocation marks the record unavailable to integration resolution.

## Key rotation

M7 validates one active key ID. A safe rotation requires an explicit re-encryption process:

1. Pause writes and external-action runners.
2. Back up the database.
3. Decrypt each active envelope with the old key.
4. Re-encrypt with the new key and key ID.
5. Verify every integration through a non-mutating call.
6. Deploy the new key to web and all runners.
7. Resume execution.

Do not change `AGENCY_SECRET_KEY_ID` without re-encrypting stored values.

## Isolation boundary

The current implementation uses one platform-supplied encryption key with tenant/name-bound authenticated envelopes. This prevents ciphertext from being moved between tenant/name contexts, but it is not a distinct KMS key per tenant. Regulated deployments should use an external key-management design with per-tenant keys or separate data planes.
