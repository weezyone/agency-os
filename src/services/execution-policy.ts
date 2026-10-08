import type { Task } from "@/schemas/domain";
import type { AgentRole, ExecutionMode, QaResult } from "@/schemas/execution";
import type { WorkspaceValidationResult } from "@/schemas/workspace";

const roleRules: Array<{ role: AgentRole; terms: string[] }> = [
  { role: "qa", terms: ["qa", "quality", "test", "testing", "reviewer", "validation"] },
  { role: "research", terms: ["research", "analyst", "discovery", "competitive", "strategy research"] },
  { role: "frontend", terms: ["frontend", "front-end", "react", "next.js", "nextjs", "web developer", "ui engineer"] },
  { role: "backend", terms: ["backend", "back-end", "api", "database", "data engineer", "devops", "platform"] },
  { role: "design", terms: ["design", "designer", "ux", "ui", "brand", "creative", "prototype", "wireframe"] },
  { role: "tech-lead", terms: ["tech lead", "technical lead", "architect", "engineering lead", "software engineer"] },
];

/**
 * Maps a free-text task owner role onto a known agent role using keyword
 * rules, defaulting to `tech-lead` when nothing matches.
 *
 * @param ownerRole Free-text role from the task (e.g. "React developer").
 * @returns The closest matching agent role.
 */
export function resolveAgentRole(ownerRole: string): AgentRole {
  const normalized = ownerRole.toLowerCase().trim();
  return roleRules.find((rule) => rule.terms.some((term) => normalized.includes(term)))?.role ?? "tech-lead";
}

const workspaceTaskTerms = [
  "implement",
  "build",
  "code",
  "repository",
  "refactor",
  "fix",
  "component",
  "route",
  "api",
  "database",
  "migration",
  "test",
];

/**
 * Chooses whether a task runs in `workspace` mode (repository checkout,
 * patch, validation) or `artifact` mode (document-only output). Frontend and
 * backend roles always need a workspace; other roles fall back to artifacts
 * unless a tech-lead task's text mentions implementation work.
 *
 * @param task The task being queued.
 * @param role The resolved agent role for the task.
 * @returns The execution mode for the run.
 */
export function resolveExecutionMode(task: Task, role: AgentRole): ExecutionMode {
  if (role === "frontend" || role === "backend") return "workspace";
  if (role !== "tech-lead") return "artifact";
  const taskText = `${task.title} ${task.description} ${task.acceptanceCriteria.join(" ")}`.toLowerCase();
  return workspaceTaskTerms.some((term) => taskText.includes(term)) ? "workspace" : "artifact";
}


/**
 * Normalizes a raw QA agent result into the control plane's verdict
 * vocabulary. A passing-looking verdict is downgraded to `revise` whenever the
 * score is below threshold or any acceptance criterion failed, and concrete
 * revision instructions are synthesized when the agent left them empty — the
 * next attempt must always receive actionable feedback.
 *
 * @param qa The QA result returned by the quality-gate agent.
 * @param minQaScore Minimum score required to pass.
 * @returns The normalized QA result.
 */
export function normalizeQaResult(qa: QaResult, minQaScore: number): QaResult {
  if (qa.verdict === "fail") return qa;

  const failedCriteria = qa.criteria.filter((criterion) => !criterion.passed);
  const needsRevision = qa.verdict === "revise" || qa.score < minQaScore || failedCriteria.length > 0;
  if (!needsRevision) return qa;

  const generatedInstructions = [
    ...(qa.score < minQaScore ? [`Raise the QA score from ${qa.score} to at least ${minQaScore}.`] : []),
    ...failedCriteria.map((criterion) => `Satisfy acceptance criterion: ${criterion.criterion}. Evidence gap: ${criterion.evidence}`),
    ...qa.findings,
  ];

  return {
    ...qa,
    verdict: "revise",
    revisionInstructions: qa.revisionInstructions.length
      ? qa.revisionInstructions
      : generatedInstructions.length
        ? generatedInstructions
        : ["Address the QA summary and resubmit concrete acceptance evidence."],
  };
}

/**
 * Normalizes a QA result for workspace-mode runs. On top of score/criteria
 * checks, a failed or missing workspace validation gate forces a revision —
 * the QA narrative can never override authoritative command evidence.
 *
 * @param qa The QA result returned by the quality-gate agent.
 * @param minQaScore Minimum score required to pass.
 * @param validation The workspace validation result, or `null` when no
 *   allowlisted validation command ran.
 * @returns The normalized QA result with validation instructions attached.
 */
export function normalizeWorkspaceQaResult(
  qa: QaResult,
  minQaScore: number,
  validation: WorkspaceValidationResult | null,
): QaResult {
  const normalized = normalizeQaResult(qa, minQaScore);
  if (validation?.passed) return normalized;

  const validationInstruction = validation
    ? `Resolve workspace validation failure: ${validation.summary}`
    : "Run and capture at least one allowlisted validation command before requesting approval.";

  return {
    ...normalized,
    verdict: normalized.verdict === "fail" ? "fail" : "revise",
    findings: [...normalized.findings, validationInstruction],
    revisionInstructions: normalized.revisionInstructions.includes(validationInstruction)
      ? normalized.revisionInstructions
      : [...normalized.revisionInstructions, validationInstruction],
  };
}

/** Terminal QA decision for one execution attempt. */
export type QaOutcome = "passed" | "revision_requested" | "failed";

/**
 * Decides the attempt outcome from a normalized QA result. Passing requires
 * both a `pass` verdict and a threshold score; anything else becomes a
 * revision request while attempt budget remains, and a failure once the
 * budget is exhausted (or on an explicit `fail` verdict).
 *
 * @param input QA result, score threshold, and attempt budget position.
 * @returns The outcome to persist for the attempt.
 */
export function decideQaOutcome(input: {
  qa: QaResult;
  minQaScore: number;
  currentAttempt: number;
  maxAttempts: number;
}): QaOutcome {
  if (input.qa.verdict === "pass" && input.qa.score >= input.minQaScore) return "passed";
  if (input.qa.verdict !== "fail" && input.currentAttempt < input.maxAttempts) return "revision_requested";
  return "failed";
}

function normalizeDependency(value: string) {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Readiness verdict for queueing a task, with human-readable blockers. */
export type TaskReadiness = {
  ready: boolean;
  reasons: string[];
};

/**
 * Checks whether a task may be queued for execution. A task is not ready when
 * it is already done or blocked, has an active run, or any dependency
 * (matched by id or normalized title against sibling tasks) is unresolved or
 * incomplete.
 *
 * @param task The task to evaluate.
 * @param projectTasks All tasks of the same project, used to resolve dependencies.
 * @returns Readiness flag plus the reasons blocking execution, if any.
 */
export function evaluateTaskReadiness(task: Task, projectTasks: Task[]): TaskReadiness {
  const reasons: string[] = [];

  if (task.status === "done") reasons.push("Task is already complete.");
  if (task.status === "blocked") reasons.push("Task is blocked and requires operator review.");
  if (task.activeRunId) reasons.push("Task already has an active execution run.");

  for (const dependency of task.dependencies) {
    const normalized = normalizeDependency(dependency);
    const match = projectTasks.find(
      (candidate) => candidate.id === dependency || normalizeDependency(candidate.title) === normalized,
    );

    if (!match) {
      reasons.push(`Dependency is unresolved: ${dependency}`);
      continue;
    }
    if (match.status !== "done") reasons.push(`Dependency is not complete: ${match.title}`);
  }

  return { ready: reasons.length === 0, reasons };
}
