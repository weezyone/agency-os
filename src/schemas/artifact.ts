import { z } from "zod";

export const artifactKindSchema = z.enum([
  "workspace_patch",
  "worker_output",
  "qa_result",
  "command_log",
  "execution_manifest",
  "provenance_attestation",
]);

export const artifactProviderSchema = z.enum(["filesystem", "s3"]);

export const artifactRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  projectId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  attemptId: z.string(),
  workspaceId: z.string().nullable(),
  kind: artifactKindSchema,
  provider: artifactProviderSchema,
  storageKey: z.string().min(1),
  storageUri: z.string().min(1),
  contentType: z.string().min(1),
  filename: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.date(),
  expiresAt: z.date().nullable(),
});

export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
