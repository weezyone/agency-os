import { describe, expect, it } from "vitest";
import { currentTenantId, tenantFilter, withTenantContext } from "@/lib/tenant-context";

describe("tenant execution context", () => {
  it("binds repository filters to the active tenant", async () => {
    const result = await withTenantContext(
      { tenantId: "tenant-alpha", principalId: "member-1", source: "test" },
      async () => ({ tenantId: currentTenantId(), filter: tenantFilter({ id: "project-1" }) }),
    );

    expect(result).toEqual({
      tenantId: "tenant-alpha",
      filter: { tenantId: "tenant-alpha", id: "project-1" },
    });
  });

  it("isolates concurrent asynchronous tenant contexts", async () => {
    const [alpha, beta] = await Promise.all([
      withTenantContext(
        { tenantId: "tenant-alpha", principalId: null, source: "test" },
        async () => { await Promise.resolve(); return currentTenantId(); },
      ),
      withTenantContext(
        { tenantId: "tenant-beta", principalId: null, source: "test" },
        async () => { await Promise.resolve(); return currentTenantId(); },
      ),
    ]);

    expect(alpha).toBe("tenant-alpha");
    expect(beta).toBe("tenant-beta");
  });
});
