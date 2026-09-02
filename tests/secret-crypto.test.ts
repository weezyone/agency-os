import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptTenantValue, encryptTenantValue } from "@/lib/secret-crypto";
import { resetEnvForTests } from "@/lib/env";

const originalEnv = { ...process.env };

describe.sequential("tenant secret encryption", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      OPENAI_API_KEY: "test-key",
      MONGODB_URI: "mongodb://127.0.0.1:27017",
      MONGODB_DATABASE: "agency_os_test",
      AGENCY_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      AGENCY_SECRET_KEY_ID: "test-key-v1",
    };
    resetEnvForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it("round-trips only with the same tenant and secret name", () => {
    const envelope = encryptTenantValue("tenant-a", "github-token", "gh-test-secret");
    expect(decryptTenantValue("tenant-a", "github-token", envelope)).toBe("gh-test-secret");
    expect(() => decryptTenantValue("tenant-b", "github-token", envelope)).toThrow();
    expect(() => decryptTenantValue("tenant-a", "linear-token", envelope)).toThrow();
  });

  it("uses unique nonces for repeated encryption", () => {
    const first = encryptTenantValue("tenant-a", "github-token", "same-value");
    const second = encryptTenantValue("tenant-a", "github-token", "same-value");
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });
});
