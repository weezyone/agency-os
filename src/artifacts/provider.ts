import { env } from "@/lib/env";
import type { ArtifactStore } from "@/artifacts/contracts";
import { filesystemArtifactStore } from "@/artifacts/filesystem-store";
import { s3ArtifactStore } from "@/artifacts/s3-store";
import type { ArtifactRecord } from "@/schemas/artifact";

export function artifactStore(): ArtifactStore {
  return env().AGENCY_ARTIFACT_PROVIDER === "s3" ? s3ArtifactStore : filesystemArtifactStore;
}

export function artifactStoreFor(provider: ArtifactRecord["provider"]): ArtifactStore {
  return provider === "s3" ? s3ArtifactStore : filesystemArtifactStore;
}
