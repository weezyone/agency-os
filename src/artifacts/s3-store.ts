import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import type { ArtifactStore } from "@/artifacts/contracts";

function logicalKey(storageKey: string) {
  const normalized = storageKey.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifact storage key is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Artifact storage key contains unsupported characters");
  return normalized;
}

function objectKey(storageKey: string) {
  const normalized = logicalKey(storageKey);
  const prefix = env().AGENCY_S3_PREFIX.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${normalized}` : normalized;
}

let cachedClient: S3Client | undefined;
function client() {
  if (cachedClient) return cachedClient;
  const config = env();
  const explicitCredentials = config.AGENCY_S3_ACCESS_KEY_ID && config.AGENCY_S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: config.AGENCY_S3_ACCESS_KEY_ID,
        secretAccessKey: config.AGENCY_S3_SECRET_ACCESS_KEY,
        sessionToken: config.AGENCY_S3_SESSION_TOKEN,
      }
    : undefined;
  cachedClient = new S3Client({
    region: config.AGENCY_S3_REGION,
    endpoint: config.AGENCY_S3_ENDPOINT,
    forcePathStyle: config.AGENCY_S3_FORCE_PATH_STYLE,
    credentials: explicitCredentials,
  });
  return cachedClient;
}

async function bodyToBuffer(body: unknown, maxBytes: number) {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
    return Buffer.from(body);
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const value = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    if (value.byteLength > maxBytes) throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
    return Buffer.from(value);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

export const s3ArtifactStore: ArtifactStore = {
  name: "s3",

  async put(storageKey, content, metadata) {
    const config = env();
    if (!config.AGENCY_S3_BUCKET) throw new Error("S3 artifact bucket is not configured");
    if (content.length > config.AGENCY_ARTIFACT_MAX_BYTES) {
      throw new Error(`Artifact exceeds ${config.AGENCY_ARTIFACT_MAX_BYTES} bytes`);
    }
    const logical = logicalKey(storageKey);
    const key = objectKey(logical);
    const sha256 = metadata?.sha256 ?? createHash("sha256").update(content).digest("hex");
    await client().send(new PutObjectCommand({
      Bucket: config.AGENCY_S3_BUCKET,
      Key: key,
      Body: content,
      ContentLength: content.length,
      ContentType: metadata?.contentType ?? "application/octet-stream",
      Metadata: { sha256 },
      ServerSideEncryption: config.AGENCY_S3_SERVER_SIDE_ENCRYPTION,
      SSEKMSKeyId: config.AGENCY_S3_SERVER_SIDE_ENCRYPTION === "aws:kms" ? config.AGENCY_S3_KMS_KEY_ID : undefined,
    }));
    return {
      storageKey: logical,
      storageUri: `s3://${config.AGENCY_S3_BUCKET}/${key}`,
      bytes: content.length,
      sha256,
    };
  },

  async read(storageKey) {
    const config = env();
    if (!config.AGENCY_S3_BUCKET) throw new Error("S3 artifact bucket is not configured");
    const result = await client().send(new GetObjectCommand({
      Bucket: config.AGENCY_S3_BUCKET,
      Key: objectKey(storageKey),
    }));
    if (typeof result.ContentLength === "number" && result.ContentLength > config.AGENCY_ARTIFACT_MAX_BYTES) {
      throw new Error(`Downloaded artifact exceeds ${config.AGENCY_ARTIFACT_MAX_BYTES} bytes`);
    }
    const content = await bodyToBuffer(result.Body, config.AGENCY_ARTIFACT_MAX_BYTES);
    if (content.length > config.AGENCY_ARTIFACT_MAX_BYTES) {
      throw new Error(`Downloaded artifact exceeds ${config.AGENCY_ARTIFACT_MAX_BYTES} bytes`);
    }
    return content;
  },

  async remove(storageKey) {
    const config = env();
    if (!config.AGENCY_S3_BUCKET) throw new Error("S3 artifact bucket is not configured");
    await client().send(new DeleteObjectCommand({
      Bucket: config.AGENCY_S3_BUCKET,
      Key: objectKey(storageKey),
    }));
  },

  async health() {
    const config = env();
    if (!config.AGENCY_S3_BUCKET) return { provider: "s3", available: false, message: "S3 bucket is not configured" };
    try {
      await client().send(new HeadBucketCommand({ Bucket: config.AGENCY_S3_BUCKET }));
      return { provider: "s3", available: true, message: `S3 bucket ${config.AGENCY_S3_BUCKET} is reachable` };
    } catch (error) {
      return { provider: "s3", available: false, message: error instanceof Error ? error.message : "S3 health check failed" };
    }
  },
};
