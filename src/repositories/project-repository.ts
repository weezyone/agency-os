import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import type { Client, Project, ProjectStatus, RepositoryBinding, Task, TaskStatus } from "@/schemas/domain";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const clients = db.collection<Client>("clients");
  const projects = db.collection<Project>("projects");
  const tasks = db.collection<Task>("tasks");

  await Promise.all([
    clients.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: env().AGENCY_TENANT_ID } }),
    projects.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: env().AGENCY_TENANT_ID } }),
    tasks.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: env().AGENCY_TENANT_ID } }),
  ]);

  await Promise.all([
    clients.createIndex({ id: 1 }, { unique: true }),
    clients.createIndex({ tenantId: 1, email: 1, updatedAt: -1 }),
    projects.createIndex({ id: 1 }, { unique: true }),
    projects.createIndex({ tenantId: 1, clientId: 1, updatedAt: -1 }),
    projects.createIndex({ tenantId: 1, status: 1, updatedAt: -1 }),
    tasks.createIndex({ id: 1 }, { unique: true }),
    tasks.createIndex({ tenantId: 1, projectId: 1, status: 1, priority: 1 }),
    tasks.createIndex({ tenantId: 1, activeRunId: 1 }, { sparse: true }),
  ]);

  return { clients, projects, tasks };
});

function projectStatusForTasks(tasks: Task[]): ProjectStatus {
  if (!tasks.length) return "planning";
  if (tasks.every((task) => task.status === "done")) return "done";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => ["todo", "in_progress", "review"].includes(task.status))) return "active";
  return "planning";
}

export const projectRepository = {
  async createClient(input: Omit<Client, "id" | "tenantId" | "createdAt" | "updatedAt">) {
    const { clients } = await collections();
    const now = new Date();
    const client: Client = { id: randomUUID(), tenantId: currentTenantId(), ...input, createdAt: now, updatedAt: now };
    await clients.insertOne(client);
    return client;
  },

  async createProject(input: Omit<Project, "id" | "tenantId" | "createdAt" | "updatedAt">) {
    const { projects } = await collections();
    const now = new Date();
    const project: Project = { id: randomUUID(), tenantId: currentTenantId(), ...input, createdAt: now, updatedAt: now };
    await projects.insertOne(project);
    return project;
  },

  async createTasks(inputs: Array<Omit<Task, "id" | "tenantId" | "createdAt" | "updatedAt">>) {
    const { tasks } = await collections();
    const tenantId = currentTenantId();
    const now = new Date();
    const docs: Task[] = inputs.map((input) => ({
      id: randomUUID(),
      tenantId,
      activeRunId: null,
      completedRunId: null,
      ...input,
      createdAt: now,
      updatedAt: now,
    }));
    if (docs.length) await tasks.insertMany(docs);
    return docs;
  },

  async getProject(id: string) {
    const { projects, tasks } = await collections();
    const project = await projects.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!project) return null;
    const projectTasks = await tasks
      .find(tenantFilter({ projectId: id }), { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    return { project, tasks: projectTasks };
  },

  async getTask(id: string) {
    const { tasks } = await collections();
    return tasks.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  async getTaskContext(id: string) {
    const { projects, tasks } = await collections();
    const task = await tasks.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!task) return null;
    const [project, projectTasks] = await Promise.all([
      projects.findOne(tenantFilter({ id: task.projectId }), { projection: { _id: 0 } }),
      tasks.find(tenantFilter({ projectId: task.projectId }), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    ]);
    if (!project) return null;
    return { project, task, tasks: projectTasks };
  },

  async listProjects(limit = 25) {
    const { projects } = await collections();
    return projects.find(tenantFilter(), { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
  },

  async bindRepository(projectId: string, repository: RepositoryBinding) {
    const { projects } = await collections();
    return projects.findOneAndUpdate(
      tenantFilter({ id: projectId }),
      { $set: { repository, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async transitionTask(id: string, from: TaskStatus | TaskStatus[], to: TaskStatus, patch: Partial<Task> = {}) {
    const { tasks } = await collections();
    const allowed = Array.isArray(from) ? from : [from];
    return tasks.findOneAndUpdate(
      tenantFilter({ id, status: { $in: allowed } }),
      { $set: { ...patch, status: to, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async patchTask(id: string, patch: Partial<Task>) {
    const { tasks } = await collections();
    return tasks.findOneAndUpdate(
      tenantFilter({ id }),
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async refreshProjectStatus(projectId: string) {
    const { projects, tasks } = await collections();
    const projectTasks = await tasks.find(tenantFilter({ projectId }), { projection: { _id: 0 } }).toArray();
    const status = projectStatusForTasks(projectTasks);
    const patch: Partial<Project> = { status, updatedAt: new Date() };
    if (status === "done") patch.currentPhase = "Complete";
    return projects.findOneAndUpdate(
      tenantFilter({ id: projectId }),
      { $set: patch },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },
};
