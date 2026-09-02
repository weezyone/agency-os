import { env } from "@/lib/env";
import { dockerIsolatedProvider } from "@/workspaces/docker-isolated-provider";
import { localProcessProvider } from "@/workspaces/local-process-provider";
import { remoteHttpProvider } from "@/workspaces/remote-http-provider";
import type { WorkspaceProcessProvider } from "@/workspaces/contracts";

export function workspaceProcessProvider(): WorkspaceProcessProvider {
  switch (env().AGENCY_WORKSPACE_PROVIDER) {
    case "docker-isolated": return dockerIsolatedProvider;
    case "remote-http": return remoteHttpProvider;
    case "local-process": return localProcessProvider;
    default: throw new Error(`Unsupported workspace provider: ${String(env().AGENCY_WORKSPACE_PROVIDER)}`);
  }
}

export async function terminateWorkspaceRuntime(scopeId: string) {
  const provider = workspaceProcessProvider();
  const providers = provider.name === localProcessProvider.name
    ? [localProcessProvider]
    : [localProcessProvider, provider];
  const terminated = await Promise.all(
    providers.map((candidate) => candidate.terminateScope ? candidate.terminateScope(scopeId) : 0),
  );
  return terminated.reduce((total, count) => total + count, 0);
}

export async function cleanupOrphanedWorkspaceRuntimes() {
  const provider = workspaceProcessProvider();
  return provider.cleanupOrphans ? provider.cleanupOrphans() : 0;
}
