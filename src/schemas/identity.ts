import { z } from "zod";

export const memberRoleSchema = z.enum(["owner", "admin", "operator", "reviewer", "viewer"]);
export const memberStatusSchema = z.enum(["active", "disabled"]);

export const permissionSchema = z.enum([
  "control:read",
  "project:write",
  "run:dispatch",
  "run:cancel",
  "workspace:review",
  "action:propose",
  "action:approve",
  "action:execute",
  "artifact:read",
  "metrics:read",
  "usage:read",
  "admin:members",
  "admin:keys",
  "admin:tenant",
  "admin:secrets",
  "admin:policies",
  "admin:pricing",
]);

export const memberSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
  role: memberRoleSchema,
  status: memberStatusSchema,
  identityProvider: z.enum(["local", "oidc"]).default("local"),
  subject: z.string().nullable().default(null),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastAuthenticatedAt: z.date().nullable(),
});

export const apiKeySchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  memberId: z.string(),
  name: z.string().min(1),
  prefix: z.string().min(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});

export const browserSessionSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  memberId: z.string().min(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  csrfTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.date(),
  expiresAt: z.date(),
  lastSeenAt: z.date(),
  revokedAt: z.date().nullable(),
  userAgentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ipHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

export const principalSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  memberId: z.string().nullable(),
  email: z.string().email().nullable(),
  displayName: z.string().min(1),
  role: memberRoleSchema,
  permissions: z.array(permissionSchema),
  authMethod: z.enum(["disabled", "bootstrap", "api_key", "session"]),
  keyId: z.string().nullable(),
  sessionId: z.string().nullable(),
});

export const createMemberSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(120),
  role: memberRoleSchema.exclude(["owner"]).default("viewer"),
});

export const updateMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: memberRoleSchema.exclude(["owner"]).optional(),
  status: memberStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one member field is required");

export const createApiKeySchema = z.object({
  memberId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  expiresAt: z.coerce.date().nullable().optional(),
});

export type MemberRole = z.infer<typeof memberRoleSchema>;
export type MemberStatus = z.infer<typeof memberStatusSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ApiKeyRecord = z.infer<typeof apiKeySchema>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
