import { z } from "zod";
import { prioritySchema } from "@/schemas/domain";

/**
 * Structured output contract for the planning agent: delivery phases plus an
 * executable task breakdown with acceptance criteria. Parsed from the agent's
 * structured output and persisted as project tasks by the intake service.
 */
export const planningOutputSchema = z.object({
  phases: z.array(z.object({
    name: z.string(),
    objective: z.string(),
    exitCriteria: z.array(z.string()),
  })).min(1),
  tasks: z.array(z.object({
    title: z.string(),
    description: z.string(),
    ownerRole: z.string(),
    priority: prioritySchema,
    estimateHours: z.number().nonnegative().nullable(),
    dependencies: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()).min(1),
  })).min(1),
  immediateNextAction: z.string(),
});

export type PlanningOutput = z.infer<typeof planningOutputSchema>;
