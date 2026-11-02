import type { OperatorCommandOrigin } from "../../../operators/command-delivery.ts";
import type { Case } from "../../../../../domain/work/entities/cases.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../../../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../../../../domain/governance/records/pending-change.ts";
import type { MainCandidateInspection } from "../../../operators/conversations.ts";

export interface OperatorAuthorityLifecycle {
  /** May read the open branch Requests (4.8d D3). */
  requestOpeningContext?(): Promise<ChatContext["requestOpening"]>;
  openRequest?(
    command: Extract<ChatDecision, { kind: "open_request" }>,
  ): Promise<
    import("../../../../../domain/work/dialogue.ts").RequestOpeningOutcome
  >;
  resumeRequest?(
    command: Extract<ChatDecision, { kind: "resume_request" }>,
  ): Promise<
    import("../../../../../domain/work/dialogue.ts").RequestResumeOutcome
  >;
  clearCandidateInspection?(): void;
  /** These methods are bound to admitted operator runtimes; policies select actual holders. */
  candidateDecisionContext?(): NonNullable<
    import("../../../../../domain/work/dialogue.ts").ChatContext[
      "operatorToolAdmission"
    ]
  >;
  inspectCandidate?(
    command: Extract<ChatDecision, { kind: "inspect_operator_candidate" }>,
  ): Promise<MainCandidateInspection>;
  decideCandidate?(
    command: Extract<ChatDecision, { kind: "decide_operator_candidate" }>,
    origin?: OperatorCommandOrigin,
  ): Promise<void>;
  /** The designated actor and current domain policy are checked before every decision. */
  decide?(
    command: Extract<ChatDecision, { kind: "decide_operator_change" }>,
    origin?: OperatorCommandOrigin,
  ): Promise<void>;
  /** May read the open Request spaces (covered Branch Operator requests). */
  decisionContext?(): Promise<
    import("../../../../../domain/work/dialogue.ts").ChatContext[
      "operatorAuthority"
    ]
  >;
  /** The registered Main only (4.8d D4): the execution space of an open
   * Request Case of this system, after verifying its admitted recipients; otherwise
   * `INVALID_AUTHORITY_POLICY` with recipient and Case context. */
  recipientSpaceFor?(
    caseId: string,
    recipients: readonly string[],
  ): Promise<string>;
  proposed(change: PendingChange): Promise<void>;
  approved(change: PendingChange): Promise<void>;
  closed(record: Case): Promise<void>;
}
