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

/**
 * Tenant-scoped store for encrypted secrets.
 *
 * Values are envelope-encrypted per tenant before persistence and never leave
 * the repository in cleartext except through the explicit `getValue*` reads.
 */
export const secretRepository = {
  /**
   * Creates or rotates a secret value.
   *
   * Rotation preserves id, creator, and creation time while updating
   * `rotatedAt`. The returned record has its ciphertext and auth tag redacted
   * so callers (and their logs/serializers) cannot accidentally expose them.
   *
   * @param input - Secret name, purpose, and plaintext value.
   * @param actor - Principal performing the write.
   * @returns The stored record with sensitive envelope fields redacted.
   */
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

  /**
   * Decrypts and returns a secret's plaintext value.
   *
   * @param id - Secret id.
   * @param tenantId - Owning tenant; defaults to the current tenant context.
   * @returns The decrypted value, or null when not found or revoked.
   */
  async getValue(id: string, tenantId = currentTenantId()) {
    const { secrets } = await collections();
    const record = await secrets.findOne({ id, tenantId, revokedAt: null }, { projection: { _id: 0 } });
    if (!record) return null;
    return decryptTenantValue(record.tenantId, record.name, record.envelope);
  },

  /**
   * Decrypts and returns a secret's plaintext value by name.
   *
   * @param name - Secret name within the current tenant.
   * @returns The decrypted value, or null when not found or revoked.
   */
  async getValueByName(name: string) {
    const { secrets } = await collections();
    const record = await secrets.findOne(tenantFilter({ name, revokedAt: null }), { projection: { _id: 0 } });
    if (!record) return null;
    return decryptTenantValue(record.tenantId, record.name, record.envelope);
  },

  /**
   * @returns Secret metadata for the tenant with all envelope material (ciphertext, auth tag, IV) excluded.
   */
  async list() {
    const { secrets } = await collections();
    return secrets.find(tenantFilter(), {
      projection: { _id: 0, "envelope.ciphertext": 0, "envelope.authTag": 0, "envelope.iv": 0 },
    }).sort({ updatedAt: -1 }).toArray();
  },

  /**
   * Soft-revokes a secret so it can no longer be read while keeping the audit trail.
   *
   * @param id - Secret id within the current tenant.
   * @returns The revoked record (envelope omitted), or null when not found or already revoked.
   */
  async revoke(id: string) {
    const { secrets } = await collections();
    return secrets.findOneAndUpdate(
      tenantFilter({ id, revokedAt: null }),
      { $set: { revokedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, envelope: 0 } },
    );
  },
};
