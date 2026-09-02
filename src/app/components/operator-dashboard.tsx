"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Permission =
  | "control:read"
  | "project:write"
  | "run:dispatch"
  | "run:cancel"
  | "workspace:review"
  | "action:propose"
  | "action:approve"
  | "action:execute"
  | "artifact:read"
  | "metrics:read"
  | "usage:read"
  | "admin:members"
  | "admin:keys"
  | "admin:tenant"
  | "admin:secrets"
  | "admin:policies"
  | "admin:pricing";

type Principal = {
  id: string;
  tenantId: string;
  memberId: string | null;
  email: string | null;
  displayName: string;
  role: "owner" | "admin" | "operator" | "reviewer" | "viewer";
  permissions: Permission[];
  authMethod: "disabled" | "bootstrap" | "api_key" | "session";
};

type Tenant = {
  id: string;
  slug: string;
  displayName: string;
  status: "active" | "suspended";
};

type ActionApproval = {
  principalId: string;
  displayName: string;
  role: Principal["role"];
  approvedAt: string;
};

type Project = {
  id: string;
  title: string;
  status: string;
  objective: string;
  currentPhase: string;
  updatedAt: string;
  repository?: {
    provider: "github" | "git";
    url: string;
    cloneUrl: string;
    fullName: string | null;
    defaultBranch: string;
  } | null;
};

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  ownerRole: string;
  activeRunId?: string | null;
  completedRunId?: string | null;
};

type Action = {
  id: string;
  kind: "linear.createProject" | "linear.createIssue" | "github.createRepository" | "github.publishWorkspace";
  status: "proposed" | "approved" | "rejected" | "executing" | "succeeded" | "failed";
  payload: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  requestedBy: string;
  requestedByDisplayName: string;
  requestedByPrincipalId: string | null;
  requiredApprovals: number;
  approvals: ActionApproval[];
  approvedBy: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
};

type ActionEvent = {
  id: string;
  actionId: string;
  event: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type WorkerArtifact = {
  type: string;
  title: string;
  description: string;
  content: string;
  path: string | null;
  url: string | null;
};

type WorkerOutput = {
  summary: string;
  artifacts: WorkerArtifact[];
  blockers: string[];
  completionNotes: string[];
  handoff: string;
  confidence: number;
};

type QaResult = {
  score: number;
  verdict: "pass" | "revise" | "fail";
  summary: string;
  findings: string[];
  revisionInstructions: string[];
};

type ExecutionRun = {
  id: string;
  projectId: string;
  taskId: string;
  assignedRole: string;
  executionMode: "artifact" | "workspace";
  status: "queued" | "running" | "qa_review" | "revision_requested" | "approval_required" | "passed" | "failed" | "cancelled";
  requestedBy: string;
  currentAttempt: number;
  maxAttempts: number;
  minQaScore: number;
  lastWorkerOutput: WorkerOutput | null;
  lastQa: QaResult | null;
  lastError: string | null;
  cancellationReason: string | null;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Workspace = {
  id: string;
  runId: string;
  status: "preparing" | "ready" | "applying" | "validating" | "revision_required" | "review_required" | "approved" | "rejected" | "failed" | "cleaned";
  repositoryFullName: string | null;
  baseRef: string;
  baseSha: string | null;
  branchName: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diff: string;
  diffTruncated: boolean;
  validation: {
    executedScripts: string[];
    skippedScripts: string[];
    changedScripts?: string[];
    passed: boolean;
    summary: string;
  } | null;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  pullRequestUrl: string | null;
  failure: string | null;
};

type WorkspaceCommand = {
  id: string;
  workspaceId: string;
  label: string;
  status: "running" | "succeeded" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
};

type ExecutionJob = {
  id: string;
  runId: string;
  projectId: string;
  taskId: string;
  status: "queued" | "leased" | "running" | "retry_wait" | "succeeded" | "failed" | "dead_letter" | "cancelled";
  priority: number;
  requestedBy: string;
  targetAttemptNumber: number;
  deliveryCount: number;
  maxDeliveries: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  cancelRequestedAt: string | null;
  cancellationReason: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ExecutionArtifact = {
  id: string;
  runId: string;
  attemptId: string;
  kind: string;
  filename: string;
  bytes: number;
  sha256: string;
  downloadUrl: string;
};

const kindLabel: Record<Action["kind"], string> = {
  "linear.createProject": "Linear project",
  "linear.createIssue": "Linear issue",
  "github.createRepository": "GitHub repository",
  "github.publishWorkspace": "GitHub draft pull request",
};

const activeRunStatuses = new Set<ExecutionRun["status"]>([
  "queued",
  "running",
  "qa_review",
  "revision_requested",
  "approval_required",
]);

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.sessionStorage.getItem("agencyos.api-key")?.trim() ?? window.sessionStorage.getItem("agencyos.operator-token")?.trim();
  return token ? { "x-agency-api-key": token } : {};
}

function browserCookie(name: string) {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

function csrfHeader(method: string | undefined) {
  const normalized = (method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalized)) return null;
  return browserCookie("agency_session_csrf")
    ?? document.cookie.split(";").map((part) => part.trim()).find((part) => part.includes("_csrf="))?.split("=").slice(1).join("=")
    ?? null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const csrf = csrfHeader(init?.method);
  if (csrf && !headers.has("x-agency-csrf-token")) headers.set("x-agency-csrf-token", csrf);

  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function OperatorDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [jobs, setJobs] = useState<ExecutionJob[]>([]);
  const [artifacts, setArtifacts] = useState<ExecutionArtifact[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceCommands, setWorkspaceCommands] = useState<WorkspaceCommand[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId],
  );

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const latestJobByRun = useMemo(() => {
    const map = new Map<string, ExecutionJob>();
    for (const job of [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      if (!map.has(job.runId)) map.set(job.runId, job);
    }
    return map;
  }, [jobs]);
  const artifactsByRun = useMemo(() => {
    const map = new Map<string, ExecutionArtifact[]>();
    for (const artifact of artifacts) map.set(artifact.runId, [...(map.get(artifact.runId) ?? []), artifact]);
    return map;
  }, [artifacts]);
  const workspaceById = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const commandsByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceCommand[]>();
    for (const command of workspaceCommands) {
      map.set(command.workspaceId, [...(map.get(command.workspaceId) ?? []), command]);
    }
    return map;
  }, [workspaceCommands]);
  const latestRunByTask = useMemo(() => {
    const map = new Map<string, ExecutionRun>();
    for (const run of [...runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      if (!map.has(run.taskId)) map.set(run.taskId, run);
    }
    return map;
  }, [runs]);

  const loadPrincipal = useCallback(async () => {
    const data = await requestJson<{ principal: Principal; tenant: Tenant | null }>("/api/auth/session");
    setPrincipal(data.principal);
    setTenant(data.tenant);
    return data.principal;
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await requestJson<{ projects: Project[] }>("/api/projects");
    setProjects(data.projects);
    setProjectId((current) => current || data.projects[0]?.id || "");
  }, []);

  const loadProject = useCallback(async (id: string) => {
    if (!id) return;
    const [projectData, activityData, executionData] = await Promise.all([
      requestJson<{ project: Project; tasks: Task[] }>(`/api/projects/${id}`),
      requestJson<{ actions: Action[]; events: ActionEvent[] }>(`/api/projects/${id}/activity`),
      requestJson<{
        runs: ExecutionRun[];
        jobs: ExecutionJob[];
        artifacts: ExecutionArtifact[];
        workspaces: Workspace[];
        commands: WorkspaceCommand[];
      }>(`/api/projects/${id}/runs`),
    ]);
    setProjects((current) => current.map((project) => project.id === projectData.project.id ? projectData.project : project));
    setTasks(projectData.tasks);
    setActions(activityData.actions);
    setEvents(activityData.events);
    setRuns(executionData.runs);
    setJobs(executionData.jobs);
    setArtifacts(executionData.artifacts);
    setWorkspaces(executionData.workspaces);
    setWorkspaceCommands(executionData.commands);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    await Promise.all([loadPrincipal(), loadProjects()]);
    if (projectId) await loadProject(projectId);
  }, [loadPrincipal, loadProject, loadProjects, projectId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setApiKey(
      window.sessionStorage.getItem("agencyos.api-key")
        ?? window.sessionStorage.getItem("agencyos.operator-token")
        ?? "",
    );
    setCredentialsReady(true);
  }, []);

  useEffect(() => {
    if (!credentialsReady) return;
    Promise.all([loadPrincipal(), loadProjects()]).catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to authenticate and load projects"));
  }, [credentialsReady, loadPrincipal, loadProjects]);

  useEffect(() => {
    if (!credentialsReady) return;
    loadProject(projectId).catch((err) => setError(err instanceof Error ? err.message : "Failed to load project"));
  }, [credentialsReady, loadProject, projectId]);

  useEffect(() => {
    if (typeof window === "undefined" || !credentialsReady) return;
    if (apiKey.trim()) {
      window.sessionStorage.setItem("agencyos.api-key", apiKey.trim());
      window.sessionStorage.removeItem("agencyos.operator-token");
    } else {
      window.sessionStorage.removeItem("agencyos.api-key");
      window.sessionStorage.removeItem("agencyos.operator-token");
      setPrincipal(null);
    }
  }, [apiKey, credentialsReady]);

  useEffect(() => {
    const hasActiveJob = jobs.some((job) => ["queued", "leased", "running", "retry_wait"].includes(job.status));
    if (!projectId || !hasActiveJob) return;
    const timer = window.setInterval(() => {
      loadProject(projectId).catch((err) => setError(err instanceof Error ? err.message : "Failed to refresh execution queue"));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [jobs, loadProject, projectId]);

  async function mutate(label: string, fn: () => Promise<unknown>) {
    let failed = false;
    try {
      setBusy(label);
      setError(null);
      await fn();
    } catch (err) {
      failed = true;
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      try {
        await Promise.all([loadProject(projectId), loadProjects()]);
      } catch (refreshError) {
        if (!failed) setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh project state");
      }
      setBusy(null);
    }
  }

  function provision() {
    return mutate("provision", () =>
      requestJson(`/api/projects/${projectId}/provision`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function approve(action: Action) {
    return mutate(action.id, () =>
      requestJson(`/api/actions/${action.id}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function reject(action: Action) {
    const reason = window.prompt("Why are you rejecting this action?");
    if (!reason?.trim()) return;
    return mutate(action.id, () =>
      requestJson(`/api/actions/${action.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    );
  }

  function execute(action: Action) {
    return mutate(action.id, () =>
      requestJson(`/api/actions/${action.id}/execute`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function syncLinearTasks() {
    const linearProject = actions.find(
      (action) => action.kind === "linear.createProject" && action.status === "succeeded",
    );
    if (!linearProject) {
      setError("Execute the Linear project action successfully before proposing task sync.");
      return;
    }
    return mutate("sync-linear", () =>
      requestJson(`/api/projects/${projectId}/sync-linear-tasks`, {
        method: "POST",
        body: JSON.stringify({ linearProjectActionId: linearProject.id }),
      }),
    );
  }

  function queueReady() {
    return mutate("queue-ready", () =>
      requestJson(`/api/projects/${projectId}/dispatch-ready`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function queueTask(task: Task) {
    return mutate(`queue:${task.id}`, () =>
      requestJson(`/api/tasks/${task.id}/runs`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function executeWorkerRun(run: ExecutionRun) {
    return mutate(`run:${run.id}`, () =>
      requestJson(`/api/runs/${run.id}/execute`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function retryDurableJob(job: ExecutionJob) {
    return mutate(`retry-job:${job.id}`, () =>
      requestJson(`/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  async function downloadArtifact(artifact: ExecutionArtifact) {
    try {
      setBusy(`artifact:${artifact.id}`);
      setError(null);
      const response = await fetch(artifact.downloadUrl, { headers: authHeaders(), credentials: "same-origin" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body?.message === "string" ? body.message : `Artifact download failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Artifact download failed");
    } finally {
      setBusy(null);
    }
  }

  function cancelWorkerRun(run: ExecutionRun) {
    const reason = window.prompt("Why are you cancelling this worker run?");
    if (!reason?.trim()) return;
    return mutate(`cancel:${run.id}`, () =>
      requestJson(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    );
  }

  function bindRepository() {
    const url = window.prompt("Git repository URL (for GitHub, use the repository page URL):");
    if (!url?.trim()) return;
    const defaultBranch = window.prompt("Default branch:", "main")?.trim() || "main";
    return mutate("bind-repository", () =>
      requestJson(`/api/projects/${projectId}/repository`, {
        method: "PUT",
        body: JSON.stringify({
          provider: url.includes("github.com") ? "github" : "git",
          url: url.trim(),
          defaultBranch,
        }),
      }),
    );
  }

  function approveWorkspace(run: ExecutionRun) {
    return mutate(`approve-workspace:${run.id}`, () =>
      requestJson(`/api/runs/${run.id}/approve-workspace`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function rejectWorkspace(run: ExecutionRun) {
    const reason = window.prompt("What must the worker revise before this patch can be approved?");
    if (!reason?.trim()) return;
    return mutate(`reject-workspace:${run.id}`, () =>
      requestJson(`/api/runs/${run.id}/reject-workspace`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    );
  }

  function proposePullRequest(run: ExecutionRun) {
    return mutate(`publish:${run.id}`, () =>
      requestJson(`/api/runs/${run.id}/propose-pull-request`, {
        method: "POST",
        body: JSON.stringify({ draft: true }),
      }),
    );
  }

  function retryActionProposal(action: Action) {
    return mutate(`retry-action:${action.id}`, () =>
      requestJson(`/api/actions/${action.id}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  }

  function signOut() {
    return mutate("sign-out", async () => {
      await requestJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
      window.sessionStorage.removeItem("agencyos.api-key");
      window.location.assign("/login");
    });
  }

  const can = (permission: Permission) => principal?.permissions.includes(permission) ?? false;
  const principalApprovalId = principal?.memberId ?? principal?.id ?? null;

  const pendingCount = actions.filter((action) => action.status === "proposed").length;
  const queuedCount = jobs.filter((job) => ["queued", "leased", "running", "retry_wait"].includes(job.status)).length;
  const revisionCount = runs.filter((run) => run.status === "revision_requested").length;
  const approvalRequiredCount = runs.filter((run) => run.status === "approval_required").length;
  const passedCount = runs.filter((run) => run.status === "passed").length;
  const failedCount = runs.filter((run) => run.status === "failed").length;
  const linearProjectReady = actions.some(
    (action) => action.kind === "linear.createProject" && action.status === "succeeded",
  );

  return (
    <main className="operator-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AGENCYOS / OPERATOR</p>
          <h1 className="operator-title">Command the work.</h1>
        </div>
        <div className="topbar-actions">
          <input
            className="operator-token-input"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="AgencyOS API key"
            aria-label="AgencyOS API key"
            autoComplete="off"
          />
          {principal ? (
            <span className="muted" title={principal.email ?? undefined}>
              {principal.displayName} · {principal.role}{tenant ? ` · ${tenant.displayName}` : ""}
            </span>
          ) : null}
          {principal?.authMethod === "session" ? (
            <button className="button ghost small" onClick={signOut} disabled={busy !== null}>Sign out</button>
          ) : null}
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Select project">
            {projects.length === 0 ? <option value="">No projects yet</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.title}</option>
            ))}
          </select>
          <button className="button secondary" onClick={() => refresh()} disabled={busy !== null}>Refresh</button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!selectedProject ? (
        <section className="empty-state">
          <p className="eyebrow">NO ACTIVE PROJECT</p>
          <h2>Run intake first.</h2>
          <p>Once an intake creates a project, it will appear here with its tasks, actions, and worker runs.</p>
          <code>POST /api/intake</code>
        </section>
      ) : (
        <>
          <section className="project-hero">
            <div>
              <div className="status-row">
                <span className={`status-pill status-${selectedProject.status}`}>{statusLabel(selectedProject.status)}</span>
                <span>{selectedProject.currentPhase || "Unassigned phase"}</span>
              </div>
              <h2>{selectedProject.title}</h2>
              <p>{selectedProject.objective}</p>
              <div className="repository-line">
                {selectedProject.repository ? (
                  <>
                    <span className="repo-indicator">Repository bound</span>
                    <a href={selectedProject.repository.url} target="_blank" rel="noreferrer">
                      {selectedProject.repository.fullName ?? selectedProject.repository.url} ↗
                    </a>
                    <span>{selectedProject.repository.defaultBranch}</span>
                  </>
                ) : (
                  <span className="repo-warning">No repository bound—workspace runs cannot start.</span>
                )}
              </div>
            </div>
            <div className="hero-actions">
              <button
                className="button primary"
                onClick={queueReady}
                disabled={busy !== null || !can("run:dispatch") || tasks.every((task) => task.status === "done")}
              >
                {busy === "queue-ready" ? "Queueing…" : "Queue ready work"}
              </button>
              <button
                className="button secondary"
                onClick={provision}
                disabled={busy !== null || !can("action:propose") || actions.some((action) => action.kind === "linear.createProject" || action.kind === "github.createRepository")}
              >
                {busy === "provision" ? "Proposing…" : "Propose provisioning"}
              </button>
              <button className="button secondary" onClick={syncLinearTasks} disabled={busy !== null || !can("action:propose") || !linearProjectReady}>
                {busy === "sync-linear" ? "Proposing…" : "Propose Linear sync"}
              </button>
              {!selectedProject.repository ? (
                <button className="button secondary" onClick={bindRepository} disabled={busy !== null || !can("project:write")}>
                  {busy === "bind-repository" ? "Binding…" : "Bind repository"}
                </button>
              ) : null}
            </div>
          </section>

          <section className="metric-grid metric-grid-six">
            <article><span>Tasks</span><strong>{tasks.length}</strong></article>
            <article><span>External approvals</span><strong>{pendingCount}</strong></article>
            <article><span>Worker queue</span><strong>{queuedCount}</strong></article>
            <article><span>Needs revision</span><strong>{revisionCount}</strong></article>
            <article><span>Patch review</span><strong>{approvalRequiredCount}</strong></article>
            <article><span>Completed / failed</span><strong>{passedCount} / {failedCount}</strong></article>
          </section>

          <section className="panel workforce-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">M6 / DISTRIBUTED CONTROL PLANE</p>
                <h3>Routed workers, immutable evidence, named review, and approval</h3>
              </div>
              <span>{runs.length} runs</span>
            </div>

            <div className="run-grid">
              {runs.length === 0 ? (
                <div className="run-empty">
                  <p>No worker runs yet.</p>
                  <span>Queue dependency-ready work to assign the first specialist.</span>
                </div>
              ) : runs.map((run) => {
                const task = taskById.get(run.taskId);
                const workspace = run.workspaceId ? workspaceById.get(run.workspaceId) : undefined;
                const commands = workspace ? commandsByWorkspace.get(workspace.id) ?? [] : [];
                const job = latestJobByRun.get(run.id);
                const runArtifacts = artifactsByRun.get(run.id) ?? [];
                const activeJob = job && ["queued", "leased", "running", "retry_wait"].includes(job.status) ? job : null;
                const retryableJob = job && run.status !== "cancelled" && ["failed", "dead_letter"].includes(job.status) ? job : null;
                const publishAction = actions.find(
                  (action) => action.kind === "github.publishWorkspace" && action.payload.runId === run.id,
                );
                const canExecute = (run.status === "queued" || run.status === "revision_requested") && !activeJob && !retryableJob;
                const canCancel = run.status === "queued"
                  || run.status === "revision_requested"
                  || run.status === "running"
                  || run.status === "qa_review"
                  || run.status === "approval_required";
                const reviewReady = run.status === "approval_required" && (!job || job.status === "succeeded");
                return (
                  <article className="run-card" key={run.id}>
                    <div className="run-card-top">
                      <div>
                        <p className="action-kind">{run.assignedRole} · {run.executionMode} · attempt {run.currentAttempt}/{run.maxAttempts}</p>
                        <h4>{task?.title ?? run.taskId}</h4>
                      </div>
                      <span className={`status-pill status-${run.status}`}>{statusLabel(run.status)}</span>
                    </div>

                    <div className="run-facts">
                      <span>QA threshold {run.minQaScore}</span>
                      <span>Updated {formatDate(run.updatedAt)}</span>
                      {job ? <span className={`status-pill status-${job.status}`}>job {statusLabel(job.status)} · attempt {job.targetAttemptNumber} · delivery {job.deliveryCount}/{job.maxDeliveries}</span> : null}
                      {run.lastQa ? <strong className="qa-score">QA {run.lastQa.score}</strong> : null}
                    </div>

                    {run.lastWorkerOutput ? <p className="run-summary">{run.lastWorkerOutput.summary}</p> : null}
                    {run.lastQa ? <p className="qa-summary">{run.lastQa.summary}</p> : null}
                    {run.lastError ? <p className="inline-error">{run.lastError}</p> : null}

                    {run.lastQa?.revisionInstructions.length ? (
                      <div className="revision-box">
                        <strong>Required revision</strong>
                        <ul>{run.lastQa.revisionInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ul>
                      </div>
                    ) : null}

                    {run.lastWorkerOutput?.artifacts.length ? (
                      <div className="artifact-list">
                        {run.lastWorkerOutput.artifacts.slice(0, 6).map((artifact) => (
                          <span key={`${artifact.type}:${artifact.title}`}>{artifact.type}: {artifact.title}</span>
                        ))}
                      </div>
                    ) : null}

                    {runArtifacts.length ? (
                      <div className="artifact-list durable-artifacts">
                        {runArtifacts.map((artifact) => (
                          <button
                            className="artifact-download"
                            key={artifact.id}
                            onClick={() => downloadArtifact(artifact)}
                            disabled={busy !== null || !can("artifact:read")}
                            title={`SHA-256 ${artifact.sha256}`}
                          >
                            {busy === `artifact:${artifact.id}` ? "Downloading…" : `${artifact.kind}: ${artifact.filename}`}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {workspace ? (
                      <div className="workspace-box">
                        <div className="workspace-heading">
                          <div>
                            <strong>{workspace.branchName}</strong>
                            <span>{workspace.changedFiles.length} files · +{workspace.additions}/-{workspace.deletions}</span>
                          </div>
                          <span className={`status-pill status-${workspace.status}`}>{statusLabel(workspace.status)}</span>
                        </div>
                        <p className={workspace.validation?.passed ? "validation-pass" : "validation-fail"}>
                          {workspace.validation?.summary ?? "Validation has not completed."}
                        </p>
                        {workspace.validation?.changedScripts?.length ? (
                          <p className="inline-error">Changed validators: {workspace.validation.changedScripts.join(", ")}</p>
                        ) : null}
                        {commands.length ? (
                          <div className="command-chips">
                            {commands.filter((command) => command.label.startsWith("Validate:") || command.label.includes("dependencies")).map((command) => (
                              <span className={`command-${command.status}`} key={command.id}>{command.label}: {statusLabel(command.status)}</span>
                            ))}
                          </div>
                        ) : null}
                        {workspace.changedFiles.length ? (
                          <details className="patch-details">
                            <summary>Inspect patch and changed files</summary>
                            <div className="changed-file-list">
                              {workspace.changedFiles.map((file) => <code key={file}>{file}</code>)}
                            </div>
                            <pre className="diff-view">{workspace.diff || "Patch content is empty."}{workspace.diffTruncated ? "\n\n[Diff truncated in dashboard storage]" : ""}</pre>
                          </details>
                        ) : null}
                        {workspace.failure ? <p className="inline-error">{workspace.failure}</p> : null}
                        {workspace.pullRequestUrl ? (
                          <a className="external-link" href={workspace.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request ↗</a>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="action-buttons">
                      {canExecute ? (
                        <button className="button primary small" onClick={() => executeWorkerRun(run)} disabled={busy !== null || !can("run:dispatch")}>
                          {busy === `run:${run.id}`
                            ? "Enqueueing…"
                            : run.status === "revision_requested"
                              ? "Enqueue revision"
                              : "Enqueue worker"}
                        </button>
                      ) : null}
                      {retryableJob ? (
                        <button className="button secondary small" onClick={() => retryDurableJob(retryableJob)} disabled={busy !== null || !can("run:dispatch")}>
                          {busy === `retry-job:${retryableJob.id}` ? "Scheduling…" : "Retry delivery"}
                        </button>
                      ) : null}
                      {canCancel ? (
                        <button className="button ghost small" onClick={() => cancelWorkerRun(run)} disabled={busy !== null || !can("run:cancel")}>Cancel</button>
                      ) : null}
                      {reviewReady ? (
                        <>
                          <button className="button primary small" onClick={() => approveWorkspace(run)} disabled={busy !== null || !can("workspace:review")}>
                            {busy === `approve-workspace:${run.id}` ? "Approving…" : "Approve patch"}
                          </button>
                          <button className="button ghost small" onClick={() => rejectWorkspace(run)} disabled={busy !== null || !can("workspace:review")}>
                            Request revision
                          </button>
                        </>
                      ) : null}
                      {run.status === "approval_required" && !reviewReady ? (
                        <span className="muted">Review controls unlock after durable delivery succeeds.</span>
                      ) : null}
                      {run.status === "passed" && workspace?.status === "approved" && !publishAction && !workspace.pullRequestUrl ? (
                        <button className="button secondary small" onClick={() => proposePullRequest(run)} disabled={busy !== null || !can("action:propose")}>
                          {busy === `publish:${run.id}` ? "Proposing…" : "Propose draft PR"}
                        </button>
                      ) : null}
                      {publishAction ? <span className="muted">PR action: {statusLabel(publishAction.status)}</span> : null}
                      {activeJob ? <span className="muted">Durable job is {statusLabel(activeJob.status)}{activeJob.leaseOwner ? ` on ${activeJob.leaseOwner}` : ""}.</span> : null}
                      {run.status === "passed" ? <span className="success-copy">QA and human review passed.</span> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="dashboard-grid control-grid">
            <section className="panel actions-panel">
              <div className="panel-heading">
                <div><p className="eyebrow">CONTROLLED EXTERNAL EXECUTION</p><h3>Approval queue</h3></div>
                <span>{actions.length} actions</span>
              </div>
              <div className="action-list">
                {actions.length === 0 ? <p className="muted">No external actions proposed for this project yet.</p> : actions.map((action) => (
                  <article className="action-card" key={action.id}>
                    <div className="action-card-top">
                      <div>
                        <p className="action-kind">{kindLabel[action.kind]}</p>
                        <h4>{String(action.payload.name ?? action.payload.title ?? action.kind)}</h4>
                      </div>
                      <span className={`status-pill status-${action.status}`}>{statusLabel(action.status)}</span>
                    </div>
                    <p className="action-meta">
                      Requested by {action.requestedByDisplayName ?? action.requestedBy} · {action.risk} risk · {action.approvals.length}/{action.requiredApprovals} approvals · {formatDate(action.createdAt)}
                    </p>
                    {action.approvals.length ? (
                      <div className="artifact-list">
                        {action.approvals.map((approval) => (
                          <span key={approval.principalId}>{approval.displayName} · {approval.role}</span>
                        ))}
                      </div>
                    ) : null}
                    {action.error ? <p className="inline-error">{action.error}</p> : null}
                    {action.result?.url ? (
                      <a className="external-link" href={String(action.result.url)} target="_blank" rel="noreferrer">Open created resource ↗</a>
                    ) : null}
                    <div className="action-buttons">
                      {action.status === "proposed" && can("action:approve") ? (
                        <>
                          <button
                            className="button primary small"
                            onClick={() => approve(action)}
                            disabled={busy !== null || Boolean(principalApprovalId && action.approvals.some((item) => item.principalId === principalApprovalId))}
                          >
                            {principalApprovalId && action.approvals.some((item) => item.principalId === principalApprovalId)
                              ? "Approval recorded"
                              : "Record approval"}
                          </button>
                          <button className="button ghost small" onClick={() => reject(action)} disabled={busy !== null}>Reject</button>
                        </>
                      ) : null}
                      {action.status === "approved" && can("action:execute") ? (
                        <button className="button primary small" onClick={() => execute(action)} disabled={busy !== null}>
                          {busy === action.id ? "Queueing…" : "Queue execution"}
                        </button>
                      ) : null}
                      {(action.status === "failed" || action.status === "rejected") && can("action:propose") ? (
                        <button className="button secondary small" onClick={() => retryActionProposal(action)} disabled={busy !== null}>
                          {busy === `retry-action:${action.id}` ? "Restoring…" : "Restore proposal"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel activity-panel">
              <div className="panel-heading"><div><p className="eyebrow">IMMUTABLE EXTERNAL HISTORY</p><h3>Audit timeline</h3></div></div>
              <div className="timeline">
                {events.length === 0 ? <p className="muted">External action events will appear here.</p> : events.map((event) => {
                  const action = actions.find((item) => item.id === event.actionId);
                  return (
                    <div className="timeline-item" key={event.id}>
                      <span className="timeline-dot" />
                      <div>
                        <strong>{statusLabel(event.event)}</strong>
                        <p>{action ? kindLabel[action.kind] : "Action"} · {event.actor}</p>
                        <time>{formatDate(event.createdAt)}</time>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="panel task-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">PROJECT PLAN</p><h3>Tasks</h3></div>
              <span>{tasks.filter((task) => task.status === "done").length}/{tasks.length} done</span>
            </div>
            <div className="task-table-wrap">
              <table className="task-table">
                <thead>
                  <tr><th>Task</th><th>Owner</th><th>Priority</th><th>Status</th><th>Worker run</th><th>Control</th></tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const linkedRun = task.activeRunId ? runById.get(task.activeRunId) : latestRunByTask.get(task.id);
                    const hasActiveRun = linkedRun ? activeRunStatuses.has(linkedRun.status) : false;
                    return (
                      <tr key={task.id}>
                        <td>{task.title}</td>
                        <td>{task.ownerRole}</td>
                        <td>{task.priority}</td>
                        <td><span className={`status-pill status-${task.status}`}>{statusLabel(task.status)}</span></td>
                        <td>{linkedRun ? <span className={`status-pill status-${linkedRun.status}`}>{statusLabel(linkedRun.status)}</span> : <span className="muted">Unassigned</span>}</td>
                        <td>
                          {task.status !== "done" && !hasActiveRun ? (
                            <button className="button secondary small" onClick={() => queueTask(task)} disabled={busy !== null || !can("run:dispatch")}>
                              {busy === `queue:${task.id}` ? "Queueing…" : "Queue"}
                            </button>
                          ) : null}
                          {hasActiveRun ? <span className="muted">Managed above</span> : null}
                          {task.status === "done" ? <span className="success-copy">Complete</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
