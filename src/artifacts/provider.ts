import { env } from "@/lib/env";
import type { ArtifactStore } from "@/artifacts/contracts";
import { filesystemArtifactStore } from "@/artifacts/filesystem-store";
import { s3ArtifactStore } from "@/artifacts/s3-store";
import type { ArtifactRecord } from "@/schemas/artifact";

/** Returns the artifact store selected by the current environment config. */
export function artifactStore(): ArtifactStore {
  return env().AGENCY_ARTIFACT_PROVIDER === "s3" ? s3ArtifactStore : filesystemArtifactStore;
}

/**
 * Returns the store for a persisted artifact record's provider, so artifacts
 * written before a provider config change remain readable and deletable.
 *
 * @param provider - Provider recorded when the artifact was stored.
 */
export function artifactStoreFor(provider: ArtifactRecord["provider"]): ArtifactStore {
  return provider === "s3" ? s3ArtifactStore : filesystemArtifactStore;
}
