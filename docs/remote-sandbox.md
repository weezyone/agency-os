# Remote sandbox contract

## Goal

The `remote-http` provider moves repository script execution out of the AgencyOS runner and removes the production requirement for a Docker socket on that runner.

## Request signing

Each request includes:

- Millisecond timestamp
- Random nonce
- HTTP method
- Request path
- SHA-256 body digest
- Audience
- HMAC-SHA256 signature

The remote service must verify all fields, use constant-time signature comparison, enforce a narrow clock-skew window, and atomically reject reused nonces.

## Workspace handoff

AgencyOS sends immutable workspace evidence:

- Tenant and workspace identifiers
- Repository clone URL and base branch
- Base commit SHA
- Approved patch and patch SHA-256
- Resource limits

The sandbox reconstructs a disposable workspace, applies the patch, and executes only the provided executable/argument array. It returns bounded logs, status, runtime identity, quota indicators, and the final workspace patch digest.

AgencyOS rejects validation evidence when the returned digest differs from the expected patch or the sandbox reports an integrity violation.

## Trust boundary

The HMAC authenticates the service-to-service request; it does not make the sandbox itself trustworthy. Production sandbox infrastructure should additionally provide:

- Isolated microVM or container runtime
- Deny-by-default egress
- CPU, memory, PID, disk, and wall-time quotas
- Non-root execution
- Read-only base image
- Ephemeral workspace destruction
- Image digest allowlisting
- Central logs and metrics
- Separate cloud identity from the control plane

## Availability

Remote execution can fail after the sandbox performed work but before the runner received the response. Workspace validation is therefore digest-based and retryable. External publication remains a separate approved action.
