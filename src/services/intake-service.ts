import { intakeAnalysisSchema, type IntakeRequest } from "@/schemas/intake";
import { planningOutputSchema } from "@/schemas/planning";
import { intakeAgent } from "@/mastra/agents/intake-agent";
import { planningAgent } from "@/mastra/agents/planning-agent";
import { projectRepository } from "@/repositories/project-repository";
import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";
import { recordGenerationUsage } from "@/services/usage-service";

export async function runIntake(request: IntakeRequest) {
  const tenantId = currentTenantId();
  const resource = `tenant:${tenantId}:client:${request.email.toLowerCase()}`;
  const thread = `tenant:${tenantId}:intake:${crypto.randomUUID()}`;

  const intakeResult = await intakeAgent.generate(
    `Analyze this client intake and return only the requested structured result:\n${JSON.stringify(request, null, 2)}`,
    {
      memory: { resource, thread },
      structuredOutput: { schema: intakeAnalysisSchema, errorStrategy: "strict" },
    },
  );
  await recordGenerationUsage({
    result: intakeResult,
    model: env().AGENCY_MODEL,
    agent: "intake",
    operation: "intake.analyze",
    requestId: intakeResult.runId ?? null,
  }).catch((error) => console.error("Usage accounting failed", error));
  const analysis = intakeAnalysisSchema.parse(intakeResult.object);

  const client = await projectRepository.createClient({
    companyName: request.companyName,
    contactName: request.contactName,
    email: request.email.toLowerCase(),
    preferences: [],
  });

  const project = await projectRepository.createProject({
    clientId: client.id,
    title: request.projectTitle,
    status: "planning",
    objective: analysis.objective,
    scope: analysis.scope,
    constraints: [...analysis.constraints, ...request.constraints],
    deliverables: analysis.deliverables,
    risks: analysis.risks,
    currentPhase: analysis.recommendedPhases[0] ?? "Planning",
  });

  const planningResult = await planningAgent.generate(
    `Create a build-ready plan for this project.\nProject id: ${project.id}\nIntake analysis:\n${JSON.stringify(analysis, null, 2)}`,
    {
      memory: { resource: `tenant:${tenantId}:project:${project.id}`, thread: `tenant:${tenantId}:planning:${project.id}` },
      structuredOutput: { schema: planningOutputSchema, errorStrategy: "strict" },
    },
  );
  await recordGenerationUsage({
    result: planningResult,
    model: env().AGENCY_MODEL,
    agent: "planning",
    operation: "project.plan",
    requestId: planningResult.runId ?? null,
    projectId: project.id,
  }).catch((error) => console.error("Usage accounting failed", error));
  const plan = planningOutputSchema.parse(planningResult.object);

  const tasks = await projectRepository.createTasks(
    plan.tasks.map((task) => ({
      projectId: project.id,
      title: task.title,
      description: task.description,
      ownerRole: task.ownerRole,
      status: "backlog" as const,
      priority: task.priority,
      estimateHours: task.estimateHours,
      dependencies: task.dependencies,
      acceptanceCriteria: task.acceptanceCriteria,
    })),
  );

  return { client, project, analysis, plan, tasks };
}
