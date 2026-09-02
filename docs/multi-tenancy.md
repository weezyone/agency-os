# Multi-tenancy

## Boundary

M7 uses a tenant identifier as part of every user-facing domain and execution record. Authentication establishes a `TenantExecutionContext` using Node.js `AsyncLocalStorage`. Repositories derive their tenant filter from that context rather than accepting a tenant identifier from a browser payload.

Tenant-owned records include clients, projects, tasks, actions, action events, execution runs, attempts, events, jobs, job events, workspaces, commands, artifacts, admission reservations, outbox messages, policies, secrets, usage, members, API keys, and browser sessions.

Globally claimed infrastructure records—runner presence, expired-lease recovery, artifact garbage collection, and OIDC state lookup—are intentionally global. A claimed record carries its stored tenant identifier, and the runner re-enters that tenant context before calling tenant-scoped services.

## Query rule

User-facing repository methods must use one of:

```ts
tenantFilter({ id })
currentTenantId()
```

A route must not read a tenant ID from request JSON and pass it to a repository as authority. Direct object identifiers from another tenant resolve as not found.

## Legacy migration

M6 single-tenant records without `tenantId` are lazily assigned to `AGENCY_TENANT_ID` when their collection initializes. Set that variable to the real legacy tenant before starting M7. Do not change it midway through migration.

Recommended migration order:

1. Back up MongoDB and object storage.
2. Stop M6 web and runner processes.
3. Set `AGENCY_TENANT_ID` to the legacy agency tenant.
4. Start one M7 web instance and one runner.
5. Exercise projects, actions, runs, workspaces, and artifacts.
6. Inspect collection counts by `tenantId`.
7. Enable additional tenant creation only after legacy records are verified.

## Indexing

Tenant-scoped uniqueness is used for idempotency keys, API-key membership, policies, prices, action queues, and evidence. UUID-based public IDs remain globally unique, but tenant filters are still mandatory.

## Remaining limits

Application filtering is not a substitute for database-level isolation in highly adversarial deployments. Future hardening may use separate databases or clusters for regulated tenants, tenant-bound object-store credentials, dedicated runner pools, and row-level audit verification.

## Tenant creation and first credential

Only platform bootstrap authority can create a tenant. The create-tenant response contains a one-time `initialApiKey.token` for the first owner. It is the handoff credential that lets the owner configure the tenant before OIDC is available. Store and transmit it as a secret, create a replacement owner key after OIDC works, and revoke the initial key. AgencyOS stores only its hash and cannot display it again.

OIDC subject uniqueness uses a partial compound index on `{ tenantId, subject }`, so invited/local members without a subject can coexist. During account linking, AgencyOS resolves both verified email and OIDC subject and rejects cases where they point at different memberships.

## Capacity boundary

Admission applies both platform-wide ready/active job caps and tenant-level ready/active/project limits. The daily execution reservation remains transactional and tenant-scoped. Global caps protect shared runner capacity; they are not a billing mechanism.
