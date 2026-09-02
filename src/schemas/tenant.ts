import { z } from "zod";
import { memberRoleSchema } from "@/schemas/identity";

export const tenantStatusSchema = z.enum(["active", "suspended"]);

export const tenantSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  displayName: z.string().min(1).max(160),
  status: tenantStatusSchema,
  allowedEmailDomains: z.array(z.string().min(1)).default([]),
  activePolicyId: z.string().nullable(),
  oidcConnectionId: z.string().nullable(),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const createTenantSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  displayName: z.string().trim().min(1).max(160),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().min(1)).max(20).default([]),
});

export const updateTenantSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().min(1)).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one tenant field is required");

export const tenantInvitationSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  email: z.string().email(),
  role: memberRoleSchema.exclude(["owner"]),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  invitedBy: z.string().min(1),
  createdAt: z.date(),
  expiresAt: z.date(),
  acceptedAt: z.date().nullable(),
  acceptedByMemberId: z.string().nullable(),
  revokedAt: z.date().nullable(),
});

export const createTenantInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: memberRoleSchema.exclude(["owner"]).default("viewer"),
  expiresInHours: z.number().int().min(1).max(720).default(72),
});

export const oidcConnectionSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecretId: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  status: z.enum(["active", "disabled"]),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const configureOidcConnectionSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(8),
  scopes: z.array(z.string().trim().min(1)).min(1).max(20).default(["openid", "email", "profile"]),
}).refine((value) => value.scopes.includes("openid"), {
  path: ["scopes"],
  message: "OIDC scopes must include openid",
});

export const oidcTransactionSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  codeVerifierCiphertext: z.string().min(1),
  nonceCiphertext: z.string().min(1),
  invitationId: z.string().nullable(),
  returnTo: z.string().min(1),
  createdAt: z.date(),
  expiresAt: z.date(),
  consumedAt: z.date().nullable(),
});

export type Tenant = z.infer<typeof tenantSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type TenantInvitation = z.infer<typeof tenantInvitationSchema>;
export type CreateTenantInvitationInput = z.infer<typeof createTenantInvitationSchema>;
export type OidcConnection = z.infer<typeof oidcConnectionSchema>;
export type ConfigureOidcConnectionInput = z.infer<typeof configureOidcConnectionSchema>;
export type OidcTransaction = z.infer<typeof oidcTransactionSchema>;
