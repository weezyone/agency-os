import type { ExecutionJob } from "@/schemas/execution-job";

export function publicExecutionJob(job: ExecutionJob) {
  const { leaseTokenHash, activeKey, ...safe } = job;
  void leaseTokenHash;
  void activeKey;
  return safe;
}
