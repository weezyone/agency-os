import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("M7 remote execution deployment boundary", () => {
  it("keeps Docker socket access out of the M7 Compose topology", () => {
    const source = readFileSync(new URL("../compose.m7.yml", import.meta.url), "utf8");
    expect(source).not.toMatch(/docker\.sock|\/var\/run\/docker/i);
    expect(source).toContain("target: remote-worker");
    expect(source).toContain("AGENCY_WORKSPACE_PROVIDER: remote-http");
    expect(source).toContain('AGENCY_OIDC_ALLOWED_ISSUER_HOSTS: ${AGENCY_OIDC_ALLOWED_ISSUER_HOSTS:?Set AGENCY_OIDC_ALLOWED_ISSUER_HOSTS}');
    expect(source).toContain('AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: "true"');
    expect(source).toContain('AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: "false"');
  });

  it("pins production identity and credential-fallback controls in Kubernetes", () => {
    const source = readFileSync(new URL("../deploy/k8s/staging/all.yaml", import.meta.url), "utf8");
    expect(source).toContain("AGENCY_OIDC_ALLOWED_ISSUER_HOSTS: login.example.com");
    expect(source).toContain('AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: "true"');
    expect(source).toContain('AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: "false"');
    expect(source).toContain('AGENCY_ADMISSION_MAX_GLOBAL_READY_JOBS: "1000"');
    expect(source).toContain('AGENCY_ADMISSION_MAX_GLOBAL_ACTIVE_JOBS: "100"');
  });

  it("keeps the remote-worker target free of the Docker client", () => {
    const source = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const section = source.split("FROM worker-base AS remote-worker")[1]?.split(/\nFROM /)[0] ?? "";
    expect(section).not.toMatch(/docker-cli|docker\.sock|\/var\/run\/docker/i);
  });
});
