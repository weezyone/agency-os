import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CommandRequest, CommandResult, WorkspaceProcessProvider } from "@/workspaces/contracts";
import { unrefTimer } from "@/lib/timers";

const runtimeHome = path.join(process.env.TMPDIR ?? "/tmp", "agency-os-runtime-home");
mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
const activeByScope = new Map<string, Set<ChildProcess>>();

function restrictedEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Workspace commands must not inherit AgencyOS credentials (OpenAI, MongoDB,
  // GitHub, Linear, etc.). Only basic process/runtime values are inherited.
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    HOME: runtimeHome,
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  return {
    NODE_ENV: process.env.NODE_ENV,
    ...Object.fromEntries(
      Object.entries({ ...base, ...overrides }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
}

function appendLimited(current: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, limit: number) {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  const accepted = chunk.subarray(0, remaining);
  current.push(accepted);
  state.bytes += accepted.length;
  if (accepted.length < chunk.length) state.truncated = true;
}

function track(scopeId: string, child: ChildProcess) {
  const processes = activeByScope.get(scopeId) ?? new Set<ChildProcess>();
  processes.add(child);
  activeByScope.set(scopeId, processes);
  return () => {
    processes.delete(child);
    if (processes.size === 0) activeByScope.delete(scopeId);
  };
}

function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  unrefTimer(killTimer);
}

export const localProcessProvider: WorkspaceProcessProvider = {
  name: "local-process",
  run(request: CommandRequest) {
    return new Promise<CommandResult>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(request.signal.reason instanceof Error ? request.signal.reason : new Error("Command was aborted before start"));
        return;
      }

      const startedAt = new Date();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { bytes: 0, truncated: false };
      const stderrState = { bytes: 0, truncated: false };
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: restrictedEnvironment(request.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const untrack = track(request.scopeId, child);
      const abort = () => {
        aborted = true;
        terminate(child);
      };
      request.signal?.addEventListener("abort", abort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, request.timeoutMs);
      unrefTimer(timer);

      child.stdout?.on("data", (chunk: Buffer) => appendLimited(stdout, chunk, stdoutState, request.outputLimitBytes));
      child.stderr?.on("data", (chunk: Buffer) => appendLimited(stderr, chunk, stderrState, request.outputLimitBytes));

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        untrack();
        reject(error);
      });

      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        untrack();
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          outputTruncated: stdoutState.truncated || stderrState.truncated,
          timedOut,
          startedAt,
          completedAt: new Date(),
          runtimeProvider: "local-process",
          runtimeId: child.pid ? String(child.pid) : null,
          resourceLimits: null,
          quotaExceeded: false,
          forcedTeardown: timedOut || aborted,
          workspacePatchSha256: null,
          integrityViolation: false,
        });
      });
    });
  },

  async terminateScope(scopeId: string) {
    const processes = [...(activeByScope.get(scopeId) ?? [])];
    for (const process of processes) terminate(process);
    return processes.length;
  },
};
