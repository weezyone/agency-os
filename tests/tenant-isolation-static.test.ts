import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tenantScopedRepositories = [
  "project-repository.ts",
  "action-repository.ts",
  "execution-repository.ts",
  "workspace-repository.ts",
  "artifact-repository.ts",
  "admission-repository.ts",
  "outbox-repository.ts",
  "usage-repository.ts",
  "secret-repository.ts",
  "policy-repository.ts",
];

describe("tenant persistence boundary", () => {
  for (const file of tenantScopedRepositories) {
    it(`${file} binds user-facing operations to tenant context`, () => {
      const source = readFileSync(new URL(`../src/repositories/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(/tenantFilter|currentTenantId/);
    });
  }
});
