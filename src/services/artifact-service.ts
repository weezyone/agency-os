import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";
import { artifactStore, artifactStoreFor } from "@/artifacts/provider";
import { artifactRepository } from "@/repositories/artifact-repository";
import { executionRepository } from "@/repositories/execution-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import type { ArtifactKind, ArtifactRecord } from "@/schemas/artifact";
import { createProvenanceAttestation } from "@/services/provenance-service";

function expiresAt() {
  return new Date(Date.now() + env().AGENCY_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
}

function publicArtifact(artifact: ArtifactRecord) {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    taskId: artifact.taskId,
    runId: artifact.runId,
    attemptId: artifact.attemptId,
    workspaceId: artifact.workspaceId,
    kind: artifact.kind,
    contentType: artifact.contentType,
    filename: artifact.filename,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    downloadUrl: `/api/artifacts/${artifact.id}`,
  };
}

async function storeArtifact(input: {
  kind: ArtifactKind;
  projectId: string;
  taskId: string;
  runId: string;
  attemptId: string;
  workspaceId: string | null;
  contentType: string;
  filename: string;
  content: string;
}) {
  const existing = await artifactRepository.getKind(input.runId, input.attemptId, input.kind);
  if (existing) return existing;

  const storageKey = [
    currentTenantId(),
    input.projectId,
    input.runId,
    input.attemptId,
    input.filename,
  ].map((value) => value.replace(/[^A-Za-z0-9._-]+/g, "-")).join("/");
  const content = Buffer.from(input.content, "utf8");
  const store = artifactStore();
  const stored = await store.put(storageKey, content, { contentType: input.contentType });
  return artifactRepository.createOrGet({
    projectId: input.projectId,
    taskId: input.taskId,
    runId: input.runId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    provider: store.name,
    storageKey: stored.storageKey,
    storageUri: stored.storageUri,
    contentType: input.contentType,
    filename: input.filename,
    bytes: stored.bytes,
    sha256: stored.sha256,
    expiresAt: expiresAt(),
  });
}

export async function persistExecutionArtifacts(runId: string, runnerId: string | null = null) {
  const detail = await executionRepository.getDetail(runId);
  if (!detail) throw new Error("Execution run not found");
  const attempt = detail.attempts.at(-1);
  if (!attempt) return [];
  const workspaceDetail = attempt.workspaceId
    ? await workspaceRepository.getDetail(attempt.workspaceId)
    : null;

  const common = {
    projectId: detail.run.projectId,
    taskId: detail.run.taskId,
    runId: detail.run.id,
    attemptId: attempt.id,
    workspaceId: attempt.workspaceId,
  };
  const artifacts: ArtifactRecord[] = [];

  if (attempt.workerOutput) {
    artifacts.push(await storeArtifact({
      ...common,
      kind: "worker_output",
      contentType: "application/json",
      filename: "worker-output.json",
      content: JSON.stringify(attempt.workerOutput, null, 2),
    }));
  }
  if (attempt.qa) {
    artifacts.push(await storeArtifact({
      ...common,
      kind: "qa_result",
      contentType: "application/json",
      filename: "qa-result.json",
      content: JSON.stringify(attempt.qa, null, 2),
    }));
  }
  if (workspaceDetail?.workspace.diff || workspaceDetail?.workspace.patchPath) {
    const fullPatch = workspaceDetail.workspace.patchPath
      ? await readFile(workspaceDetail.workspace.patchPath, "utf8")
      : workspaceDetail.workspace.diff;
    artifacts.push(await storeArtifact({
      ...common,
      kind: "workspace_patch",
      contentType: "text/x-diff; charset=utf-8",
      filename: "workspace.patch",
      content: fullPatch,
    }));
  }
  if (workspaceDetail) {
    artifacts.push(await storeArtifact({
      ...common,
      kind: "command_log",
      contentType: "application/json",
      filename: "commands.json",
      content: JSON.stringify(workspaceDetail.commands, null, 2),
    }));
  }

  const manifestPayload = {
    generatedAt: new Date().toISOString(),
    run: detail.run,
    attempt: {
      id: attempt.id,
      number: attempt.number,
      executionMode: attempt.executionMode,
      agentRole: attempt.agentRole,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    },
    workspace: workspaceDetail?.workspace
      ? {
          id: workspaceDetail.workspace.id,
          provider: workspaceDetail.workspace.provider,
          status: workspaceDetail.workspace.status,
          repositoryFullName: workspaceDetail.workspace.repositoryFullName,
          baseRef: workspaceDetail.workspace.baseRef,
          baseSha: workspaceDetail.workspace.baseSha,
          branchName: workspaceDetail.workspace.branchName,
          changedFiles: workspaceDetail.workspace.changedFiles,
          additions: workspaceDetail.workspace.additions,
          deletions: workspaceDetail.workspace.deletions,
          validation: workspaceDetail.workspace.validation,
        }
      : null,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      filename: artifact.filename,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  };
  artifacts.push(await storeArtifact({
    ...common,
    kind: "execution_manifest",
    contentType: "application/json",
    filename: "manifest.json",
    content: JSON.stringify(manifestPayload, null, 2),
  }));

  const attestation = createProvenanceAttestation({
    runId: detail.run.id,
    attemptId: attempt.id,
    projectId: detail.run.projectId,
    taskId: detail.run.taskId,
    runnerId,
    sandboxImage: env().AGENCY_SANDBOX_IMAGE,
    subjects: artifacts.map((artifact) => ({
      name: artifact.filename,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      kind: artifact.kind,
    })),
  });
  if (attestation) {
    artifacts.push(await storeArtifact({
      ...common,
      kind: "provenance_attestation",
      contentType: "application/json",
      filename: "provenance.json",
      content: JSON.stringify(attestation, null, 2),
    }));
  }

  return artifacts.map(publicArtifact);
}

export async function listRunArtifacts(runId: string) {
  return (await artifactRepository.listRun(runId)).map(publicArtifact);
}

export async function readArtifact(id: string) {
  const artifact = await artifactRepository.get(id);
  if (!artifact) return null;
  if (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now()) return null;
  const content = await artifactStoreFor(artifact.provider).read(artifact.storageKey);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== artifact.sha256 || content.length !== artifact.bytes) {
    throw new Error("Artifact integrity verification failed");
  }
  return { artifact, content };
}

export async function cleanupExpiredArtifacts(limit = 100) {
  const expired = await artifactRepository.listExpiredAllTenants(new Date(), limit);
  let removed = 0;
  for (const artifact of expired) {
    await artifactStoreFor(artifact.provider).remove(artifact.storageKey);
    const result = await artifactRepository.deleteGlobal(artifact.id, artifact.tenantId);
    removed += result.deletedCount;
  }
  return removed;
}
