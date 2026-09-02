import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import type {
  CommandRequest,
  CommandResult,
  SandboxResourceLimits,
  WorkspaceProcessProvider,
} from "@/workspaces/contracts";

const remoteCommandResponseSchema = z.object({
  requestId: z.string().min(1),
  runtimeId: z.string().min(1).nullable().default(null),
  exitCode: z.number().int().nullable(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  outputTruncated: z.boolean().default(false),
  timedOut: z.boolean().default(false),
  quotaExceeded: z.boolean().default(false),
  forcedTeardown: z.boolean().default(false),
  workspacePatchSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  integrityViolation: z.boolean().default(false),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  resourceLimits: z.object({
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    pidsLimit: z.number().int().positive(),
    diskBytes: z.number().int().positive(),
    networkMode: z.enum(["none", "bridge"]),
    readOnlyRoot: z.boolean(),
  }).nullable().default(null),
});

const remoteHealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  message: z.string().default("Remote sandbox responded"),
});

function bodyHash(body: string) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function remoteSandboxSignature(input: {
  method: string;
  pathname: string;
  body: string;
  timestamp: string;
  nonce: string;
  audience: string;
  secret: string;
}) {
  const canonical = [
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.pathname,
    bodyHash(input.body),
    input.audience,
  ].join("\n");
  return createHmac("sha256", input.secret).update(canonical, "utf8").digest("base64url");
}

export function verifyRemoteSandboxSignature(input: Parameters<typeof remoteSandboxSignature>[0] & { signature: string }) {
  const expected = Buffer.from(remoteSandboxSignature(input));
  const actual = Buffer.from(input.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function resourceLimits(): SandboxResourceLimits {
  const config = env();
  return {
    cpus: config.AGENCY_SANDBOX_CPUS,
    memoryMb: config.AGENCY_SANDBOX_MEMORY_MB,
    pidsLimit: config.AGENCY_SANDBOX_PIDS_LIMIT,
    diskBytes: config.AGENCY_SANDBOX_DISK_BYTES,
    networkMode: config.AGENCY_SANDBOX_NETWORK,
    readOnlyRoot: config.AGENCY_SANDBOX_READ_ONLY,
  };
}

function endpoint(pathname: string) {
  const base = env().AGENCY_REMOTE_SANDBOX_URL;
  if (!base) throw new Error("Remote sandbox URL is not configured");
  return new URL(pathname, base.endsWith("/") ? base : `${base}/`);
}

async function signedFetch(pathname: string, init: RequestInit, signal?: AbortSignal) {
  const config = env();
  const secret = config.AGENCY_REMOTE_SANDBOX_HMAC_SECRET;
  if (!secret) throw new Error("Remote sandbox HMAC secret is not configured");
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  const url = endpoint(pathname);
  const signature = remoteSandboxSignature({
    method,
    pathname: url.pathname,
    body,
    timestamp,
    nonce,
    audience: config.AGENCY_REMOTE_SANDBOX_AUDIENCE,
    secret,
  });

  const timeout = AbortSignal.timeout(config.AGENCY_REMOTE_SANDBOX_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    ...init,
    signal: combined,
    headers: {
      "content-type": "application/json",
      "x-agency-audience": config.AGENCY_REMOTE_SANDBOX_AUDIENCE,
      "x-agency-body-sha256": bodyHash(body),
      "x-agency-nonce": nonce,
      "x-agency-signature": signature,
      "x-agency-timestamp": timestamp,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 2_000);
    throw new Error(`Remote sandbox ${method} ${url.pathname} failed (${response.status})${details ? `: ${details}` : ""}`);
  }
  return response;
}

export const remoteHttpProvider: WorkspaceProcessProvider = {
  name: "remote-http",

  async run(request: CommandRequest): Promise<CommandResult> {
    if (!request.remoteWorkspace) {
      throw new Error("Remote sandbox execution requires immutable repository and patch evidence");
    }
    const limits = resourceLimits();
    const workspacePath = `/v1/workspaces/${encodeURIComponent(request.scopeId)}`;
    const workspaceBody = JSON.stringify({
      audience: env().AGENCY_REMOTE_SANDBOX_AUDIENCE,
      workspace: request.remoteWorkspace,
      limits,
    });
    await signedFetch(workspacePath, { method: "PUT", body: workspaceBody }, request.signal);

    const requestId = randomUUID();
    const commandBody = JSON.stringify({
      requestId,
      label: request.label,
      executable: request.executable,
      args: request.args,
      cwd: ".",
      timeoutMs: request.timeoutMs,
      outputLimitBytes: request.outputLimitBytes,
    });
    const response = await signedFetch(`${workspacePath}/commands`, { method: "POST", body: commandBody }, request.signal);
    const parsed = remoteCommandResponseSchema.parse(await response.json());
    if (parsed.requestId !== requestId) throw new Error("Remote sandbox returned a mismatched request identifier");
    return {
      exitCode: parsed.exitCode,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      outputTruncated: parsed.outputTruncated,
      timedOut: parsed.timedOut,
      startedAt: new Date(parsed.startedAt),
      completedAt: new Date(parsed.completedAt),
      runtimeProvider: "remote-http",
      runtimeId: parsed.runtimeId,
      resourceLimits: parsed.resourceLimits,
      quotaExceeded: parsed.quotaExceeded,
      forcedTeardown: parsed.forcedTeardown,
      workspacePatchSha256: parsed.workspacePatchSha256,
      integrityViolation: parsed.integrityViolation,
    };
  },

  async terminateScope(scopeId: string) {
    const pathname = `/v1/workspaces/${encodeURIComponent(scopeId)}`;
    await signedFetch(pathname, { method: "DELETE", body: "" });
    return 1;
  },

  async health() {
    try {
      const response = await signedFetch("/health", { method: "GET", body: "" });
      const result = remoteHealthSchema.parse(await response.json());
      return {
        provider: "remote-http" as const,
        available: result.status === "ok",
        version: result.version,
        image: result.image,
        message: result.message,
      };
    } catch (error) {
      return {
        provider: "remote-http" as const,
        available: false,
        version: null,
        image: null,
        message: error instanceof Error ? error.message : "Remote sandbox health check failed",
      };
    }
  },
};
