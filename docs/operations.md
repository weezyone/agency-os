# Operations

M7 exposes tenant-scoped authenticated operational state for queue health, action delivery, storage, admission, usage, and human review while returning only coarse shared-fleet runner capacity.

## Health endpoints

### Public liveness

```http
GET /api/health
```

Returns minimal application/version status. It does not reveal runner IDs, hostnames, queue depth, provider details, or credentials.

### Authenticated deep health

```http
GET /api/health?deep=1
```

Requires `metrics:read` and probes:

- MongoDB connectivity;
- execution queue state;
- outbox state;
- runner freshness and capacity;
- artifact provider health;
- sandbox provider health;
- admission budget state.

A service can be live while deep health is degraded.

## Operational snapshot

```http
GET /api/operations/overview
```

Returns:

- execution jobs by status;
- outbox pending/leased/retry/dead-letter counts;
- daily reserved/consumed/released budget units;
- online, stale, active, and capacity runner information;
- coarse runner provider, region, status, staleness, active-work, and capacity data without runner IDs, hostnames, or labels;
- actions by status and awaiting-approval count;
- active artifact count and bytes;
- workspace review counts;
- optional artifact-storage probe result.

This route requires `metrics:read`.

## Prometheus metrics

```http
GET /api/metrics
```

Current gauges include:

```text
agencyos_execution_jobs{status=...}
agencyos_actions{status=...}
agencyos_outbox_pending
agencyos_outbox_leased
agencyos_outbox_retry_wait
agencyos_outbox_dead_letter
agencyos_runners_online
agencyos_runner_capacity
agencyos_runner_active_work
agencyos_admission_reserved_units
agencyos_admission_consumed_units
agencyos_admission_limit_units
agencyos_artifacts_active
agencyos_artifact_bytes
agencyos_workspace_reviews_pending
```

The endpoint requires `metrics:read` and returns Prometheus text exposition.

## Alerting recommendations

Alert when:

- ready jobs increase while compatible online runner capacity is zero;
- outbox dead letters are nonzero;
- runner nodes are stale;
- daily budget remaining falls below an operating threshold;
- artifact storage probe fails;
- workspace review backlog exceeds the agency's service-level target;
- actions remain `executing` without an active outbox lease;
- cancellation requests remain unacknowledged beyond a lease interval;
- QA revisions repeatedly reach the maximum attempt count.

## Runbook: no runner capacity

1. Query `/api/operations/overview`.
2. Compare pending queues/resource classes/region preferences with runner advertisements.
3. Verify runner MongoDB and S3 connectivity.
4. Verify its clock is synchronized.
5. Check `AGENCY_RUNNER_QUEUES` includes the pending queue.
6. Verify the workspace pool can reach and authenticate to the remote sandbox service.
7. Verify the sandbox service has healthy runtime capacity and nonce/replay storage.
8. Start or restore a compatible runner pool.

## Runbook: outbox dead letter

1. Identify the message and linked action in MongoDB or the action endpoint.
2. Determine whether the external resource may already exist.
3. Verify GitHub/Linear credentials and network access.
4. Correct the cause.
5. Use the action retry flow, which returns the action to proposal and resets approvals.
6. Obtain the required approval quorum again.
7. Queue execution again.

Do not manually set a dead-letter message to pending without reconciling the linked action.

## Runbook: artifact integrity failure

1. Stop publication for the affected run.
2. Preserve the metadata and storage object for investigation.
3. Compare provider versioning/audit logs.
4. Rotate credentials if unauthorized mutation is possible.
5. Re-run the execution from a clean base; do not waive the hash mismatch.

## Backup and recovery

Back up together:

- MongoDB control-plane collections;
- S3 artifact bucket versions/objects;
- secret-manager configuration;
- integration app credentials and webhook secrets.

MongoDB metadata without artifacts is insufficient for repository publication. Artifacts without MongoDB state are not authoritative for approvals.

## Upgrade notes

Before upgrading runners:

1. drain the runner;
2. wait for active work to finish or cancel it explicitly;
3. deploy the new image;
4. verify runner version and queues in operations overview;
5. confirm storage and sandbox health;
6. restore capacity gradually.

Do not mix pre-M7 runners into a tenant-ready fleet. Drain old runners, migrate tenant credentials and artifacts, verify remote-sandbox health, and only then enable M7 workspace dispatch and publication.
