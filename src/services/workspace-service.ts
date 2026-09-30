import { createHash } from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";
import type { Project, Task } from "@/schemas/domain";
import type { ExecutionAttempt, ExecutionRun, WorkerOutput } from "@/schemas/execution";
import type {
  WorkspaceCommand,
  WorkspaceFileChange,
  WorkspaceRecord,
  WorkspaceValidationResult,
} from "@/schemas/workspace";
import { workspaceRepository } from "@/repositories/workspace-repository";
import {
  assertRepositoryAllowed,
  normalizeWorkspacePath,
  resolveSafeWorkspacePath,
  sanitizeBranchName,
  selectTrustedValidationScripts,
  validateFileChanges,
  validationScriptAllowlist,
} from "@/services/workspace-policy";
import { localProcessProvider } from "@/workspaces/local-process-provider";
import { workspaceProcessProvider } from "@/workspaces/provider";
import { tenantSecretOrFallback, TENANT_INTEGRATION_SECRET_NAMES } from "@/services/integration-secret-service";
import type { CommandIsolation, SandboxResourceLimits } from "@/workspaces/contracts";

/** Bounded snapshot of a checked-out repository handed to the worker agent. */
export type RepositoryContext = {
  tree: string[];
  files: Array<{ path: string; content: string; truncated: boolean }>;
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
  scripts: string[];
  scriptCommands: Record<string, string>;
  baseSha: string;
};

function assertProviderAllowed() {
  const config = env();
  if (
    config.NODE_ENV === "production" &&
    config.AGENCY_WORKSPACE_PROVIDER === "local-process" &&
    !config.AGENCY_ALLOW_LOCAL_WORKSPACES_IN_PRODUCTION
  ) {
    throw new Error(
      "Local-process workspaces are disabled in production; configure an isolated workspace provider or explicitly opt in",
    );
  }
}

async function gitCredentialEnv(repositoryUrl: string): Promise<NodeJS.ProcessEnv> {
  const config = env();
  const parsed = new URL(repositoryUrl);
  const credentials: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
  };

  const githubToken = parsed.hostname.toLowerCase() === "github.com"
    ? await tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubToken, config.GITHUB_TOKEN)
    : null;
  if (githubToken) {
    const basic = Buffer.from(`x-access-token:${githubToken}`, "utf8").toString("base64");
    credentials.GIT_CONFIG_COUNT = "3";
    credentials.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    credentials.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    credentials.GIT_CONFIG_KEY_1 = "credential.helper";
    credentials.GIT_CONFIG_VALUE_1 = "";
    credentials.GIT_CONFIG_KEY_2 = "core.hooksPath";
    credentials.GIT_CONFIG_VALUE_2 = "/dev/null";
  }
  return credentials;
}

async function pathExists(value: string) {
  try {
    await access(value, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredSandboxLimits(): SandboxResourceLimits {
  const config = env();
  return {
    cpus: config.AGENCY_SANDBOX_CPUS,
    memoryMb: config.AGENCY_SANDBOX_MEMORY_MB,
    pidsLimit: config.AGENCY_SANDBOX_PIDS_LIMIT,
    diskBytes: config.AGENCY_SANDBOX_DISK_BYTES,
    networkMode: config.AGENCY_SANDBOX_NETWORK,
    readOnlyRoot: config.AGENCY_SANDBOX_READ_ONLY,
  };
}

async function remoteWorkspaceDescriptor(workspace: WorkspaceRecord) {
  if (!workspace.baseSha || !workspace.patchPath) {
    throw new Error("Remote sandbox validation requires a base commit and immutable patch evidence");
  }
  const patch = await readFile(workspace.patchPath, "utf8");
  return {
    tenantId: currentTenantId(),
    repositoryUrl: workspace.repositoryUrl,
    baseRef: workspace.baseRef,
    baseSha: workspace.baseSha,
    patchSha256: createHash("sha256").update(patch, "utf8").digest("hex"),
    patch,
  };
}

async function runRecordedCommand(input: {
  workspace: WorkspaceRecord;
  label: string;
  executable: string;
  args: string[];
  actualCwd: string;
  displayCwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitBytes?: number;
  isolation?: CommandIsolation;
  signal?: AbortSignal;
}) {
  const config = env();
  const isolation = input.isolation ?? "trusted";
  const provider = isolation === "sandbox" ? workspaceProcessProvider() : localProcessProvider;
  const record = await workspaceRepository.startCommand({
    workspaceId: input.workspace.id,
    runId: input.workspace.runId,
    attemptId: input.workspace.attemptId,
    label: input.label,
    executable: input.executable,
    args: input.args,
    cwd: input.displayCwd ?? ".",
    isolation,
    runtimeProvider: provider.name,
    resourceLimits: isolation === "sandbox" && provider.name !== "local-process" ? configuredSandboxLimits() : null,
  });

  try {
    const result = await provider.run({
      label: input.label,
      executable: input.executable,
      args: input.args,
      cwd: input.actualCwd,
      timeoutMs: input.timeoutMs ?? config.AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS,
      outputLimitBytes: input.outputLimitBytes ?? config.AGENCY_WORKSPACE_COMMAND_OUTPUT_MAX_BYTES,
      env: input.env,
      isolation,
      scopeId: input.workspace.id,
      mountRoot: input.workspace.localPath,
      remoteWorkspace: provider.name === "remote-http" ? await remoteWorkspaceDescriptor(input.workspace) : undefined,
      signal: input.signal,
    });
    const completed = await workspaceRepository.finishCommand(record.id, result);
    if (!completed) throw new Error(`Command record changed before completion: ${input.label}`);
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed to start";
    await workspaceRepository.finishCommand(record.id, {
      exitCode: null,
      stdout: "",
      stderr: message,
      outputTruncated: false,
      timedOut: false,
      runtimeProvider: provider.name,
      runtimeId: null,
      resourceLimits: isolation === "sandbox" && provider.name !== "local-process" ? configuredSandboxLimits() : null,
      quotaExceeded: false,
      forcedTeardown: false,
      workspacePatchSha256: null,
      integrityViolation: false,
    });
    throw error;
  }
}

function requireCommandSuccess(command: WorkspaceCommand) {
  if (command.status === "succeeded") return command;
  const details = [command.stderr, command.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`${command.label} failed${details ? `: ${details.slice(0, 1_500)}` : ""}`);
}

function workspacePaths(input: { projectId: string; runId: string; attemptId: string }) {
  const config = env();
  const attemptRoot = path.join(config.AGENCY_WORKSPACE_ROOT, input.projectId, input.runId, input.attemptId);
  return {
    attemptRoot,
    repositoryPath: path.join(attemptRoot, "repo"),
    patchPath: path.join(attemptRoot, "changes.patch"),
  };
}

function branchName(run: ExecutionRun, attempt: ExecutionAttempt) {
  return sanitizeBranchName(`agencyos/${run.taskId.slice(0, 12)}-${run.id.slice(0, 8)}-a${attempt.number}`);
}

/**
 * Prepares an isolated workspace for an execution attempt: clones the
 * project's bound repository (shallow, single-branch), creates the attempt
 * branch, records the base commit, and — when the previous attempt's
 * workspace was rejected or needs revision — seeds its patch so revision work
 * continues instead of restarting. Every git step runs as a recorded command
 * for audit, and the workspace is failed on any error.
 *
 * @param input The run, the new attempt, the project, and an optional abort signal.
 * @returns The workspace record in `ready` status (or the current record when
 *   preparation already completed).
 * @throws When the project has no bound repository, the provider or clone URL
 *   is disallowed, or any preparation step fails.
 */
export async function prepareWorkspace(input: {
  run: ExecutionRun;
  attempt: ExecutionAttempt;
  project: Project;
  signal?: AbortSignal;
}) {
  assertProviderAllowed();
  const repository = input.project.repository;
  if (!repository) {
    throw new Error("Project must be bound to a repository before workspace execution can start");
  }
  assertRepositoryAllowed(repository.cloneUrl);

  const paths = workspacePaths({ projectId: input.project.id, runId: input.run.id, attemptId: input.attempt.id });
  const previous = await workspaceRepository.previousForRun(input.run.id);
  const seedWorkspace = previous && ["revision_required", "rejected"].includes(previous.status) ? previous : null;
  const workspace = await workspaceRepository.create({
    runId: input.run.id,
    attemptId: input.attempt.id,
    projectId: input.project.id,
    taskId: input.run.taskId,
    provider: env().AGENCY_WORKSPACE_PROVIDER,
    repositoryUrl: repository.cloneUrl,
    repositoryFullName: repository.fullName,
    baseRef: repository.defaultBranch,
    branchName: branchName(input.run, input.attempt),
    localPath: paths.repositoryPath,
    seededFromWorkspaceId: seedWorkspace?.id ?? null,
  });

  if (workspace.status !== "preparing") return workspace;

  try {
    await rm(paths.attemptRoot, { recursive: true, force: true });
    await mkdir(paths.attemptRoot, { recursive: true });

    const cloneArgs = ["clone", "--no-tags", "--depth", "1", "--branch", workspace.baseRef, "--single-branch"];
    if (new URL(workspace.repositoryUrl).protocol === "file:") cloneArgs.push("--no-hardlinks");
    cloneArgs.push(workspace.repositoryUrl, paths.repositoryPath);

    requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Clone repository",
      executable: "git",
      args: cloneArgs,
      actualCwd: paths.attemptRoot,
      displayCwd: ".",
      env: await gitCredentialEnv(workspace.repositoryUrl),
      timeoutMs: Math.max(env().AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS, 300_000),
      signal: input.signal,
    }));

    requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Create workspace branch",
      executable: "git",
      args: ["checkout", "-b", workspace.branchName],
      actualCwd: paths.repositoryPath,
      signal: input.signal,
    }));

    requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Configure git author name",
      executable: "git",
      args: ["config", "user.name", env().AGENCY_GIT_AUTHOR_NAME],
      actualCwd: paths.repositoryPath,
      signal: input.signal,
    }));
    requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Configure git author email",
      executable: "git",
      args: ["config", "user.email", env().AGENCY_GIT_AUTHOR_EMAIL],
      actualCwd: paths.repositoryPath,
      signal: input.signal,
    }));

    const shaCommand = requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Read base commit",
      executable: "git",
      args: ["rev-parse", "HEAD"],
      actualCwd: paths.repositoryPath,
      signal: input.signal,
    }));
    const baseSha = shaCommand.stdout.trim();
    if (!baseSha) throw new Error("Git did not return a base commit SHA");

    if (seedWorkspace?.patchPath && seedWorkspace.appliedChanges.length > 0 && await pathExists(seedWorkspace.patchPath)) {
      requireCommandSuccess(await runRecordedCommand({
        workspace,
        label: "Seed previous revision patch",
        executable: "git",
        args: ["apply", "--binary", "--whitespace=nowarn", seedWorkspace.patchPath],
        actualCwd: paths.repositoryPath,
        signal: input.signal,
      }));
    }

    const ready = await workspaceRepository.markReady(workspace.id, {
      baseSha,
      patchPath: paths.patchPath,
      seededFromWorkspaceId: seedWorkspace?.id ?? null,
    });
    if (!ready) throw new Error("Workspace state changed before preparation completed");
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace preparation failed";
    await workspaceRepository.fail(workspace.id, "workspace-service", message);
    throw error;
  }
}

function tokenizeTask(task: Task) {
  return new Set(
    `${task.title} ${task.description} ${task.acceptanceCriteria.join(" ")}`
      .toLowerCase()
      .split(/[^a-z0-9._/-]+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 3),
  );
}

function scorePath(filePath: string, terms: Set<string>) {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += term.includes("/") ? 6 : 2;
  }
  if (/^(package\.json|readme(?:\.md)?|tsconfig\.json|vite\.config|next\.config)/i.test(lower)) score += 12;
  if (/\.(?:ts|tsx|js|jsx|json|md|css|scss|yaml|yml)$/i.test(lower)) score += 2;
  if (/\.(?:lock|png|jpg|jpeg|gif|webp|ico|pdf|zip)$/i.test(lower)) score -= 8;
  return score;
}

function isProbablyBinary(content: Buffer) {
  return content.subarray(0, Math.min(content.length, 8_000)).includes(0);
}

async function detectPackageManager(repositoryPath: string): Promise<RepositoryContext["packageManager"]> {
  if (await pathExists(path.join(repositoryPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(repositoryPath, "yarn.lock"))) return "yarn";
  if (await pathExists(path.join(repositoryPath, "package-lock.json"))) return "npm";
  if (await pathExists(path.join(repositoryPath, "package.json"))) return "npm";
  return "unknown";
}

async function readPackageScriptCommands(repositoryPath: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path.join(repositoryPath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(value.scripts ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  } catch {
    return {};
  }
}

/**
 * Builds the bounded repository snapshot given to the worker agent: an
 * inventory of tracked/untracked files, the full text of the most
 * task-relevant files (ranked by keyword score, capped in count and bytes,
 * binaries excluded), detected package manager, and the baseline package.json
 * script definitions that later decide which validation scripts are trusted.
 *
 * @param workspace The prepared workspace to snapshot.
 * @param task The task whose text drives relevance ranking.
 * @param signal Optional abort signal.
 * @returns The repository context.
 * @throws When the inventory command fails or the abort signal fires.
 */
export async function buildRepositoryContext(workspace: WorkspaceRecord, task: Task, signal?: AbortSignal): Promise<RepositoryContext> {
  const config = env();
  const list = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Inventory repository files",
    executable: "git",
    args: ["ls-files", "--cached", "--others", "--exclude-standard"],
    actualCwd: workspace.localPath,
    outputLimitBytes: 2_000_000,
    signal,
  }));

  const tree: string[] = [...new Set<string>(list.stdout.split(/\r?\n/).map((value: string) => value.trim()).filter(Boolean))].slice(0, 2_000);
  const terms = tokenizeTask(task);
  const candidates = tree
    .map((filePath: string) => ({ filePath, score: scorePath(filePath, terms) }))
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

  const files: RepositoryContext["files"] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Repository context collection was aborted");
    if (files.length >= config.AGENCY_WORKSPACE_CONTEXT_MAX_FILES) break;
    let safe;
    try {
      safe = await resolveSafeWorkspacePath(workspace.localPath, candidate.filePath);
    } catch {
      continue;
    }

    try {
      const fileStat = await stat(safe.absolutePath);
      if (!fileStat.isFile() || fileStat.size > config.AGENCY_WORKSPACE_MAX_FILE_BYTES) continue;
      const raw = await readFile(safe.absolutePath);
      if (isProbablyBinary(raw)) continue;
      const remaining = config.AGENCY_WORKSPACE_CONTEXT_MAX_BYTES - totalBytes;
      if (remaining <= 0) break;
      const accepted = raw.subarray(0, remaining);
      files.push({
        path: safe.relativePath,
        content: accepted.toString("utf8"),
        truncated: accepted.length < raw.length,
      });
      totalBytes += accepted.length;
    } catch {
      // Files may disappear between inventory and read; omit rather than failing the run.
    }
  }

  const scriptCommands = await readPackageScriptCommands(workspace.localPath);
  return {
    tree,
    files,
    packageManager: await detectPackageManager(workspace.localPath),
    scripts: Object.keys(scriptCommands),
    scriptCommands,
    baseSha: workspace.baseSha ?? "unknown",
  };
}

async function collectDiff(workspace: WorkspaceRecord, signal?: AbortSignal) {
  const config = env();
  requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Register untracked files for diff",
    executable: "git",
    args: ["add", "-N", "--", "."],
    actualCwd: workspace.localPath,
    signal,
  }));

  const diffCommand = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Capture workspace patch",
    executable: "git",
    args: ["diff", "--binary", "--no-ext-diff", "--", "."],
    actualCwd: workspace.localPath,
    outputLimitBytes: Math.max(config.AGENCY_WORKSPACE_DIFF_MAX_BYTES * 6, 4_000_000),
    signal,
  }));
  if (diffCommand.outputTruncated) throw new Error("Workspace patch exceeded the maximum internal capture size");
  if (!workspace.patchPath) throw new Error("Workspace patch path is missing");
  await writeFile(workspace.patchPath, diffCommand.stdout, "utf8");

  const numstat = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Calculate patch statistics",
    executable: "git",
    args: ["diff", "--numstat", "--", "."],
    actualCwd: workspace.localPath,
    signal,
  }));
  let additions = 0;
  let deletions = 0;
  const changedFiles: string[] = [];
  for (const line of numstat.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    if (added && added !== "-") additions += Number.parseInt(added, 10) || 0;
    if (deleted && deleted !== "-") deletions += Number.parseInt(deleted, 10) || 0;
    const changedPath = pathParts.join("\t").trim();
    if (changedPath) changedFiles.push(changedPath);
  }

  const diffBytes = Buffer.byteLength(diffCommand.stdout, "utf8");
  const diffTruncated = diffBytes > config.AGENCY_WORKSPACE_DIFF_MAX_BYTES;
  const diff = diffTruncated
    ? Buffer.from(diffCommand.stdout, "utf8").subarray(0, config.AGENCY_WORKSPACE_DIFF_MAX_BYTES).toString("utf8")
    : diffCommand.stdout;

  return { changedFiles: [...new Set(changedFiles)], additions, deletions, diff, diffTruncated };
}

/**
 * Applies worker-proposed file changes to the workspace after policy
 * validation. Create/update/delete semantics are enforced strictly (a create
 * must not overwrite, an update/delete must target an existing file), then
 * the resulting patch, change statistics, and change list are captured as the
 * workspace's reviewable evidence. The workspace is failed on any error.
 *
 * @param workspace The ready workspace.
 * @param changes Validated file changes proposed by the worker.
 * @param signal Optional abort signal checked between file writes.
 * @returns The workspace record with applied changes and captured diff.
 * @throws When the changes violate policy, the workspace cannot accept
 *   changes from its current state, or a filesystem/git step fails.
 */
export async function applyWorkspaceChanges(workspace: WorkspaceRecord, changes: WorkspaceFileChange[], signal?: AbortSignal) {
  validateFileChanges(changes);
  const applying = await workspaceRepository.markApplying(workspace.id, changes);
  if (!applying) throw new Error("Workspace cannot accept changes from its current state");

  try {
    for (const change of changes) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Workspace change application was aborted");
      const safe = await resolveSafeWorkspacePath(workspace.localPath, change.path);
      const exists = await pathExists(safe.absolutePath);
      if (change.operation === "create" && exists) throw new Error(`Create target already exists: ${safe.relativePath}`);
      if (change.operation === "update" && !exists) throw new Error(`Update target does not exist: ${safe.relativePath}`);
      if (change.operation === "delete" && !exists) throw new Error(`Delete target does not exist: ${safe.relativePath}`);

      if (change.operation === "delete") {
        const targetStat = await stat(safe.absolutePath);
        if (!targetStat.isFile()) throw new Error(`Only regular files may be deleted: ${safe.relativePath}`);
        await unlink(safe.absolutePath);
      } else {
        await mkdir(path.dirname(safe.absolutePath), { recursive: true });
        await writeFile(safe.absolutePath, change.content ?? "", { encoding: "utf8", flag: change.operation === "create" ? "wx" : "w" });
      }
    }

    const evidence = await collectDiff(applying, signal);
    const completed = await workspaceRepository.markChangesApplied(workspace.id, {
      appliedChanges: changes,
      ...evidence,
    });
    if (!completed) throw new Error("Workspace state changed before changes were recorded");
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Applying workspace changes failed";
    await workspaceRepository.fail(workspace.id, "workspace-service", message);
    throw error;
  }
}

function packageCommand(packageManager: RepositoryContext["packageManager"], script: string) {
  switch (packageManager) {
    case "pnpm": return { executable: "pnpm", args: ["run", script] };
    case "yarn": return { executable: "yarn", args: ["run", script] };
    case "npm": return { executable: "npm", args: ["run", script] };
    default: return null;
  }
}

function dependencyInstallCommand(packageManager: RepositoryContext["packageManager"]) {
  switch (packageManager) {
    case "pnpm": return { executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
    case "yarn": return { executable: "yarn", args: ["install", "--immutable", "--mode=skip-build"] };
    case "npm": return { executable: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
    default: return null;
  }
}

async function verifyValidationPatchStability(
  workspace: WorkspaceRecord,
  expectedPatch: string,
  signal?: AbortSignal,
) {
  const commands: WorkspaceCommand[] = [];
  commands.push(requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Register validation-created files for integrity check",
    executable: "git",
    args: ["add", "-N", "--", "."],
    actualCwd: workspace.localPath,
    signal,
  })));

  const currentPatch = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Verify validation preserved reviewed patch",
    executable: "git",
    args: ["diff", "--binary", "--no-ext-diff", "--", "."],
    actualCwd: workspace.localPath,
    outputLimitBytes: Math.max(env().AGENCY_WORKSPACE_DIFF_MAX_BYTES * 6, 4_000_000),
    signal,
  }));
  commands.push(currentPatch);
  if (currentPatch.outputTruncated) {
    throw new Error("Post-validation patch verification output was truncated");
  }

  const expectedHash = createHash("sha256").update(expectedPatch).digest("hex");
  const currentHash = createHash("sha256").update(currentPatch.stdout).digest("hex");
  if (expectedHash === currentHash) return { unchanged: true, commands };

  // Validation mutated the tree (build output, codegen, etc.). The reviewed
  // patch is the only content allowed to survive validation, so the tree is
  // reset to the base commit and the reviewed patch is reapplied verbatim.

  if (!workspace.baseSha || !workspace.patchPath) {
    throw new Error("Workspace is missing the patch evidence required for safe restoration");
  }

  commands.push(requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Restore reviewed patch after validation mutation",
    executable: "git",
    args: ["reset", "--hard", workspace.baseSha],
    actualCwd: workspace.localPath,
    signal,
  })));
  commands.push(requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Remove validation-created untracked files",
    executable: "git",
    args: ["clean", "-fd", "--", "."],
    actualCwd: workspace.localPath,
    signal,
  })));
  if (expectedPatch.length > 0) {
    commands.push(requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Reapply reviewed patch after validation mutation",
      executable: "git",
      args: ["apply", "--binary", "--whitespace=nowarn", workspace.patchPath],
      actualCwd: workspace.localPath,
      signal,
    })));
  }

  return { unchanged: false, commands };
}

/**
 * Runs the workspace validation gate: optionally installs locked
 * dependencies, then executes only the allowlisted validation scripts whose
 * package.json definitions were not modified by the worker patch. Afterwards
 * the repository patch is re-hashed and compared against the reviewed patch —
 * validation must never mutate the change set under review; if it did, the
 * reviewed patch is restored and validation counts as failed. The recorded
 * commands and a machine-readable validation result are persisted on the
 * workspace as authoritative QA evidence.
 *
 * @param workspace The workspace with applied changes.
 * @param repositoryContext Baseline repository snapshot from before the changes.
 * @param requestedScripts Scripts requested by the worker; defaults to the
 *   whole allowlist when empty.
 * @param signal Optional abort signal.
 * @returns The validated workspace record and every recorded command.
 * @throws When the workspace cannot enter validation or a required step fails.
 */
export async function validateWorkspace(
  workspace: WorkspaceRecord,
  repositoryContext: RepositoryContext,
  requestedScripts: string[],
  signal?: AbortSignal,
): Promise<{ workspace: WorkspaceRecord; commands: WorkspaceCommand[] }> {
  const validating = await workspaceRepository.markValidationStarted(workspace.id);
  if (!validating) throw new Error("Workspace cannot start validation from its current state");
  if (!validating.patchPath) throw new Error("Workspace patch path is missing before validation");

  const expectedPatch = await readFile(validating.patchPath, "utf8");
  const expectedPatchSha256 = createHash("sha256").update(expectedPatch, "utf8").digest("hex");
  const allowed = validationScriptAllowlist();
  const requested = requestedScripts.length ? requestedScripts : allowed;
  const currentScriptCommands = await readPackageScriptCommands(validating.localPath);
  const selected = selectTrustedValidationScripts({
    requested,
    allowed,
    original: repositoryContext.scriptCommands,
    current: currentScriptCommands,
  });
  const {
    requested: normalizedRequested,
    scripts,
    skippedScripts,
    changedScripts,
  } = selected;
  const commands: WorkspaceCommand[] = [];
  const executionCommands: WorkspaceCommand[] = [];
  const executedScripts: string[] = [];
  let installFailed = false;

  try {
    if (env().AGENCY_WORKSPACE_DEPENDENCY_MODE === "frozen") {
      const install = dependencyInstallCommand(repositoryContext.packageManager);
      if (install) {
        const command = await runRecordedCommand({
          workspace: validating,
          label: "Install locked dependencies",
          executable: install.executable,
          args: install.args,
          actualCwd: validating.localPath,
          timeoutMs: Math.max(env().AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS, 600_000),
          isolation: "sandbox",
          signal,
        });
        commands.push(command);
        executionCommands.push(command);
        installFailed = command.status !== "succeeded";
      }
    }

    if (!installFailed) {
      for (const script of scripts) {
        const commandSpec = packageCommand(repositoryContext.packageManager, script);
        if (!commandSpec) break;
        const command = await runRecordedCommand({
          workspace: validating,
          label: `Validate: ${script}`,
          executable: commandSpec.executable,
          args: commandSpec.args,
          actualCwd: validating.localPath,
          isolation: "sandbox",
          signal,
        });
        commands.push(command);
        executionCommands.push(command);
        executedScripts.push(script);
      }
    }

    const integrity = await verifyValidationPatchStability(validating, expectedPatch, signal);
    commands.push(...integrity.commands);

    const failedLabels = executionCommands
      .filter((command) => command.status !== "succeeded")
      .map((command) => command.label);
    const remoteIntegrityPassed = executionCommands.every((command) =>
      command.runtimeProvider !== "remote-http"
      || (!command.integrityViolation && command.workspacePatchSha256 === expectedPatchSha256),
    );
    const passed = !installFailed
      && scripts.length > 0
      && changedScripts.length === 0
      && executedScripts.length === scripts.length
      && executionCommands.every((command) => command.status === "succeeded")
      && remoteIntegrityPassed
      && integrity.unchanged;

    const summary = changedScripts.length > 0
      ? `Validation script definitions changed in the worker patch and were not trusted: ${changedScripts.join(", ")}.`
      : !remoteIntegrityPassed
        ? "Remote sandbox evidence did not match the submitted workspace patch digest."
      : !integrity.unchanged
      ? "Validation commands modified the repository patch. AgencyOS restored the worker patch and requires a new revision."
      : installFailed
        ? "Locked dependency installation failed; validation scripts were not run."
        : scripts.length === 0
          ? "No allowlisted validation scripts were available in package.json."
          : failedLabels.length > 0
            ? `Validation failed: ${failedLabels.join(", ")}.`
            : passed
              ? `All ${executedScripts.length} validation command(s) passed and preserved the reviewed patch.`
              : "Validation did not complete every requested allowlisted script.";

    const validation: WorkspaceValidationResult = {
      requestedScripts: normalizedRequested,
      executedScripts,
      skippedScripts,
      changedScripts,
      passed,
      summary,
      commandIds: commands.map((command) => command.id),
    };
    const completed = await workspaceRepository.markValidationCompleted(validating.id, validation);
    if (!completed) throw new Error("Workspace state changed before validation completed");
    return { workspace: completed, commands };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace validation failed";
    await workspaceRepository.fail(workspace.id, "workspace-service", message);
    throw error;
  }
}

/**
 * Appends control-plane-produced evidence artifacts (the verified patch and
 * the validation command log) to the worker's self-reported output, so QA
 * judges authoritative records rather than worker claims.
 *
 * @param input Worker output plus the validated workspace and its commands.
 * @returns Worker output with the evidence artifacts appended (capped at 20).
 */
export function enrichWorkerOutput(input: {
  output: WorkerOutput;
  workspace: WorkspaceRecord;
  commands: WorkspaceCommand[];
}): WorkerOutput {
  const commandEvidence = input.commands.map((command) => ({
    label: command.label,
    status: command.status,
    exitCode: command.exitCode,
    stdout: command.stdout.slice(0, 8_000),
    stderr: command.stderr.slice(0, 8_000),
    truncated: command.outputTruncated,
  }));

  return {
    ...input.output,
    artifacts: [
      ...input.output.artifacts,
      {
        type: "code",
        title: "Verified workspace patch",
        description: `${input.workspace.changedFiles.length} changed file(s), +${input.workspace.additions}/-${input.workspace.deletions}`,
        content: input.workspace.diff,
        path: null,
        url: null,
        metadata: {
          workspaceId: input.workspace.id,
          branchName: input.workspace.branchName,
          baseSha: input.workspace.baseSha,
          changedFiles: input.workspace.changedFiles,
          diffTruncated: input.workspace.diffTruncated,
        },
      },
      {
        type: "test",
        title: "Workspace validation evidence",
        description: input.workspace.validation?.summary ?? "Validation did not produce a summary.",
        content: JSON.stringify(commandEvidence, null, 2),
        path: null,
        url: null,
        metadata: {
          workspaceId: input.workspace.id,
          passed: input.workspace.validation?.passed ?? false,
          executedScripts: input.workspace.validation?.executedScripts ?? [],
          skippedScripts: input.workspace.validation?.skippedScripts ?? [],
          changedScripts: input.workspace.validation?.changedScripts ?? [],
        },
      },
    ].slice(0, 20),
  };
}

/**
 * Assembles the authoritative evidence package handed to the QA agent for a
 * workspace-mode attempt: patch text, change statistics, validation outcome,
 * and bounded command transcripts.
 *
 * @param workspace The validated workspace.
 * @param commands Commands recorded during validation.
 * @returns The evidence object embedded in the QA prompt.
 */
export function workspaceEvidenceForQa(workspace: WorkspaceRecord, commands: WorkspaceCommand[]) {
  return {
    workspaceId: workspace.id,
    repositoryFullName: workspace.repositoryFullName,
    baseRef: workspace.baseRef,
    baseSha: workspace.baseSha,
    branchName: workspace.branchName,
    changedFiles: workspace.changedFiles,
    additions: workspace.additions,
    deletions: workspace.deletions,
    diff: workspace.diff,
    diffTruncated: workspace.diffTruncated,
    validation: workspace.validation,
    commands: commands.map((command) => ({
      label: command.label,
      status: command.status,
      exitCode: command.exitCode,
      stdout: command.stdout.slice(0, 12_000),
      stderr: command.stderr.slice(0, 12_000),
      outputTruncated: command.outputTruncated,
      timedOut: command.timedOut,
    })),
  };
}

/**
 * Commits and pushes a human-approved local workspace branch. Before any
 * push, the on-disk working tree is re-diffed against the base commit and
 * hash-compared with the stored approved patch — content that changed after
 * review must go through a new QA and approval cycle instead of being
 * published. Git hooks are disabled for commit and push.
 *
 * @param workspace The approved workspace.
 * @param commitMessage Commit message (truncated to 220 characters).
 * @returns The published commit SHA.
 * @throws When the workspace is not approved, has no changes, its contents
 *   drifted from the approved patch, or any git step fails.
 */
export async function publishWorkspaceBranch(workspace: WorkspaceRecord, commitMessage: string) {
  if (workspace.status !== "approved" || workspace.reviewStatus !== "approved") {
    throw new Error("Workspace must be human-approved before it can be published");
  }
  if (!workspace.changedFiles.length) throw new Error("Workspace has no changed files to publish");

  if (!workspace.baseSha || !workspace.patchPath) {
    throw new Error("Workspace is missing its approved patch evidence");
  }
  const approvedPatch = await readFile(workspace.patchPath, "utf8");
  const currentPatch = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Verify approved workspace patch",
    executable: "git",
    args: ["diff", "--binary", "--no-ext-diff", workspace.baseSha, "--", "."],
    actualCwd: workspace.localPath,
    outputLimitBytes: Math.max(env().AGENCY_WORKSPACE_DIFF_MAX_BYTES * 6, 4_000_000),
  }));
  if (currentPatch.outputTruncated) throw new Error("Workspace patch verification output was truncated");
  const approvedHash = createHash("sha256").update(approvedPatch).digest("hex");
  const currentHash = createHash("sha256").update(currentPatch.stdout).digest("hex");
  if (approvedHash !== currentHash) {
    throw new Error("Workspace contents changed after review; a new QA and human approval cycle is required");
  }

  const gitEnv = await gitCredentialEnv(workspace.repositoryUrl);
  requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Restore approved repository remote",
    executable: "git",
    args: ["remote", "set-url", "origin", workspace.repositoryUrl],
    actualCwd: workspace.localPath,
  }));
  requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Stage approved workspace",
    executable: "git",
    args: ["add", "--all", "--", "."],
    actualCwd: workspace.localPath,
  }));

  const stagedDiff = await runRecordedCommand({
    workspace,
    label: "Check staged workspace changes",
    executable: "git",
    args: ["diff", "--cached", "--quiet", "--exit-code", "--", "."],
    actualCwd: workspace.localPath,
  });
  if (stagedDiff.timedOut || stagedDiff.exitCode === null || ![0, 1].includes(stagedDiff.exitCode)) {
    requireCommandSuccess(stagedDiff);
  }

  // Exit code 1 means there is a staged diff. Exit code 0 can occur on a retry
  // after the commit already succeeded locally but the push/PR request failed.
  if (stagedDiff.exitCode === 1) {
    requireCommandSuccess(await runRecordedCommand({
      workspace,
      label: "Commit approved workspace",
      executable: "git",
      args: ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-m", commitMessage.slice(0, 220)],
      actualCwd: workspace.localPath,
    }));
  }

  const sha = requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Read published commit",
    executable: "git",
    args: ["rev-parse", "HEAD"],
    actualCwd: workspace.localPath,
  })).stdout.trim();
  if (!sha) throw new Error("Git did not return the published commit SHA");
  if (stagedDiff.exitCode === 0 && sha === workspace.baseSha) {
    throw new Error("Workspace has no committed changes to publish");
  }

  requireCommandSuccess(await runRecordedCommand({
    workspace,
    label: "Push approved workspace branch",
    executable: "git",
    args: ["-c", "core.hooksPath=/dev/null", "push", "--set-upstream", "origin", `HEAD:refs/heads/${workspace.branchName}`],
    actualCwd: workspace.localPath,
    env: gitEnv,
    timeoutMs: Math.max(env().AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS, 300_000),
  }));
  return sha;
}

/**
 * Computes a content fingerprint over the workspace's base commit, patch, and
 * branch name. Used in idempotency keys so a re-proposed publish collapses
 * unless the reviewed content actually changed.
 *
 * @param workspace The workspace to fingerprint.
 * @returns SHA-256 hex digest of the workspace's identifying content.
 */
export function workspaceFingerprint(workspace: WorkspaceRecord) {
  return createHash("sha256")
    .update(`${workspace.baseSha ?? ""}\n${workspace.diff}\n${workspace.branchName}`)
    .digest("hex");
}
