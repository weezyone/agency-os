# Durable runner contract

## Purpose

The durable runner removes specialist and QA execution from the HTTP lifecycle. The web control plane creates an idempotent job; a separate runner leases that job and reconciles every outcome into run, attempt, task, workspace, job-event, and artifact records.

## Collections

### `execution_jobs`

One document represents one durable delivery stream for an execution run. A sparse unique `activeKey` enforces at most one nonterminal job for `run:<runId>:execute`.

Each job records both:

- `deliveryCount`, which counts infrastructure deliveries; and
- `targetAttemptNumber`, which identifies the exact worker/QA attempt that delivery is allowed to start or reconcile.

### `execution_job_events`

Append-only events record enqueue, claim, start, lease expiry, retry, cancellation, success, failure, and dead-letter transitions.

### `runner_nodes`

Runner registrations expose version, provider, active job IDs, lifecycle status, and last-seen time only through authenticated operational diagnostics.

## Lease protocol

1. A runner atomically changes an available `queued` or `retry_wait` job to `leased`.
2. The claim increments `deliveryCount` and `leaseGeneration`.
3. A cryptographically random raw lease token is returned only to the runner.
4. MongoDB stores only `SHA-256(rawToken)`.
5. `start()` changes the exact token-owned lease to `running`.
6. Heartbeats renew only the same owner/token while the lease remains unexpired.
7. Every checkpoint verifies that the job is still `running`, unexpired, uncancelled, and token-owned.
8. Completion, failure, and cancellation use the same token and ownership predicates.

A lease token alone is insufficient after expiry. A stale runner cannot complete the job, and attempt transitions include the expected attempt number so an old runner cannot interrupt a newer attempt.

## Heartbeat versus control polling

Lease renewal and operator control are intentionally separate:

- `AGENCY_RUNNER_HEARTBEAT_MS` renews ownership.
- `AGENCY_RUNNER_CONTROL_POLL_MS` observes cancellation or ownership loss without extending the lease.

The control poll aborts active Mastra generation and workspace commands through `AbortSignal`. Repository containers are force-removed during teardown. Both intervals must remain shorter than `AGENCY_RUNNER_LEASE_MS`.

## Delivery replay is not an agent retry

Infrastructure recovery and agent revision are separate state machines.

A replacement runner first compares `run.currentAttempt` with `job.targetAttemptNumber`:

- If the target attempt has not started, the runner may claim that exact attempt.
- If the target attempt already exists, the runner performs only reconciliation and artifact persistence.
- It never spends another worker attempt merely because a queue delivery crashed.
- A genuine QA or human revision creates a later job targeting `currentAttempt + 1`.

This fence prevents repeated deliveries from silently consuming `maxAttempts`.

## Recovery and dead letters

Before claiming new work, a runner reaps expired `leased` or `running` jobs:

- A non-exhausted job becomes `retry_wait`.
- An exhausted job becomes `dead_letter`.
- A cancel-pending expired job remains claimable solely so another runner can finish cancellation reconciliation and teardown.

If an exhausted delivery abandoned a run in `running` or `qa_review`, the runner closes that attempt with the expected-attempt fence and moves the run to its bounded revision or failure state.

An operator may explicitly restore only the latest `failed` or `dead_letter` delivery through `POST /api/jobs/:id/retry`. The retry keeps the same target attempt, resets only the delivery budget, and refuses superseded jobs.

## Delivery and attempt budgets

Two budgets protect different failure domains:

- `maxDeliveries` limits infrastructure delivery of one target attempt.
- `maxAttempts` limits worker/QA revisions in the execution run.

Exhausting either budget produces an inspectable terminal or intervention state rather than an infinite loop.

## Cancellation

Cancellation is a durable control message, not a best-effort process signal.

The cancellation service:

1. Marks the active job cancel-requested or immediately cancels an unclaimed job.
2. Causes the control poll to abort generation and commands.
3. Terminates every runtime associated with the linked workspace.
4. Fences and closes the current attempt.
5. Reconciles completion races in favor of the accepted cancellation request.
6. Returns the task to `todo` and clears active/completed run pointers.
7. Marks a nonapproved workspace failed with a cancellation reason.
8. Acknowledges the durable job as `cancelled` and releases its active key.

Job-specific cancellation first verifies that the requested job is still the active delivery, so an old job ID cannot cancel a newer delivery.

## Graceful shutdown

`SIGINT` and `SIGTERM` put the runner into `draining`:

- no new jobs are claimed;
- active jobs receive an abort signal;
- the runner waits for bounded cleanup;
- orphan containers are swept;
- the node is marked offline.

If the process dies without cleanup, lease expiry and labeled-container cleanup provide the recovery path.

## Operational health

`GET /api/health` returns a limited public status. `GET /api/health?deep=1` requires operator authorization and includes queue counts, runner nodes, and sandbox availability.

Recommended alerts:

- ready jobs with zero online runners;
- oldest-ready age above the queue SLO;
- repeated lease expiry;
- dead-letter jobs;
- stale runner nodes;
- sandbox health failure;
- abnormal cancellation or quota-exceeded rates.
