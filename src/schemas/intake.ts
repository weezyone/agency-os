import { z } from "zod";

export const intakeRequestSchema = z.object({
  companyName: z.string().min(2),
  contactName: z.string().min(2),
  email: z.string().email(),
  projectTitle: z.string().min(2),
  projectBrief: z.string().min(20),
  goals: z.array(z.string().min(2)).min(1),
  requestedDeliverables: z.array(z.string()).default([]),
  budget: z.string().optional(),
  deadline: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
});

export const intakeAnalysisSchema = z.object({
  projectType: z.string(),
  objective: z.string(),
  scope: z.array(z.string()).min(1),
  deliverables: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  constraints: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  recommendedPhases: z.array(z.string()).min(1),
  complexity: z.enum(["low", "medium", "high"]),
});

export type IntakeRequest = z.infer<typeof intakeRequestSchema>;
export type IntakeAnalysis = z.infer<typeof intakeAnalysisSchema>;
