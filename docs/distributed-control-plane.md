# Distributed Control Plane

M6 separates coordination from execution so the Next.js web tier does not require access to a runner's local repository workspace.

## Shared durable state

MongoDB stores:

- projects and tasks;
- execution runs and attempts;
- execution jobs, events, leases, and runner presence;
- external actions and approvals;
- transactional outbox deliveries;
- identity and API-key metadata;
- artifact metadata and provenance;
- admission reservations and usage buckets.

S3-compatible storage holds immutable artifact bytes.

Runner-local files are disposable.

## Runner capabilities

A runner registers:

```text
region
queues
resource classes
labels
maximum concurrency
workspace provider
version
last-seen timestamp
active work IDs
```

Configuration example:

```env
AGENCY_RUNNER_REGION=us-west
AGENCY_RUNNER_QUEUES=workspace,external-actions,events
AGENCY_RUNNER_RESOURCE_CLASSES=standard,large
AGENCY_RUNNER_LABELS=node22,client-safe
AGENCY_RUNNER_CONCURRENCY=2
```

Execution-job claims filter by region preference, queue, and resource class. Outbox claims filter by queue. Labels are advertised for operations and future policy routing; M6 does not yet require labels on individual jobs.

## Work categories

### Artifact jobs

Research, planning, design analysis, and other structured-output work. Durable evidence normally includes worker output, QA result, and manifest.

### Workspace jobs

Repository-bound implementation work. The runner clones the repository, applies bounded model-proposed file operations, validates through an isolated container, captures the Git patch, invokes independent QA, and uploads evidence.

### External-action outbox

Approved GitHub and Linear mutations. Execution is performed by a runner, not the web request.

### Event outbox

Signed at-least-once domain-event webhook delivery.

## Lease and fencing model

Both execution jobs and outbox messages use:

- atomic claim transitions;
- random lease tokens;
- persisted token hashes rather than raw tokens;
- lease ownership and expiration;
- periodic heartbeat renewal;
- bounded delivery counts;
- retry-wait and dead-letter states;
- completion filters requiring a still-valid lease.

Execution jobs additionally use target-attempt fencing. Re-delivery of an infrastructure job reconciles the same agent attempt instead of silently consuming a new revision attempt.

## Remote-safe publication

The publication runner no longer trusts a local path from the original workspace host.

It receives an approved action containing:

- patch artifact ID;
- expected patch SHA-256;
- repository clone URL and full name;
- base branch and base commit SHA;
- generated branch name;
- PR title/body/draft flag.

The runner:

1. Reads the artifact through the provider recorded on that artifact.
2. Verifies its hash.
3. Clones a fresh repository into a temporary runner-local directory.
4. Checks out the exact approved base commit.
5. Applies the patch with Git's binary patch path.
6. Verifies the reconstructed staged patch hash.
7. Commits and pushes the dedicated branch.
8. Finds or creates the draft pull request idempotently.
9. Persists the result and removes the temporary directory.

If the branch already exists, the runner verifies that its base-to-head patch exactly matches the approved patch before reuse.

## Admission controls

Before an execution job is enqueued, AgencyOS checks:

- ready-job count;
- active-job count;
- active jobs for the project.

It then reserves daily execution budget units transactionally. Artifact and workspace modes have separate configured costs.

The daily budget is the hard transactional limit. Queue-count checks are operational admission guards and can be approximate under high concurrency.

Reservations settle as:

- `consumed` after execution or a delivery that spent runner work;
- `released` when enqueue fails or work is cancelled before delivery;
- idempotently unchanged after prior settlement.

## Deployment pattern

A production-shaped deployment uses:

```text
web replicas
     |
MongoDB replica set / sharded cluster
     |
S3-compatible artifact bucket
     |
runner pools by region and capability
```

Each Docker-based runner still needs local Docker daemon access and disposable workspace storage. Place it on a dedicated machine. A future remote-sandbox adapter should replace direct Docker socket access for stronger isolation.
