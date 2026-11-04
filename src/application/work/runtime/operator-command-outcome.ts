import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";

/** A known command result grants no authority. The accepted-command digest
 * binds its target identity, immutable pin, input and originating native effect. */
export interface OperatorCommandOutcome {
  format: "operator-command-outcome/v1";
  acceptedDigest: string;
  /** Actual canonical revision containing this result; immutable on notification retry. */
  revision: number;
  result: { status: "succeeded" } | {
    status: "refused";
    refusal: {
      kind: "operator-authority";
      code: OperatorAuthorityError["code"];
      message: string;
      context: OperatorAuthorityError["context"];
      recovery: OperatorAuthorityError["recovery"];
    };
  };
}
