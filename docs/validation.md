# Validation record — AgencyOS 0.7.0 / M7

**Validation date:** 2026-08-29  
**Milestone:** Tenant-ready launch plane  
**Release posture:** Structurally validated staging release candidate; dependency-backed and live-infrastructure gates remain mandatory before production use.

## Scope reviewed

M7 extends the M6 distributed control plane with:

- tenant identity embedded in user-facing domain, execution, queue, audit, evidence, policy, secret, usage, membership, API-key, and browser-session records;
- tenant-context repository filtering and tenant re-entry for background deliveries;
- invite-gated OpenID Connect Authorization Code + PKCE login;
- server-side browser sessions, `HttpOnly` cookies, and CSRF verification;
- one-time initial owner credential handoff for newly created tenants;
- tenant-bound encrypted integration-secret envelopes;
- versioned action policy with immutable decision snapshots;
- global, tenant, project, and daily-budget admission controls;
- a signed remote-sandbox provider contract that removes the production Docker-socket dependency from AgencyOS runners;
- tenant-scoped model usage and optional cost estimation;
- OpenTelemetry initialization and manual execution/outbox spans;
- Compose and Kubernetes staging topology plus a cross-tenant acceptance harness.

M7 provides application-level multi-tenancy for controlled staging and initial launch. This record does **not** claim formal compliance certification, cryptographic tenant data-plane separation, or adversarially verified SaaS isolation.

## Completed in this build environment

### Release validator

The dependency-light release gate was executed through the repository script:

```bash
npm run validate:release
```

It passed with:

| Check | Result |
|---|---:|
| TypeScript/TSX source, test, and script files | 169 |
| Transpile/syntax diagnostics | 0 |
| Internal `@/` imports inspected | 516 |
| Missing internal imports | 0 |
| JSON files parsed | 2 |
| YAML files parsed | 7 |
| Kubernetes staging documents | 10 |
| Expected Kubernetes resources present | 10/10 |
| Vitest files present | 23 |
| API route modules | 51 |
| Protected routes missing `requirePrincipal` | 0 |
| Environment-schema keys | 121 |
| Missing `.env.example` keys | 0 |
| Extra `.env.example` keys | 0 |
| Tenant-bound repository families checked | 10 |
| Markdown files checked | 19 |
| Broken relative documentation links | 0 |
| Secret-pattern findings | 0 |
| Forbidden generated/local release files | 0 |
| Release-validator warnings | 0 |
| Release-validator status | Passed |

The Kubernetes inventory was asserted exactly, not merely parsed:

1. `Namespace/agency-os-staging`
2. `ConfigMap/agency-os-config`
3. `ServiceAccount/agency-os`
4. `Service/agency-os-web`
5. `Deployment/agency-os-web`
6. `Deployment/agency-os-runner-artifact`
7. `Deployment/agency-os-runner-workspace`
8. `Deployment/agency-os-runner-external`
9. `HorizontalPodAutoscaler/agency-os-web`
10. `HorizontalPodAutoscaler/agency-os-runner-workspace`

Static deployment checks also confirmed that the M7 Compose topology and `remote-worker` image target do not mount or depend on a Docker socket.

### TypeScript classification without installed packages

A global compiler pass was run:

```bash
tsc --noEmit --pretty false --incremental false
```

Because the repository has no installed dependencies or generated typings in this environment, the pass reported 881 dependency/context-induced diagnostics:

| Diagnostic | Count | Expected cause here |
|---|---:|---|
| `TS2307` | 184 | Package and Node module typings unavailable |
| `TS2580` | 175 | Node globals/types unavailable |
| `TS7006` | 84 | Contextual callback types unavailable with missing dependencies |
| `TS7026` | 406 | React JSX intrinsic types unavailable |
| `TS2875` | 5 | JSX runtime unavailable |
| `TS7053` | 3 | Imported contextual/schema types unavailable |
| `TS2503` | 13 | Node namespace unavailable |
| `TS7031` | 11 | Contextual destructuring types unavailable |

No diagnostic codes outside those dependency/context categories were present. This is useful structural evidence, but it is not a substitute for the real project typecheck after `npm install`.

### Tenant and authorization assertions

Static code and regression-test review confirmed:

- browser and API-key principals establish tenant context server-side;
- user-facing repositories bind lookups to `tenantFilter(...)` or `currentTenantId()`;
- public object IDs from another tenant resolve as not found through tenant-scoped repositories;
- globally claimed jobs and outbox messages carry their tenant ID and re-enter that context before service execution;
- the Project Manager service identity cannot supply a tenant or requester identity from model output;
- tenant owners cannot create sibling tenants;
- tenant creation transactionally creates the tenant, first owner membership, and one-time initial owner API key;
- the initial API key is returned once and only its hash is stored;
- owner self-demotion and self-suspension paths are rejected by the membership schema/repository boundary;
- OIDC invitation membership is checked against tenant, normalized email, expiry, revocation, and one-time use;
- OIDC account linking checks both verified email and provider subject and rejects split-identity collisions;
- tenant/subject uniqueness uses a partial compound index so pre-OIDC members without subjects can coexist;
- production OIDC discovery requires HTTPS, an exact issuer-host allowlist, and a verified-email claim;
- obvious loopback/private issuer addresses, URL credentials, query strings, and fragments are rejected unless an explicit non-production override is enabled;
- session-authenticated mutations require both CSRF cookie/header agreement and the stored session CSRF hash;
- production security headers include HSTS, frame denial, MIME sniffing protection, restrictive permissions policy, no-referrer, and a baseline CSP;
- authentication pages and endpoints use `Cache-Control: no-store`.

### Secrets and policy assertions

The review confirmed:

- tenant secret responses expose metadata, not plaintext values or encrypted envelope fields;
- AES-256-GCM associated data binds ciphertext to tenant ID and secret name;
- deployment-wide GitHub/Linear fallback is disabled by default and rejected in production when enabled;
- action proposals store the evaluated policy ID, version, checksum, matched rule, risk, required approvals, approver roles, executor roles, and separation requirement;
- later policy edits cannot retroactively weaken an already-proposed action;
- deny rules take precedence over permissive matches;
- named approvals remain distinct and requester/approver separation uses stable principal identity.

### Admission and execution assertions

M7 admission now checks:

- platform-wide ready-job cap;
- platform-wide active-job cap;
- tenant ready-job cap;
- tenant active-job cap;
- tenant/project active-job cap;
- transactionally reserved tenant daily budget units.

Queue claims remain globally schedulable, while claimed execution and outbox work re-enter the record's tenant context. Durable delivery count remains separate from agent attempt count.

### Remote sandbox and deployment assertions

The remote provider signs requests over timestamp, nonce, method, path, body digest, and audience. AgencyOS validates response shape, enforces bounded timeouts, and rejects a returned patch digest that differs from the expected immutable patch.

The staging manifests configure:

- database authentication mode;
- exact OIDC issuer-host allowlisting;
- verified-email enforcement;
- disabled global integration fallback;
- transaction-required MongoDB behavior;
- S3 evidence storage;
- remote HTTP sandbox execution;
- platform-wide admission caps;
- queue-specific runner pools;
- non-root execution, read-only root filesystems, dropped capabilities, and runtime-default seccomp;
- OpenTelemetry export;
- separate horizontal scaling for the web and workspace-runner tiers.

The remote sandbox remains an external trust boundary. Its service must independently enforce request freshness, nonce replay protection, egress restrictions, runtime isolation, image policy, resource quotas, log limits, and teardown.

### Git patch-integrity recovery exercise

A fresh temporary Git repository exercise verified recovery after validator side effects:

1. Created and committed a base repository.
2. Produced a worker patch containing tracked and new-file changes.
3. Added validator mutations and confirmed the patch digest changed.
4. Reset and cleaned the repository to the base commit.
5. Reapplied the stored worker patch.
6. Confirmed the restored patch digest exactly matched the original worker patch.

```text
worker patch:   9695bc6d0449b0641798205e597414f2c2243dec4d2139c505b28c9843202e19
mutated patch:  b69203a4ddb11bad29cea66fc9d10e6c46e995aa34c2b85987ea9b7ccdff94f8
restored patch: 9695bc6d0449b0641798205e597414f2c2243dec4d2139c505b28c9843202e19
```

### Package and release hygiene

`npm pack --dry-run --json` completed successfully:

| Item | Result |
|---|---:|
| Package | `agency-os@0.7.0` |
| Publishable files | 207 |
| Dry-run unpacked bytes | 738,000 |

The release tree contains no `node_modules`, `.next`, `.env.local`, ZIP archive, or TypeScript build-info file. `.gitignore` and `.dockerignore` exclude generated dependency, build, environment, data, and archive material.

The release scanner checked source, scripts, deployment files, workflows, the environment example, README, and changelog for common OpenAI, GitHub, AWS, MongoDB credential, and private-key patterns. No matching secret material remained.

## Environment-limited checks

The execution environment could not resolve `registry.npmjs.org`; the dependency installation attempt timed out with `EAI_AGAIN`. The repository therefore contains no `node_modules` directory and no generated lockfile.

The Docker CLI and `kubectl` are not installed in this build environment.

This record therefore does **not** claim that the following passed here:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
docker build --target web .
docker build --target remote-worker .
docker compose -f compose.m7.yml config
kubectl apply --dry-run=server -f deploy/k8s/staging/all.yaml
npm run staging:acceptance
```

It also does not claim live verification against:

- a transaction-capable MongoDB deployment;
- an S3-compatible object store;
- a real OIDC provider;
- a remote sandbox service;
- GitHub or Linear tenant credentials;
- an OTLP collector;
- a Kubernetes cluster or autoscaler.

## Required definitive verification

Run in networked CI or a staging environment:

```bash
npm install --no-audit --no-fund
npm run validate:release
npm run check
npm run build

docker build --target web -t agency-os-web:0.7.0 .
docker build --target remote-worker -t agency-os-runner:0.7.0 .
docker compose -f compose.m7.yml config
```

Then complete the staging gate in [`staging-acceptance.md`](staging-acceptance.md), including:

1. Create two tenants and securely deliver each one-time initial owner key.
2. Configure OIDC from the allowlisted issuer and verify invitation-only login.
3. Rotate/revoke the initial owner keys after browser login succeeds.
4. Verify cross-tenant direct-ID requests return `404` for projects, actions, runs, artifacts, policies, usage, and secrets.
5. Verify suspended tenants, disabled members, revoked keys, expired sessions, invalid CSRF, expired invitations, and mismatched OIDC subjects are denied.
6. Exercise global and tenant admission caps under concurrent enqueue load.
7. Kill runners mid-delivery and confirm lease recovery does not consume another agent attempt.
8. Exercise remote-sandbox timestamp, signature, audience, nonce-replay, resource-limit, and patch-digest failures.
9. Complete a high-risk, distinct-approver publication from an immutable approved patch artifact.
10. Confirm GitHub/Linear actions do not read deployment-wide fallback credentials in production.
11. Verify S3 object size/digest enforcement, retention, denied anonymous access, and backup restore.
12. Confirm OTLP traces and usage events contain identifiers and metrics but no secrets, prompts, source text, patches, or client content unless deliberately approved.

## Residual risks and explicit boundaries

- **Application-level isolation:** Tenant safety depends on request context plus repository filters. It is not database row-level security. Regulated or mutually hostile tenants may require separate databases, clusters, buckets, credentials, and runner pools.
- **Platform encryption key:** Secret envelopes are tenant/name-bound, but the current application uses one platform key rather than a distinct KMS key per tenant.
- **Global model-provider credential:** Model calls still use the deployment's provider credential. Tenant-scoped model API keys and provider accounts are not yet implemented.
- **Shared object-store plane:** A tenant ID is part of artifact metadata/storage keys, but strong isolation still depends on bucket IAM, encryption, retention, logging, versioning, and optional per-tenant data planes.
- **OIDC SSRF defense:** Exact issuer-host allowlisting and local/private-address checks are application guards. Production should also enforce DNS and outbound-network policy on the web tier.
- **Remote sandbox contract:** AgencyOS authenticates requests and validates evidence, but cannot prove the remote runtime enforced its advertised isolation. Operate the sandbox as a hardened, separately credentialed service.
- **At-least-once delivery:** Execution and outbox deliveries may replay after ambiguous failures. Adapters and consumers must remain idempotent.
- **CSP:** The baseline policy still permits `'unsafe-inline'` for Next.js compatibility. A nonce- or hash-based CSP is a future hardening item.
- **Browser authentication:** OIDC sessions are implemented, but MFA policy, step-up authentication, SCIM, enterprise logout propagation, and recovery-code workflows depend on the identity-provider/deployment design.
- **Cost data:** Token counts are captured when providers return usage. Monetary estimates remain null unless a tenant explicitly configures a price catalog; they are not billing records.
- **No lockfile:** Generate, review, and commit a lockfile during the first successful networked dependency verification.

## Release decision

The M7 source is ready for networked CI and controlled staging verification. It should not be represented as fully build-green, formally certified, or production-deployed until the dependency-backed build, live tenant-isolation suite, real OIDC/MongoDB/S3/remote-sandbox integrations, and staging acceptance gate all pass.
