import { env } from "@/lib/env";
import { currentTenantId } from "@/lib/tenant-context";
import { qualityGateAgent } from "@/mastra/agents/quality-gate-agent";
import { workerAgents } from "@/mastra/agents/worker-agents";
import { executionRepository } from "@/repositories/execution-repository";
import { executionJobRepository } from "@/repositories/execution-job-repository";
import { projectRepository } from "@/repositories/project-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { publicWorkspace } from "@/services/workspace-public";
import { ExecutionLeaseLostError, type ExecutionGuard } from "@/services/execution-guard";
import { terminateWorkspaceRuntime } from "@/workspaces/provider";
import type { Project, Task } from "@/schemas/domain";
import {
  queueTaskRunSchema,
  qaResultSchema,
  workerOutputSchema,
  type AgentRole,
  type ExecutionRun,
  type QueueTaskRunInput,
  type WorkerOutput,
} from "@/schemas/execution";
import type { WorkspaceCommand, WorkspaceRecord } from "@/schemas/workspace";
import { recordGenerationUsage } from "@/services/usage-service";
import {
  decideQaOutcome,
  evaluateTaskReadiness,
  normalizeQaResult,
  normalizeWorkspaceQaResult,
  resolveAgentRole,
  resolveExecutionMode,
} from "@/services/execution-policy";
import {
  applyWorkspaceChanges,
  buildRepositoryContext,
  enrichWorkerOutput,
  prepareWorkspace,
  validateWorkspace,
  workspaceEvidenceForQa,
  type RepositoryContext,
} from "@/services/workspace-service";

function workerPrompt(input: {
  run: ExecutionRun;
  project: Project;
  task: Task;
  repositoryContext?: RepositoryContext;
}) {
  return `
Execute this bounded AgencyOS task and return only the requested structured result.

EXECUTION MODE
${input.run.executionMode}

PROJECT
${JSON.stringify({
  id: input.project.id,
  title: input.project.title,
  objective: input.project.objective,
  scope: input.project.scope,
  constraints: input.project.constraints,
  deliverables: input.project.deliverables,
  risks: input.project.risks,
  repository: input.project.repository ?? null,
}, null, 2)}

TASK
${JSON.stringify({
  id: input.task.id,
  title: input.task.title,
  description: input.task.description,
  ownerRole: input.task.ownerRole,
  priority: input.task.priority,
  dependencies: input.task.dependencies,
  acceptanceCriteria: input.task.acceptanceCriteria,
}, null, 2)}

EXECUTION
${JSON.stringify({
  assignedRole: input.run.assignedRole,
  attempt: input.run.currentAttempt,
  maxAttempts: input.run.maxAttempts,
  previousQa: input.run.lastQa,
  previousWorkerSummary: input.run.lastWorkerOutput?.summary ?? null,
}, null, 2)}

${input.repositoryContext ? `REPOSITORY SNAPSHOT
${JSON.stringify(input.repositoryContext, null, 2)}

WORKSPACE REQUIREMENTS
- Return every repository mutation in fileChanges.
- Use exact repository-relative paths from the snapshot when updating or deleting files.
- Use create only for files that do not exist and update only for files that exist.
- Keep changes bounded to this task and acceptance criteria.
- requestedValidationScripts may contain only package.json script names visible in the snapshot.
- Do not claim commands passed; AgencyOS will execute and attach authoritative evidence after applying the changes.
` : ""}
Produce concrete artifacts that satisfy the acceptance criteria. If the task cannot be completed from the supplied context, return explicit blockers instead of fabricating completion.
`;
}

function qaPrompt(input: {
  run: ExecutionRun;
  project: Project;
  task: Task;
  workerOutput: WorkerOutput;
  workspaceEvidence?: unknown;
}) {
  return `
Evaluate this worker attempt as AgencyOS's independent quality gate.
The configured pass threshold is ${input.run.minQaScore}/100.
Return only the requested structured QA result.

PROJECT CONSTRAINTS
${JSON.stringify(input.project.constraints, null, 2)}

TASK
${JSON.stringify({
  title: input.task.title,
  description: input.task.description,
  acceptanceCriteria: input.task.acceptanceCriteria,
}, null, 2)}

WORKER OUTPUT
${JSON.stringify(input.workerOutput, null, 2)}

${input.workspaceEvidence ? `AUTHORITATIVE WORKSPACE EVIDENCE
${JSON.stringify(input.workspaceEvidence, null, 2)}

QA RULES FOR WORKSPACE MODE
- Treat command exit codes, captured output, changed-file inventory, and patch text as authoritative.
- Do not accept unsupported claims in the worker narrative over contradictory command evidence.
- A failed or missing validation gate requires revision unless the task explicitly has no executable validation path and the evidence explains why.
- Confirm every acceptance criterion against the actual patch and evidence.
` : ""}
`;
}

export async function queueTaskRun(taskId: string, rawInput: QueueTaskRunInput | unknown = {}) {
  const input = queueTaskRunSchema.parse(rawInput);
  const context = await projectRepository.getTaskContext(taskId);
  if (!context) throw new Error("Task not found");
  if (context.task.status === "done") throw new Error("Completed tasks cannot be queued again");

  const assignedRole: AgentRole = input.assignedRole ?? resolveAgentRole(context.task.ownerRole);
  const executionMode = input.executionMode ?? resolveExecutionMode(context.task, assignedRole);
  const run = await executionRepository.queue({
    projectId: context.project.id,
    taskId: context.task.id,
    assignedRole,
    executionMode,
    requestedBy: input.requestedBy,
    maxAttempts: input.maxAttempts ?? env().AGENCY_MAX_ATTEMPTS,
    minQaScore: input.minQaScore ?? env().AGENCY_QA_MIN_SCORE,
  });

  if (run.status === "queued") {
    await projectRepository.transitionTask(
      context.task.id,
      ["backlog", "todo", "blocked", "review", "in_progress"],
      "todo",
      { activeRunId: run.id },
    );
  } else {
    await projectRepository.patchTask(context.task.id, { activeRunId: run.id });
  }
  await projectRepository.refreshProjectStatus(context.project.id);
  return run;
}

export async function queueReadyTasks(projectId: string, requestedBy = "project-manager-agent") {
  const bundle = await projectRepository.getProject(projectId);
  if (!bundle) throw new Error("Project not found");

  const queued = [];
  const skipped: Array<{ taskId: string; title: string; reasons: string[] }> = [];

  for (const task of bundle.tasks) {
    const readiness = evaluateTaskReadiness(task, bundle.tasks);
    if (!readiness.ready) {
      skipped.push({ taskId: task.id, title: task.title, reasons: readiness.reasons });
      continue;
    }
    queued.push(await queueTaskRun(task.id, { requestedBy }));
  }

  return { project: bundle.project, queued, skipped };
}

export async function executeRun(
  runId: string,
  executedBy = "operator-dashboard",
  guard?: ExecutionGuard,
) {
  const checkpoint = async (stage: string) => {
    if (guard?.signal.aborted) throw new ExecutionLeaseLostError(stage, "Execution was cancelled or lost its lease");
    await guard?.assertActive(stage);
  };

  await checkpoint("before-run-load");
  const current = await executionRepository.get(runId);
  if (!current) throw new Error("Execution run not found");
  if (current.status === "passed") return executionRepository.getDetail(runId);
  if (current.status !== "queued" && current.status !== "revision_requested") {
    throw new Error(`Execution run cannot start from status ${current.status}`);
  }
  if (current.currentAttempt >= current.maxAttempts) throw new Error("Execution run has exhausted its attempt budget");
  await checkpoint("before-run-claim");

  const claimed = await executionRepository.claim(runId, executedBy);
  if (!claimed) throw new Error("Execution run was already claimed or cannot be retried");
  const attempt = await executionRepository.createAttempt(claimed);
  const context = await projectRepository.getTaskContext(claimed.taskId);
  if (!context) {
    await executionRepository.failAttempt({
      runId: claimed.id,
      attemptId: attempt.id,
      actor: executedBy,
      error: "Task or project context no longer exists",
    });
    throw new Error("Task or project context no longer exists");
  }

  await projectRepository.transitionTask(
    context.task.id,
    ["backlog", "todo", "blocked", "review", "in_progress"],
    "in_progress",
    { activeRunId: claimed.id },
  );
  await projectRepository.refreshProjectStatus(context.project.id);

  let finalized = false;
  let workspace: WorkspaceRecord | null = null;
  let validationCommands: WorkspaceCommand[] = [];
  let runtimeRun = claimed;

  try {
    await checkpoint("before-execution");
    let repositoryContext: RepositoryContext | undefined;
    if (runtimeRun.executionMode === "workspace") {
      await checkpoint("before-workspace-preparation");
      workspace = await prepareWorkspace({ run: runtimeRun, attempt, project: context.project, signal: guard?.signal });
      const attached = await executionRepository.attachWorkspace(
        runtimeRun.id,
        attempt.id,
        workspace.id,
        "workspace-service",
      );
      if (!attached) throw new Error("Execution run state changed before workspace attachment");
      runtimeRun = attached;
      await checkpoint("after-workspace-preparation");
      repositoryContext = await buildRepositoryContext(workspace, context.task, guard?.signal);
      await checkpoint("after-repository-context");
    }

    await checkpoint("before-worker-generation");
    const worker = workerAgents[runtimeRun.assignedRole];
    const workerResult = await worker.generate(
      workerPrompt({ run: runtimeRun, project: context.project, task: context.task, repositoryContext }),
      {
        abortSignal: guard?.signal,
        memory: {
          resource: `tenant:${currentTenantId()}:project:${runtimeRun.projectId}`,
          thread: `tenant:${currentTenantId()}:execution:${runtimeRun.id}:attempt:${runtimeRun.currentAttempt}:worker`,
        },
        structuredOutput: { schema: workerOutputSchema, errorStrategy: "strict" },
      },
    );
    await recordGenerationUsage({
      result: workerResult,
      model: env().AGENCY_WORKER_MODEL,
      agent: `worker:${runtimeRun.assignedRole}`,
      operation: "execution.worker",
      requestId: workerResult.runId ?? null,
      projectId: runtimeRun.projectId,
      taskId: runtimeRun.taskId,
      runId: runtimeRun.id,
      attemptId: attempt.id,
    }).catch((error) => console.error("Usage accounting failed", error));
    let workerOutput = workerOutputSchema.parse(workerResult.object);
    await checkpoint("after-worker-generation");

    if (workspace && repositoryContext) {
      await checkpoint("before-workspace-apply");
      workspace = await applyWorkspaceChanges(workspace, workerOutput.fileChanges, guard?.signal);
      await checkpoint("before-workspace-validation");
      const validation = await validateWorkspace(
        workspace,
        repositoryContext,
        workerOutput.requestedValidationScripts,
        guard?.signal,
      );
      workspace = validation.workspace;
      validationCommands = validation.commands;
      await checkpoint("after-workspace-validation");
      workerOutput = enrichWorkerOutput({ output: workerOutput, workspace, commands: validationCommands });
    }

    await checkpoint("before-worker-persist");
    const qaReviewRun = await executionRepository.markWorkerCompleted(
      runtimeRun.id,
      attempt.id,
      workerOutput,
      `worker:${runtimeRun.assignedRole}`,
    );
    if (!qaReviewRun) throw new Error("Execution run state changed before QA review");

    await projectRepository.transitionTask(
      context.task.id,
      ["in_progress", "review"],
      "review",
      { activeRunId: runtimeRun.id },
    );
    await executionRepository.markQaStarted(qaReviewRun, "quality-gate");
    await checkpoint("before-qa-generation");

    const qaAgentResult = await qualityGateAgent.generate(
      qaPrompt({
        run: qaReviewRun,
        project: context.project,
        task: context.task,
        workerOutput,
        workspaceEvidence: workspace ? workspaceEvidenceForQa(workspace, validationCommands) : undefined,
      }),
      {
        abortSignal: guard?.signal,
        memory: {
          resource: `tenant:${currentTenantId()}:project:${runtimeRun.projectId}`,
          thread: `tenant:${currentTenantId()}:execution:${runtimeRun.id}:attempt:${runtimeRun.currentAttempt}:qa`,
        },
        structuredOutput: { schema: qaResultSchema, errorStrategy: "strict" },
      },
    );
    await checkpoint("after-qa-generation");
    await recordGenerationUsage({
      result: qaAgentResult,
      model: env().AGENCY_QA_MODEL,
      agent: "quality-gate",
      operation: "execution.qa",
      requestId: qaAgentResult.runId ?? null,
      projectId: runtimeRun.projectId,
      taskId: runtimeRun.taskId,
      runId: runtimeRun.id,
      attemptId: attempt.id,
    }).catch((error) => console.error("Usage accounting failed", error));
    const parsedQa = qaResultSchema.parse(qaAgentResult.object);
    let qa = workspace
      ? normalizeWorkspaceQaResult(parsedQa, runtimeRun.minQaScore, workspace.validation)
      : normalizeQaResult(parsedQa, runtimeRun.minQaScore);
    if (workspace && workspace.changedFiles.length === 0 && qa.verdict !== "fail") {
      const instruction = "Produce a non-empty repository patch that satisfies the assigned implementation task.";
      qa = {
        ...qa,
        verdict: "revise",
        findings: [...qa.findings, instruction],
        revisionInstructions: qa.revisionInstructions.includes(instruction)
          ? qa.revisionInstructions
          : [...qa.revisionInstructions, instruction],
      };
    }
    const qaOutcome = decideQaOutcome({
      qa,
      minQaScore: runtimeRun.minQaScore,
      currentAttempt: runtimeRun.currentAttempt,
      maxAttempts: runtimeRun.maxAttempts,
    });
    const runOutcome = workspace && qaOutcome === "passed" ? "approval_required" : qaOutcome;

    await checkpoint("before-qa-persist");
    const finished = await executionRepository.finishAttempt({
      runId: runtimeRun.id,
      attemptId: attempt.id,
      qa,
      status: runOutcome,
      actor: "quality-gate",
    });
    if (!finished) throw new Error("Execution run state changed before QA completion");
    finalized = true;

    if (runOutcome === "passed") {
      await projectRepository.transitionTask(
        context.task.id,
        ["review", "in_progress"],
        "done",
        { activeRunId: null, completedRunId: runtimeRun.id },
      );
    } else if (runOutcome === "approval_required") {
      if (!workspace) throw new Error("Workspace approval was requested without a workspace");
      const reviewWorkspace = await workspaceRepository.markReviewRequired(workspace.id, "quality-gate");
      if (!reviewWorkspace) throw new Error("Workspace state changed before review handoff");
      await projectRepository.transitionTask(
        context.task.id,
        ["review", "in_progress"],
        "review",
        { activeRunId: runtimeRun.id },
      );
    } else if (runOutcome === "revision_requested") {
      if (workspace) await workspaceRepository.markRevisionRequired(workspace.id, "quality-gate", qa.summary);
      await projectRepository.transitionTask(
        context.task.id,
        ["review", "in_progress"],
        "in_progress",
        { activeRunId: runtimeRun.id },
      );
    } else {
      if (workspace) await workspaceRepository.fail(workspace.id, "quality-gate", qa.summary);
      await projectRepository.transitionTask(
        context.task.id,
        ["review", "in_progress"],
        "blocked",
        { activeRunId: null },
      );
    }

    await projectRepository.refreshProjectStatus(context.project.id);
    return getExecutionDetail(runtimeRun.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution failure";
    const leaseLost = error instanceof ExecutionLeaseLostError || guard?.signal.aborted === true;
    if (!finalized) {
      if (workspace) {
        await terminateWorkspaceRuntime(workspace.id).catch(() => undefined);
        await workspaceRepository.fail(workspace.id, executedBy, message);
      }

      if (leaseLost) {
        const interruption = await executionRepository.interruptCurrentAttempt({
          runId: runtimeRun.id,
          actor: executedBy,
          error: message,
          expectedAttemptNumber: runtimeRun.currentAttempt,
        });
        if (interruption.interrupted) {
          await projectRepository.transitionTask(
            context.task.id,
            ["backlog", "todo", "in_progress", "review", "blocked"],
            interruption.run?.status === "revision_requested" ? "in_progress" : "blocked",
            { activeRunId: interruption.run?.status === "revision_requested" ? runtimeRun.id : null },
          );
        }
      } else {
        const interruption = await executionRepository.interruptCurrentAttempt({
          runId: runtimeRun.id,
          actor: executedBy,
          error: message,
          expectedAttemptNumber: runtimeRun.currentAttempt,
        });
        if (interruption.interrupted) {
          await projectRepository.transitionTask(
            context.task.id,
            ["backlog", "todo", "in_progress", "review", "blocked"],
            interruption.run?.status === "revision_requested" ? "in_progress" : "blocked",
            { activeRunId: interruption.run?.status === "revision_requested" ? runtimeRun.id : null },
          );
        }
      }
      await projectRepository.refreshProjectStatus(context.project.id);
    }
    throw error;
  }
}

export async function approveWorkspaceRun(
  runId: string,
  approvedBy: string,
  reason?: string,
) {
  const run = await executionRepository.get(runId);
  if (!run) throw new Error("Execution run not found");
  if (run.status === "passed") return getExecutionDetail(runId);
  if (run.status !== "approval_required" || !run.workspaceId) {
    throw new Error(`Execution run cannot be approved from status ${run.status}`);
  }
  if (env().AGENCY_REQUIRE_SEPARATE_APPROVER && run.requestedBy === approvedBy) {
    throw new Error("Separation of duties prevents the run requester from approving this workspace");
  }

  const delivery = await executionJobRepository.listForRun(run.id);
  const latestJob = delivery.jobs[0] ?? null;
  if (latestJob && latestJob.status !== "succeeded") {
    throw new Error(`Workspace approval requires a succeeded durable delivery; current delivery is ${latestJob.status}`);
  }

  const workspace = await workspaceRepository.approve(run.workspaceId, approvedBy, reason);
  if (!workspace) throw new Error("Workspace cannot be approved from its current state");
  const completed = await executionRepository.approveWorkspace(run.id, approvedBy, workspace.id);
  if (!completed) throw new Error("Execution run state changed before workspace approval completed");

  await projectRepository.transitionTask(
    run.taskId,
    ["review", "in_progress"],
    "done",
    { activeRunId: null, completedRunId: run.id },
  );
  await projectRepository.refreshProjectStatus(run.projectId);
  return getExecutionDetail(run.id);
}

export async function rejectWorkspaceRun(
  runId: string,
  rejectedBy: string,
  reason: string,
) {
  const run = await executionRepository.get(runId);
  if (!run) throw new Error("Execution run not found");
  if (run.status !== "approval_required" || !run.workspaceId) {
    throw new Error(`Execution run cannot be rejected from status ${run.status}`);
  }

  const delivery = await executionJobRepository.listForRun(run.id);
  const latestJob = delivery.jobs[0] ?? null;
  if (latestJob && latestJob.status !== "succeeded") {
    throw new Error(`Workspace revision requires a succeeded durable delivery; current delivery is ${latestJob.status}`);
  }

  const workspace = await workspaceRepository.reject(run.workspaceId, rejectedBy, reason);
  if (!workspace) throw new Error("Workspace cannot be rejected from its current state");
  const next = await executionRepository.rejectWorkspace(run.id, rejectedBy, workspace.id, reason);
  if (!next) throw new Error("Execution run state changed before workspace rejection completed");

  if (next.status === "revision_requested") {
    await projectRepository.transitionTask(
      run.taskId,
      ["review", "in_progress"],
      "in_progress",
      { activeRunId: run.id },
    );
  } else {
    await projectRepository.transitionTask(
      run.taskId,
      ["review", "in_progress"],
      "blocked",
      { activeRunId: null },
    );
  }
  await projectRepository.refreshProjectStatus(run.projectId);
  return getExecutionDetail(run.id);
}

export async function getExecutionDetail(runId: string) {
  const detail = await executionRepository.getDetail(runId);
  if (!detail) return null;
  const workspaceDetail = detail.run.workspaceId
    ? await workspaceRepository.getDetail(detail.run.workspaceId)
    : null;
  return {
    ...detail,
    workspace: workspaceDetail?.workspace ? publicWorkspace(workspaceDetail.workspace) : null,
    commands: workspaceDetail?.commands ?? [],
    workspaceEvents: workspaceDetail?.events ?? [],
  };
}

export async function cancelRun(runId: string, cancelledBy: string, reason: string) {
  const run = await executionRepository.cancel(runId, cancelledBy, reason);
  if (!run) {
    const current = await executionRepository.get(runId);
    if (!current) throw new Error("Execution run not found");
    throw new Error(`Execution run cannot be cancelled from status ${current.status}`);
  }

  await projectRepository.transitionTask(
    run.taskId,
    ["todo", "in_progress", "review", "blocked", "backlog"],
    "todo",
    { activeRunId: null },
  );
  await projectRepository.refreshProjectStatus(run.projectId);
  return run;
}
