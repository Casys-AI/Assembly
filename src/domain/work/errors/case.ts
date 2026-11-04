export class CaseError extends Error {
  constructor(
    public readonly code:
      | "NOT_SUPPORTED_YET"
      | "INVALID_CASE"
      | "NOT_FOUND"
      | "CASE_NOT_FOUND"
      | "CASE_NOT_OWNED"
      | "AGENT_BUSY"
      | "CASE_BUSY"
      | "CASE_CLOSED"
      | "CASE_VERDICT_REQUIRED"
      | "CASE_SCOPE_MISSING"
      | "CASE_CONFLICT"
      | "CASE_DISPATCH_UNKNOWN"
      | "INVALID_SCHEDULE"
      | "INVALID_CASE_ACTION"
      | "CASE_EXECUTION_FAILED",
    message: string,
    public readonly context?: Record<string, string>,
    public readonly recovery?: string,
  ) {
    super(message);
    this.name = "CaseError";
  }
}
