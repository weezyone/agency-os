import { describe, expect, it } from "vitest";
import { updateTenantSchema } from "@/schemas/tenant";

describe("tenant self-service update contract", () => {
  it("permits presentation and email-domain changes", () => {
    expect(updateTenantSchema.parse({
      displayName: "Agency Alpha",
      allowedEmailDomains: ["agency.example"],
    })).toEqual({
      displayName: "Agency Alpha",
      allowedEmailDomains: ["agency.example"],
    });
  });

  it("rejects tenant status changes from the tenant self-service route", () => {
    expect(() => updateTenantSchema.parse({ status: "suspended" })).toThrow();
  });
});
