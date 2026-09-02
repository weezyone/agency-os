# Artifact Storage and Provenance

M6 introduces a provider contract for immutable execution evidence.

## Providers

### Filesystem

Best for local development or a single runner host.

```env
AGENCY_ARTIFACT_PROVIDER=filesystem
AGENCY_ARTIFACT_ROOT=/tmp/agency-os/artifacts
```

### S3-compatible

Required when web and runner nodes do not share a POSIX filesystem.

```env
AGENCY_ARTIFACT_PROVIDER=s3
AGENCY_S3_REGION=us-east-1
AGENCY_S3_BUCKET=agency-os-production
AGENCY_S3_PREFIX=agency-os
```

Optional compatible-provider settings:

```env
AGENCY_S3_ENDPOINT=https://object.example.com
AGENCY_S3_FORCE_PATH_STYLE=true
AGENCY_S3_ACCESS_KEY_ID=...
AGENCY_S3_SECRET_ACCESS_KEY=...
```

Prefer workload identity, instance roles, or another short-lived credential mechanism instead of static keys.

## Stored evidence

A completed execution can persist:

- worker output;
- independent QA result;
- approved repository patch;
- validation command ledger;
- execution manifest;
- provenance attestation.

Artifact metadata includes:

```text
provider
logical storage key
media type
byte length
SHA-256
run/project/task linkage
creation and expiry time
```

The provider is stored per record. A deployment can therefore read historical filesystem records after switching new writes to S3, provided the historical filesystem remains available to that process.

## Integrity checks

On write, AgencyOS calculates SHA-256 and stores the expected byte length.

On read, it verifies both:

- actual byte length equals metadata;
- actual SHA-256 equals metadata.

A mismatch fails closed.

GitHub publication separately verifies the patch hash before applying it and verifies the reconstructed staged Git patch after applying it.

## Provenance

The manifest can be accompanied by a canonical JSON provenance statement covering:

- run, attempt, project, and task IDs;
- runner ID;
- workspace ID;
- artifact hashes;
- execution and QA status;
- creation timestamp;
- configured key ID.

When `AGENCY_PROVENANCE_HMAC_SECRET` is configured, AgencyOS signs the canonical statement using HMAC-SHA256.

```env
AGENCY_PROVENANCE_HMAC_SECRET=<minimum-32-character-secret>
AGENCY_PROVENANCE_KEY_ID=agency-os-prod-2026-01
```

This detects unauthorized modification when the verifier controls the secret. It is not a public-key signature and does not replace image signing, hardware attestation, or an external transparency log.

## Storage health

Deep health can probe the active provider:

- filesystem: create and remove a probe object;
- S3: perform a bucket head check.

The public health route never exposes provider details. Use authenticated deep health or `/api/operations/overview`.

## Deployment responsibilities

AgencyOS does not create or configure the bucket. Production operators should apply:

- least-privilege bucket policy;
- encryption at rest;
- TLS in transit;
- lifecycle and retention policy;
- versioning or object lock where required;
- audit logging;
- network restrictions;
- credential rotation.

Artifact retention in AgencyOS removes expired bytes and metadata through runner garbage collection. Object-store lifecycle rules should act as a defense in depth, not the sole application retention mechanism.
