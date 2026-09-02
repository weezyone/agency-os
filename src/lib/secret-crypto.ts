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

function additionalData(tenantId: string, name: string) {
  return Buffer.from(`agency-os:v1:${tenantId}:${name}`, "utf8");
}

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
