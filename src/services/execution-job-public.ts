import type { ExecutionJob } from "@/schemas/execution-job";

/**
 * Strips lease-security internals (lease token hash, idempotency fencing key)
 * from an execution job before it is exposed through APIs.
 *
 * @param job The stored execution job.
 * @returns The job without sensitive lease fields.
 */
export function publicExecutionJob(job: ExecutionJob) {
  const { leaseTokenHash, activeKey, ...safe } = job;
  void leaseTokenHash;
  void activeKey;
  return safe;
}
