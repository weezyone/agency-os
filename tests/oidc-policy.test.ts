import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvForTests } from "@/lib/env";
import { validateOidcIssuer } from "@/lib/oidc-policy";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  resetEnvForTests();
});

function configure(overrides: Record<string, string> = {}) {
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.MONGODB_URI = "mongodb://localhost:27017";
  process.env.MONGODB_DATABASE = "agency_os_test";
  process.env.AGENCY_AUTH_MODE = "bootstrap";
  process.env.AGENCY_BOOTSTRAP_OWNER_TOKEN = "x".repeat(40);
  process.env.AGENCY_TRANSACTIONS_REQUIRED = "true";
  process.env.AGENCY_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.AGENCY_OIDC_ALLOWED_ISSUER_HOSTS = "login.example.com";
  Object.assign(process.env, overrides);
  resetEnvForTests();
}

describe("OIDC issuer network policy", () => {
  it("accepts an exact allowlisted HTTPS issuer", () => {
    configure();
    expect(validateOidcIssuer("https://login.example.com/oidc")).toBe("https://login.example.com/oidc");
  });

  it("rejects unapproved or private issuer hosts", () => {
    configure();
    expect(() => validateOidcIssuer("https://other.example.com")).toThrow(/allowlist/i);
    expect(() => validateOidcIssuer("https://127.0.0.1")).toThrow(/private/i);
  });

  it("rejects production global integration fallback and unverified-email mode", () => {
    configure({ AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: "true" });
    expect(() => env()).toThrow(/global integration credential fallback/i);

    configure({ AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: "false" });
    expect(() => env()).toThrow(/verified email/i);
  });

  it("rejects insecure production issuers", () => {
    configure();
    expect(() => validateOidcIssuer("http://login.example.com")).toThrow(/HTTPS/i);
  });
});
