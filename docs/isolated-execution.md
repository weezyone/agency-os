# Isolated execution contract

## Threat model

Repository package scripts are untrusted code. They may attempt to read credentials, inspect the host, persist processes, consume resources, access the network, modify files outside the repository, mutate Git metadata, or interfere with later trusted publication.

M5 runs package-manager commands in a disposable Docker container. Git checkout and publication remain trusted control-plane operations with a scrubbed environment; repository-provided scripts do not run in the trusted process provider.

## Default Docker controls

Each command receives a new container with:

- `--rm` and a unique name;
- management, scope, and expiry labels;
- `--pull never` against a prebuilt toolchain image;
- `--network none` by default;
- `--ipc none`;
- CPU, memory, memory-swap, PID, and file-descriptor limits;
- an init process and a short stop timeout;
- a non-root UID:GID;
- a read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges=true`;
- bounded in-memory `/tmp` and home tmpfs mounts;
- one writable bind mount containing the attempt working tree;
- a nested read-only bind mount for `/workspace/.git`;
- a narrow fixed environment with no AgencyOS credentials.

The model cannot alter these arguments. It can request only a package script name, which AgencyOS intersects with the configured allowlist and the trusted pre-change `package.json` script definition.

## Filesystem and Git-metadata boundary

Before the sandbox starts, AgencyOS verifies that the mount root is inside `AGENCY_WORKSPACE_ROOT`. When the runner itself is containerized, `AGENCY_SANDBOX_HOST_WORKSPACE_ROOT` maps the runner-visible path to the host path understood by the Docker daemon.

The working tree is writable because validators may create caches or generated files. `.git` is overlaid read-only so repository code cannot rewrite hooks, remotes, configuration, refs, or other metadata later consumed by trusted Git operations.

The container root is read-only. A host-side quota monitor terminates the container when the complete workspace exceeds `AGENCY_SANDBOX_DISK_BYTES`. Disk monitoring is a bounded guard, not a kernel-enforced filesystem quota. Dedicated production runners should use project quotas, volume quotas, or a remote sandbox with native disk limits.

## Validation-script integrity

The initial repository context captures each allowlisted script's exact command string before worker changes are applied. Before validation, AgencyOS reads `package.json` again.

A validator runs only when:

1. the script name is configured in `AGENCY_WORKSPACE_VALIDATION_SCRIPTS`;
2. the script existed in the pre-change repository; and
3. its command string is byte-for-byte unchanged.

A worker cannot replace `test` with a trivial success command and use that altered definition as passing evidence. Changed validator definitions are recorded and force validation failure.

## Patch stability after validation

After all package scripts finish, AgencyOS captures the repository patch again and compares its SHA-256 hash with the worker patch captured before validation.

If a validator changes tracked or untracked content, AgencyOS:

1. marks validation unsuccessful;
2. resets the working tree to the stored base SHA;
3. removes validation-created untracked files; and
4. reapplies the original worker patch from durable workspace evidence.

Human review therefore receives the worker patch, not validator side effects.

## Environment isolation

Child sandboxes receive only fixed runtime values such as:

```text
HOME
TMPDIR
CI
NO_COLOR
npm_config_audit
npm_config_fund
npm_config_update_notifier
```

They do not inherit:

- `OPENAI_API_KEY`;
- `MONGODB_URI`;
- `GITHUB_TOKEN`;
- `LINEAR_API_KEY`;
- operator credentials;
- Docker client configuration;
- the Docker socket.

Git credentials are supplied only to specific trusted clone or push processes and are not persisted in command evidence.

## Network modes

`none` is the default and preferred mode. It prevents package downloads and tests that require external services.

`bridge` enables general egress. It exists as an explicit development escape hatch, not as a strong production policy. Production should provide one of:

- a tightly allowlisted egress proxy;
- an internal package mirror;
- prebuilt dependency layers;
- a remote sandbox with per-job network policy.

## Dependency installation

`AGENCY_WORKSPACE_DEPENDENCY_MODE=none` skips installation.

`frozen` invokes one of:

```text
npm ci --ignore-scripts --no-audit --no-fund
pnpm install --frozen-lockfile --ignore-scripts
yarn install --immutable --mode=skip-build
```

Lifecycle scripts remain disabled. A failed install is durable failed evidence and prevents validation scripts from running.

## Forced teardown and garbage collection

Timeout, cancellation, lease loss, disk quota, or runner shutdown triggers immediate container removal. Containers are labeled with an expiry epoch. Runner startup and shutdown sweep expired managed containers left by process crashes.

Scope-based termination removes all containers associated with one workspace ID.

## Docker socket boundary

The Compose runner mounts `/var/run/docker.sock`. Anyone controlling that runner process can control the Docker host. Treat the runner as privileged infrastructure:

- place it on a dedicated host or VM;
- do not cohost sensitive workloads;
- restrict who can deploy or modify the runner image;
- never mount the socket into child sandboxes;
- prefer a remote sandbox API or microVM service for multi-tenant production.

## Image integrity

M5 uses a named local image and `--pull never`. Before production:

- pin the base image by digest;
- generate and scan an SBOM;
- sign the sandbox image;
- verify signatures at deployment;
- rebuild on a defined patch cadence;
- maintain separate toolchain images where languages require different dependencies.
