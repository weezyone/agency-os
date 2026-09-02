import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { env } from "@/lib/env";
import type { ArtifactStore } from "@/artifacts/contracts";

function normalizeKey(storageKey: string) {
  const normalized = storageKey.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifact storage key is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Artifact storage key contains unsupported characters");
  return normalized;
}

function resolveKey(storageKey: string) {
  const root = path.resolve(env().AGENCY_ARTIFACT_ROOT);
  const normalized = normalizeKey(storageKey);
  const absolutePath = path.resolve(root, normalized);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Artifact path escapes the configured root");
  }
  return { root, normalized, absolutePath };
}

export const filesystemArtifactStore: ArtifactStore = {
  name: "filesystem",
  async put(storageKey: string, content: Buffer) {
    const config = env();
    if (content.length > config.AGENCY_ARTIFACT_MAX_BYTES) {
      throw new Error(`Artifact exceeds ${config.AGENCY_ARTIFACT_MAX_BYTES} bytes`);
    }

    const target = resolveKey(storageKey);
    await mkdir(path.dirname(target.absolutePath), { recursive: true, mode: 0o700 });
    const temporary = `${target.absolutePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, target.absolutePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    return {
      storageKey: target.normalized,
      storageUri: `file://${target.absolutePath}`,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  },

  async read(storageKey: string) {
    const target = resolveKey(storageKey);
    const metadata = await stat(target.absolutePath);
    if (!metadata.isFile()) throw new Error("Artifact storage target is not a regular file");
    if (metadata.size > env().AGENCY_ARTIFACT_MAX_BYTES) {
      throw new Error(`Downloaded artifact exceeds ${env().AGENCY_ARTIFACT_MAX_BYTES} bytes`);
    }
    return readFile(target.absolutePath);
  },

  async remove(storageKey: string) {
    await rm(resolveKey(storageKey).absolutePath, { force: true });
  },

  async health() {
    const root = path.resolve(env().AGENCY_ARTIFACT_ROOT);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const probe = path.join(root, `.health-${randomUUID()}`);
    try {
      await writeFile(probe, "ok", { mode: 0o600, flag: "wx" });
      return { provider: "filesystem", available: true, message: `Artifact root is writable at ${root}` };
    } catch (error) {
      return { provider: "filesystem", available: false, message: error instanceof Error ? error.message : "Artifact root health check failed" };
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
  },
};
