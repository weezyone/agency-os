import { z } from "zod";

export const projectStatusSchema = z.enum([
  "intake",
  "planning",
  "active",
  "blocked",
  "review",
  "done",
  "cancelled",
]);

export const taskStatusSchema = z.enum(["backlog", "todo", "in_progress", "review", "done", "blocked"]);
export const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const repositoryBindingSchema = z.object({
  provider: z.enum(["github", "git"]),
  url: z.string().url(),
  cloneUrl: z.string().url(),
  fullName: z.string().min(1).nullable().default(null),
  defaultBranch: z.string().min(1).default("main"),
  externalId: z.string().min(1).nullable().default(null),
  boundBy: z.string().min(1),
  boundAt: z.date(),
});

export const clientSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  companyName: z.string().min(1),
  contactName: z.string().min(1),
  email: z.string().email(),
  preferences: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const projectSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  clientId: z.string(),
  title: z.string().min(1),
  status: projectStatusSchema,
  objective: z.string(),
  scope: z.array(z.string()),
  constraints: z.array(z.string()),
  deliverables: z.array(z.string()),
  risks: z.array(z.string()),
  currentPhase: z.string(),
  repository: repositoryBindingSchema.nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const taskSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string(),
  ownerRole: z.string(),
  status: taskStatusSchema,
  priority: prioritySchema,
  estimateHours: z.number().nonnegative().nullable(),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  activeRunId: z.string().nullable().optional(),
  completedRunId: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Client = z.infer<typeof clientSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>;
