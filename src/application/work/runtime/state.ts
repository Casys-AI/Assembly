import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import type {
  AuthorityExercise,
  OwnerAuthority,
  ScopedOperatorRef,
} from "../../../domain/governance/authority.ts";
import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlow } from "../../../domain/model/execution/flow.ts";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import { type ModelContextTool } from "../context/model-tools.ts";
import type { SystemConfiguration } from "../../../domain/governance/records/system-configuration.ts";
import type { OperatorNotice } from "../../../domain/governance/operator-authority.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { ToolFailure } from "../tools/tool-invocation.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type {
  ChatCallResult,
  ChatDecisionCall,
  ProviderRepair,
  ProviderTurn,
} from "../conversation/chat-decision.ts";

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
  observation?: import("../context/evidence.ts").MessageObservation;
  /** Added only by the host after admission of a modeled operator request. */
  work?: {
    mainOrder?: {
      openingId: string;
      caller: ScopedOperatorRef;
    };
    parentInvocation?:
      import("../../../domain/work/execution/case-context.ts").ParentInvocationAnchor;
    designerContext?:
      import("../../../domain/work/execution/case-context.ts").DesignerExecutionContext;
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
    import("./operator-command-outcome.ts").OperatorCommandOutcome;
  /** Actual execution-pin activation; never a message or a publication notice. */
  effectiveModelUpdate?:
    import("../../../domain/work/records/effective-model-update.ts").EffectiveModelUpdate;
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
        import("../../../domain/model/execution/executable-model.ts").ExecutableModelVersion;
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
    import("../../../domain/work/value-objects/runtime-provenance.ts").RuntimeProvenanceRecord;
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
    invocation:
      import("../../../domain/work/execution/case-context.ts").CaseInvocation;
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
    import("./budget-ceiling-transition.ts").BudgetCeilingTransition;
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
      import("../../../domain/work/records/task-source-input.ts").TaskSourceInputCapture[];
    /** Previous active selection retained for audit and original opening replay. */
    previousTaskSourceInputs?:
      import("../../../domain/work/records/task-source-input.ts").TaskSourceInput[];
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
  scheduledExecution?: ScheduledExecution;
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
  cases?: import("../../../domain/work/entities/cases.ts").Case[];
  caseBudgetPending?: boolean;
  caseInvocation?:
    import("../../../domain/work/execution/case-context.ts").CaseInvocation;
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
      import("../../../domain/work/value-objects/runtime-provenance.ts").RuntimeProvenanceIncompleteReason[];
  };
  workBudget?: import("../../../domain/work/policies/budget.ts").WorkBudgetView;
  budgetPromotionCandidateId?: string;
  workBudgetBinding?: { budgetId: string; scopeId: string };
  budgetSuspension?: {
    nodeId: string;
    operation:
      import("../../../domain/work/policies/budget.ts").WorkBudgetOperation;
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

export interface RequestResumeOutcome {
  caseId: string;
  operatorId: string;
  status: import("../../../domain/work/entities/cases.ts").CaseStatus;
  modelVersion?: string;
  reply?: string;
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
    import("../../../domain/model/execution/flow.ts").FlowActionResult
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

export type CaseContinuation = Pick<
  SystemRuntimeState,
  | "caseInvocation"
  | "activeInputMessageId"
  | "conversationCursor"
  | "conversationContext"
  | "conversationFlow"
  | "budgetSuspension"
  | "budgetPromotionCandidateId"
  | "workBudget"
  | "workBudgetBinding"
  | "caseBudgetPending"
  | "lastToolFailure"
>;

export interface ScheduledExecution {
  caseId: string;
  id: string;
  startedAt: string;
  previous: CaseContinuation;
}
