import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import type {
  WorkspaceCommand,
  WorkspaceEvent,
  WorkspaceFileChange,
  WorkspaceRecord,
  WorkspaceValidationResult,
} from "@/schemas/workspace";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const workspaces = db.collection<WorkspaceRecord>("workspaces");
  const commands = db.collection<WorkspaceCommand>("workspace_commands");
  const events = db.collection<WorkspaceEvent>("workspace_events");

  await Promise.all([
    workspaces.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID } },
    ),
    commands.updateMany(
      { tenantId: { $exists: false } },
      {
        $set: {
          tenantId: env().AGENCY_TENANT_ID,
          isolation: "trusted",
          runtimeProvider: "local-process",
          runtimeId: null,
          resourceLimits: null,
          quotaExceeded: false,
          forcedTeardown: false,
          workspacePatchSha256: null,
          integrityViolation: false,
        },
      },
    ),
    events.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: env().AGENCY_TENANT_ID } },
    ),
    workspaces.updateMany(
      { validation: { $ne: null }, "validation.changedScripts": { $exists: false } },
      { $set: { "validation.changedScripts": [] } },
    ),
  ]);

  await Promise.all([
    workspaces.createIndex({ id: 1 }, { unique: true }),
    workspaces.createIndex({ tenantId: 1, attemptId: 1 }, { unique: true }),
    workspaces.createIndex({ tenantId: 1, runId: 1, createdAt: -1 }),
    workspaces.createIndex({ tenantId: 1, projectId: 1, updatedAt: -1 }),
    workspaces.createIndex({ tenantId: 1, status: 1, updatedAt: -1 }),
    commands.createIndex({ id: 1 }, { unique: true }),
    commands.createIndex({ tenantId: 1, workspaceId: 1, startedAt: 1 }),
    events.createIndex({ id: 1 }, { unique: true }),
    events.createIndex({ tenantId: 1, workspaceId: 1, createdAt: 1 }),
    events.createIndex({ tenantId: 1, runId: 1, createdAt: -1 }),
  ]);

  return { workspaces, commands, events };
});

async function appendEvent(input: Omit<WorkspaceEvent, "id" | "tenantId" | "createdAt">) {
  const { events } = await collections();
  const event: WorkspaceEvent = { id: randomUUID(), tenantId: currentTenantId(), ...input, createdAt: new Date() };
  await events.insertOne(event);
  return event;
}

async function reviewTransition(
  id: string,
  from: WorkspaceRecord["status"][],
  to: WorkspaceRecord["status"],
  event: WorkspaceEvent["event"],
  actor: string,
  reason?: string,
) {
  const { workspaces } = await collections();
  const workspace = await workspaces.findOneAndUpdate(
    tenantFilter({ id, status: { $in: from } }),
    { $set: { status: to, updatedAt: new Date() } },
    { returnDocument: "after", projection: { _id: 0 } },
  );
  if (workspace) {
    await appendEvent({
      workspaceId: id,
      runId: workspace.runId,
      attemptId: workspace.attemptId,
      event,
      actor,
      metadata: { reason: reason ?? null },
    });
  }
  return workspace;
}

export const workspaceRepository = {
  async summary() {
    const { workspaces } = await collections();
    const statuses: WorkspaceRecord["status"][] = [
      "preparing", "ready", "applying", "validating", "revision_required",
      "review_required", "approved", "rejected", "failed", "cleaned",
    ];
    const counts = Object.fromEntries(await Promise.all(
      statuses.map(async (status) => [status, await workspaces.countDocuments(tenantFilter({ status }))]),
    )) as Record<WorkspaceRecord["status"], number>;
    return { counts, reviewPending: counts.review_required };
  },

  async create(input: Omit<WorkspaceRecord,
    | "id"
    | "tenantId"
    | "status"
    | "baseSha"
    | "patchPath"
    | "requestedChanges"
    | "appliedChanges"
    | "changedFiles"
    | "additions"
    | "deletions"
    | "diff"
    | "diffTruncated"
    | "validation"
    | "reviewStatus"
    | "reviewedBy"
    | "reviewReason"
    | "reviewedAt"
    | "publishedCommitSha"
    | "pullRequestUrl"
    | "failure"
    | "createdAt"
    | "updatedAt"
  >) {
    const { workspaces } = await collections();
    const existing = await workspaces.findOne(tenantFilter({ attemptId: input.attemptId }), { projection: { _id: 0 } });
    if (existing) return existing;

    const now = new Date();
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      tenantId: currentTenantId(),
      ...input,
      status: "preparing",
      baseSha: null,
      patchPath: null,
      requestedChanges: [],
      appliedChanges: [],
      changedFiles: [],
      additions: 0,
      deletions: 0,
      diff: "",
      diffTruncated: false,
      validation: null,
      reviewStatus: "pending",
      reviewedBy: null,
      reviewReason: null,
      reviewedAt: null,
      publishedCommitSha: null,
      pullRequestUrl: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await workspaces.insertOne(workspace);
    } catch (error) {
      const duplicate = await workspaces.findOne(tenantFilter({ attemptId: input.attemptId }), { projection: { _id: 0 } });
      if (duplicate) return duplicate;
      throw error;
    }

    await appendEvent({
      workspaceId: workspace.id,
      runId: workspace.runId,
      attemptId: workspace.attemptId,
      event: "created",
      actor: "workspace-service",
      metadata: {
        provider: workspace.provider,
        repositoryUrl: workspace.repositoryUrl,
        baseRef: workspace.baseRef,
        branchName: workspace.branchName,
      },
    });
    return workspace;
  },

  async get(id: string) {
    const { workspaces } = await collections();
    return workspaces.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  async latestForRun(runId: string) {
    const { workspaces } = await collections();
    return workspaces.find(tenantFilter({ runId }), { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(1).next();
  },

  async previousForRun(runId: string, excludeWorkspaceId?: string) {
    const { workspaces } = await collections();
    return workspaces
      .find(tenantFilter(excludeWorkspaceId ? { runId, id: { $ne: excludeWorkspaceId } } : { runId }), { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
  },

  async getDetail(id: string) {
    const { workspaces, commands, events } = await collections();
    const workspace = await workspaces.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!workspace) return null;
    const [workspaceCommands, workspaceEvents] = await Promise.all([
      commands.find(tenantFilter({ workspaceId: id }), { projection: { _id: 0 } }).sort({ startedAt: 1 }).toArray(),
      events.find(tenantFilter({ workspaceId: id }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    ]);
    return { workspace, commands: workspaceCommands, events: workspaceEvents };
  },

  async listProject(projectId: string) {
    const { workspaces, commands, events } = await collections();
    const projectWorkspaces = await workspaces
      .find(tenantFilter({ projectId }), { projection: { _id: 0 } })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
    if (!projectWorkspaces.length) return { workspaces: [], commands: [], workspaceEvents: [] };

    const ids = projectWorkspaces.map((workspace) => workspace.id);
    const [projectCommands, projectEvents] = await Promise.all([
      commands.find(tenantFilter({ workspaceId: { $in: ids } }), { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(500).toArray(),
      events.find(tenantFilter({ workspaceId: { $in: ids } }), { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(500).toArray(),
    ]);
    return { workspaces: projectWorkspaces, commands: projectCommands, workspaceEvents: projectEvents };
  },

  async markReady(id: string, input: { baseSha: string; patchPath: string; seededFromWorkspaceId?: string | null }) {
    const { workspaces } = await collections();
    const now = new Date();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "preparing" }),
      { $set: { status: "ready", baseSha: input.baseSha, patchPath: input.patchPath, seededFromWorkspaceId: input.seededFromWorkspaceId ?? null, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace?.seededFromWorkspaceId) {
      await appendEvent({
        workspaceId: workspace.id,
        runId: workspace.runId,
        attemptId: workspace.attemptId,
        event: "seeded",
        actor: "workspace-service",
        metadata: { sourceWorkspaceId: workspace.seededFromWorkspaceId },
      });
    }
    return workspace;
  },

  async markApplying(id: string, changes: WorkspaceFileChange[]) {
    const { workspaces } = await collections();
    return workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "ready" }),
      { $set: { status: "applying", requestedChanges: changes, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async markChangesApplied(id: string, input: {
    appliedChanges: WorkspaceFileChange[];
    changedFiles: string[];
    additions: number;
    deletions: number;
    diff: string;
    diffTruncated: boolean;
  }) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "applying" }),
      { $set: { status: "ready", ...input, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({
        workspaceId: workspace.id,
        runId: workspace.runId,
        attemptId: workspace.attemptId,
        event: "changes_applied",
        actor: "workspace-service",
        metadata: { changedFiles: workspace.changedFiles, additions: workspace.additions, deletions: workspace.deletions },
      });
    }
    return workspace;
  },

  async markValidationStarted(id: string) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "ready" }),
      { $set: { status: "validating", updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({
        workspaceId: workspace.id,
        runId: workspace.runId,
        attemptId: workspace.attemptId,
        event: "validation_started",
        actor: "workspace-service",
        metadata: {},
      });
    }
    return workspace;
  },

  async markValidationCompleted(id: string, validation: WorkspaceValidationResult) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "validating" }),
      { $set: { status: "ready", validation, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({
        workspaceId: workspace.id,
        runId: workspace.runId,
        attemptId: workspace.attemptId,
        event: "validation_completed",
        actor: "workspace-service",
        metadata: {
          passed: validation.passed,
          executedScripts: validation.executedScripts,
          skippedScripts: validation.skippedScripts,
          changedScripts: validation.changedScripts,
        },
      });
    }
    return workspace;
  },

  async markRevisionRequired(id: string, actor: string, reason: string) {
    return reviewTransition(id, ["ready", "validating"], "revision_required", "revision_required", actor, reason);
  },

  async markReviewRequired(id: string, actor: string) {
    return reviewTransition(id, ["ready"], "review_required", "review_required", actor);
  },

  async approve(id: string, actor: string, reason?: string) {
    const { workspaces } = await collections();
    const now = new Date();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "review_required", reviewStatus: "pending" }),
      { $set: { status: "approved", reviewStatus: "approved", reviewedBy: actor, reviewReason: reason ?? null, reviewedAt: now, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({ workspaceId: id, runId: workspace.runId, attemptId: workspace.attemptId, event: "approved", actor, metadata: { reason: reason ?? null } });
    }
    return workspace;
  },

  async reject(id: string, actor: string, reason: string) {
    const { workspaces } = await collections();
    const now = new Date();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "review_required", reviewStatus: "pending" }),
      { $set: { status: "rejected", reviewStatus: "rejected", reviewedBy: actor, reviewReason: reason, reviewedAt: now, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({ workspaceId: id, runId: workspace.runId, attemptId: workspace.attemptId, event: "rejected", actor, metadata: { reason } });
    }
    return workspace;
  },

  async markPublishStarted(id: string, actor: string) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!workspace || workspace.status !== "approved") return null;
    await appendEvent({ workspaceId: id, runId: workspace.runId, attemptId: workspace.attemptId, event: "publish_started", actor, metadata: {} });
    return workspace;
  },

  async markPublished(id: string, actor: string, commitSha: string, pullRequestUrl: string) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: "approved" }),
      { $set: { publishedCommitSha: commitSha, pullRequestUrl, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({ workspaceId: id, runId: workspace.runId, attemptId: workspace.attemptId, event: "published", actor, metadata: { commitSha, pullRequestUrl } });
    }
    return workspace;
  },

  async markPublishFailed(id: string, actor: string, failure: string) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!workspace) return null;
    await appendEvent({
      workspaceId: id,
      runId: workspace.runId,
      attemptId: workspace.attemptId,
      event: "publish_failed",
      actor,
      metadata: { failure },
    });
    return workspace;
  },

  async fail(id: string, actor: string, failure: string) {
    const { workspaces } = await collections();
    const workspace = await workspaces.findOneAndUpdate(
      tenantFilter({ id, status: { $nin: ["approved", "cleaned"] } }),
      { $set: { status: "failed", failure, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (workspace) {
      await appendEvent({ workspaceId: id, runId: workspace.runId, attemptId: workspace.attemptId, event: "failed", actor, metadata: { failure } });
    }
    return workspace;
  },

  async startCommand(input: Omit<WorkspaceCommand,
    | "id"
    | "tenantId"
    | "runtimeId"
    | "status"
    | "exitCode"
    | "stdout"
    | "stderr"
    | "outputTruncated"
    | "timedOut"
    | "quotaExceeded"
    | "forcedTeardown"
    | "workspacePatchSha256"
    | "integrityViolation"
    | "startedAt"
    | "completedAt"
  >) {
    const { commands } = await collections();
    const command: WorkspaceCommand = {
      id: randomUUID(),
      tenantId: currentTenantId(),
      ...input,
      runtimeId: null,
      status: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      timedOut: false,
      quotaExceeded: false,
      forcedTeardown: false,
      workspacePatchSha256: null,
      integrityViolation: false,
      startedAt: new Date(),
      completedAt: null,
    };
    await commands.insertOne(command);
    return command;
  },

  async finishCommand(id: string, result: Pick<WorkspaceCommand,
    | "exitCode"
    | "stdout"
    | "stderr"
    | "outputTruncated"
    | "timedOut"
    | "runtimeProvider"
    | "runtimeId"
    | "resourceLimits"
    | "quotaExceeded"
    | "forcedTeardown"
    | "workspacePatchSha256"
    | "integrityViolation"
  >) {
    const { commands } = await collections();
    const status = result.timedOut ? "timed_out" : result.exitCode === 0 && !result.quotaExceeded ? "succeeded" : "failed";
    return commands.findOneAndUpdate(
      tenantFilter({ id, status: "running" }),
      { $set: { ...result, status, completedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

};
