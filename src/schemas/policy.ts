import { z } from "zod";
import { actionKindSchema, actionRiskSchema } from "@/schemas/actions";
import { memberRoleSchema } from "@/schemas/identity";

export const policyMatchSchema = z.object({
  actionKinds: z.array(actionKindSchema).min(1).optional(),
  risks: z.array(actionRiskSchema).min(1).optional(),
  requesterRoles: z.array(memberRoleSchema).min(1).optional(),
});

export const policyEffectSchema = z.object({
  deny: z.boolean().default(false),
  requiredApprovals: z.number().int().min(1).max(5),
  requireSeparateApprover: z.boolean().default(true),
  approverRoles: z.array(memberRoleSchema).min(1),
  executorRoles: z.array(memberRoleSchema).min(1),
});

export const actionPolicyRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  description: z.string().min(1).max(300),
  match: policyMatchSchema,
  effect: policyEffectSchema,
});

export const actionPolicyDocumentSchema = z.object({
  apiVersion: z.literal("agencyos/v1"),
  kind: z.literal("ActionPolicy"),
  defaultEffect: policyEffectSchema,
  rules: z.array(actionPolicyRuleSchema).max(100),
});

export const actionPolicyRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  name: z.string().min(1).max(160),
  version: z.number().int().min(1),
  status: z.enum(["draft", "active", "retired"]),
  document: actionPolicyDocumentSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  activatedAt: z.date().nullable(),
  retiredAt: z.date().nullable(),
});

export const createActionPolicySchema = z.object({
  name: z.string().trim().min(1).max(160),
  document: actionPolicyDocumentSchema,
  activate: z.boolean().default(false),
});

export const actionPolicyDecisionSchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.number().int().min(1),
  policyChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  matchedRuleId: z.string().nullable(),
  denied: z.boolean(),
  requiredApprovals: z.number().int().min(1).max(5),
  requireSeparateApprover: z.boolean(),
  approverRoles: z.array(memberRoleSchema).min(1),
  executorRoles: z.array(memberRoleSchema).min(1),
});

export type ActionPolicyDocument = z.infer<typeof actionPolicyDocumentSchema>;
export type ActionPolicyRecord = z.infer<typeof actionPolicyRecordSchema>;
export type CreateActionPolicyInput = z.infer<typeof createActionPolicySchema>;
export type ActionPolicyDecision = z.infer<typeof actionPolicyDecisionSchema>;
