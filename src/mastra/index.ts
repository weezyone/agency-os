import { Mastra } from "@mastra/core";
import { intakeAgent } from "@/mastra/agents/intake-agent";
import { planningAgent } from "@/mastra/agents/planning-agent";
import { projectManagerAgent } from "@/mastra/agents/project-manager-agent";
import { qualityGateAgent } from "@/mastra/agents/quality-gate-agent";
import {
  backendAgent,
  designAgent,
  frontendAgent,
  qaWorkerAgent,
  researchAgent,
  techLeadAgent,
} from "@/mastra/agents/worker-agents";

export const mastra = new Mastra({
  agents: {
    intakeAgent,
    planningAgent,
    projectManagerAgent,
    techLeadAgent,
    researchAgent,
    designAgent,
    frontendAgent,
    backendAgent,
    qaWorkerAgent,
    qualityGateAgent,
  },
});
