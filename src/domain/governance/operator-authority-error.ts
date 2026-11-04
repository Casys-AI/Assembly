export class OperatorAuthorityError extends Error {
  readonly recovery = { action: "refuse-and-repropose" } as const;
  constructor(
    readonly code:
      | "INVALID_AUTHORITY_POLICY"
      | "AUTHORITY_POLICY_FORBIDDEN"
      | "AUTHORITY_POLICY_STALE"
      | "AUTHORITY_REQUEST_STALE"
      | "AUTHORITY_OUT_OF_BOUNDS"
      | "AUTHORITY_RECEIPT_MISMATCH"
      | "AUTHORITY_PROVENANCE_MISMATCH"
      | "INVALID_MODEL_EDIT_GRANT"
      | "INVALID_OPERATOR_REQUEST"
      | "CHANGE_PREVIEW_MISMATCH"
      | "OPERATOR_OPEN_FAILED"
      | "OPERATOR_CAPACITY_EXCEEDED",
    message: string,
    readonly context: Record<string, string | string[]> = {},
  ) {
    super(message);
    this.name = "OperatorAuthorityError";
  }
}
