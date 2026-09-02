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

export function resolveExecutionMode(task: Task, role: AgentRole): ExecutionMode {
  if (role === "frontend" || role === "backend") return "workspace";
  if (role !== "tech-lead") return "artifact";
  const taskText = `${task.title} ${task.description} ${task.acceptanceCriteria.join(" ")}`.toLowerCase();
  return workspaceTaskTerms.some((term) => taskText.includes(term)) ? "workspace" : "artifact";
}


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

export type QaOutcome = "passed" | "revision_requested" | "failed";

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

export type TaskReadiness = {
  ready: boolean;
  reasons: string[];
};

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
