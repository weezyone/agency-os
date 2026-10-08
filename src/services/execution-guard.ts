/**
 * Raised when an execution runner loses its job lease (or is asked to stop)
 * mid-flight. The `stage` label identifies the checkpoint that detected the
 * loss, which matters because work performed after lease loss is not durable
 * and must be interrupted rather than completed.
 */
export class ExecutionLeaseLostError extends Error {
  readonly stage: string;

  constructor(stage: string, message = "Execution lease is no longer valid") {
    super(`${message} (${stage})`);
    this.name = "ExecutionLeaseLostError";
    this.stage = stage;
  }
}

/** Lease-fencing handle passed through long-running execution stages. */
export type ExecutionGuard = {
  signal: AbortSignal;
  assertActive(stage: string): Promise<void>;
};
