import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { unrefTimer } from "@/lib/timers";
import { githubAdapter } from "@/integrations/github/adapter";
import { artifactRepository } from "@/repositories/artifact-repository";
import { workspaceRepository } from "@/repositories/workspace-repository";
import { githubPublishWorkspacePayloadSchema } from "@/schemas/actions";
import { artifactStoreFor } from "@/artifacts/provider";
import { assertRepositoryAllowed, inferGitHubFullName, sanitizeBranchName } from "@/services/workspace-policy";
import { tenantSecretOrFallback, TENANT_INTEGRATION_SECRET_NAMES } from "@/services/integration-secret-service";

async function gitEnvironment(repositoryUrl: string): Promise<NodeJS.ProcessEnv> {
  const config = env();
  const parsed = new URL(repositoryUrl);
  const result: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
  };
  const githubToken = parsed.hostname.toLowerCase() === "github.com"
    ? await tenantSecretOrFallback(TENANT_INTEGRATION_SECRET_NAMES.githubToken, config.GITHUB_TOKEN)
    : null;
  if (githubToken) {
    const basic = Buffer.from(`x-access-token:${githubToken}`, "utf8").toString("base64");
    result.GIT_CONFIG_COUNT = "3";
    result.GIT_CONFIG_KEY_2 = "http.https://github.com/.extraheader";
    result.GIT_CONFIG_VALUE_2 = `Authorization: Basic ${basic}`;
  }
  return result;
}

async function runGit(input: {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowExitCodes?: number[];
  timeoutMs?: number;
}) {
  const outputLimit = Math.max(env().AGENCY_WORKSPACE_DIFF_MAX_BYTES * 8, 8_000_000);
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH, HOME: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        ...input.env,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs ?? Math.max(env().AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS, 300_000));
    unrefTimer(timer);
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= outputLimit) return;
      const accepted = chunk.subarray(0, Math.max(0, outputLimit - bytes));
      target.push(accepted);
      bytes += accepted.length;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode };
      if (timedOut) return reject(new Error(`Git command timed out: git ${input.args.join(" ")}`));
      if (!(input.allowExitCodes ?? [0]).includes(exitCode)) {
        return reject(new Error(`Git command failed (${exitCode}): git ${input.args.join(" ")}\n${result.stderr.slice(-4_000)}`));
      }
      resolve(result);
    });
  });
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function publishApprovedWorkspace(rawPayload: unknown, actor = "distributed-action-runner") {
  const payload = githubPublishWorkspacePayloadSchema.parse(rawPayload);
  const workspace = await workspaceRepository.get(payload.workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.projectId !== payload.projectId || workspace.runId !== payload.runId) {
    throw new Error("Workspace does not belong to the requested project and run");
  }
  if (workspace.status !== "approved" || workspace.reviewStatus !== "approved") {
    throw new Error("Workspace must be human-approved before it can be published");
  }
  if (workspace.repositoryFullName !== payload.repositoryFullName) throw new Error("Workspace repository does not match the publish action");
  if (workspace.branchName !== payload.branchName || workspace.baseRef !== payload.baseBranch || workspace.baseSha !== payload.baseSha) {
    throw new Error("Workspace branch or base metadata does not match the publish action");
  }
  if (workspace.pullRequestUrl && workspace.publishedCommitSha) {
    return {
      externalId: workspace.publishedCommitSha,
      commitSha: workspace.publishedCommitSha,
      branchName: workspace.branchName,
      url: workspace.pullRequestUrl,
      pullRequestUrl: workspace.pullRequestUrl,
    };
  }

  const artifact = await artifactRepository.get(payload.patchArtifactId);
  if (!artifact || artifact.kind !== "workspace_patch" || artifact.workspaceId !== workspace.id || artifact.runId !== workspace.runId) {
    throw new Error("Approved workspace patch artifact was not found or does not match this workspace");
  }
  if (artifact.sha256 !== payload.patchSha256) throw new Error("Publish action patch digest does not match stored artifact metadata");
  if (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now()) throw new Error("Approved workspace patch artifact has expired");
  const patch = await artifactStoreFor(artifact.provider).read(artifact.storageKey);
  if (patch.length !== artifact.bytes || sha256(patch) !== payload.patchSha256) {
    throw new Error("Workspace patch artifact failed its size or SHA-256 integrity check");
  }

  const cloneUrl = assertRepositoryAllowed(payload.repositoryCloneUrl);
  if (cloneUrl.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub publication requires a github.com clone URL");
  }
  const cloneFullName = inferGitHubFullName(payload.repositoryCloneUrl);
  if (cloneFullName && cloneFullName.toLowerCase() !== payload.repositoryFullName.toLowerCase()) {
    throw new Error("GitHub clone URL does not match the approved repository full name");
  }
  if (sanitizeBranchName(payload.branchName) !== payload.branchName) throw new Error("Publish branch name is not canonical");

  const root = path.resolve(env().AGENCY_WORKSPACE_ROOT, "publications");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, `${workspace.id}-`));
  const repositoryPath = path.join(temporary, "repository");
  const patchPath = path.join(temporary, "approved.patch");
  const credentials = await gitEnvironment(payload.repositoryCloneUrl);

  await workspaceRepository.markPublishStarted(workspace.id, actor);
  try {
    await writeFile(patchPath, patch, { mode: 0o600 });
    await runGit({ args: ["clone", "--no-checkout", "--", payload.repositoryCloneUrl, repositoryPath], cwd: temporary, env: credentials });
    await runGit({ args: ["config", "core.hooksPath", "/dev/null"], cwd: repositoryPath });
    await runGit({ args: ["config", "user.name", env().AGENCY_GIT_AUTHOR_NAME], cwd: repositoryPath });
    await runGit({ args: ["config", "user.email", env().AGENCY_GIT_AUTHOR_EMAIL], cwd: repositoryPath });

    const remote = await runGit({
      args: ["ls-remote", "--heads", "origin", `refs/heads/${payload.branchName}`],
      cwd: repositoryPath,
      env: credentials,
    });
    const remoteExists = Boolean(remote.stdout.trim());
    let commitSha: string;

    if (remoteExists) {
      await runGit({
        args: ["fetch", "--no-tags", "origin", `refs/heads/${payload.branchName}:refs/remotes/origin/${payload.branchName}`],
        cwd: repositoryPath,
        env: credentials,
      });
      await runGit({ args: ["checkout", "-B", payload.branchName, `refs/remotes/origin/${payload.branchName}`], cwd: repositoryPath });
      await runGit({ args: ["merge-base", "--is-ancestor", payload.baseSha, "HEAD"], cwd: repositoryPath });
      const existingPatch = await runGit({
        args: ["diff", "--binary", "--no-ext-diff", payload.baseSha, "HEAD", "--", "."],
        cwd: repositoryPath,
      });
      if (sha256(existingPatch.stdout) !== payload.patchSha256) {
        throw new Error(`Remote branch ${payload.branchName} exists but does not contain the approved patch`);
      }
      commitSha = (await runGit({ args: ["rev-parse", "HEAD"], cwd: repositoryPath })).stdout.trim();
    } else {
      await runGit({ args: ["cat-file", "-e", `${payload.baseSha}^{commit}`], cwd: repositoryPath });
      await runGit({ args: ["checkout", "-b", payload.branchName, payload.baseSha], cwd: repositoryPath });
      await runGit({ args: ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath], cwd: repositoryPath });
      await runGit({ args: ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath], cwd: repositoryPath });
      const stagedPatch = await runGit({
        args: ["diff", "--cached", "--binary", "--no-ext-diff", payload.baseSha, "--", "."],
        cwd: repositoryPath,
      });
      if (sha256(stagedPatch.stdout) !== payload.patchSha256) throw new Error("Reconstructed workspace patch differs from the human-approved artifact");
      await runGit({
        args: ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-m", payload.title.slice(0, 220)],
        cwd: repositoryPath,
      });
      commitSha = (await runGit({ args: ["rev-parse", "HEAD"], cwd: repositoryPath })).stdout.trim();
      await runGit({
        args: ["-c", "core.hooksPath=/dev/null", "push", "--set-upstream", "origin", `HEAD:refs/heads/${payload.branchName}`],
        cwd: repositoryPath,
        env: credentials,
      });
    }

    const pullRequest = await githubAdapter.createPullRequest({
      repositoryFullName: payload.repositoryFullName,
      title: payload.title,
      head: payload.branchName,
      base: payload.baseBranch,
      body: payload.body,
      draft: payload.draft,
    });
    await workspaceRepository.markPublished(workspace.id, actor, commitSha, pullRequest.url);
    return {
      externalId: pullRequest.externalId,
      pullRequestNumber: pullRequest.number,
      commitSha,
      branchName: payload.branchName,
      url: pullRequest.url,
      pullRequestUrl: pullRequest.url,
      patchArtifactId: payload.patchArtifactId,
      patchSha256: payload.patchSha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace publishing failed";
    await workspaceRepository.markPublishFailed(workspace.id, actor, message);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
