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

export function policyChecksum(document: ActionPolicyDocument) {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export const policyRepository = {
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

  async getActive() {
    const { policies } = await collections();
    return policies.findOne(tenantFilter({ status: "active" }), { projection: { _id: 0 }, sort: { version: -1 } });
  },

  async list() {
    const { policies } = await collections();
    return policies.find(tenantFilter(), { projection: { _id: 0 } }).sort({ version: -1 }).toArray();
  },
};
