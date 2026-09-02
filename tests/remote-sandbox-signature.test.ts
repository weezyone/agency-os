import { describe, expect, it } from "vitest";
import { remoteSandboxSignature, verifyRemoteSandboxSignature } from "@/workspaces/remote-http-provider";

const request = {
  method: "POST",
  pathname: "/v1/workspaces/workspace-1/commands",
  body: JSON.stringify({ executable: "npm", args: ["run", "test"] }),
  timestamp: "1787990400000",
  nonce: "nonce-123",
  audience: "agency-os-sandbox",
  secret: "test-secret-with-more-than-thirty-two-characters",
};

describe("remote sandbox request signing", () => {
  it("verifies the exact canonical request", () => {
    const signature = remoteSandboxSignature(request);
    expect(verifyRemoteSandboxSignature({ ...request, signature })).toBe(true);
  });

  it("rejects body, path, and audience tampering", () => {
    const signature = remoteSandboxSignature(request);
    expect(verifyRemoteSandboxSignature({ ...request, body: "{}", signature })).toBe(false);
    expect(verifyRemoteSandboxSignature({ ...request, pathname: "/v1/workspaces/other/commands", signature })).toBe(false);
    expect(verifyRemoteSandboxSignature({ ...request, audience: "other-service", signature })).toBe(false);
  });
});
