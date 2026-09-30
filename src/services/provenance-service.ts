import { createHmac } from "node:crypto";
import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Serializes a value deterministically (sorted object keys, ISO dates) so the
 * same logical statement always produces the same bytes — a precondition for
 * reproducible HMAC signatures over provenance statements.
 *
 * @param value Arbitrary JSON-compatible value.
 * @returns The canonical JSON string.
 */
export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Builds an in-toto-style provenance statement binding a run/attempt and its
 * execution environment to the SHA-256 digests of every artifact it produced,
 * signed with the tenant's HMAC key. Returns `null` when no provenance secret
 * is configured, so provenance is strictly opt-in rather than silently unsigned.
 *
 * @param input Run/attempt identity, runner and sandbox metadata, and the
 *   artifact subjects to attest.
 * @returns The statement plus its signature, or `null` when unconfigured.
 */
export function createProvenanceAttestation(input: {
  runId: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  runnerId: string | null;
  sandboxImage: string;
  subjects: Array<{ name: string; sha256: string; bytes: number; kind: string }>;
}) {
  const config = env();
  if (!config.AGENCY_PROVENANCE_HMAC_SECRET) return null;
  const statement = {
    _type: "https://agencyos.dev/provenance/v1",
    issuedAt: new Date().toISOString(),
    tenantId: currentTenantId(),
    subject: input.subjects.map((subject) => ({
      name: subject.name,
      digest: { sha256: subject.sha256 },
      bytes: subject.bytes,
      kind: subject.kind,
    })),
    predicate: {
      runId: input.runId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      taskId: input.taskId,
      runnerId: input.runnerId,
      sandboxImage: input.sandboxImage,
    },
  };
  const canonical = canonicalJson(statement);
  const signature = createHmac("sha256", config.AGENCY_PROVENANCE_HMAC_SECRET)
    .update(canonical, "utf8")
    .digest("base64url");
  return {
    statement,
    signature: {
      algorithm: "hmac-sha256",
      keyId: config.AGENCY_PROVENANCE_KEY_ID,
      value: signature,
    },
  };
}
