export type ReplayErrorCode =
  | "malformed"
  | "unsupported"
  | "resource-limit"
  | "integrity"
  | "simulation-mismatch";

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;

  constructor(code: ReplayErrorCode, message: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
  }
}

export function isReplayError(value: unknown): value is ReplayError {
  return value instanceof ReplayError;
}
