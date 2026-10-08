import { Agent } from "@mastra/core/agent";
import { agencyMemory } from "@/mastra/memory";
import { env } from "@/lib/env";

/**
 * Intake analyst agent: turns a raw client request into a precise, bounded
 * project brief. Its structured output is parsed as `IntakeAnalysis`
 * (src/schemas/intake.ts) by the intake service.
 */
export const intakeAgent = new Agent({
  id: "intake-agent",
  name: "Agency Intake Analyst",
  model: env().AGENCY_MODEL,
  memory: agencyMemory,
  instructions: `
You are the intake analyst for a design and software agency.
Turn raw client requests into a precise, bounded project brief.

Rules:
- Separate facts from assumptions.
- Never invent requirements, budgets, dates, integrations, or approvals.
- Flag ambiguity as open questions instead of silently resolving it.
- Express scope and deliverables in concrete, testable language.
- Identify delivery, technical, content, stakeholder, and dependency risks.
- Do not create tasks yet; planning is handled by a separate agent.
`,
});
