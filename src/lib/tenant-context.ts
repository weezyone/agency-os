import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@/lib/env";

export type TenantExecutionContext = {
  tenantId: string;
  principalId: string | null;
  source: "request" | "runner" | "system" | "test";
};

const storage = new AsyncLocalStorage<TenantExecutionContext>();

export function currentTenantContext(): TenantExecutionContext {
  return storage.getStore() ?? {
    tenantId: env().AGENCY_TENANT_ID,
    principalId: null,
    source: "system",
  };
}

export function currentTenantId() {
  return currentTenantContext().tenantId;
}

export function enterTenantContext(context: TenantExecutionContext) {
  storage.enterWith(context);
}

export function withTenantContext<T>(
  context: TenantExecutionContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

type DeepWritable<T> = T extends (...args: never[]) => unknown ? T : { -readonly [K in keyof T]: DeepWritable<T[K]> };

export function tenantFilter<const T extends Record<string, unknown>>(filter?: T) {
  return { tenantId: currentTenantId(), ...(filter ?? {}) } as { tenantId: string } & DeepWritable<T>;
}
