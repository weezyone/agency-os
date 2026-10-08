import { env } from "@/lib/env";
import { dockerIsolatedProvider } from "@/workspaces/docker-isolated-provider";
import { localProcessProvider } from "@/workspaces/local-process-provider";
import { remoteHttpProvider } from "@/workspaces/remote-http-provider";
import type { WorkspaceProcessProvider } from "@/workspaces/contracts";

/**
 * Resolves the configured workspace process provider from `AGENCY_WORKSPACE_PROVIDER`.
 *
 * @returns The singleton provider implementation for the configured runtime.
 * @throws {Error} If the configured provider name is not supported.
 */
export function workspaceProcessProvider(): WorkspaceProcessProvider {
  switch (env().AGENCY_WORKSPACE_PROVIDER) {
    case "docker-isolated": return dockerIsolatedProvider;
    case "remote-http": return remoteHttpProvider;
    case "local-process": return localProcessProvider;
    default: throw new Error(`Unsupported workspace provider: ${String(env().AGENCY_WORKSPACE_PROVIDER)}`);
  }
}

/**
 * Terminates every runtime associated with a workspace scope.
 *
 * The local-process provider is always included because scope ids are shared
 * across providers and a scope may have stray local children even when another
 * provider is configured.
 *
 * @param scopeId - Workspace scope whose processes/containers should be torn down.
 * @returns Total number of runtimes terminated across all consulted providers.
 */
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

/**
 * Removes orphaned runtimes (e.g. expired containers) left behind by crashed runners.
 *
 * @returns Number of orphaned runtimes removed, or 0 when the provider cannot clean up.
 */
export async function cleanupOrphanedWorkspaceRuntimes() {
  const provider = workspaceProcessProvider();
  return provider.cleanupOrphans ? provider.cleanupOrphans() : 0;
}
