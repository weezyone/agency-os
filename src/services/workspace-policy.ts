import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { env } from "@/lib/env";
import type { WorkspaceFileChange } from "@/schemas/workspace";

const blockedTopLevel = new Set([
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "node_modules",
]);

const blockedFilePatterns = [
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^(?:\.github\/(?:workflows|actions)|\.circleci|\.buildkite|\.husky|\.githooks|\.lefthook)(?:\/|$)/i,
  /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile)$/i,
];

const blockedContentPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private key material" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "API key-like token" },
  { pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/, label: "GitHub token-like value" },
  { pattern: /mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/i, label: "database credentials" },
  { pattern: /(?:OPENAI_API_KEY|GITHUB_TOKEN|LINEAR_API_KEY)\s*=\s*[^\s"']+/i, label: "credential assignment" },
];

/**
 * Returns the configured allowlist of package.json script names that may run
 * as workspace validation commands.
 *
 * @returns Deduplicated allowlist of script names.
 */
export function validationScriptAllowlist(): string[] {
  return [...new Set<string>(env().AGENCY_WORKSPACE_VALIDATION_SCRIPTS.split(",").map((value: string) => value.trim()).filter(Boolean))];
}

/**
 * Selects which requested validation scripts may actually run. A script is
 * trusted only when it is allowlisted AND its package.json definition is
 * byte-identical to the pre-task baseline — a worker could otherwise edit a
 * script's command to execute arbitrary code during "validation" and have the
 * output treated as authoritative evidence.
 *
 * @param input Requested script names, the allowlist, and the baseline vs
 *   current package.json script maps.
 * @returns The requested names partitioned into trusted scripts, skipped
 *   scripts, and scripts whose definitions changed.
 */
export function selectTrustedValidationScripts(input: {
  requested: string[];
  allowed: string[];
  original: Record<string, string>;
  current: Record<string, string>;
}): { requested: string[]; scripts: string[]; skippedScripts: string[]; changedScripts: string[] } {
  const requested: string[] = [...new Set<string>(input.requested)];
  const allowed = new Set<string>(input.allowed);
  const changedScripts = requested.filter((script) => {
    const original = input.original[script];
    const current = input.current[script];
    return (typeof original === "string" || typeof current === "string") && original !== current;
  });
  const scripts = requested.filter((script) => (
    allowed.has(script)
    && typeof input.original[script] === "string"
    && input.original[script] === input.current[script]
  ));
  return {
    requested,
    scripts,
    skippedScripts: requested.filter((script) => !scripts.includes(script)),
    changedScripts,
  };
}

/**
 * Normalizes an arbitrary string into a safe git branch name, falling back to
 * a fixed default when nothing usable remains.
 *
 * @param value Raw branch name candidate.
 * @returns A lowercase, ref-safe branch name of at most 180 characters.
 */
export function sanitizeBranchName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return normalized || "agencyos/change";
}

/**
 * Normalizes a worker-supplied repository-relative path and rejects anything
 * outside the allowed write surface: absolute paths, traversal above the
 * repository root, protected top-level entries (.git, node_modules, env/rc
 * files), CI/workflow definitions (which could smuggle code execution into
 * the host repository's automation), and likely secret-bearing files.
 *
 * @param value Raw path from a proposed file change.
 * @returns The normalized POSIX-style relative path.
 * @throws When the path is empty, escapes the repository, or is protected.
 */
export function normalizeWorkspacePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").trim();
  if (!normalized || normalized.includes("\0")) throw new Error("Workspace path is empty or invalid");
  if (path.posix.isAbsolute(normalized)) throw new Error(`Absolute workspace paths are not allowed: ${value}`);

  const safe = path.posix.normalize(normalized);
  if (safe === ".." || safe.startsWith("../")) throw new Error(`Workspace path escapes the repository: ${value}`);
  const first = safe.split("/")[0]?.toLowerCase();
  if (!first || blockedTopLevel.has(first)) throw new Error(`Workspace path is protected: ${value}`);
  const basename = path.posix.basename(safe).toLowerCase();
  if (basename.startsWith(".env") && ![".env.example", ".env.sample"].includes(basename)) {
    throw new Error(`Workspace path may contain secrets: ${value}`);
  }
  if (blockedFilePatterns.some((pattern) => pattern.test(safe))) throw new Error(`Workspace path may contain secrets: ${value}`);
  return safe;
}

async function nearestExistingPath(target: string, root: string) {
  let current = target;
  while (current !== root) {
    try {
      await lstat(current);
      return current;
    } catch {
      current = path.dirname(current);
    }
  }
  return root;
}

/**
 * Resolves a relative workspace path to an absolute path that is guaranteed
 * to stay inside the workspace root. Both the resolved target and the nearest
 * existing ancestor are checked against the real root, and every existing
 * path segment is rejected if it is a symlink, so a worker cannot escape the
 * sandbox through symlinked directories.
 *
 * @param root Absolute workspace root.
 * @param relativePath Worker-supplied relative path.
 * @returns The normalized relative path and its safe absolute path.
 * @throws When the path escapes the root or traverses a symlink.
 */
export async function resolveSafeWorkspacePath(root: string, relativePath: string) {
  const safeRelative = normalizeWorkspacePath(relativePath);
  const resolvedRoot = await realpath(root);
  const target = path.resolve(resolvedRoot, safeRelative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Workspace path escapes the repository: ${relativePath}`);
  }

  const existing = await nearestExistingPath(target, resolvedRoot);
  const resolvedExisting = await realpath(existing);
  if (resolvedExisting !== resolvedRoot && !resolvedExisting.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Workspace path resolves through a symlink outside the repository: ${relativePath}`);
  }

  let cursor = resolvedRoot;
  for (const segment of safeRelative.split("/")) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Workspace path contains a symlink: ${relativePath}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("symlink")) throw error;
      break;
    }
  }

  return { relativePath: safeRelative, absolutePath: target };
}

/**
 * Validates a batch of worker-proposed file changes against the workspace
 * write policy: per-batch file count, per-file and total byte limits, path
 * safety (via {@link normalizeWorkspacePath}), duplicate paths, and a content
 * scan for private keys, tokens, and credential assignments that must never
 * be written into a publishable change set.
 *
 * @param changes The proposed file changes.
 * @throws When any limit, path, or content rule is violated.
 */
export function validateFileChanges(changes: WorkspaceFileChange[]) {
  const config = env();
  if (changes.length > config.AGENCY_WORKSPACE_MAX_CHANGED_FILES) {
    throw new Error(`Worker proposed ${changes.length} file changes; maximum is ${config.AGENCY_WORKSPACE_MAX_CHANGED_FILES}`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const change of changes) {
    const safePath = normalizeWorkspacePath(change.path);
    if (seen.has(safePath)) throw new Error(`Worker proposed duplicate changes for ${safePath}`);
    seen.add(safePath);

    const bytes = change.content ? Buffer.byteLength(change.content, "utf8") : 0;
    if (bytes > config.AGENCY_WORKSPACE_MAX_FILE_BYTES) {
      throw new Error(`Worker change for ${safePath} exceeds the per-file byte limit`);
    }
    if (change.content) {
      const match = blockedContentPatterns.find((rule) => rule.pattern.test(change.content ?? ""));
      if (match) throw new Error(`Worker change for ${safePath} contains ${match.label}`);
    }
    totalBytes += bytes;
  }

  if (totalBytes > config.AGENCY_WORKSPACE_MAX_TOTAL_WRITE_BYTES) {
    throw new Error(`Worker changes exceed the total write limit of ${config.AGENCY_WORKSPACE_MAX_TOTAL_WRITE_BYTES} bytes`);
  }
}

/**
 * Validates a repository clone URL before any git operation uses it: only
 * HTTPS URLs on allowlisted hosts (or `file:` URLs when local repositories
 * are explicitly enabled) are accepted, and embedded credentials are rejected
 * so secrets cannot leak into clone URLs or logs. This is the SSRF boundary
 * for all workspace cloning.
 *
 * @param repositoryUrl Candidate clone URL.
 * @returns The parsed URL when allowed.
 * @throws When the URL is malformed, uses a disallowed scheme or host, or
 *   embeds credentials.
 */
export function assertRepositoryAllowed(repositoryUrl: string) {
  const config = env();
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new Error("Repository clone URL must be an absolute URL");
  }

  if (parsed.protocol === "file:") {
    if (!config.AGENCY_WORKSPACE_ALLOW_LOCAL_REPOS) throw new Error("Local repository URLs are disabled");
    return parsed;
  }

  if (parsed.protocol !== "https:") throw new Error("Only HTTPS repository URLs are allowed");
  const allowedHosts = new Set(
    config.AGENCY_WORKSPACE_ALLOWED_GIT_HOSTS.split(",").map((host: string) => host.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Repository host is not allowlisted: ${parsed.hostname}`);
  }
  if (parsed.username || parsed.password) throw new Error("Repository URLs cannot contain embedded credentials");
  return parsed;
}

/**
 * Extracts the `owner/repo` full name from a github.com URL.
 *
 * @param repositoryUrl Candidate repository URL.
 * @returns The `owner/repo` full name (original casing), or `null` for
 *   non-GitHub or malformed URLs.
 */
export function inferGitHubFullName(repositoryUrl: string) {
  try {
    const parsed = new URL(repositoryUrl);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}


/**
 * Canonicalizes a GitHub repository URL to exactly
 * `https://github.com/OWNER/REPO.git` (dropping query, hash, and suffix
 * variants) so stored clone URLs compare equal across equivalent spellings.
 * Non-GitHub URLs pass through unchanged.
 *
 * @param repositoryUrl Candidate repository URL.
 * @returns The canonical clone URL.
 * @throws When a github.com URL does not identify exactly one owner/repo.
 */
export function normalizeRepositoryCloneUrl(repositoryUrl: string) {
  const parsed = new URL(repositoryUrl);
  if (parsed.hostname.toLowerCase() !== "github.com") return parsed.toString();
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("GitHub repository URL must be exactly https://github.com/OWNER/REPOSITORY");
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/${parts[0]}/${parts[1]}.git`;
  return parsed.toString();
}
