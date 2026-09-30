import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import type { ArtifactKind, ArtifactRecord } from "@/schemas/artifact";

const collection = lazyAsync(async () => {
  const db = await getDb();
  const artifacts = db.collection<ArtifactRecord>("execution_artifacts");
  await artifacts.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId: env().AGENCY_TENANT_ID } },
  );
  await Promise.all([
    artifacts.createIndex({ id: 1 }, { unique: true }),
    artifacts.createIndex({ tenantId: 1, runId: 1, attemptId: 1, kind: 1 }, { unique: true }),
    artifacts.createIndex({ tenantId: 1, projectId: 1, createdAt: -1 }),
    artifacts.createIndex({ tenantId: 1, expiresAt: 1 }),
    artifacts.createIndex({ expiresAt: 1 }),
  ]);
  return artifacts;
});

/** Tenant-scoped store for execution artifacts, keyed uniquely per run/attempt/kind. */
export const artifactRepository = {
  /**
   * Creates an artifact record, returning the existing one for a repeated run/attempt/kind.
   *
   * Retried uploads race on the unique index; the duplicate-key path re-reads
   * the winner instead of failing so artifact registration is idempotent.
   *
   * @param input - Artifact fields except id, tenantId, and createdAt.
   * @returns The existing or newly created artifact record.
   */
  async createOrGet(input: Omit<ArtifactRecord, "id" | "tenantId" | "createdAt">) {
    const artifacts = await collection();
    const tenantId = currentTenantId();
    const key = { tenantId, runId: input.runId, attemptId: input.attemptId, kind: input.kind };
    const existing = await artifacts.findOne(key, { projection: { _id: 0 } });
    if (existing) return existing;

    const artifact: ArtifactRecord = { id: randomUUID(), tenantId, ...input, createdAt: new Date() };
    try {
      await artifacts.insertOne(artifact);
      return artifact;
    } catch (error) {
      const duplicate = await artifacts.findOne(key, { projection: { _id: 0 } });
      if (duplicate) return duplicate;
      throw error;
    }
  },

  /**
   * @param id - Artifact id within the current tenant.
   * @returns The artifact record, or null when not found.
   */
  async get(id: string) {
    const artifacts = await collection();
    return artifacts.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  /**
   * @param runId - Run id within the current tenant.
   * @returns Non-expired artifacts for the run, oldest first.
   */
  async listRun(runId: string) {
    const artifacts = await collection();
    return artifacts.find(tenantFilter({
      runId,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  },

  /**
   * @param runId - Run id within the current tenant.
   * @param attemptId - Attempt id within the run.
   * @returns Non-expired artifacts for the attempt, oldest first.
   */
  async listAttempt(runId: string, attemptId: string) {
    const artifacts = await collection();
    return artifacts
      .find(tenantFilter({
        runId,
        attemptId,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }), { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
  },

  /**
   * @returns Active/expired artifact counts and total bytes of active artifacts for the tenant.
   */
  async summary() {
    const artifacts = await collection();
    const now = new Date();
    const [activeCount, expiredCount, bytes] = await Promise.all([
      artifacts.countDocuments(tenantFilter({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] })),
      artifacts.countDocuments(tenantFilter({ expiresAt: { $ne: null, $lte: now } })),
      artifacts.aggregate<{ total: number }>([
        { $match: tenantFilter({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }) },
        { $group: { _id: null, total: { $sum: "$bytes" } } },
      ]).next(),
    ]);
    return { activeCount, expiredCount, activeBytes: bytes?.total ?? 0 };
  },

  /**
   * Lists expired artifacts across all tenants for the garbage collector.
   *
   * Deliberately bypasses the tenant filter: GC is a platform-level duty and
   * must see every tenant's expired rows.
   *
   * @param now - Reference time for expiry comparison.
   * @param limit - Maximum batch size, oldest expiry first.
   * @returns Expired artifact records.
   */
  async listExpiredAllTenants(now = new Date(), limit = 100) {
    const artifacts = await collection();
    return artifacts
      .find({ expiresAt: { $ne: null, $lte: now } }, { projection: { _id: 0 } })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .toArray();
  },

  /**
   * Deletes an artifact by id with an explicit tenant id (used by cross-tenant GC).
   *
   * @param id - Artifact id.
   * @param tenantId - Owning tenant, required so deletes stay tenant-scoped.
   * @returns The MongoDB delete result.
   */
  async deleteGlobal(id: string, tenantId: string) {
    const artifacts = await collection();
    return artifacts.deleteOne({ id, tenantId });
  },

  /**
   * @param runId - Run id within the current tenant.
   * @param attemptId - Attempt id within the run.
   * @param kind - Artifact kind to look up.
   * @returns The matching artifact, or null when not found.
   */
  async getKind(runId: string, attemptId: string, kind: ArtifactKind) {
    const artifacts = await collection();
    return artifacts.findOne(tenantFilter({ runId, attemptId, kind }), { projection: { _id: 0 } });
  },
};
