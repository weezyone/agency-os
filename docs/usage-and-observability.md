# Usage and observability

## Provider usage ledger

AgencyOS records available model usage for PM, intake, planning, specialist worker, and QA generations. Each event includes tenant, provider, model, agent, operation, related project/task/run identifiers, token categories, and retention expiry.

Cost estimates are deliberately tenant-configured. When no active price exists for a provider/model pair, AgencyOS records tokens and leaves `estimatedCostMicros` null. This avoids silently applying stale public pricing.

Price catalogs are versioned. Historical usage retains the price version used for its estimate.

## OpenTelemetry

Set:

```env
AGENCY_OTEL_ENABLED=true
OTEL_SERVICE_NAME=agency-os
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_HEADERS=
AGENCY_OTEL_SAMPLE_RATIO=0.25
```

The Next.js instrumentation hook and runner initialize the Node SDK. Runner execution and outbox deliveries create manual spans. Export through an OpenTelemetry Collector so credentials, batching, retries, filtering, and vendor routing are managed outside application code.

## Metrics

Authenticated metrics cover execution jobs, actions, outbox backlog, runner capacity, admission budget, artifact volume, and pending workspace reviews. Tenant-facing operational snapshots expose aggregate runner capacity, not runner hostnames or IDs.

## Data handling

Do not place prompts, source code, secrets, or full model responses in metric attributes. Usage records contain counts and identifiers, not prompt content.
