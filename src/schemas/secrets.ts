import { z } from "zod";

/**
 * Tenant secret contracts.
 *
 * Secrets are stored only as versioned AES-256-GCM envelopes; plaintext
 * appears solely in the upsert input schema parsed at the secrets API
 * boundary. Records are persisted by the secret repository and decrypted on
 * demand by the integration-secret service.
 */
export const encryptedEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("A256GCM"),
  keyId: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});

/** Stored secret: metadata plus its encrypted envelope; never carries plaintext. */
export const tenantSecretSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  purpose: z.enum(["oidc_client_secret", "github_token", "linear_token", "webhook_secret", "custom"]),
  envelope: encryptedEnvelopeSchema,
  createdBy: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
  rotatedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});

export const upsertTenantSecretSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: tenantSecretSchema.shape.purpose,
  value: z.string().min(1).max(100_000),
});

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;
export type TenantSecret = z.infer<typeof tenantSecretSchema>;
export type UpsertTenantSecretInput = z.infer<typeof upsertTenantSecretSchema>;
