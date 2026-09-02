import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { projectRepository } from "@/repositories/project-repository";
import { actionRepository } from "@/repositories/action-repository";
import { executionRepository } from "@/repositories/execution-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { agentRoleSchema, executionModeSchema } from "@/schemas/execution";
import { proposeProjectProvisioning, proposeLinearTaskSync } from "@/services/provisioning-service";
import { queueReadyTasks, queueTaskRun } from "@/services/execution-service";
import { proposeWorkspacePublish } from "@/services/workspace-review-service";

export const getProjectTool = createTool({
  id: "get-project-truth",
  description: "Read the current project record and task plan from AgencyOS. Use this before making status claims or recommendations.",
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: z.object({
    found: z.boolean(),
    project: z.unknown().nullable(),
    tasks: z.array(z.unknown()),
  }),
  execute: async ({ projectId }) => {
    const bundle = await projectRepository.getProject(projectId);
    return bundle
      ? { found: true, project: bundle.project, tasks: bundle.tasks }
      : { found: false, project: null, tasks: [] };
  },
});

export const getProjectActionsTool = createTool({
  id: "get-project-actions",
  description: "Read controlled external-action proposals and their current statuses for a project. This never performs a write.",
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: z.object({ actions: z.array(z.unknown()), events: z.array(z.unknown()) }),
  execute: async ({ projectId }) => actionRepository.listProjectActivity(projectId),
});

export const getProjectRunsTool = createTool({
  id: "get-project-execution-runs",
  description: "Read worker runs, attempts, QA results, workspaces, command evidence, and execution events. Use this before claiming work passed QA or was approved.",
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: z.object({
    runs: z.array(z.unknown()),
    attempts: z.array(z.unknown()),
    events: z.array(z.unknown()),
    workspaces: z.array(z.unknown()),
    commands: z.array(z.unknown()),
    workspaceEvents: z.array(z.unknown()),
  }),
  execute: async ({ projectId }) => {
    const [runs, workspaces] = await Promise.all([
      executionRepository.listProjectActivity(projectId),
      workspaceRepository.listProject(projectId),
    ]);
    return { ...runs, ...workspaces };
  },
});

export const proposeProjectProvisioningTool = createTool({
  id: "propose-project-provisioning",
  description: "Prepare approval-required Linear project and private GitHub repository actions for a project. This only proposes actions; it never approves or executes them.",
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: z.object({ project: z.unknown(), actions: z.array(z.unknown()) }),
  execute: async ({ projectId }) => proposeProjectProvisioning(projectId, "project-manager-agent"),
});

export const proposeLinearTaskSyncTool = createTool({
  id: "propose-linear-task-sync",
  description: "After a Linear project creation action has succeeded, prepare approval-required Linear issue proposals for every AgencyOS task. This does not approve or execute them.",
  inputSchema: z.object({
    projectId: z.string().min(1),
    linearProjectActionId: z.string().min(1),
  }),
  outputSchema: z.object({ project: z.unknown(), actions: z.array(z.unknown()) }),
  execute: async ({ projectId, linearProjectActionId }) =>
    proposeLinearTaskSync(projectId, linearProjectActionId, "project-manager-agent"),
});

export const queueTaskRunTool = createTool({
  id: "queue-task-run",
  description: "Assign one AgencyOS task to a specialized worker and place it in the durable execution queue. Queuing does not execute the worker or spend the attempt budget.",
  inputSchema: z.object({
    taskId: z.string().min(1),
    assignedRole: agentRoleSchema.optional(),
    executionMode: executionModeSchema.optional(),
  }),
  outputSchema: z.unknown(),
  execute: async ({ taskId, assignedRole, executionMode }) =>
    queueTaskRun(taskId, { requestedBy: "project-manager-agent", assignedRole, executionMode }),
});

export const proposeWorkspacePublishTool = createTool({
  id: "propose-workspace-publish",
  description: "Prepare an approval-required GitHub branch push and draft pull request for a human-approved workspace. This only proposes the external action.",
  inputSchema: z.object({
    runId: z.string().min(1),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    draft: z.boolean().default(true),
  }),
  outputSchema: z.unknown(),
  execute: async ({ runId, ...input }) => proposeWorkspacePublish(runId, input, "project-manager-agent"),
});

export const queueReadyTasksTool = createTool({
  id: "queue-ready-project-tasks",
  description: "Queue every dependency-ready task that has no active run. This prepares internal work but does not execute any worker or QA model call.",
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: z.object({ project: z.unknown(), queued: z.array(z.unknown()), skipped: z.array(z.unknown()) }),
  execute: async ({ projectId }) => queueReadyTasks(projectId, "project-manager-agent"),
});

export const projectManagerTools = {
  getProject: getProjectTool,
  getProjectActions: getProjectActionsTool,
  getProjectRuns: getProjectRunsTool,
  proposeProjectProvisioning: proposeProjectProvisioningTool,
  proposeLinearTaskSync: proposeLinearTaskSyncTool,
  queueTaskRun: queueTaskRunTool,
  queueReadyTasks: queueReadyTasksTool,
  proposeWorkspacePublish: proposeWorkspacePublishTool,
};
