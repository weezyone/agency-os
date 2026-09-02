import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("browser security boundary", () => {
  it("prevents invitation-token referrer leakage and caches no auth pages", () => {
    const source = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
    expect(source).toContain('value: "no-referrer"');
    expect(source).toContain('source: "/auth/:path*"');
    expect(source).toContain('value: "no-store"');
    expect(source).toContain("Content-Security-Policy");
  });
});
