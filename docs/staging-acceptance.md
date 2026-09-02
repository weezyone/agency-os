# Staging acceptance

## Required infrastructure

- Transaction-capable MongoDB
- S3-compatible evidence bucket
- OpenID Connect provider
- OTLP collector endpoint
- Signed remote sandbox service
- At least one artifact/event runner
- At least one workspace runner
- At least one external-action runner

## Tenant onboarding preflight

1. Create each tenant with platform bootstrap authority.
2. Capture the returned one-time `initialApiKey.token`; verify it is not present in subsequent reads.
3. Configure an issuer whose exact hostname appears in `AGENCY_OIDC_ALLOWED_ISSUER_HOSTS`.
4. Complete invitation-only login with a verified email claim.
5. Issue a replacement owner API key and revoke the initial credential.
6. Store GitHub and Linear credentials in the tenant secret store; keep global fallback disabled.

## Automated read-only gate

```bash
AGENCY_STAGING_BASE_URL=https://agency-os-staging.example.com \
AGENCY_STAGING_API_KEY_A=<tenant-a-viewer-or-higher-key> \
npm run staging:acceptance
```

For the cross-tenant denial probe, also set:

```bash
AGENCY_STAGING_API_KEY_B=<different-tenant-key>
AGENCY_STAGING_PROJECT_ID_A=<known-tenant-a-project-id>
```

The harness confirms that the second tenant receives `404` when requesting the first tenant's project by identifier.

## Manual launch gate

Complete these before public client use:

1. Sign in through OIDC using an invitation.
2. Confirm session logout and member disablement revoke access.
3. Create two tenants and verify projects, actions, usage, secrets, policies, and artifacts do not cross tenant boundaries.
4. Queue an artifact run and a workspace run.
5. Kill a runner mid-delivery and verify lease recovery without consuming an extra agent attempt.
6. Verify remote sandbox replay protection and patch-digest mismatch rejection.
7. Configure a high-risk publication policy and collect the required distinct approvals.
8. Publish a draft pull request from an approved immutable patch artifact.
9. Exercise Linear action idempotency.
10. Verify S3 digest checks, artifact retention, and denied unauthenticated downloads.
11. Confirm OTLP traces reach the collector and do not contain secrets or source text.
12. Run backup restore and tenant-secret recovery procedures.

## Failure rule

Do not weaken auth, tenant filters, policy quorum, sandbox integrity, or transactional requirements to make staging pass. Treat a failed gate as a release blocker.
