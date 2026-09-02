import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("new-tenant bootstrap handoff", () => {
  it("creates a one-time owner credential inside the tenant-creation transaction", () => {
    const service = readFileSync(new URL("../src/services/tenant-service.ts", import.meta.url), "utf8");
    expect(service).toContain("createInitialTenantApiKey");
    expect(service).toContain("initialApiKey");
    expect(service).toContain("withMongoTransaction");
  });

  it("uses a partial tenant-subject index for pre-OIDC memberships", () => {
    const repository = readFileSync(new URL("../src/repositories/identity-repository.ts", import.meta.url), "utf8");
    expect(repository).toContain("tenant_subject_unique_partial_v7");
    expect(repository).toContain('partialFilterExpression: { subject: { $type: "string" } }');
    expect(repository).toContain("OIDC email and subject resolve to different tenant memberships");
  });
});
