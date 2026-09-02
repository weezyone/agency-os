import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("multi-tenant admission boundaries", () => {
  it("checks platform, tenant, and project capacity before reserving work", () => {
    const source = readFileSync(new URL("../src/services/admission-service.ts", import.meta.url), "utf8");
    expect(source).toContain("globalAdmissionSummary");
    expect(source).toContain("AGENCY_ADMISSION_MAX_GLOBAL_READY_JOBS");
    expect(source).toContain("AGENCY_ADMISSION_MAX_GLOBAL_ACTIVE_JOBS");
    expect(source).toContain("AGENCY_ADMISSION_MAX_PROJECT_ACTIVE_JOBS");
  });
});
