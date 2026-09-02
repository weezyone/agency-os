import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { lstat, opendir } from "node:fs/promises";
import { env } from "@/lib/env";
import { unrefTimer } from "@/lib/timers";
import type {
  CommandRequest,
  CommandResult,
  SandboxResourceLimits,
  WorkspaceProcessProvider,
} from "@/workspaces/contracts";

const SANDBOX_EXECUTABLES = new Set(["npm", "pnpm", "yarn"]);

function appendLimited(current: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, limit: number) {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const accepted = chunk.subarray(0, limit - state.bytes);
  current.push(accepted);
  state.bytes += accepted.length;
  if (accepted.length < chunk.length) state.truncated = true;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONTEXT"];
  return Object.fromEntries(
    allowed
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      const target = path.join(current, entry.name);
      let stats;
      try {
        stats = await lstat(target);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) stack.push(target);
      else if (stats.isFile()) bytes += stats.size;
    }
  }
  return bytes;
}

function safeContainerName(scopeId: string) {
  const scope = scopeId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40) || "workspace";
  return `agencyos-${scope}-${randomBytes(5).toString("hex")}`.slice(0, 63);
}

function mountTarget(request: CommandRequest) {
  if (!request.mountRoot) throw new Error("Docker sandbox commands require a mount root");
  const root = path.resolve(request.mountRoot);
  const workspaceRoot = path.resolve(env().AGENCY_WORKSPACE_ROOT);
  const workspaceRelative = path.relative(workspaceRoot, root);
  if (workspaceRelative.startsWith("..") || path.isAbsolute(workspaceRelative)) {
    throw new Error("Sandbox mount root escapes the configured workspace root");
  }

  const cwd = path.resolve(request.cwd);
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Sandbox working directory escapes its mount root");

  const configuredHostRoot = env().AGENCY_SANDBOX_HOST_WORKSPACE_ROOT;
  if (configuredHostRoot && !path.isAbsolute(configuredHostRoot)) {
    throw new Error("AGENCY_SANDBOX_HOST_WORKSPACE_ROOT must be an absolute path");
  }
  const source = configuredHostRoot
    ? path.resolve(configuredHostRoot, workspaceRelative)
    : root;
  if ([root, source].some((value) => value.includes(",") || value.includes("\n"))) {
    throw new Error("Sandbox mount path contains unsupported characters");
  }
  return {
    root,
    source,
    gitSource: path.join(source, ".git"),
    containerCwd: relative ? `/workspace/${relative.split(path.sep).join("/")}` : "/workspace",
  };
}

function resourceLimits(): SandboxResourceLimits {
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

function sandboxUser() {
  const configured = env().AGENCY_SANDBOX_USER;
  if (configured) return configured;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}

function runDocker(args: string[], options: { timeoutMs: number; outputLimitBytes: number; signal?: AbortSignal }) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Docker command was aborted before start"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(env().AGENCY_SANDBOX_DOCKER_BINARY, args, {
      env: dockerEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      unrefTimer(killTimer);
    };
    options.signal?.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    unrefTimer(timer);
    child.stdout?.on("data", (chunk: Buffer) => appendLimited(stdout, chunk, stdoutState, options.outputLimitBytes));
    child.stderr?.on("data", (chunk: Buffer) => appendLimited(stderr, chunk, stderrState, options.outputLimitBytes));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated: stdoutState.truncated || stderrState.truncated,
      });
    });
  });
}

async function removeContainer(name: string) {
  const config = env();
  await runDocker(["rm", "-f", name], {
    timeoutMs: config.AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS,
    outputLimitBytes: 32_000,
  }).catch(() => undefined);
}

export function buildDockerRunArguments(
  request: CommandRequest,
  containerName: string,
  expiresAt: number,
) {
  if (request.isolation !== "sandbox") throw new Error("Docker isolated provider only accepts sandbox commands");
  if (!SANDBOX_EXECUTABLES.has(request.executable)) {
    throw new Error(`Executable is not allowed in the Docker sandbox: ${request.executable}`);
  }

  const config = env();
  const limits = resourceLimits();
  const mounted = mountTarget(request);
  const args = [
    "run",
    "--rm",
    "--name", containerName,
    "--label", "agencyos.managed=true",
    "--label", `agencyos.scope=${request.scopeId.replace(/[^A-Za-z0-9_.-]+/g, "-")}`,
    "--label", `agencyos.expires=${expiresAt}`,
    "--pull", "never",
    "--network", limits.networkMode,
    "--ipc", "none",
    "--cpus", String(limits.cpus),
    "--memory", `${limits.memoryMb}m`,
    "--memory-swap", `${limits.memoryMb}m`,
    "--pids-limit", String(limits.pidsLimit),
    "--ulimit", "nofile=1024:1024",
    "--init",
    "--stop-timeout", "2",
    "--user", sandboxUser(),
    "--workdir", mounted.containerCwd,
    "--mount", `type=bind,src=${mounted.source},dst=/workspace,rw,bind-propagation=rprivate`,
    "--mount", `type=bind,src=${mounted.gitSource},dst=/workspace/.git,readonly,bind-propagation=rprivate`,
    "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${limits.memoryMb > 512 ? config.AGENCY_SANDBOX_TMPFS_MB : Math.min(config.AGENCY_SANDBOX_TMPFS_MB, 128)}m`,
    "--tmpfs", "/home/runner:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--env", "HOME=/home/runner",
    "--env", "TMPDIR=/tmp",
    "--env", "CI=1",
    "--env", "NO_COLOR=1",
    "--env", "npm_config_audit=false",
    "--env", "npm_config_fund=false",
    "--env", "npm_config_update_notifier=false",
  ];
  if (limits.readOnlyRoot) args.push("--read-only");
  if (config.AGENCY_SANDBOX_DROP_CAPABILITIES) args.push("--cap-drop", "ALL");
  if (config.AGENCY_SANDBOX_NO_NEW_PRIVILEGES) args.push("--security-opt", "no-new-privileges=true");
  args.push(config.AGENCY_SANDBOX_IMAGE, request.executable, ...request.args);
  return { args, limits, mounted };
}

export const dockerIsolatedProvider: WorkspaceProcessProvider = {
  name: "docker-isolated",

  async run(request: CommandRequest): Promise<CommandResult> {
    const config = env();
    const containerName = safeContainerName(request.scopeId);
    const expiresAt = Math.floor((Date.now() + request.timeoutMs + config.AGENCY_RUNNER_ORPHAN_GRACE_MS) / 1_000);
    const { args, limits, mounted } = buildDockerRunArguments(request, containerName, expiresAt);
    const initialBytes = await directoryBytes(mounted.root);
    if (initialBytes > limits.diskBytes) throw new Error("Workspace exceeds its disk quota before sandbox execution");

    const startedAt = new Date();
    let quotaExceeded = false;
    let forcedTeardown = false;
    let finished = false;
    let quotaCheckInFlight = false;
    const quotaWatch = setInterval(() => {
      if (finished || quotaCheckInFlight) return;
      quotaCheckInFlight = true;
      void directoryBytes(mounted.root)
        .then((bytes) => {
          if (!finished && !quotaExceeded && bytes > limits.diskBytes) {
            quotaExceeded = true;
            forcedTeardown = true;
            void removeContainer(containerName);
          }
        })
        .catch(() => undefined)
        .finally(() => { quotaCheckInFlight = false; });
    }, 750);
    unrefTimer(quotaWatch);

    const abortTeardown = () => {
      forcedTeardown = true;
      void removeContainer(containerName);
    };
    request.signal?.addEventListener("abort", abortTeardown, { once: true });

    try {
      const result = await runDocker(args, {
        timeoutMs: request.timeoutMs,
        outputLimitBytes: request.outputLimitBytes,
        signal: request.signal,
      });
      if (result.timedOut || request.signal?.aborted) {
        forcedTeardown = true;
        await removeContainer(containerName);
      }
      const finalBytes = await directoryBytes(mounted.root);
      if (finalBytes > limits.diskBytes) quotaExceeded = true;
      return {
        exitCode: quotaExceeded ? null : result.exitCode,
        stdout: result.stdout,
        stderr: quotaExceeded
          ? `${result.stderr}${result.stderr ? "\n" : ""}Workspace disk quota exceeded; sandbox was terminated.`
          : result.stderr,
        outputTruncated: result.truncated,
        timedOut: result.timedOut,
        startedAt,
        completedAt: new Date(),
        runtimeProvider: "docker-isolated",
        runtimeId: containerName,
        resourceLimits: limits,
        quotaExceeded,
        forcedTeardown,
        workspacePatchSha256: null,
        integrityViolation: false,
      };
    } finally {
      finished = true;
      clearInterval(quotaWatch);
      request.signal?.removeEventListener("abort", abortTeardown);
      await removeContainer(containerName);
    }
  },

  async terminateScope(scopeId: string) {
    const result = await runDocker([
      "ps", "-aq", "--filter", "label=agencyos.managed=true", "--filter", `label=agencyos.scope=${scopeId.replace(/[^A-Za-z0-9_.-]+/g, "-")}`,
    ], { timeoutMs: env().AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS, outputLimitBytes: 64_000 });
    const ids = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    await Promise.all(ids.map((id) => removeContainer(id)));
    return ids.length;
  },

  async cleanupOrphans() {
    const listed = await runDocker(
      ["ps", "-aq", "--filter", "label=agencyos.managed=true"],
      { timeoutMs: env().AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS, outputLimitBytes: 128_000 },
    );
    const ids = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    let removed = 0;
    for (const id of ids) {
      const inspected = await runDocker(
        ["inspect", "--format", "{{index .Config.Labels \"agencyos.expires\"}}", id],
        { timeoutMs: env().AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS, outputLimitBytes: 16_000 },
      ).catch(() => null);
      const expires = Number(inspected?.stdout.trim());
      if (Number.isFinite(expires) && expires > 0 && expires <= Math.floor(Date.now() / 1_000)) {
        await removeContainer(id);
        removed += 1;
      }
    }
    return removed;
  },

  async health() {
    try {
      const version = await runDocker(
        ["version", "--format", "{{.Server.Version}}"],
        { timeoutMs: 10_000, outputLimitBytes: 16_000 },
      );
      if (version.exitCode !== 0) throw new Error(version.stderr || "Docker server unavailable");
      const image = await runDocker(
        ["image", "inspect", env().AGENCY_SANDBOX_IMAGE, "--format", "{{.Id}}"],
        { timeoutMs: 10_000, outputLimitBytes: 16_000 },
      );
      if (image.exitCode !== 0) throw new Error(`Sandbox image is unavailable: ${env().AGENCY_SANDBOX_IMAGE}`);
      return {
        provider: "docker-isolated" as const,
        available: true,
        version: version.stdout.trim() || null,
        image: image.stdout.trim() || env().AGENCY_SANDBOX_IMAGE,
        message: "Docker daemon and sandbox image are available",
      };
    } catch (error) {
      return {
        provider: "docker-isolated" as const,
        available: false,
        version: null,
        image: env().AGENCY_SANDBOX_IMAGE,
        message: error instanceof Error ? error.message : "Docker sandbox health check failed",
      };
    }
  },
};
