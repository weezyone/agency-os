# AgencyOS

Project-manager-first operating system for an agentic design and development agency.

AgencyOS turns client intake into typed project plans, dispatches bounded specialist work, validates repository changes through an isolated execution provider, requires independent QA and human review, and places consequential writes behind tenant-owned policy and named approvals.

## Current milestone: M7 tenant-ready launch plane

M7 upgrades the M6 distributed control plane into a launchable **multi-tenant staging architecture**:

- Tenant identity is included in domain records, queue deliveries, audit events, workspaces, artifacts, usage, and Mastra memory keys.
- User-facing repository reads and writes are bound to an `AsyncLocalStorage` tenant context.
- Browser authentication uses invite-gated OIDC Authorization Code + PKCE, server-side sessions, `HttpOnly` cookies, and double-submit CSRF verification.
- API-key authentication remains available for automation and staging acceptance.
- GitHub, Linear, OIDC, and other integration credentials use tenant-bound AES-256-GCM envelopes with associated-data binding under the platform encryption key.
- Approval rules are versioned policy documents. Every action stores an immutable policy decision snapshot.
- Repository validation can execute through a signed remote-sandbox contract, removing Docker-socket access from production AgencyOS runners.
- Provider token usage is persisted per tenant. Cost is estimated only from an explicitly configured tenant price catalog.
- OpenTelemetry traces can be exported through OTLP.
- Compose, Kubernetes staging manifests, queue-specific runner pools, and a tenant-isolation acceptance harness are included.

M7 provides application-level tenant isolation. It is suitable for controlled staging and an initial agency launch after the documented dependency-backed and live-infrastructure gates pass. It is **not yet a claim of formal compliance certification or adversarially verified SaaS isolation**.

## Architecture

```text
OIDC user / API-key automation
             |
             v
   Next.js tenant control plane
             |
    authenticated tenant context
     /          |           \
    v           v            v
projects    policy engine   encrypted secrets
    |           |            |
    v           v            +--> GitHub / Linear credentials
execution   approval snapshot
  queue          |
    |            v
    +------> transactional outbox
    |
compatible runner pool
    |
    +--> artifact worker
    +--> signed remote sandbox workspace
    +--> approved external action
    |
independent QA + named human review
    |
S3-compatible immutable evidence
    |
usage ledger + OTLP traces
```

## Non-negotiable control boundaries

1. A worker cannot approve its own result.
2. QA passing does not publish repository changes.
3. The requester cannot satisfy a separate-approver requirement.
4. High-risk actions can require multiple distinct authorized approvers.
5. Existing action proposals retain the policy version and decision used when they were created.
6. Browser request identity, tenant identity, and CSRF verification are established server-side.
7. Tenant secrets are never returned in plaintext after creation.
8. Model-proposed shell strings are not executed. Validation is restricted to pre-existing allowlisted package scripts.
9. Remote sandbox responses must match the approved workspace patch digest.
10. Production runners do not require a Docker socket when `remote-http` is selected.
11. Provider cost is not guessed from a hard-coded public price table.
12. External writes execute from the transactional outbox, not directly from the browser request.

## Repository layout

```text
src/
  app/                  Next.js UI and API routes
  artifacts/            Filesystem and S3 evidence providers
  integrations/         GitHub and Linear adapters
  lib/                  Auth, tenant context, crypto, environment, MongoDB
  mastra/               PM, intake, planning, worker, QA agents and tools
  observability/        OpenTelemetry initialization and span helpers
  repositories/         Tenant-scoped persistence and lease fencing
  runner/               Distributed execution/outbox worker
  schemas/              Zod contracts for persistence and API boundaries
  services/             Orchestration, policy, usage, review, publication
  workspaces/            Local, Docker, and signed remote providers

deploy/k8s/staging/     Staging Kubernetes reference manifests
scripts/                Release validation and staging acceptance
docs/                   Architecture, security, and operations notes
```

## Local development

Requirements:

- Node.js 22+
- MongoDB
- An OpenAI API key
- Docker only when using `docker-isolated`

```bash
cp .env.example .env.local
npm install --no-audit --no-fund
npm run validate:release
npm run check
```

Use this trusted local configuration:

```env
NODE_ENV=development
AGENCY_AUTH_MODE=disabled
AGENCY_TRANSACTIONS_REQUIRED=false
AGENCY_ARTIFACT_PROVIDER=filesystem
AGENCY_WORKSPACE_PROVIDER=local-process
AGENCY_WORKSPACE_ALLOW_LOCAL_REPOS=true
```

Start the web control plane:

```bash
npm run dev
```

Start a runner in another terminal:

```bash
npm run runner
```

Open `http://localhost:3000`.

## Tenant bootstrap

Generate the bootstrap, encryption, sandbox-signing, and provenance secrets:

```bash
openssl rand -base64 48
openssl rand -base64 32
openssl rand -base64 48
openssl rand -base64 48
```

Start with:

```env
AGENCY_AUTH_MODE=bootstrap
AGENCY_BOOTSTRAP_OWNER_TOKEN=<48-byte-random-secret>
AGENCY_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
AGENCY_REMOTE_SANDBOX_HMAC_SECRET=<48-byte-random-secret>
AGENCY_PROVENANCE_HMAC_SECRET=<48-byte-random-secret>
```

The platform bootstrap owner creates tenants; tenant owners cannot create sibling tenants. Tenant creation returns an `initialApiKey.token` exactly once for the new owner. Deliver that token through a secure channel, use it to configure OIDC, invitations, tenant integrations, and the initial policy, then issue a replacement key and revoke the bootstrap key. The token is never retrievable again.

For staging and production, also constrain discovery and disable deployment-wide credential fallback:

```env
AGENCY_OIDC_ALLOWED_ISSUER_HOSTS=login.example.com
AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL=true
AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK=false
```

After the owner has verified OIDC login and rotated the initial API key, use:

```env
AGENCY_AUTH_MODE=database
```

See:

- [`docs/multi-tenancy.md`](docs/multi-tenancy.md)
- [`docs/oidc-and-sessions.md`](docs/oidc-and-sessions.md)
- [`docs/tenant-secrets.md`](docs/tenant-secrets.md)

## Tenant-owned policy

Actions are evaluated when proposed. The resulting decision is stored on the action:

```json
{
  "policyId": "...",
  "policyVersion": 4,
  "policyChecksum": "...",
  "matchedRuleId": "high-risk-two-person",
  "requiredApprovals": 2,
  "requireSeparateApprover": true,
  "approverRoles": ["reviewer", "admin", "owner"],
  "executorRoles": ["operator", "admin", "owner"]
}
```

Policy edits affect future proposals only. See [`docs/policy-as-code.md`](docs/policy-as-code.md).

## Remote workspace execution

Production staging should use:

```env
AGENCY_WORKSPACE_PROVIDER=remote-http
AGENCY_REMOTE_SANDBOX_URL=https://sandbox.example.com
AGENCY_REMOTE_SANDBOX_HMAC_SECRET=<shared-random-secret>
AGENCY_REMOTE_SANDBOX_AUDIENCE=agency-os-sandbox
```

Requests are signed over timestamp, nonce, method, path, body digest, and audience. The remote service must enforce freshness and nonce replay prevention in addition to verifying the signature. AgencyOS verifies the returned workspace patch digest before accepting validation evidence.

See [`docs/remote-sandbox.md`](docs/remote-sandbox.md).

## Staging deployment

### Docker Compose

```bash
cp .env.example .env.local
# Configure managed MongoDB, S3, OIDC, OTLP, and the remote sandbox.
docker compose -f compose.m7.yml up --build
```

M7 Compose starts:

- Web control plane
- Artifact/event runner pool
- Workspace runner pool
- External-action runner pool

No service mounts `/var/run/docker.sock`.

### Kubernetes

Reference manifests are under [`deploy/k8s/staging`](deploy/k8s/staging). Replace image names, domains, bucket names, and secret placeholders before applying:

```bash
kubectl apply -f deploy/k8s/staging/all.yaml
```

Do not apply `secret.example.yaml` as-is.

## Staging acceptance

The acceptance harness is intentionally read-oriented. It verifies:

- Public liveness and version
- API-key authentication
- Principal/tenant consistency
- Tenant-scoped project listings
- Deep health contract
- Optional cross-tenant direct-ID denial

```bash
export AGENCY_STAGING_BASE_URL=https://agency-os-staging.example.com
export AGENCY_STAGING_API_KEY_A=<tenant-a-key>
export AGENCY_STAGING_API_KEY_B=<tenant-b-key>
export AGENCY_STAGING_PROJECT_ID_A=<known-tenant-a-project>
npm run staging:acceptance
```

See [`docs/staging-acceptance.md`](docs/staging-acceptance.md).

## Observability and usage

```env
AGENCY_OTEL_ENABLED=true
OTEL_SERVICE_NAME=agency-os
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
AGENCY_OTEL_SAMPLE_RATIO=0.25
```

Token usage is recorded for PM, intake, planning, worker, and QA generations. A tenant admin can configure a price catalog; until then, token counts are recorded with `estimatedCostMicros: null`.

See [`docs/usage-and-observability.md`](docs/usage-and-observability.md).

## Release gates

Run before deployment:

```bash
npm run validate:release
npm run check
npm run build
docker build --target web -t agency-os-web:0.7.0 .
docker build --target remote-worker -t agency-os-runner:0.7.0 .
npm run staging:acceptance
```

The generated release validation record distinguishes structural checks completed in the build environment from dependency-backed, Docker-backed, OIDC-provider, S3, MongoDB-transaction, and remote-sandbox tests that still require live infrastructure.

## Documentation

- [`docs/multi-tenancy.md`](docs/multi-tenancy.md)
- [`docs/oidc-and-sessions.md`](docs/oidc-and-sessions.md)
- [`docs/policy-as-code.md`](docs/policy-as-code.md)
- [`docs/tenant-secrets.md`](docs/tenant-secrets.md)
- [`docs/remote-sandbox.md`](docs/remote-sandbox.md)
- [`docs/usage-and-observability.md`](docs/usage-and-observability.md)
- [`docs/staging-acceptance.md`](docs/staging-acceptance.md)
- [`docs/validation.md`](docs/validation.md)
