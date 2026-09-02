# Transactional Outbox

M6 moves approved external side effects out of the web request and into a durable, runner-leased outbox.

## Why it exists

Without an outbox, this failure is possible:

```text
MongoDB action state commits
        |
process crashes
        |
external execution message is never published
```

The reverse is also dangerous:

```text
external write succeeds
        |
process crashes before local state records success
        |
operator retries and may duplicate the write
```

AgencyOS writes state transitions and their outbox messages in one MongoDB transaction. Runners deliver the outbox at least once, while integration adapters use idempotency and recovery checks.

## Topics

### `action.execute`

Executes an already approved Linear or GitHub action. Queue: `external-actions`.

### `domain.event`

Delivers signed action lifecycle events to an optional webhook. Queue: `events`.

## Delivery lifecycle

```text
pending
  -> leased
  -> succeeded
  -> retry_wait -> leased
  -> dead_letter
```

Every message contains:

- tenant ID;
- aggregate type and ID;
- correlation ID;
- idempotency key;
- queue;
- delivery count and maximum;
- availability time;
- lease owner/hash/expiry;
- last error and completion time.

## Atomic action execution queueing

`POST /api/actions/:id/execute` does not call GitHub or Linear.

In one transaction it:

1. verifies the action is approved;
2. inserts or reuses the idempotent `action.execute` outbox message;
3. transitions the action to `executing`;
4. stores the delivery ID;
5. appends audit events and their domain-event messages.

Production requires:

```env
AGENCY_TRANSACTIONS_REQUIRED=true
```

The MongoDB deployment must support transactions.

## Delivery fencing

A runner can complete or fail an outbox message only while it still owns an unexpired lease whose token hash matches the claim.

A heartbeat extends long deliveries. If the lease expires:

- the message returns to retry wait when deliveries remain;
- it becomes dead letter when the budget is exhausted;
- linked action state is reconciled to failed for terminal action deliveries.

## Integration idempotency

AgencyOS also protects the external boundary:

- repository creation searches for the AgencyOS recovery marker;
- existing unrelated repositories are treated as collisions;
- branch publication reuses an existing matching branch only after patch verification;
- draft PR creation searches for an existing matching head/base pull request;
- action proposals use deterministic or supplied idempotency keys.

Exactly-once side effects cannot be assumed across arbitrary external APIs. The design combines transactional intent, at-least-once delivery, idempotent adapters, and explicit audit evidence.

## Signed webhooks

When configured, domain events use:

```text
x-agency-event-id
x-agency-event-timestamp
x-agency-event-signature: sha256=<hex>
idempotency-key
```

The signature input is:

```text
<unix-timestamp>.<raw-json-body>
```

Consumers should:

1. reject stale timestamps;
2. compute HMAC-SHA256 with the shared secret;
3. compare signatures in constant time;
4. deduplicate by event ID or idempotency key;
5. return non-2xx only when delivery should retry.

If no webhook URL is configured, domain events are acknowledged without an outbound call; the MongoDB action-event ledger remains authoritative.
