import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, loadProjectEnv, resetEnvForTests } from "@/lib/env";

const originalEnv = { ...process.env };

describe("standalone process env files", () => {
  let dir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.MONGODB_URI;
    delete process.env.OPENAI_API_KEY;
    resetEnvForTests();
    dir = await mkdtemp(join(tmpdir(), "agency-os-env-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetEnvForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads required secrets from .env outside the Next.js runtime", async () => {
    await writeFile(
      join(dir, ".env"),
      [
        "OPENAI_API_KEY=from-dotenv",
        "MONGODB_URI=mongodb://127.0.0.1:27017/from-dotenv",
      ].join("\n"),
    );

    loadProjectEnv(dir);

    expect(env().OPENAI_API_KEY).toBe("from-dotenv");
    expect(env().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/from-dotenv");
  });
});
