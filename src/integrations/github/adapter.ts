import { env } from "@/lib/env";
import { githubIntegrationConfig } from "@/services/integration-secret-service";

async function githubHeaders() {
  const { token } = await githubIntegrationConfig();
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2026-03-10",
    "user-agent": "AgencyOS",
  };
}

type GitHubRepositoryResponse = {
  id?: number;
  html_url?: string;
  clone_url?: string;
  full_name?: string;
  default_branch?: string;
  homepage?: string | null;
  private?: boolean;
  message?: string;
};

type GitHubPullRequestResponse = {
  id?: number;
  number?: number;
  html_url?: string;
  message?: string;
};

function repositoryResult(body: GitHubRepositoryResponse) {
  if (!body.id || !body.html_url || !body.clone_url || !body.full_name) return null;
  return {
    externalId: String(body.id),
    url: body.html_url,
    cloneUrl: body.clone_url,
    fullName: body.full_name,
    defaultBranch: body.default_branch ?? "main",
  };
}

function pullRequestResult(body: GitHubPullRequestResponse) {
  if (!body.id || !body.number || !body.html_url) return null;
  return { externalId: String(body.id), number: body.number, url: body.html_url };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export const githubAdapter = {
  async createRepository(input: { name: string; description: string; private: boolean; projectId: string }) {
    const config = env();
    const { org } = await githubIntegrationConfig();
    if (!org) throw new Error("GitHub organization is not configured for this tenant");
    const projectUrl = new URL(config.APP_URL);
    projectUrl.searchParams.set("project", input.projectId);
    const recoveryMarker = projectUrl.toString();

    const createResponse = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos`, {
      method: "POST",
      headers: await githubHeaders(),
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        private: input.private,
        has_issues: true,
        has_projects: true,
        auto_init: true,
        homepage: recoveryMarker,
      }),
    });
    const createBody = await readJson<GitHubRepositoryResponse>(createResponse);
    const created = repositoryResult(createBody);
    if (createResponse.ok && created) return created;

    // A prior attempt may have created the repository before its HTTP response was lost.
    // Recover that result instead of creating a duplicate or permanently dead-ending the action.
    if (createResponse.status === 422) {
      const existingResponse = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(input.name)}`,
        { headers: await githubHeaders() },
      );
      const existingBody = await readJson<GitHubRepositoryResponse>(existingResponse);
      const existing = repositoryResult(existingBody);
      const matchesRecoveryMarker = existingBody.homepage === recoveryMarker;
      const matchesVisibility = existingBody.private === undefined || existingBody.private === input.private;
      if (existingResponse.ok && existing && matchesRecoveryMarker && matchesVisibility) return existing;
      if (existingResponse.ok && existing) {
        throw new Error(
          `GitHub repository ${existing.fullName} already exists but is not marked as this AgencyOS project's repository`,
        );
      }
    }

    throw new Error(
      `GitHub repository creation failed (${createResponse.status}): ${createBody.message ?? "unknown error"}`,
    );
  },

  async createPullRequest(input: {
    repositoryFullName: string;
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
  }) {
    const [owner, repository] = input.repositoryFullName.split("/");
    if (!owner || !repository) throw new Error("GitHub repository full name must be OWNER/REPOSITORY");
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`;

    // Publication is retryable. Reuse the open PR for the same head/base pair when a
    // previous request succeeded remotely but AgencyOS did not persist the response.
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${input.head}`,
      base: input.base,
      per_page: "1",
    });
    const existingResponse = await fetch(`${endpoint}?${query.toString()}`, { headers: await githubHeaders() });
    const existingBody = await readJson<GitHubPullRequestResponse[]>(existingResponse);
    const existing = Array.isArray(existingBody) ? pullRequestResult(existingBody[0] ?? {}) : null;
    if (existingResponse.ok && existing) return existing;
    if (!existingResponse.ok) {
      const body = existingBody as unknown as { message?: string };
      throw new Error(
        `GitHub pull request lookup failed (${existingResponse.status}): ${body.message ?? "unknown error"}`,
      );
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: await githubHeaders(),
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
      }),
    });
    const body = await readJson<GitHubPullRequestResponse>(response);
    const created = pullRequestResult(body);
    if (!response.ok || !created) {
      throw new Error(`GitHub pull request creation failed (${response.status}): ${body.message ?? "unknown error"}`);
    }
    return created;
  },
};
