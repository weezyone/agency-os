import { afterEach, describe, expect, it } from "vitest";
import {
  assertOperator,
  OperatorUnauthorizedError,
  validOperatorToken,
} from "@/lib/operator-auth";

const originalEnv = { ...process.env };

describe.sequential("operator authorization", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("allows local development when operator auth is disabled", () => {
    process.env.AGENCY_REQUIRE_OPERATOR_AUTH = "false";
    delete process.env.AGENCY_OPERATOR_TOKEN;
    expect(validOperatorToken(null)).toBe(true);
    expect(() => assertOperator(new Request("http://localhost/api/projects"))).not.toThrow();
  });

  it("accepts header and bearer credentials using exact token matching", () => {
    process.env.AGENCY_REQUIRE_OPERATOR_AUTH = "true";
    process.env.AGENCY_OPERATOR_TOKEN = "a-long-test-operator-token-at-least-32-characters";

    expect(validOperatorToken("a-long-test-operator-token-at-least-32-characters")).toBe(true);
    expect(validOperatorToken("a-long-test-operator-tokeN")).toBe(false);
    expect(() => assertOperator(new Request("http://localhost/api/projects", {
      headers: { authorization: "Bearer a-long-test-operator-token-at-least-32-characters" },
    }))).not.toThrow();
  });

  it("rejects missing credentials when authorization is enabled", () => {
    process.env.AGENCY_REQUIRE_OPERATOR_AUTH = "true";
    process.env.AGENCY_OPERATOR_TOKEN = "a-long-test-operator-token-at-least-32-characters";
    expect(() => assertOperator(new Request("http://localhost/api/projects")))
      .toThrow(OperatorUnauthorizedError);
  });
});
