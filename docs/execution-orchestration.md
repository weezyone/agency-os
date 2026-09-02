# Execution orchestration contract

## Purpose

The execution subsystem converts project tasks into auditable specialist attempts without allowing the project manager to silently consume compute, bypass QA, approve its own patch, or declare external work complete.

## Invariants

1. A task may have at most one active run.
2. A run may have at most one active execution job.
3. Only `queued` and `revision_requested` runs may be enqueued.
4. A durable job must hold a valid runner lease before claiming an attempt.
5. A job targets one explicit attempt number.
6. Redelivering a job never increments the agent attempt counter when that target attempt already exists.
7. Claiming a genuinely new run attempt increments the attempt counter atomically.
8. Worker completion is not task completion.
9. QA is independent from the worker.
10. A workspace-mode QA pass becomes `approval_required`, not `passed`.
11. Only human workspace approval moves a workspace run to `passed` and the task to `done`.
12. Workspace review is unavailable until the durable delivery reaches `succeeded` and all evidence is persisted.
13. External publication remains a separate proposed/approved/executed action.
14. Revision instructions remain attached to the same run and feed the next attempt.
15. Exhausting the attempt budget moves the run to `failed` and the task to `blocked`.
16. Terminal runs release the task's unique active-run slot.
17. Lease generation, lease token, and expected attempt number fence stale runners.
18. Cancellation reconciles the job, run, attempt, task, workspace, and runtime.

## Execution modes

`resolveExecutionMode()` selects:

- `workspace` for frontend/backend tasks and implementation-oriented tech-lead work;
- `artifact` for research, design, planning, QA analysis, and non-repository work.

An operator may override the mode when queueing a task.

## Run state machines

Artifact mode:

```text
queued -> running -> qa_review -> passed
                         |
                         +-> revision_requested -> running
                         +-> failed
```

Workspace mode:

```text
queued -> running -> qa_review -> approval_required -> passed
                         |                 |
                         |                 +-> revision_requested -> running
                         +-> revision_requested -> running
                         +-> failed
```

The durable-job lifecycle is independent:

```text
queued -> leased -> running -> succeeded
                         |
                         +-> retry_wait -> leased
                         +-> failed / dead_letter
                         +-> cancelled
```

## Role routing

Planner owner labels are mapped to bounded runtime roles:

```text
tech-lead
research
design
frontend
backend
qa
```

Unknown labels fall back to `tech-lead` so the system fails toward technical triage rather than an arbitrary specialist.

## Dependency readiness

Dependencies may reference task IDs or exact normalized task titles. Unresolved dependency text blocks bulk dispatch instead of being ignored.

## QA policy

A run has a passing QA result only when:

```text
qa.verdict === "pass"
AND
qa.score >= minQaScore
```

Workspace mode additionally requires a nonempty patch and passing authoritative validation evidence. A model's claim that tests passed is ignored unless the workspace command ledger supports it.

Validation evidence is untrusted when a worker altered the underlying package-script definition or when validators changed the patch under review.

## Human patch review

The reviewer sees the patch, changed-file list, line counts, validation summary, command records, QA findings, changed validator definitions, and revision instructions. Approval and rejection are separate API transitions. Rejection either requests another bounded attempt or fails the run when the retry budget is exhausted.

## Durable executor

M5 enqueues execution through `POST /api/runs/:id/execute`. A separate runner atomically leases the job, heartbeats ownership, observes cancellation through a fast control poll, and processes or reconciles one target attempt.

Expired leases are recovered within a delivery budget. Operators can restore the latest failed/dead-lettered delivery explicitly. A delivery retry is infrastructure recovery, not an implicit worker revision.

Repository-provided package scripts execute through the Docker-isolated provider. Git control operations remain in a scrubbed trusted provider. See [`durable-runner.md`](durable-runner.md) and [`isolated-execution.md`](isolated-execution.md).
