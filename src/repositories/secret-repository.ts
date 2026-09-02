import { randomUUID } from "node:crypto";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { decryptTenantValue, encryptTenantValue } from "@/lib/secret-crypto";
import type { TenantSecret, UpsertTenantSecretInput } from "@/schemas/secrets";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const secrets = db.collection<TenantSecret>("tenant_secrets");
  await Promise.all([
    secrets.createIndex({ id: 1 }, { unique: true }),
    secrets.createIndex({ tenantId: 1, name: 1 }, { unique: true }),
    secrets.createIndex({ tenantId: 1, purpose: 1, revokedAt: 1 }),
  ]);
  return { secrets };
});

export const secretRepository = {
  async upsert(input: UpsertTenantSecretInput, actor: string) {
    const { secrets } = await collections();
    const tenantId = currentTenantId();
    const existing = await secrets.findOne({ tenantId, name: input.name }, { projection: { _id: 0 } });
    const now = new Date();
    const record: TenantSecret = {
      id: existing?.id ?? randomUUID(),
      tenantId,
      name: input.name,
      purpose: input.purpose,
      envelope: encryptTenantValue(tenantId, input.name, input.value),
      createdBy: existing?.createdBy ?? actor,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      rotatedAt: existing ? now : null,
      revokedAt: null,
    };
    await secrets.replaceOne({ tenantId, name: input.name }, record, { upsert: true });
    return { ...record, envelope: { ...record.envelope, ciphertext: "[redacted]", authTag: "[redacted]" } };
  },

  async getValue(id: string, tenantId = currentTenantId()) {
    const { secrets } = await collections();
    const record = await secrets.findOne({ id, tenantId, revokedAt: null }, { projection: { _id: 0 } });
    if (!record) return null;
    return decryptTenantValue(record.tenantId, record.name, record.envelope);
  },

  async getValueByName(name: string) {
    const { secrets } = await collections();
    const record = await secrets.findOne(tenantFilter({ name, revokedAt: null }), { projection: { _id: 0 } });
    if (!record) return null;
    return decryptTenantValue(record.tenantId, record.name, record.envelope);
  },

  async list() {
    const { secrets } = await collections();
    return secrets.find(tenantFilter(), {
      projection: { _id: 0, "envelope.ciphertext": 0, "envelope.authTag": 0, "envelope.iv": 0 },
    }).sort({ updatedAt: -1 }).toArray();
  },

  async revoke(id: string) {
    const { secrets } = await collections();
    return secrets.findOneAndUpdate(
      tenantFilter({ id, revokedAt: null }),
      { $set: { revokedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, envelope: 0 } },
    );
  },
};
