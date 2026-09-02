export class ExecutionLeaseLostError extends Error {
  readonly stage: string;

  constructor(stage: string, message = "Execution lease is no longer valid") {
    super(`${message} (${stage})`);
    this.name = "ExecutionLeaseLostError";
    this.stage = stage;
  }
}

export type ExecutionGuard = {
  signal: AbortSignal;
  assertActive(stage: string): Promise<void>;
};
