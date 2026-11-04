import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import type { ModelDelegationRequest } from "../../../domain/governance/model-access/model-delegation-request.ts";
import type {
  ChangeProposal,
  MandateRequestedRights,
} from "../../../domain/governance/records/pending-change.ts";
import type { EvolutionCategory } from "../../../domain/model/evolution/policy.ts";
import type { ToolDraft } from "../../../domain/work/records/candidates.ts";
import type { ModelRevisionRequest } from "./chat-context.ts";

/** Actual bounded observations from one independently opened Request; no authority. */
/** What an `open_request` turn observes: the branch Request and its opening
 * phase, or a coded refusal with its recovery. Data, never authority. */
export type RequestOpeningOutcome =
  | {
    status: "opened";
    caseId: string;
    caseNumber: number;
    executionSpaceId: string;
    phase:
      import("../../../domain/work/request-spaces/opening.ts").OpeningPhase;
    /** Present when the opening stopped at a recoverable phase. */
    issues?: string[];
  }
  | {
    status: "refused";
    code: string;
    recovery: string;
    context?: Record<string, unknown>;
  };

/** Closed host commands; all authority and source identities come from runtime. */
export type OperatorEvolutionCommand =
  | {
    kind: "prepare_operator_evolution";
    text: string;
    reason: string;
    editJson: string;
  }
  | {
    kind: "decide_operator_evolution";
    text: string;
    dossierId: string;
    decision: "accept" | "cancel";
  }
  | { kind: "adopt_operator_evolution"; text: string; dossierId: string };

export interface OperatorEvolutionSummary {
  /** The act succeeded, but its additional source-pinned UI receipt could not be read. */
  conversationReceiptUnavailable?: true;
  /** Optional host read receipt; persisted as an immutable conversation observation. */
  conversationRecord?:
    import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationRecord;
  id: string;
  revision: number;
  status: string;
  baseVersion: string;
  candidateVersion: string;
  sourceDigest: string;
  recipeDigest: string;
  proposalDigest: string;
  categories: EvolutionCategory[];
  targets: {
    operatorId: string;
    previousDigest: string;
    candidateDigest: string;
  }[];
  preparation: { actorId: string; policyId: string; policyRevision: number };
  acceptance?: { actorId: string; policyId: string; policyRevision: number };
  adoptionAuthorization?: {
    actorId: string;
    policyId: string;
    policyRevision: number;
  };
  publishedVersion?: string;
  adoptedOperatorIds: string[];
  blockers: { code: string; operatorId?: string; detail: string }[];
}

/** What an operator may request: the stored rights, except that a delegated
 * policy names its recipient Case, never a space (4.8d D4). The host derives
 * `recipientExecutionSpaceId` from the Case before the proposal and does not
 * store the Case. */
export type MandateRightsRequest =
  | Exclude<
    MandateRequestedRights,
    { operatorAuthority: unknown } | { toolAdmission: unknown }
  >
  | {
    operatorAuthority:
      & Omit<
        import("../../../domain/governance/policies/operator-authority-policy.ts").OperatorAuthorityPolicyRequest,
        "recipientExecutionSpaceId"
      >
      & { recipientCaseId?: string };
  }
  | {
    toolAdmission:
      & Omit<
        import("../../../domain/governance/policies/tool-admission-policy.ts").ToolAdmissionPolicyRequest,
        "recipientExecutionSpaceId"
      >
      & { recipientCaseId?: string };
  };

export type ChatDecision =
  | OperatorEvolutionCommand
  | {
    /** The Branch Operator is the source's unique Request owner, never chosen
     * by the Main Operator (4.8d D3). */
    kind: "open_request";
    text: string;
    objective: string;
    openingId: string;
    source:
      | { kind: "current-main" }
      | { kind: "release"; releaseId: string; digest: string };
  }
  | {
    kind: "resume_request";
    text: string;
    operatorId?: string;
    caseId: string;
    resumeId: string;
    instruction: string;
  }
  | {
    kind: "inspect_operator_candidate";
    text: string;
    operatorId: string;
    candidateId: string;
    candidateDigest: string;
    expectedRevision: number;
    caseId: string;
    policyId: string;
    policyRevision: number;
  }
  | {
    kind: "decide_operator_candidate";
    text: string;
    operatorId: string;
    candidateId: string;
    candidateDigest: string;
    expectedRevision: number;
    caseId: string;
    policyId: string;
    policyRevision: number;
    verdict: "approve" | "refuse";
    reason: string;
  }
  | {
    kind: "decide_operator_change";
    text: string;
    operatorId: string;
    changeId: string;
    expectedRevision: number;
    policyId: string;
    policyRevision: number;
    verdict: "approve" | "refuse";
  }
  | {
    kind: "reply";
    text: string;
    caseClosure?: "done" | "abandoned";
    watchResult?: { changed: boolean; summary: string };
  }
  | {
    /** Read more decision context before returning an executable choice. */
    kind: "consult_model";
    text: string;
    inputJson: string;
  }
  | ({ kind: "propose_sysml_revision"; text: string } & ModelRevisionRequest)
  | ({ kind: "propose_sysml_edit"; text: string } & ModelEditRequest)
  | (
    & { kind: "propose_model_delegation"; text: string }
    & ModelDelegationRequest
  )
  | (
    & Omit<
      Extract<ChangeProposal, { kind: "propose_mandate_change" }>,
      "requestedRights"
    >
    & { requestedRights: MandateRightsRequest }
  )
  | Extract<ChangeProposal, { kind: "propose_agent_creation" }>
  | { kind: "propose_tool"; text: string; tool: ToolDraft }
  | {
    kind: "invoke_behavior";
    text: string;
    behaviorId: string;
    /** Parsed and validated against the admitted native input schema by the host. */
    inputJson: string;
  }
  | {
    kind: "invoke_tool";
    text: string;
    toolId: string;
    input: { url: string };
  };

export interface ChatDecisionCall {
  /** Provider-issued ID retained unchanged, or an explicit host-scalar ID for
   * a scalar response without a provider correlation. Stored once, never reminted on replay. */
  id: string;
  decision: ChatDecision;
}

/** Exact host-built opening brief. Persisted once so later calls append history. */
export interface ProviderTurn {
  inputMessageId: string;
  brief: unknown;
  /** Host-recorded decisions and contribution completions delivered between calls,
   * appended after the brief and before this call; never fabricated provider
   * tool results. */
  requestOutcomes?: Array<{ messageId: string; value: unknown }>;
}

/** Host-authored schema repair, with authentic provider blocks kept opaque. */
export interface ProviderRepair {
  assistantBlocks?: unknown[];
  userBlocks: unknown[];
}

export interface ChatDecisionBatch {
  calls: ChatDecisionCall[];
  /** Opaque signed thinking/tool-use blocks, interpreted only by the adapter. */
  assistantBlocks?: unknown[];
  providerTurn?: ProviderTurn;
  providerRepairs?: ProviderRepair[];
}

export interface ChatCallResult {
  status:
    | "succeeded"
    | "refused"
    | "failed"
    | "awaiting-admission"
    | "unknown"
    | "cancelled";
  code: string;
  details: string;
  value?: unknown;
  /** The complete observation remains available through the evidence reader. */
  reference?: { messageId: string; messageDigest: string };
}
