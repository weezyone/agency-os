/** Execution trust level: "trusted" runs in-process, "sandbox" must be isolated by the provider. */
export type CommandIsolation = "trusted" | "sandbox";
export type WorkspaceRuntimeProvider = "local-process" | "docker-isolated" | "remote-http";

export type SandboxResourceLimits = {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  diskBytes: number;
  networkMode: "none" | "bridge";
  readOnlyRoot: boolean;
};

/** Immutable repository and patch evidence a remote sandbox materializes before running commands. */
export type RemoteWorkspaceDescriptor = {
  tenantId: string;
  repositoryUrl: string;
  baseRef: string;
  baseSha: string;
  patchSha256: string;
  patch: string;
};

export type CommandRequest = {
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: NodeJS.ProcessEnv;
  isolation: CommandIsolation;
  scopeId: string;
  mountRoot?: string;
  signal?: AbortSignal;
  remoteWorkspace?: RemoteWorkspaceDescriptor;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  startedAt: Date;
  completedAt: Date;
  runtimeProvider: WorkspaceRuntimeProvider;
  runtimeId: string | null;
  resourceLimits: SandboxResourceLimits | null;
  quotaExceeded: boolean;
  forcedTeardown: boolean;
  workspacePatchSha256: string | null;
  integrityViolation: boolean;
};

export type WorkspaceProviderHealth = {
  provider: WorkspaceRuntimeProvider;
  available: boolean;
  version: string | null;
  image: string | null;
  message: string;
};

/** Contract every workspace runtime (local, Docker, remote HTTP sandbox) implements to run commands. */
export interface WorkspaceProcessProvider {
  readonly name: WorkspaceRuntimeProvider;
  run(request: CommandRequest): Promise<CommandResult>;
  terminateScope?(scopeId: string): Promise<number>;
  cleanupOrphans?(): Promise<number>;
  health?(): Promise<WorkspaceProviderHealth>;
}
