import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@/lib/env";

/** Tenant and principal identity attached to the current async execution. */
export type TenantExecutionContext = {
  tenantId: string;
  principalId: string | null;
  source: "request" | "runner" | "system" | "test";
};

const storage = new AsyncLocalStorage<TenantExecutionContext>();

/**
 * Returns the context for the current async execution. Code running outside
 * any entered context (startup, cron-like work) falls back to the configured
 * bootstrap tenant marked with source `system`.
 */
export function currentTenantContext(): TenantExecutionContext {
  return storage.getStore() ?? {
    tenantId: env().AGENCY_TENANT_ID,
    principalId: null,
    source: "system",
  };
}

/** Returns the tenant id of the current async execution. */
export function currentTenantId() {
  return currentTenantContext().tenantId;
}

/**
 * Attaches a context to the current async execution and everything it
 * awaits/spawns later. Use at request or job start; prefer
 * {@link withTenantContext} when the scope has a clear boundary.
 *
 * @param context - Tenant identity to activate.
 */
export function enterTenantContext(context: TenantExecutionContext) {
  storage.enterWith(context);
}

/**
 * Runs an operation with the given context active, restoring the previous
 * context afterwards.
 *
 * @param context - Tenant identity to activate.
 * @param operation - Work to run inside the context.
 * @returns The operation's return value.
 */
export function withTenantContext<T>(
  context: TenantExecutionContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

/**
 * Merges the current tenant id into a MongoDB filter so repository queries
 * are tenant-scoped by construction and cannot accidentally read across
 * tenants.
 *
 * @param filter - Additional equality conditions to combine with the tenant.
 */
export function tenantFilter<T extends Record<string, unknown>>(filter?: T) {
  return { tenantId: currentTenantId(), ...(filter ?? {}) } as { tenantId: string } & T;
}
