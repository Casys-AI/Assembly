/** Conversational dialogue and runtime journal: decisions, context, messages,
 * and the persisted runtime state.
 *
 * Lot 8 deviation (recorded): SystemRuntimeState/ChatDecision/ChatContext stay
 * in domain/work instead of moving to application. Domain code consumes them
 * (governance policies type decisions against ChatDecision/ChatContext, the
 * executable model carries ChatContext["mandate"], work records carry
 * SystemRuntimeState), so moving them would create forbidden
 * domain->application edges. See the architecture test (DDD direction).
 */
import type {
  AuthorityExercise,
  OwnerAuthority,
  ScopedOperatorRef,
} from "../governance/authority.ts";
import type {
  ExecutableModel,
  ExecutionPolicy,
  ModelExecutionReference,
} from "../model/execution/executable-model.ts";
import type { CompiledFlow } from "../model/execution/flow.ts";
import type {
  EvolutionAuthorityExercise,
  EvolutionCategory,
  NativeEvolutionPolicy,
} from "../model/evolution/policy.ts";
import type { NativeBehaviorContract } from "../model/execution/native-contracts.ts";
import type { ModelEditRequest } from "../model/editing/tooling.ts";
import type { ModelDelegationRequest } from "../governance/records/model-delegation-request.ts";
import type { ModelAdministrationAuthority } from "../governance/policies/model-delegation.ts";
import type {
  ModelContextOverview,
  ModelContextTool,
} from "../model/consultation/context.ts";

import type { ToolKind } from "../shared-kernel/tool-kind.ts";
import type {
  MandateRequestedRights,
  MandateRightsRequest,
  PendingChange,
  SupportedMandateChange,
} from "../governance/records/pending-change.ts";
import type {
  NetworkScope,
  SystemConfiguration,
} from "../governance/records/system-configuration.ts";
import type {
  AuthorityRouteCode,
  changeDecisionMetadata,
  OperatorCreationSpec,
  OperatorNotice,
} from "../governance/operator-authority.ts";
import type {
  Candidate,
  Stage,
  ToolContract,
  ToolDraft,
} from "./candidates.ts";

export interface Message {
  designerScopeId?: string;
  caseId?: string;
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: string;
  execution?: ModelExecutionReference;
  operatorNotice?: OperatorNotice;
  /** Recorded with the notice, in the same draft: this notice is the exact
   * input of one durable turn of the decider it designates. */
  noticeWake?: true;
  /** Host-recorded data; projection does not rewrite the durable journal. */
  observation?: import("./policies/context-separation.ts").MessageObservation;
  /** Added only by the host after admission of a modeled operator request. */
  work?: {
    mainOrder?: {
      openingId: string;
      caller: ScopedOperatorRef;
    };
    parentInvocation?:
      import("./execution/case-context.ts").ParentInvocationAnchor;
    designerContext?:
      import("./execution/case-context.ts").DesignerExecutionContext;
    callerId: string;
    correlationId: string;
    invocationId: string;
    behaviorId?: string;
    targetNativeId: string;
    modelVersion: { digest: string; repositoryVersion: string };
  };
}

export interface Event {
  operatorCommandOutcome?:
    import("./records/operator-command-outcome.ts").OperatorCommandOutcome;
  /** Actual execution-pin activation; never a message or a publication notice. */
  effectiveModelUpdate?:
    import("./records/effective-model-update.ts").EffectiveModelUpdate;
  code?: string;
  changeId?: string;
  /** Supersede receipt: the overtaken base pin and the adopting pin. */
  changeSuperseded?: {
    oldPin: { digest?: string; repositoryVersion?: string; revision: number };
    newPin: { digest: string; repositoryVersion?: string };
  };
  authorityExercise?: AuthorityExercise;
  /** Exact owner-selected target after native source readback and expected-pin validation. */
  modelAdoptionAuthorization?: {
    budgetCeilingManifestDigest?: string;
    softwareEvolution?: {
      dossierId: string;
      intentDigest: string;
      proposalDigest: string;
      exercise: EvolutionAuthorityExercise;
    };
    target: {
      identity: ModelIdentity;
      version:
        import("../model/execution/executable-model.ts").ExecutableModelVersion;
    };
  };
  /** Startup provenance; observing an owner is not an exercise of authority. */
  ownerAuthority?: OwnerAuthority;
  caseId?: string;
  id: string;
  at: string;
  kind: string;
  label: string;
  candidateId?: string;
  elementId?: string;
  execution?: ModelExecutionReference;
  /** Full deployment record, written once per session startup. */
  runtimeProvenance?:
    import("./value-objects/runtime-provenance.ts").RuntimeProvenanceRecord;
}

export interface ModelIdentity {
  /** Concrete native ConversationSystem selected in a shared source revision. */
  systemQualifiedName?: string;
  backend?: "native";
  projectId: string;
  editingContextId: string;
  rootId: string;
  systemId: string;
  catalogId: string;
  builderId: string;
  reviewerId?: string;
}

/** Execution data only; admitted rights and configuration are always read afresh. */
export type InvocationContinuation =
  & Pick<
    SystemRuntimeState,
    | "activeInputMessageId"
    | "conversationCursor"
    | "conversationContext"
    | "conversationFlow"
    | "budgetSuspension"
    | "budgetPromotionCandidateId"
    | "workBudget"
    | "workBudgetBinding"
    | "caseBudgetPending"
    | "activeBatchCall"
    | "error"
    | "lastToolFailure"
  >
  & {
    invocation: import("./execution/case-context.ts").CaseInvocation;
    inputMessageId?: string;
    /** Journal boundary before another invocation begins contributing. */
    messageCount?: number;
  };

/** Canonical host allocation made before an initial-tools command is accepted.
 * It grants no authority: the worker revalidates the live model, Case and claim. */
export interface InitialToolsPreparationIntent {
  key: string;
  revision: number;
  runtimeId: string;
  projectId: string;
  systemId: string;
  operatorId: string;
  modelVersion: { digest: string; repositoryVersion: string };
  flowRootId: string;
  flowOccurrenceId: string;
  flowDigest: string;
  selections: Array<{ id: string; nativeId: string; selectionDigest: string }>;
  seedId: string;
  caseId: string;
  caseBirthDigest: string;
  phase: "pending" | "terminal";
  terminal?: {
    outcome: "done" | "abandoned";
    closedAt: string;
    candidateIds: string[];
  };
}
export interface InitialToolsPreparationReference {
  key: string;
  revision: number;
}

export interface SystemRuntimeState {
  initialToolsPreparations?: Record<string, InitialToolsPreparationIntent>;
  /** Durable local-owner budget adoption and exact unfinished native family. */
  budgetCeilingTransition?:
    import("./records/budget-ceiling-transition.ts").BudgetCeilingTransition;
  /** Exact accepted contribution currently selected by the trusted worker. */
  activeInputMessageId?: string;
  /** Outgoing inbox work remains pending even when conversation can answer. */
  pendingContributions?: Record<
    string,
    {
      invocationKey: string;
      inputMessageId: string;
      targetOperatorId: string;
      invocationId: string;
      behaviorId: string;
      status: "pending" | "completed" | "failed";
      completionId?: string;
    }
  >;
  /** Host-captured work origin and bounded dialogue delivery; never execution rights. */
  changeWorkContinuations?: Record<string, {
    inputMessageId: string;
    invocationKey: string;
    feedbackRange?: { start: number; end: number };
    attempt?: {
      messageStart: number;
      priorCandidateIds: string[];
      messageRanges: Array<{ start: number; end: number }>;
      candidateIds: string[];
    };
  }>;
  /** Durable control dispositions do not assert a business work outcome. */
  candidateRecoveryDispositions?: Record<string, {
    acceptedDigest: string;
    candidateId: string;
    continuationDigest: string;
    kind:
      | "blocked"
      | "not-started"
      | "recoverable-under-same-delivery"
      | "resumed";
    target?: NonNullable<SystemRuntimeState["caseInvocation"]>;
    modelRevision?: number;
    /** Exact A-owned message boundaries across temporary selections. */
    baseMessageEnd?: number;
    messageRanges?: Array<{ start: number; end: number }>;
    replacementId?: string;
    reason?: "budget" | "unknown" | "opportunity-changed";
    checkpoint?: { threadId: string; runId: string; checkpointId: string };
    budget?: {
      scopeId: string;
      ownerId: string;
      eventIndex: number;
      eventDigest: string;
    };
  }>;
  /** Temporary selection owned by one durable candidate recovery command. */
  candidateRecoverySelection?: {
    acceptedDigest: string;
    commandId: string;
    phase: "selected" | "entered" | "control-settled";
    candidateId: string;
    continuationDigest: string;
    modelRevision: number;
    baseMessageEnd: number;
    messageRanges: Array<{ start: number; end: number }>;
    segmentStart: number;
    checkpoint: { threadId: string; runId: string; checkpointId: string };
    target: NonNullable<SystemRuntimeState["caseInvocation"]>;
    previous?: NonNullable<SystemRuntimeState["caseInvocation"]>;
  };
  /** Suspended invocations, keyed by exact scope and delegated contribution. */
  invocationContinuations?: Record<string, InvocationContinuation>;
  /** Host-bound resume receipts; a started receipt is never replayed blindly. */
  requestResumptions?: Array<{
    taskSourceInputs?:
      import("./task-source-input.ts").TaskSourceInputCapture[];
    /** Previous active selection retained for audit and original opening replay. */
    previousTaskSourceInputs?:
      import("./task-source-input.ts").TaskSourceInput[];
    caseId: string;
    resumeId: string;
    instruction: string;
    openedBy: string;
    conversationId: string;
    designerScopeId: string;
    status: "started" | "completed";
    outcome?: RequestResumeOutcome;
  }>;
  /** Exact provider groups and per-member checkpoints, scoped to their original Case. */
  conversationBatches?: ConversationBatchExecution[];
  /** A correlation pointer only; every use also verifies the current Case scope. */
  activeBatchCall?: { batchId: string; callId: string };
  /** Exact human Case decision, persisted before Request source publication.
   * It stores no session secret and is not evidence of effective adoption. */
  requestNetworkDecisions?: Record<string, {
    openingId: string;
    executionSpaceId: string;
    caseId: string;
    commandId: string;
    expectedRevision: number;
    configurationRevision: number;
    proposalIntentDigest: string;
    verdict: "approve" | "refuse";
    /** The MO's delegated decision (4.8c) or the creator's creation grant
     * (4.8e); absent for the person's. The envelope is the host's own
     * record, decoded by `request-delegated-authority.ts`; its native
     * effect makes one operator command decide once (A4). */
    authority?:
      | { kind: "delegated"; digest: string; envelope: unknown }
      | { kind: "creation-grant"; digest: string; envelope: unknown };
  }>;
  /** Durable dialogue delivery by change ID, independent of the published configuration. */
  changeDecisionContinuations?: Record<
    string,
    "pending" | "feedback-sent" | "resumed"
  >;
  scheduledExecution?: import("./entities/cases.ts").ScheduledExecution;
  watchNotifications?: {
    id: string;
    caseId: string;
    /** Absent only in historical outbox entries; never inferred from content. */
    ownerId?: string;
    summary: string;
    at: string;
  }[];
  /** Derived even when restoring an older persisted execution contract. */
  ownerAuthority?: OwnerAuthority;
  cases?: import("./entities/cases.ts").Case[];
  caseBudgetPending?: boolean;
  caseInvocation?: import("./execution/case-context.ts").CaseInvocation;
  /** Perpetual conversation identity, independent of every Case and its ledger. */
  designer?: {
    scopeId: string;
    budget?: { budgetId: string; scopeId: string };
  };
  /** Resolves to a runtime-started event in this state's journal. */
  runtime?: {
    digest: string;
    complete?: boolean;
    incompleteReasons?:
      import("./value-objects/runtime-provenance.ts").RuntimeProvenanceIncompleteReason[];
  };
  workBudget?: import("./policies/budget.ts").WorkBudgetView;
  budgetPromotionCandidateId?: string;
  workBudgetBinding?: { budgetId: string; scopeId: string };
  budgetSuspension?: {
    nodeId: string;
    operation: import("./policies/budget.ts").WorkBudgetOperation;
    candidateId?: string;
    recipient: "local-control";
    reason: "exhausted" | "unavailable";
    diagnostic: string;
    attemptId?: string;
    dispatchStarted: boolean;
  };
  id: string;
  revision: number;
  catalogRevision: number;
  model?: ModelIdentity;
  messages: Message[];
  /** Canonical durable promotion state; only activation publishes a catalog entry. */
  candidates: Candidate[];
  /** Available host consultation tools, derived from the admitted revision policy. */
  modelTools?: ModelContextTool[];
  events: Event[];
  busy: boolean;
  phase: string;
  provider: string;
  error?: string;
  configuration?: SystemConfiguration;
  lastToolFailure?: ToolFailure;
  /** Immutable admitted execution contract; configuration is its read model. */
  executionModel?: ExecutableModel;
  availableExecutionModel?: ExecutableModel;
  conversationCursor?: { nodeId: string };
  conversationContext?: Record<string, unknown>;
  conversationFlow?: CompiledFlow;
}

/** Actual bounded observations from one independently opened Request; no authority. */
/** What an `open_request` turn observes: the branch Request and its opening
 * phase, or a coded refusal with its recovery. Data, never authority. */
export type RequestOpeningOutcome =
  | {
    status: "opened";
    caseId: string;
    caseNumber: number;
    executionSpaceId: string;
    phase: import("./request-spaces.ts").OpeningPhase;
    /** Present when the opening stopped at a recoverable phase. */
    issues?: string[];
  }
  | {
    status: "refused";
    code: string;
    recovery: string;
    context?: Record<string, unknown>;
  };

export interface RequestResumeOutcome {
  caseId: string;
  operatorId: string;
  status: import("./entities/cases.ts").CaseStatus;
  modelVersion?: string;
  reply?: string;
}

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
    import("./records/operator-evolution.ts").EvolutionConversationRecord;
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
  | {
    kind: "propose_mandate_change";
    text: string;
    reason: string;
    requestedRights: MandateRightsRequest;
  }
  | {
    kind: "propose_agent_creation";
    text: string;
    name: string;
    reason: string;
    role: "reviewer";
    mandate: {
      mayReviewExactCandidate: true;
      mayAdmitReviewedCandidates: true;
    };
  }
  | {
    kind: "propose_agent_creation";
    text: string;
    name: string;
    reason: string;
    role: "operator";
    operator: OperatorCreationSpec;
  }
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

export interface ConversationBatchCall extends ChatDecisionCall {
  status: "queued" | "started" | "completed" | "unknown" | "cancelled";
  result?: ChatCallResult;
  candidateId?: string;
  /** Exact proposal persisted before its publication can begin. */
  changeId?: string;
  /** Set before an opaque or remote mutation; only a durable result clears uncertainty. */
  effectStarted?: boolean;
  /** Persisted before entering each native action, never inferred from messages. */
  checkpoint?: { nodeId: string; context: Record<string, unknown> };
  /** Durable native outputs prevent repeating a known effect after interruption. */
  actionResults?: Record<
    string,
    import("../model/execution/flow.ts").FlowActionResult
  >;
}

export interface ConversationBatchExecution {
  inputMessageId?: string;
  id: string;
  /** Exact contribution identity; legacy unkeyed delegated batches cannot acquire new owners. */
  invocationKey?: string;
  caseId?: string;
  designerScopeId?: string;
  modelDigest: string;
  createdAt: string;
  /** Exact accepted history revision; absent on historical scalar batches. */
  recordedRevision?: number;
  /** Serialized context actually supplied to this response's provider. */
  decisionContextCharacters?: number;
  assistantBlocks?: unknown[];
  providerTurn?: ProviderTurn;
  providerRepairs?: ProviderRepair[];
  sourceDecision: Pick<ChatContext, "modelContext" | "modelSources">;
  calls: ConversationBatchCall[];
  /** Durable reference only; membership and receipts live in the ledger. */
  immutableGroup?: {
    groupId: string;
    manifestDigest: string;
    publication?: { publicationDigest: string; revision: number };
  };
}

/** Safe structured feedback for the next bounded conversational decision. */
export interface ToolFailure {
  code:
    | "URL_INVALID"
    | "URL_NOT_USER_SUPPLIED"
    | "NETWORK_SCOPE_DENIED"
    | "FETCH_FAILED"
    | "FETCH_TIMEOUT"
    | "TOOL_EXECUTION_FAILED"
    | "TOOL_UNAVAILABLE"
    | "REPEATED_FAILURE";
  message: string;
  retryable: boolean;
  toolId: string;
  url?: string;
  missingPermission?: { kind: "network-host"; host: string };
  allowedHosts?: string[];
}

export interface ChatContext {
  /** Pin-derived discovery only; live effect checks remain authoritative. */
  pinCapabilities?: {
    teamCreation: boolean;
    operatorDecisions: boolean;
    candidateDecisions: boolean;
  };
  /** Stable admitted policy data, separate from live target/capacity views. */
  pinPolicies?: {
    creation: NonNullable<ChatContext["operatorCreation"]>["policies"];
    authority: NonNullable<ChatContext["operatorAuthority"]>["policies"];
    toolAdmission: NonNullable<
      ChatContext["operatorToolAdmission"]
    >["policies"];
  };
  activeInputMessageId?: string;
  /** Exact prior grants and bounded dossier metadata; no source bytes or peer history. */
  operatorEvolution?: {
    policy: NativeEvolutionPolicy;
    capabilities: { prepare: boolean; accept: boolean; adopt: boolean };
    dossiers: OperatorEvolutionSummary[];
    truncated: boolean;
  };
  /** Untrusted task data from an exact host-captured source; never instructions or grants. */
  taskSourceInputs?: import("./task-source-input.ts").TaskSourceInput[];
  /** Source-admitted creation grants; hierarchy alone supplies no authority. */
  operatorCreation?: {
    policies:
      import("../governance/policies/operator-creation-policy.ts").OperatorCreationPolicy[];
    /** Read-only creator bounds (the `TeamOperatorProvision` shape): a team
     * provision must stay within these exact admitted values. */
    provisionBounds: {
      budget: {
        maxAgentDecisions: number;
        maxToolProposals: number;
        maxFlowSteps: number;
      };
      networkHosts: string[];
      mayPropose: string[];
      mayInvokeActiveCatalog: boolean;
      mayAddNetworkHosts: boolean;
      mayConsultModel: boolean;
      mayProposeSysmlRevision: boolean;
    };
  };
  /** Supplied only to Main in its design conversation (4.8d D3). */
  requestOpening?: {
    /** The `open-request` act of its own mandate: open without asking. */
    canOpen: boolean;
    /** Open branch Requests of this system, read-only, newest first, at most
     * 20. `executionSpaceId` is never typed back (A6). */
    requests: Array<{
      caseId: string;
      caseNumber: number;
      /** The Branch Operator's native ID (it shares the Main's). */
      operatorId: string;
      executionSpaceId: string;
      status: import("./entities/cases.ts").CaseStatus;
      openedBy: "main-operator" | "person";
      /** The BO's verified sub-operators, read-only (4.8e E5): what the MO
       * names in a policy's recipients or an order. */
      team: Array<
        { operatorId: string; name: string; parentOperatorId: string }
      >;
    }>;
    /** Exact Releases a Request may start from, newest first, at most 20. */
    releases: Array<{ id: string; digest: string; name: string }>;
    /** Main Requests this conversation opened in main (operator creation and
     * history): the only targets of `resume_request`. */
    mainRequests?: Array<{
      caseId: string;
      operatorId: string;
      status: import("./entities/cases.ts").CaseStatus;
    }>;
  };
  /** Opaque assistant protocol blocks and exact correlated results; never authority. */
  toolCallHistory?: Array<{
    turn?: ProviderTurn;
    repairs?: ProviderRepair[];
    assistantBlocks: unknown[];
    results: Array<{ id: string; result: string; isError?: boolean }>;
  }>;
  /** Policy-holder host metadata; candidate code is available only by exact inspection. */
  operatorToolAdmission?: {
    policies:
      import("../governance/policies/tool-admission-policy.ts").ToolAdmissionPolicy[];
    candidates: {
      operatorId: string;
      candidateId: string;
      candidateDigest: string;
      expectedRevision: number;
      caseId: string;
      name: string;
      kind: ToolKind;
      policyId: string;
      policyRevision: number;
    }[];
  };
  operatorAuthority?: {
    /** Context proof failed; no decision authority is implied. */
    error?: { code: string; context: Record<string, string>; recovery: string };
    policies:
      import("../governance/policies/operator-authority-policy.ts").OperatorAuthorityPolicy[];
    /** `executionSpaceId` and `requester` are read-only context (A6): the
     * host derives the space from the Case, the operator never types it. */
    requests: Array<
      & Pick<
        PendingChange,
        "id" | "requestedBy" | "caseId" | "baseRevision" | "requestedRights"
      >
      & {
        executionSpaceId: string;
        requester: ScopedOperatorRef;
        changeKind: PendingChange["kind"];
      }
    >;
    /** Requests that wait for the person, read-only: this operator never
     * decides them; the person decides on the relayed card. Newest first. */
    awaitingPerson: Array<{
      id: string;
      caseId: string;
      executionSpaceId: string;
      requester: ScopedOperatorRef;
      changeKind: PendingChange["kind"];
      requestedRights?: MandateRequestedRights;
      status: "human-decision" | "needs-resolution";
      code?: AuthorityRouteCode;
    }>;
    /** More than `MAX_AWAITING_PERSON` requests wait; the oldest are omitted. */
    awaitingPersonTruncated: boolean;
  };
  designer?: import("./execution/case-context.ts").DesignerExecutionContext;
  case?: import("./entities/cases.ts").Case;
  workBudget?: import("./policies/budget.ts").WorkBudgetView;
  /** Designer-facing, unmasked errors/warnings; at most 20, primary operator only. */
  modelDiagnostics?:
    readonly import("../model/policies/diagnostics.ts").ModelDiagnostic[];
  /** Host-built exact-source navigation; it grants no access or report coverage. */
  modelDiagnosticsView?: { version: string; href: string };
  /** Identity and mission read from the admitted operator's own model scope. */
  operator?: { nativeId: string; name: string; instruction: string };
  executionPolicy?: ExecutionPolicy;
  modelVersion?: { digest: string; repositoryVersion?: string };
  /** This operator's explicitly admitted execution pin, distinct from repository HEAD. */
  admittedModelVersion?: { digest: string; repositoryVersion?: string };
  modelSources?: ModelSourceRevision;
  /** A source-pinned map; modelSources then contains only explicitly loaded files. */
  modelContext?: ModelContextOverview;
  /** Standard read-only context operations; they grant no source write or admission. */
  modelTools?: ModelContextTool[];
  /** Host capability only; policy, source base and admission are still checked. */
  modelEditing?: {
    targetedEdits: boolean;
    rawRevision: boolean;
    policy?:
      import("../model/execution/native-contracts.ts").NativeModelEditPolicy;
  };
  /** Admitted administration authority, exposed only when the host can propose. */
  modelAdministration?: ModelAdministrationAuthority;
  /** Current repository records for this operator's own source proposals only. */
  sourceProposals?: readonly ModelSourceProposalStatus[];
  lastToolFailure?: ToolFailure;
  /** Only source-admitted exposures for this agent, with their native inputs. */
  modeledBehaviors?: readonly NativeBehaviorContract[];
  mandate?: {
    id: string;
    /** The `open-request` act: open a branch Request without asking the
     * person (decision 10). Absent: not granted. */
    mayOpenRequests?: true;
    mayPropose: readonly ToolKind[];
    mayInvoke: false | "active-catalog-only";
    mayReview: boolean;
    mayActivate: boolean;
    mayAdmitOwnCandidates?: boolean;
    mayChangeOwnMandate?: false;
    network: NetworkScope;
    supportedChanges: readonly SupportedMandateChange[];
  };
  configuration?: Omit<SystemConfiguration, "changes"> & {
    changes: ReturnType<typeof changeDecisionMetadata>[];
  };
  contracts?: readonly ToolContract[];
  messages: Message[];
  activeTools: Array<
    Pick<Candidate, "id" | "name" | "description" | "digest" | "kind">
  >;
  candidates: Array<
    Pick<Candidate, "id" | "name" | "stage" | "error" | "kind">
  >;
  /** Recorded local artifact evidence, without code or access to a peer's catalog. */
  artifacts?: readonly ArtifactEvidence[];
  /** Source-admitted design instructions, never execution permissions. */
  modelingGuidance?:
    readonly import("../model/execution/native-contracts.ts").NativeModelingGuidance[];
  /** Currently admitted local notes, supplied only through an exposed recall. */
  memoryGuidance?:
    readonly import("../memory/governed-memory-promotion.ts").MemoryGuidance[];
  /** Local installed metadata and exact currently loaded instruction versions. */
  skills?: {
    policy: import("../skills/context-skills.ts").SkillPolicy;
    catalog: readonly import("../skills/entities/skill.ts").SkillMetadata[];
    loaded: readonly import("../skills/entities/skill.ts").SkillGuidance[];
  };
  contextEvidence?:
    import("./policies/context-separation.ts").DecisionContextEvidence;
}

/** Facts about one exact artifact; evidence does not grant authority to use it. */
export type ArtifactEvidence =
  & Pick<
    Candidate,
    | "id"
    | "name"
    | "kind"
    | "digest"
    | "createdAt"
    | "tests"
    | "review"
    | "reviewExecution"
    | "admissionDecision"
    | "admission"
    | "reusedFrom"
  >
  & {
    localStage: Stage;
    /** Source observation for the exact identity, contract and digest, if available. */
    nativeStatus?: Stage;
    nativeModelVersion?: { digest: string; repositoryVersion?: string };
    contentDigestMatches: boolean;
    /** Confirmed at this observation only, never a grant to another operator. */
    activationConfirmed: boolean;
  };

export interface ModelSourceRevision {
  version: string;
  /** Host-verified design source S, separate from the executing contract R.
   * Read provenance only; this object conveys no source-edit or execution right. */
  requestSource?: {
    kind: "admitted-request-source";
    openingId: string;
    executionSpaceId: string;
    admittedSourceVersion: string;
    sourceAdmissionRevision: number;
    sourceAdmissionManifestDigest: string;
    executedSourceVersion: string;
  };
  /** Complete files. With modelContext present, this is the loaded working set. */
  sources: Record<string, string>;
  /** Bounded main-branch publication history of this exact source snapshot. */
  publishedRevisions?: {
    limit: number;
    proposalLimit: number;
    truncated: boolean;
    commits: PublishedModelRevision[];
  };
}

export interface PublishedModelRevision {
  version: string;
  sourceDigest: string;
  author: string;
  createdAt: string;
  /** Several accepted proposals may share one publication commit. */
  proposals?: Array<{ id: string; author: string }>;
}

export interface ModelRevisionRequest {
  reason: string;
  baseVersion: string;
  addresses?:
    import("../model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
  /** Changed source files; the repository applies them to the exact base. */
  sources: Record<string, string>;
}

export interface ModelRevisionProposal {
  id: string;
  baseVersion: string;
  status: "pending";
  addresses?:
    import("../model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
  [key: string]: unknown;
}

export interface ModelSourceProposalStatus {
  id: string;
  baseVersion: string;
  status: "preparing" | "proposed" | "accepting" | "accepted" | "rejected";
  acceptedVersion?: string;
  addresses?:
    import("../model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
}
