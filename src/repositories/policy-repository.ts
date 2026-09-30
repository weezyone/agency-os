import { createHash, randomUUID } from "node:crypto";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { withMongoTransaction } from "@/lib/transactions";
import { tenantRepository } from "@/repositories/tenant-repository";
import type { ActionPolicyDocument, ActionPolicyRecord } from "@/schemas/policy";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const policies = db.collection<ActionPolicyRecord>("action_policies");
  await Promise.all([
    policies.createIndex({ id: 1 }, { unique: true }),
    policies.createIndex({ tenantId: 1, version: 1 }, { unique: true }),
    policies.createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
  ]);
  return { policies };
});

/**
 * Computes the integrity checksum of a policy document.
 *
 * Approval records embed this checksum so auditors can prove an action was
 * governed by the exact policy content evaluated at decision time, even after
 * the policy is later edited or retired.
 *
 * @param document - The policy document to checksum.
 * @returns Hex-encoded SHA-256 of the document's JSON serialization.
 */
export function policyChecksum(document: ActionPolicyDocument) {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/** Tenant-scoped store for versioned action policies; exactly one version is active per tenant. */
export const policyRepository = {
  /**
   * Creates the next policy version, optionally activating it atomically.
   *
   * Activation retires all other versions and points the tenant at the new one
   * in a single transaction, so policy evaluation never observes a gap with no
   * active policy.
   *
   * @param input - Policy name, document, creator, and whether to activate immediately.
   * @returns The created policy record.
   */
  async create(input: { name: string; document: ActionPolicyDocument; createdBy: string; activate: boolean }) {
    const { policies } = await collections();
    const latest = await policies.find(tenantFilter(), { projection: { _id: 0, version: 1 } }).sort({ version: -1 }).limit(1).next();
    const now = new Date();
    const record: ActionPolicyRecord = {
      id: randomUUID(),
      tenantId: currentTenantId(),
      name: input.name,
      version: (latest?.version ?? 0) + 1,
      status: input.activate ? "active" : "draft",
      document: input.document,
      checksum: policyChecksum(input.document),
      createdBy: input.createdBy,
      createdAt: now,
      activatedAt: input.activate ? now : null,
      retiredAt: null,
    };

    if (!input.activate) {
      await policies.insertOne(record);
      return record;
    }

    return withMongoTransaction(async (session) => {
      await policies.updateMany(
        tenantFilter({ status: "active" }),
        { $set: { status: "retired", retiredAt: now } },
        { session },
      );
      await policies.insertOne(record, { session });
      await tenantRepository.setActivePolicy(record.id, session);
      return record;
    });
  },

  /**
   * Activates an existing policy version, retiring the others in one transaction.
   *
   * @param id - Policy id within the current tenant.
   * @returns The activated policy, or null when not found.
   */
  async activate(id: string) {
    const { policies } = await collections();
    return withMongoTransaction(async (session) => {
      const candidate = await policies.findOne(tenantFilter({ id }), { projection: { _id: 0 }, session });
      if (!candidate) return null;
      const now = new Date();
      await policies.updateMany(
        tenantFilter({ status: "active", id: { $ne: id } }),
        { $set: { status: "retired", retiredAt: now } },
        { session },
      );
      const active = await policies.findOneAndUpdate(
        tenantFilter({ id }),
        { $set: { status: "active", activatedAt: now, retiredAt: null } },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (active) await tenantRepository.setActivePolicy(active.id, session);
      return active;
    });
  },

  /**
   * @returns The tenant's active policy (highest version wins on ties), or null when none is active.
   */
  async getActive() {
    const { policies } = await collections();
    return policies.findOne(tenantFilter({ status: "active" }), { projection: { _id: 0 }, sort: { version: -1 } });
  },

  /**
   * @returns All policy versions for the tenant, newest version first.
   */
  async list() {
    const { policies } = await collections();
    return policies.find(tenantFilter(), { projection: { _id: 0 } }).sort({ version: -1 }).toArray();
  },
};
