/** Result of persisting an artifact: where it lives and how to verify it. */
export type StoredArtifact = {
  storageKey: string;
  storageUri: string;
  bytes: number;
  sha256: string;
};

/** Storage backend for durable run evidence (filesystem or S3-compatible). */
export interface ArtifactStore {
  readonly name: "filesystem" | "s3";
  put(storageKey: string, content: Buffer, metadata?: { contentType?: string; sha256?: string }): Promise<StoredArtifact>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
  health?(): Promise<{ provider: string; available: boolean; message: string }>;
}
