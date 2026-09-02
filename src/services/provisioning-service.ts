import { actionRepository } from "@/repositories/action-repository";
import { projectRepository } from "@/repositories/project-repository";
import { proposeAction } from "@/services/action-service";
import type { Principal } from "@/schemas/identity";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export async function proposeProjectProvisioning(projectId: string, requestedBy: string | Principal = "pm-agent") {
  const bundle = await projectRepository.getProject(projectId);
  if (!bundle) throw new Error("Project not found");

  const description = [bundle.project.objective, ...bundle.project.deliverables].filter(Boolean).join("\n\n");
  const linear = await proposeAction(
    {
      kind: "linear.createProject",
      payload: { name: bundle.project.title, description, projectId },
    },
    requestedBy,
    `project:${projectId}:linear-project:v1`,
  );

  const github = await proposeAction(
    {
      kind: "github.createRepository",
      payload: {
        name: slugify(bundle.project.title) || `agency-project-${projectId.slice(0, 8)}`,
        description: bundle.project.objective.slice(0, 350),
        private: true,
        projectId,
      },
    },
    requestedBy,
    `project:${projectId}:github-repository:v1`,
  );

  return { project: bundle.project, actions: [linear, github] };
}

export async function proposeLinearTaskSync(projectId: string, linearProjectActionId: string, requestedBy: string | Principal = "pm-agent") {
  const bundle = await projectRepository.getProject(projectId);
  if (!bundle) throw new Error("Project not found");

  const linearProjectAction = await actionRepository.get(linearProjectActionId);
  if (!linearProjectAction) throw new Error("Linear project action not found");
  if (linearProjectAction.kind !== "linear.createProject" || linearProjectAction.status !== "succeeded") {
    throw new Error("Linear project action must have succeeded before task sync can be proposed");
  }
  const externalId = linearProjectAction.result?.externalId;
  if (typeof externalId !== "string" || !externalId) throw new Error("Linear project action is missing externalId");

  const actions: Awaited<ReturnType<typeof proposeAction>>[] = [];
  for (const task of bundle.tasks) {
    actions.push(
      await proposeAction(
        {
          kind: "linear.createIssue",
          payload: {
            title: task.title,
            description: `${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
            projectId,
            linearProjectId: externalId,
          },
        },
        requestedBy,
        `project:${projectId}:linear-task:${task.id}:v1`,
      ),
    );
  }
  return { project: bundle.project, actions };
}
