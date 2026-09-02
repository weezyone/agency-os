# Changelog

## 0.7.0 — M7 tenant-ready launch plane

### Added

- Tenant, invitation, OIDC connection, one-time OIDC transaction, browser-session, encrypted-secret, action-policy, usage-event, and price-catalog contracts.
- AsyncLocalStorage tenant execution context and tenant-bound filters across user-facing domain, execution, action, evidence, usage, secret, and policy repositories.
- Invite-gated OIDC Authorization Code + PKCE login, server-side sessions, secure cookie helpers, logout, and session CSRF verification.
- Tenant administration routes for invitations, OIDC, encrypted integration secrets, policy versions, policy activation, and model pricing.
- Versioned action policy evaluation with immutable decision snapshots attached to every proposal.
- AES-256-GCM tenant secret envelopes with tenant/name associated-data binding.
- Signed `remote-http` workspace provider with audience binding, request body digests, bounded timeouts, and returned patch-digest verification.
- Tenant-owned GitHub and Linear credential resolution with environment fallback for migration and trusted local use.
- Provider token usage ledger and tenant-configured cost estimation.
- OpenTelemetry initialization for Next.js and runners plus manual execution/outbox spans.
- Tenant-aware Mastra memory resource and thread identifiers.
- M7 Compose topology, no-Docker-client `remote-worker` image, Kubernetes staging manifests, queue-specific runner pools, and staging acceptance script.
- Release validator covering structural TypeScript parsing, alias imports, API auth guards, environment parity, tenant repository bindings, YAML/JSON, relative links, versioning, and secret-like values.
- One-time initial owner API-key handoff created transactionally with each new tenant.
- OIDC issuer-host allowlisting, verified-email enforcement, private/local issuer guards, and conflict-safe email/subject account linking.
- Platform-wide admission caps in addition to tenant and project limits.
- Production browser security headers and no-store handling for authentication surfaces.

### Changed

- M6 single-tenant records are lazily assigned to the configured legacy tenant before tenant-scoped indexes and reads are used.
- Tenant-facing operations expose aggregate runner capacity rather than hostnames, runner IDs, or scheduling labels.
- Production workspace execution can use a remote sandbox without mounting the Docker socket into AgencyOS runners.
- Provider cost remains unknown until a tenant administrator supplies a price catalog; no public price is silently embedded.
- Deployment-wide GitHub and Linear credential fallback is opt-in for migration/trusted development and rejected in production.
- OIDC subject uniqueness now uses a partial tenant/subject index so multiple pre-OIDC invitations can coexist.
- Package and sandbox image versions advanced from `0.6.0` to `0.7.0`.

### Security notes

Application-level tenant filtering is now enforced throughout the control plane, but highly regulated deployments may still require database-per-tenant or cluster-level separation. The remote sandbox must independently enforce nonce replay protection, request freshness, runtime isolation, egress policy, and resource quotas. HMAC request authentication does not replace sandbox hardening.

### Migration

Back up MongoDB and object storage, stop M6 writers, set `AGENCY_TENANT_ID` to the legacy tenant, and start one M7 instance to complete lazy migration. Configure `AGENCY_SECRET_ENCRYPTION_KEY` before storing tenant credentials. Migrate GitHub and Linear credentials into tenant secrets before production. Deployment-wide fallback is opt-in for trusted migration/development and production configuration rejects it.

## 0.6.0 — M6 distributed multi-user control plane

### Added

- Named agency members with owner, admin, operator, reviewer, and viewer roles.
- Revocable, expiring, one-time API-key issuance with last-use tracking and hashed credential storage.
- Route-level permission enforcement and authenticated principal discovery.
- Principal-bound action requester and approval records, separation of duties, and configurable high-risk approval quorum.
- Transaction helper with snapshot/majority transaction policy and production transaction enforcement.
- Transactional outbox for approved external actions and signed domain-event webhooks.
- Runner-leased external-action and event delivery with heartbeats, bounded retries, dead letters, and lease fencing.
- S3-compatible artifact provider with optional endpoint, path-style access, static credentials, and server-side encryption settings.
- Per-artifact provider persistence, byte-length and SHA-256 read verification, and HMAC-signed canonical provenance records.
- Remote-safe GitHub publication reconstructed from the immutable approved patch artifact on the executing runner.
- Runner region, queue, resource-class, label, and capacity advertisements plus compatible job claiming.
- Transactional daily execution-budget reservations and admission guards for ready, active, and per-project work.
- Authenticated operations overview, deep health diagnostics, and Prometheus metrics.
- M6 Compose topology that removes runner workspace and artifact mounts from the web tier.
- Identity/RBAC, distributed-control-plane, artifact-storage, transactional-outbox, and operations documentation.

### Changed

- External action execution now queues an outbox delivery instead of calling GitHub or Linear in the HTTP request.
- GitHub workspace publication no longer depends on the original runner's local repository path.
- Action UI displays named requester, risk, approval quorum, and distinct approval records.
- All protected routes derive actors from authenticated principals instead of trusting body-supplied actor strings.
- Production now rejects disabled authentication and deployments that do not require MongoDB transactions.
- Default runner queues now include artifact, workspace, external-actions, and events.
- Sandbox image and application version advanced to `0.6.0`.

### Security notes

M6 is multi-user but remains single-tenant. `AGENCY_TENANT_ID` is persisted for forward compatibility, but queries are not tenant-isolated. API keys are bearer credentials and the operator dashboard is not an SSO/session product. The runner Docker socket remains host-equivalent infrastructure access and belongs on dedicated runner hosts.

### Migration

No destructive migration is required. New collections and indexes are created lazily. Existing action and execution records receive compatible defaults during repository initialization. M5 filesystem artifacts retain their recorded provider and remain readable where that filesystem is mounted. Before switching to S3 publication, complete or intentionally abandon any M5 approved workspace actions that still depend on local patch paths.

## 0.5.0 — M5 durable isolated execution

### Added

- Durable MongoDB execution jobs, append-only job events, and runner-node presence records.
- Atomic lease claims with random tokens, persisted token hashes, lease generations, heartbeats, and stale-lease recovery.
- Independent fast control polling for cancellation and ownership loss.
- Fencing by job lease and expected attempt number to prevent stale-runner writes.
- Bounded delivery retries, retry scheduling, dead-letter state, graceful drain, and orphan cleanup.
- Per-job `targetAttemptNumber` fencing so infrastructure redelivery cannot silently spend another worker attempt.
- Explicit restore of the latest failed/dead-lettered delivery through the API and operator dashboard.
- Separate `npm run runner` process and one-delivery `runner:once` mode.
- Docker-isolated package-script provider with deny-by-default networking, read-only root, non-root user, isolated IPC, dropped capabilities, no-new-privileges, CPU/memory/PID/tmpfs limits, monitored workspace quota, and forced teardown.
- Durable execution artifacts for worker output, QA results, patches, command logs, and manifests.
- Artifact expiry filtering plus runner garbage collection that removes filesystem bytes and MongoDB metadata.
- A read-only nested `.git` mount inside validation containers.
- Validation-script definition pinning and post-validation patch-integrity restoration.
- Baseline operator token authorization, authenticated artifact downloads, and sanitized public job responses.
- Minimal public health checks plus authenticated deep queue, runner, and sandbox diagnostics.
- Operator dashboard queue state, runner ownership, delivery count, cancellation, and artifact controls.
- Compose deployment for separate web and runner services with shared workspace/artifact storage.
- Durable-runner and isolated-execution threat-model documentation.

### Changed

- `POST /api/runs/:id/execute` now returns an idempotent durable job instead of running the attempt inside the HTTP request.
- Cancellation now reconciles job, run, attempt, task, workspace, and runtime states, including completion races and stale job IDs.
- Dead-letter recovery now reconciles abandoned run attempts instead of leaving them in `running` or `qa_review`.
- Repository validation scripts now use `docker-isolated` by default; trusted Git control operations remain local with a scrubbed environment.
- Human review controls remain locked until the linked durable delivery has succeeded and evidence persistence is complete.
- Public health responses no longer reveal runner hostnames, IDs, or sandbox details.
- Package version advanced from `0.4.0` to `0.5.0`.

### Security notes

The runner's Docker socket is host-equivalent infrastructure access. Child sandboxes never receive it, but the runner should live on a dedicated host/VM or be replaced by a remote sandbox API for multi-tenant production. Docker bridge networking is an explicit development escape hatch; `none` remains the default.

### Migration

No destructive migration is required. `execution_jobs`, `execution_job_events`, `runner_nodes`, and `execution_artifacts` are created lazily. Existing M3/M4 runs remain valid and are enqueued only when an operator invokes the execute route. Early M5 job records missing `targetAttemptNumber` are normalized to attempt `1` during repository initialization.

## 0.4.0 — M4 controlled real workspaces

### Added

- Project repository binding with allowlisted HTTPS clone URLs.
- Durable `workspaces`, `workspace_commands`, and `workspace_events` collections.
- Per-attempt clone, branch, repository context, structured file changes, patch capture, and validation evidence.
- Workspace and artifact execution modes with policy-based routing.
- File/path, symlink, secret-content, CI-control-file, size, output, and timeout controls.
- Scrubbed command environments that exclude AgencyOS application credentials.
- Human patch approval/rejection after independent QA.
- Approval-controlled GitHub branch publication and draft pull-request actions.
- Idempotent recovery for existing repositories, already-pushed commits, existing open pull requests, and failed/rejected action proposals.
- Sanitized workspace API responses that omit server-local repository and patch paths.
- Workspace controls, diff review, command evidence, and publication controls in the operator dashboard.
- Controlled workspace threat-model and execution-contract documentation.

### Changed

- Frontend/backend and implementation-oriented tech-lead runs default to workspace mode.
- A workspace QA pass now transitions to `approval_required`; it does not complete the task until human review.
- Existing v0.3 execution documents are lazily normalized to artifact mode.
- Docker runtime now includes Git, Corepack shims, a non-root user, and a workspace data root.
- Package version advanced from `0.3.0` to `0.4.0`.

### Security notes

`local-process` is a trusted-development provider and remains disabled in production unless explicitly enabled. It scrubs credentials and constrains command selection, but it is not a container/microVM sandbox.

### Migration

No destructive database migration is required. Workspace collections and indexes are created lazily. Existing run/attempt documents missing `executionMode` are set to `artifact` on first repository access.

## 0.3.0 — M3 execution orchestration

### Added

- Durable `execution_runs`, `execution_attempts`, and `execution_events` collections.
- Specialist routing for tech lead, research, design, frontend, backend, and QA work.
- Independent quality-gate agent with configurable score threshold.
- Dependency-aware project dispatch and per-task queue endpoints.
- Bounded revision lifecycle and task/project status synchronization.
- Operator dashboard controls for queue, execute, revise, and cancel.
- Execution policy tests and orchestration contract documentation.
