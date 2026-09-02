# Controlled workspace contract

## Purpose

A workspace converts a bounded implementation task into a reviewable repository patch without granting the project manager or worker model arbitrary shell access.

## Trust boundary

The worker model may propose:

- repository-relative file creation;
- repository-relative file updates;
- repository-relative file deletion;
- package-script names to validate.

The worker model cannot choose:

- the repository remote;
- the filesystem or mount root;
- a shell command or arbitrary executable arguments;
- environment variables or credentials;
- the publication branch name;
- whether QA passes;
- whether a human approves;
- whether GitHub publication executes.

## Provider contract

`WorkspaceProcessProvider.run()` accepts an executable, argument array, working directory, timeout, output limit, isolation level, scope ID, mount root, and optional abort signal. It never accepts a shell string.

M5 supplies two providers:

- `docker-isolated` for repository-provided package scripts;
- `local-process` for trusted Git control operations and controlled development fallback.

Workspace runtime termination is scope-based so cancellation, lease loss, and shutdown can tear down every process/container associated with one workspace.

## Local-process limitations

`local-process` is not a security sandbox. A process could access files available to the AgencyOS OS user or use the network. It reduces accidental leakage by:

- not inheriting the application environment;
- using a dedicated runtime home;
- disabling system Git configuration and terminal prompts;
- setting `CI=1`;
- applying output and wall-clock limits;
- using `shell: false`;
- tracking child processes by workspace scope for teardown.

It is disabled as the configured production workspace provider unless explicitly opted in. Repository package scripts should use `docker-isolated`.

## Docker-isolated provider

Package scripts run in a fresh, non-root container with network disabled by default, a read-only root filesystem, isolated IPC, dropped capabilities, no-new-privileges, memory/CPU/PID/file-descriptor limits, bounded tmpfs mounts, and a monitored workspace quota.

The attempt working tree is writable. Its `.git` metadata is mounted read-only. Application credentials and the Docker socket are absent from the child container.

See [`isolated-execution.md`](isolated-execution.md) for the full threat model and residual risks.

## Repository policy

The default policy permits HTTPS repositories only from `github.com`. The host allowlist is configurable. URLs with embedded credentials are rejected. `file:` repositories are available only when the local-repository flag is enabled.

Protected paths include:

- `.git`, `node_modules`, `.npmrc`, Yarn configuration, and real `.env` files;
- private-key, certificate, credential, and secret-like filenames;
- GitHub Actions workflows/actions, common CI configuration, and Git-hook directories.

Every path is normalized, checked against traversal, resolved under the real workspace root, and rejected if any component is a symlink.

## Secret policy

Proposed content is rejected when it resembles private keys, OpenAI/GitHub tokens, MongoDB credential URLs, or explicit high-value credential assignments. This is defense in depth, not a replacement for provider-side secret scanning.

## Resource limits

Environment variables bound:

- changed-file count;
- bytes per file;
- total bytes written;
- repository context files and bytes;
- stored diff bytes;
- command output bytes;
- command wall-clock time;
- validation script names;
- container CPU, memory, PID count, tmpfs, and workspace bytes.

## Validation policy

The model may request only a script name. AgencyOS intersects requested names with:

1. `AGENCY_WORKSPACE_VALIDATION_SCRIPTS`;
2. scripts present in the pre-change `package.json`; and
3. script definitions that remain unchanged after the worker patch.

It invokes the package manager directly as an argument array, such as `npm run typecheck`. No model-authored shell command executes.

`AGENCY_WORKSPACE_DEPENDENCY_MODE=none` performs no install. `frozen` performs a lockfile-respecting install with lifecycle scripts disabled. A failed install is durable failed evidence.

After validation, AgencyOS verifies that the repository patch is unchanged. Validator mutations are removed and the original worker patch is restored before review.

## Evidence and review

Each attempt stores:

- immutable workspace/run/attempt identifiers;
- base ref and SHA;
- generated branch name;
- requested and applied file operations;
- changed files and line statistics;
- bounded patch text and a durable patch artifact;
- every command, exit code, output, truncation, timeout, runtime, and quota flag;
- changed validator definitions;
- validation summary;
- QA score and findings;
- human reviewer, reason, and timestamp;
- publication commit and pull-request URL.

Server-local paths and artifact storage URIs are removed from public API responses. Workspace review controls remain locked until the linked durable delivery reaches `succeeded`, ensuring review evidence has finished persisting.

## Publication invariants

Publication is allowed only when:

1. QA passed at or above the configured threshold.
2. The execution run is `passed` after human workspace approval.
3. The workspace is `approved` with an approved review status.
4. Workspace/project/repository/run identifiers match the proposed action.
5. The current repository tree still produces the exact approved patch relative to the stored base SHA.
6. The external action is separately approved and atomically claimed.

Before push, AgencyOS restores the approved origin, disables Git hooks, commits only when needed, and pushes a unique branch. Pull-request creation reuses an existing open PR for the same head/base pair.

## Retry semantics

A failed or rejected external action can be restored to `proposed`. Repository creation recovers an already-created matching repository. Branch push is safe to repeat. Pull-request creation first searches for an existing open PR.

A failed or dead-lettered execution delivery may also be retried, but it retains its target attempt number. Delivery recovery therefore does not silently consume another agent attempt.

## Remaining production work

For multi-tenant untrusted workloads, move from a local Docker socket to dedicated runner hosts, a remote sandbox API, or microVMs. Add native disk quotas, egress allowlisting, immutable image digests, object storage, centralized telemetry, database transactions for cross-document decisions, and signed provenance.
