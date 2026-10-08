import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import type { EncryptedEnvelope } from "@/schemas/secrets";

function keyBytes() {
  const configured = env().AGENCY_SECRET_ENCRYPTION_KEY;
  if (!configured) throw new Error("Tenant secret encryption is not configured");
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error("AGENCY_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

// The tenant id and secret name are bound as GCM associated data, so an
// envelope copied to another tenant or a differently-named field fails
// authentication instead of decrypting to a valid secret in the wrong context.
function additionalData(tenantId: string, name: string) {
  return Buffer.from(`agency-os:v1:${tenantId}:${name}`, "utf8");
}

/**
 * Encrypts a tenant-owned secret with AES-256-GCM under the platform key.
 * The tenant id and secret name are bound as associated data (see
 * `additionalData`), and a fresh 96-bit IV is generated per call.
 *
 * @param tenantId - Owning tenant; becomes part of the authenticated context.
 * @param name - Logical secret name; becomes part of the authenticated context.
 * @param plaintext - Secret value to encrypt.
 * @returns The versioned encrypted envelope for storage.
 * @throws {Error} When no encryption key is configured or it is malformed.
 */
export function encryptTenantValue(tenantId: string, name: string, plaintext: string): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  cipher.setAAD(additionalData(tenantId, name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "A256GCM",
    keyId: env().AGENCY_SECRET_KEY_ID,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

/**
 * Decrypts a tenant secret envelope produced by {@link encryptTenantValue}.
 * The same tenant id and name must be supplied because they are authenticated
 * as GCM associated data; GCM tag verification also detects any tampering
 * with the ciphertext before plaintext is released.
 *
 * @param tenantId - Tenant the envelope belongs to.
 * @param name - Logical secret name used at encryption time.
 * @param envelope - Stored encrypted envelope.
 * @returns The decrypted plaintext secret.
 * @throws {Error} When the key id is not active, the encryption key is
 *   missing/malformed, or authentication fails (wrong tenant/name or
 *   tampered envelope).
 */
export function decryptTenantValue(tenantId: string, name: string, envelope: EncryptedEnvelope) {
  if (envelope.keyId !== env().AGENCY_SECRET_KEY_ID) {
    throw new Error(`Tenant secret uses unavailable key id ${envelope.keyId}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(additionalData(tenantId, name));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
