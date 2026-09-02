export type ApprovalRequirement = "none" | "human";

export interface ExternalAction<TInput, TResult> {
  id: string;
  approval: ApprovalRequirement;
  execute(input: TInput): Promise<TResult>;
}

export interface ProjectSystemAdapter {
  createProject(input: { name: string; description: string }): Promise<{ externalId: string; url?: string }>;
  createIssue(input: { projectId: string; title: string; description: string }): Promise<{ externalId: string; url?: string }>;
}

export interface SourceControlAdapter {
  createRepository(input: { name: string; description: string; private: boolean; projectId: string }): Promise<{
    externalId: string;
    url: string;
    cloneUrl: string;
    fullName: string;
    defaultBranch: string;
  }>;
  createPullRequest(input: {
    repositoryFullName: string;
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
  }): Promise<{ externalId: string; url: string; number: number }>;
}

// Linear, GitHub, and Composio implementations intentionally live behind these
// contracts so provider SDK churn cannot leak into the domain layer.
