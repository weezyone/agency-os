import { describe, expect, it } from "vitest";
import { configureOidcConnectionSchema } from "@/schemas/tenant";

describe("OIDC configuration contract", () => {
  it("requires the openid scope", () => {
    expect(() => configureOidcConnectionSchema.parse({
      issuer: "https://login.example.com",
      clientId: "agency-os",
      clientSecret: "secret-value",
      scopes: ["email", "profile"],
    })).toThrow(/openid/i);
  });
});
