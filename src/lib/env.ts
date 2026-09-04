import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalText = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const booleanFromString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // M6 identity-backed control plane. The legacy operator token remains a
  // bootstrap-token fallback so existing M5 deployments can migrate safely.
  AGENCY_AUTH_MODE: z.enum(["disabled", "bootstrap", "database"]).default("disabled"),
  AGENCY_BOOTSTRAP_OWNER_TOKEN: optionalSecret,
  AGENCY_BOOTSTRAP_OWNER_NAME: z.string().min(1).default("Agency Owner"),
  AGENCY_BOOTSTRAP_OWNER_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  AGENCY_REQUIRE_OPERATOR_AUTH: booleanFromString.default(false),
  AGENCY_OPERATOR_TOKEN: optionalSecret,
  AGENCY_REQUIRE_SEPARATE_APPROVER: booleanFromString.default(true),
  AGENCY_HIGH_RISK_APPROVALS: z.coerce.number().int().min(1).max(5).default(2),
  // Bootstrap/default tenant used only before an authenticated tenant context exists.
  AGENCY_TENANT_ID: z.string().min(1).max(120).default("agency-default"),
  AGENCY_SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("agency_session"),
  AGENCY_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  AGENCY_OIDC_TRANSACTION_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(10),
  AGENCY_OIDC_ALLOWED_ISSUER_HOSTS: z.string().default(""),
  AGENCY_OIDC_ALLOW_INSECURE_HTTP: booleanFromString.default(false),
  AGENCY_OIDC_ALLOW_PRIVATE_ISSUERS: booleanFromString.default(false),
  AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: booleanFromString.default(true),

  // Per-tenant credential encryption. Value must be a base64-encoded 32-byte key.
  AGENCY_SECRET_ENCRYPTION_KEY: optionalSecret,
  AGENCY_SECRET_KEY_ID: z.string().min(1).default("agency-os-local-v1"),
  AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: booleanFromString.default(false),

  OPENAI_API_KEY: z.string().min(1),
  AGENCY_MODEL: z.string().min(1).default("openai/gpt-5"),
  AGENCY_WORKER_MODEL: z.string().min(1).default("openai/gpt-5"),
  AGENCY_QA_MODEL: z.string().min(1).default("openai/gpt-5-mini"),
  AGENCY_MEMORY_MODEL: z.string().min(1).default("openai/gpt-5-mini"),
  AGENCY_QA_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(90),
  AGENCY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),

  // Durable execution queue and runner lease controls.
  AGENCY_RUNNER_ID: optionalText,
  AGENCY_RUNNER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  AGENCY_RUNNER_LEASE_MS: z.coerce.number().int().min(10_000).max(900_000).default(90_000),
  AGENCY_RUNNER_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(20_000),
  AGENCY_RUNNER_CONTROL_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  AGENCY_RUNNER_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(900_000).default(15_000),
  AGENCY_RUNNER_MAX_DELIVERIES: z.coerce.number().int().min(1).max(20).default(3),
  AGENCY_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  AGENCY_RUNNER_ORPHAN_GRACE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(180_000),
  AGENCY_RUNNER_REGION: z.string().min(1).default("local"),
  AGENCY_RUNNER_QUEUES: z.string().min(1).default("artifact,workspace,external-actions,events"),
  AGENCY_RUNNER_RESOURCE_CLASSES: z.string().min(1).default("standard"),
  AGENCY_RUNNER_LABELS: z.string().default(""),

  // Controlled workspaces. docker-isolated is the production path; local-process
  // remains available only for trusted development repositories.
  AGENCY_WORKSPACE_PROVIDER: z.enum(["local-process", "docker-isolated", "remote-http"]).default("docker-isolated"),
  AGENCY_REMOTE_SANDBOX_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  AGENCY_REMOTE_SANDBOX_HMAC_SECRET: optionalSecret,
  AGENCY_REMOTE_SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
  AGENCY_REMOTE_SANDBOX_AUDIENCE: z.string().min(1).default("agency-os-sandbox"),
  AGENCY_WORKSPACE_ROOT: z.string().min(1).default("/tmp/agency-os/workspaces"),
  AGENCY_WORKSPACE_ALLOWED_GIT_HOSTS: z.string().min(1).default("github.com"),
  AGENCY_WORKSPACE_ALLOW_LOCAL_REPOS: booleanFromString.default(false),
  AGENCY_ALLOW_LOCAL_WORKSPACES_IN_PRODUCTION: booleanFromString.default(false),
  AGENCY_WORKSPACE_MAX_CHANGED_FILES: z.coerce.number().int().min(1).max(200).default(40),
  AGENCY_WORKSPACE_MAX_FILE_BYTES: z.coerce.number().int().min(1_024).max(2_000_000).default(250_000),
  AGENCY_WORKSPACE_MAX_TOTAL_WRITE_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(2_000_000),
  AGENCY_WORKSPACE_CONTEXT_MAX_FILES: z.coerce.number().int().min(1).max(100).default(30),
  AGENCY_WORKSPACE_CONTEXT_MAX_BYTES: z.coerce.number().int().min(10_000).max(2_000_000).default(300_000),
  AGENCY_WORKSPACE_DIFF_MAX_BYTES: z.coerce.number().int().min(10_000).max(2_000_000).default(500_000),
  AGENCY_WORKSPACE_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(180_000),
  AGENCY_WORKSPACE_COMMAND_OUTPUT_MAX_BYTES: z.coerce.number().int().min(10_000).max(2_000_000).default(262_144),
  AGENCY_WORKSPACE_VALIDATION_SCRIPTS: z.string().default("typecheck,test,lint"),
  AGENCY_WORKSPACE_DEPENDENCY_MODE: z.enum(["none", "frozen"]).default("none"),
  AGENCY_GIT_AUTHOR_NAME: z.string().min(1).default("AgencyOS Worker"),
  AGENCY_GIT_AUTHOR_EMAIL: z.string().email().default("agencyos@example.com"),

  // Ephemeral Docker sandbox policy. Repository scripts receive no network by
  // default, a read-only root filesystem, no Linux capabilities, and quotas.
  AGENCY_SANDBOX_DOCKER_BINARY: z.string().min(1).default("docker"),
  AGENCY_SANDBOX_HOST_WORKSPACE_ROOT: optionalText,
  AGENCY_SANDBOX_IMAGE: z.string().min(1).default("agency-os-sandbox:0.7.0"),
  AGENCY_SANDBOX_NETWORK: z.enum(["none", "bridge"]).default("none"),
  AGENCY_SANDBOX_CPUS: z.coerce.number().positive().max(16).default(1),
  AGENCY_SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(65_536).default(1_024),
  AGENCY_SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(16).max(4_096).default(128),
  AGENCY_SANDBOX_TMPFS_MB: z.coerce.number().int().min(16).max(4_096).default(256),
  AGENCY_SANDBOX_DISK_BYTES: z.coerce.number().int().min(10_000_000).max(20_000_000_000).default(536_870_912),
  AGENCY_SANDBOX_USER: optionalText,
  AGENCY_SANDBOX_READ_ONLY: booleanFromString.default(true),
  AGENCY_SANDBOX_DROP_CAPABILITIES: booleanFromString.default(true),
  AGENCY_SANDBOX_NO_NEW_PRIVILEGES: booleanFromString.default(true),
  AGENCY_SANDBOX_CLEANUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // Durable evidence storage. S3-compatible storage removes the shared-POSIX
  // requirement and is the production default for distributed runners.
  AGENCY_ARTIFACT_PROVIDER: z.enum(["filesystem", "s3"]).default("filesystem"),
  AGENCY_ARTIFACT_ROOT: z.string().min(1).default("/tmp/agency-os/artifacts"),
  AGENCY_ARTIFACT_MAX_BYTES: z.coerce.number().int().min(10_000).max(100_000_000).default(10_000_000),
  AGENCY_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  AGENCY_ARTIFACT_GC_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  AGENCY_S3_REGION: z.string().min(1).default("us-east-1"),
  AGENCY_S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  AGENCY_S3_BUCKET: optionalText,
  AGENCY_S3_PREFIX: z.string().default("agency-os"),
  AGENCY_S3_FORCE_PATH_STYLE: booleanFromString.default(false),
  AGENCY_S3_ACCESS_KEY_ID: optionalSecret,
  AGENCY_S3_SECRET_ACCESS_KEY: optionalSecret,
  AGENCY_S3_SESSION_TOKEN: optionalSecret,
  AGENCY_S3_SERVER_SIDE_ENCRYPTION: z.preprocess(emptyToUndefined, z.enum(["AES256", "aws:kms"]).optional()),
  AGENCY_S3_KMS_KEY_ID: optionalText,

  // Transactional outbox and remote external-action execution.
  AGENCY_OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  AGENCY_OUTBOX_LEASE_MS: z.coerce.number().int().min(10_000).max(900_000).default(60_000),
  AGENCY_OUTBOX_MAX_DELIVERIES: z.coerce.number().int().min(1).max(20).default(5),
  AGENCY_OUTBOX_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(900_000).default(15_000),
  AGENCY_EVENT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  AGENCY_EVENT_WEBHOOK_SECRET: optionalSecret,
  AGENCY_TRANSACTIONS_REQUIRED: booleanFromString.default(false),

  // Admission controls and daily execution budget units. Units are explicit
  // policy tokens, not a claim about provider billing currency.
  AGENCY_ADMISSION_MAX_GLOBAL_READY_JOBS: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
  AGENCY_ADMISSION_MAX_GLOBAL_ACTIVE_JOBS: z.coerce.number().int().min(1).max(100_000).default(100),
  AGENCY_ADMISSION_MAX_READY_JOBS: z.coerce.number().int().min(1).max(100_000).default(100),
  AGENCY_ADMISSION_MAX_ACTIVE_JOBS: z.coerce.number().int().min(1).max(10_000).default(20),
  AGENCY_ADMISSION_MAX_PROJECT_ACTIVE_JOBS: z.coerce.number().int().min(1).max(1_000).default(5),
  AGENCY_DAILY_EXECUTION_BUDGET_UNITS: z.coerce.number().int().min(1).max(10_000_000).default(10_000),
  AGENCY_ARTIFACT_RUN_COST_UNITS: z.coerce.number().int().min(1).max(100_000).default(10),
  AGENCY_WORKSPACE_RUN_COST_UNITS: z.coerce.number().int().min(1).max(100_000).default(50),

  // Tamper-evident execution provenance. At least 32 random characters are
  // required when enabled.
  AGENCY_PROVENANCE_HMAC_SECRET: optionalSecret,
  AGENCY_PROVENANCE_KEY_ID: z.string().min(1).default("agency-os-local"),

  // OpenTelemetry. Export through an OTLP collector in production.
  AGENCY_OTEL_ENABLED: booleanFromString.default(false),
  OTEL_SERVICE_NAME: z.string().min(1).default("agency-os"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().default(""),
  AGENCY_OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),

  // Provider usage accounting. Prices are configured per tenant; no stale
  // provider price is silently assumed by the application.
  AGENCY_USAGE_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(730),

  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("agency_os"),
  LINEAR_API_KEY: optionalSecret,
  LINEAR_AUTH_MODE: z.enum(["api_key", "oauth"]).default("api_key"),
  LINEAR_TEAM_ID: optionalText,
  GITHUB_TOKEN: optionalSecret,
  GITHUB_ORG: optionalText,
}).superRefine((value, context) => {
  if (value.AGENCY_RUNNER_HEARTBEAT_MS >= value.AGENCY_RUNNER_LEASE_MS) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_RUNNER_HEARTBEAT_MS"],
      message: "Runner heartbeat must be shorter than the lease duration",
    });
  }
  if (value.AGENCY_RUNNER_CONTROL_POLL_MS >= value.AGENCY_RUNNER_LEASE_MS) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_RUNNER_CONTROL_POLL_MS"],
      message: "Runner control polling must be shorter than the lease duration",
    });
  }
  const bootstrapToken = value.AGENCY_BOOTSTRAP_OWNER_TOKEN ?? value.AGENCY_OPERATOR_TOKEN;
  if (value.AGENCY_REQUIRE_OPERATOR_AUTH && value.AGENCY_AUTH_MODE === "disabled") {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_AUTH_MODE"],
      message: "Legacy operator authentication requires bootstrap or database mode",
    });
  }
  if (value.AGENCY_AUTH_MODE === "bootstrap" && !bootstrapToken) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_BOOTSTRAP_OWNER_TOKEN"],
      message: "Bootstrap mode requires an owner token",
    });
  }
  if (bootstrapToken && bootstrapToken.length < 32) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_BOOTSTRAP_OWNER_TOKEN"],
      message: "Bootstrap owner token must contain at least 32 characters",
    });
  }
  if (value.NODE_ENV === "production" && value.AGENCY_AUTH_MODE === "disabled") {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_AUTH_MODE"],
      message: "Production requires bootstrap or database authentication",
    });
  }
  if (value.NODE_ENV === "production" && !value.AGENCY_TRANSACTIONS_REQUIRED) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_TRANSACTIONS_REQUIRED"],
      message: "Production requires MongoDB transactions for atomic state and outbox writes",
    });
  }
  if (value.AGENCY_ARTIFACT_PROVIDER === "s3" && !value.AGENCY_S3_BUCKET) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_S3_BUCKET"],
      message: "S3 artifact storage requires a bucket",
    });
  }
  if (value.AGENCY_S3_SERVER_SIDE_ENCRYPTION === "aws:kms" && !value.AGENCY_S3_KMS_KEY_ID) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_S3_KMS_KEY_ID"],
      message: "KMS encryption requires a key id",
    });
  }
  if (value.AGENCY_EVENT_WEBHOOK_URL && (!value.AGENCY_EVENT_WEBHOOK_SECRET || value.AGENCY_EVENT_WEBHOOK_SECRET.length < 32)) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_EVENT_WEBHOOK_SECRET"],
      message: "Event webhooks require a secret containing at least 32 characters",
    });
  }
  if (value.AGENCY_PROVENANCE_HMAC_SECRET && value.AGENCY_PROVENANCE_HMAC_SECRET.length < 32) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_PROVENANCE_HMAC_SECRET"],
      message: "Provenance secret must contain at least 32 characters",
    });
  }
  if (value.NODE_ENV === "production" && value.AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK"],
      message: "Production multi-tenant deployments cannot use a global integration credential fallback for GitHub or Linear",
    });
  }
  if (value.NODE_ENV === "production" && value.AGENCY_OIDC_ALLOW_INSECURE_HTTP) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_OIDC_ALLOW_INSECURE_HTTP"],
      message: "Production OIDC issuers must use HTTPS",
    });
  }
  if (value.NODE_ENV === "production" && value.AGENCY_OIDC_ALLOW_PRIVATE_ISSUERS) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_OIDC_ALLOW_PRIVATE_ISSUERS"],
      message: "Production OIDC issuers cannot target private or local hosts",
    });
  }
  if (value.NODE_ENV === "production" && !value.AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL"],
      message: "Production OIDC login requires a verified email claim",
    });
  }
  if (value.NODE_ENV === "production" && !value.AGENCY_SECRET_ENCRYPTION_KEY) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_SECRET_ENCRYPTION_KEY"],
      message: "Production requires a tenant-secret encryption key",
    });
  }
  if (value.AGENCY_SECRET_ENCRYPTION_KEY) {
    try {
      if (Buffer.from(value.AGENCY_SECRET_ENCRYPTION_KEY, "base64").length !== 32) throw new Error();
    } catch {
      context.addIssue({
        code: "custom",
        path: ["AGENCY_SECRET_ENCRYPTION_KEY"],
        message: "Tenant-secret encryption key must be base64 for exactly 32 bytes",
      });
    }
  }
  if (value.AGENCY_WORKSPACE_PROVIDER === "remote-http") {
    if (!value.AGENCY_REMOTE_SANDBOX_URL) {
      context.addIssue({ code: "custom", path: ["AGENCY_REMOTE_SANDBOX_URL"], message: "Remote sandbox provider requires a URL" });
    }
    if (!value.AGENCY_REMOTE_SANDBOX_HMAC_SECRET || value.AGENCY_REMOTE_SANDBOX_HMAC_SECRET.length < 32) {
      context.addIssue({ code: "custom", path: ["AGENCY_REMOTE_SANDBOX_HMAC_SECRET"], message: "Remote sandbox provider requires an HMAC secret containing at least 32 characters" });
    }
    if (value.NODE_ENV === "production" && value.AGENCY_REMOTE_SANDBOX_URL?.startsWith("http:")) {
      context.addIssue({ code: "custom", path: ["AGENCY_REMOTE_SANDBOX_URL"], message: "Production remote sandbox URLs must use HTTPS" });
    }
  }
  if (value.AGENCY_OTEL_ENABLED && !value.OTEL_EXPORTER_OTLP_ENDPOINT) {
    context.addIssue({ code: "custom", path: ["OTEL_EXPORTER_OTLP_ENDPOINT"], message: "OpenTelemetry export requires an OTLP endpoint" });
  }
  if (
    value.NODE_ENV === "production" &&
    value.AGENCY_WORKSPACE_PROVIDER === "local-process" &&
    !value.AGENCY_ALLOW_LOCAL_WORKSPACES_IN_PRODUCTION
  ) {
    context.addIssue({
      code: "custom",
      path: ["AGENCY_WORKSPACE_PROVIDER"],
      message: "Production requires docker-isolated workspaces unless the unsafe local override is explicit",
    });
  }
});

export type Env = z.infer<typeof envSchema>;
let cached: Env | undefined;

function envFileMode() {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test") {
    return process.env.NODE_ENV;
  }
  return "development";
}

// Next.js loads `.env*` for `next dev` / `next start`. Standalone `tsx` processes
// such as the execution runner do not, so env() fills the same files first.
export function loadProjectEnv(dir = process.cwd()) {
  const mode = envFileMode();
  const files = [
    `.env.${mode}.local`,
    mode === "test" ? undefined : ".env.local",
    `.env.${mode}`,
    ".env",
  ];

  for (const file of files) {
    if (!file) continue;
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined && value !== undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function env(): Env {
  // Vitest sets VITEST=true. Skip project files so unit tests keep an isolated process.env.
  if (!process.env.VITEST) {
    loadProjectEnv();
  }
  cached ??= envSchema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
