import type { RetainedToolsPort } from "../tools/active-tools.ts";
import type { RetainedToolInvocationTarget } from "../../../domain/work/retained-tool-dependencies.ts";
import type { ArtifactSourceServicePort } from "../artifacts/publication.ts";
import type { OperatorCommandOrigin } from "../operators/command-delivery.ts";
import type { OperatorDeliveryReceipt } from "../operators/execution.ts";
import type {
  NativeExecutionPort,
  RuntimeStateHistoryPort,
} from "../runtime/execution.ts";
import type { MessageObservation } from "../../../domain/work/policies/context-separation.ts";
import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import type {
  CompiledFlowNode,
  OperatorExecutionProfile,
} from "../../../domain/model/execution/flow.ts";
import type { ModelDiagnosticAddress } from "../../../domain/model/value-objects/diagnostic-address.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  ArtifactEvidence,
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
  ToolFailure,
} from "../../../domain/work/dialogue.ts";
import type {
  Candidate,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type {
  WorkBudgetOperation,
  WorkBudgetView,
} from "../../../domain/work/policies/budget.ts";
import type { BehaviorAdmission } from "../../governance/behavior-call-admission.ts";
import type { BehaviorInvocationPort } from "../behaviors/invocation.ts";
import type { AgentBudgetWait } from "../budget/agent.ts";
import type { DecisionInformationPort } from "../context/information-ports.ts";
import type { SchemaValidationPort } from "../behaviors/schema-validation.ts";
import type {
  AgentPort,
  ClockPort,
  ModelDiagnosticsPort,
  ToolRunnerPort,
} from "../runtime/ports.ts";
import type { ConversationModelPort } from "./ports/out/conversation-model.port.ts";

interface InvocationAdmission {
  retainedTool?: RetainedToolInvocationTarget;
  admitted: boolean;
  toolId: string;
  url?: string;
  failure?: ToolFailure;
}

/** Ephemeral data belongs to one interpreter run, including resumed runs. */
export interface ConversationTurnState {
  /** Host evidence of the exact persisted network proposal, never a flow output. */
  changeApprovalProposal?: { changeId: string; proposalIntentDigest: string };
  inputMessageId?: string;
  pendingCommand?: {
    receipt: OperatorDeliveryReceipt;
    origin: OperatorCommandOrigin;
  };
  /** Only explicitly versioned flows replace the legacy inline command loop. */
  executionProfile?: OperatorExecutionProfile;
  /** Derived from the exact admitted command output contract, never its name. */
  noticeCompletionAvailable?: boolean;
  resumeNodeId?: string;
  resumedContribution: boolean;
  proposals: number;
  decisions: number;
  chosen?: ChatDecision;
  /** Correlated member selected by the scheduler; no execution right is implied. */
  batchCall?: { batchId: string; callId: string };
  sourceDecision: Pick<ChatContext, "modelContext" | "modelSources">;
  admission?: InvocationAdmission;
  behaviorAdmission?: BehaviorAdmission;
  failures: Map<string, number>;
}

interface ConversationCaseHost {
  readonly state: SystemRuntimeState;
  readonly snapshot: SystemRuntimeState;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  currentModel(): Promise<ExecutableModel>;
  inspectModelVersion(): Promise<ExecutableModel>;
  say(text: string): Promise<void>;
  feedback(text: string, observation?: MessageObservation): Promise<void>;
}

export interface ConversationDecisionHost extends ConversationCaseHost {
  /** Verify the actual post-consultation payload before its native success edge. */
  assertDecisionContextRepresentable?(
    model: ExecutableModel,
    record: SystemRuntimeState,
  ): Promise<void>;
  operatorEvolutionContext?(
    model: ExecutableModel,
  ): Promise<ChatContext["operatorEvolution"]>;
  /** May read the open branch Requests (4.8d D3). */
  requestOpeningContext?(): Promise<ChatContext["requestOpening"]>;
  openRequest?(
    command: Extract<ChatDecision, { kind: "open_request" }>,
  ): Promise<import("../../../domain/work/dialogue.ts").RequestOpeningOutcome>;
  resumeRequest?(
    command: Extract<ChatDecision, { kind: "resume_request" }>,
  ): Promise<import("../../../domain/work/dialogue.ts").RequestResumeOutcome>;
  invalidateOperatorCandidateInspection?(): void;
  operatorToolAdmissionContext(): ChatContext["operatorToolAdmission"];
  inspectOperatorCandidate(
    command: Extract<ChatDecision, { kind: "inspect_operator_candidate" }>,
  ): Promise<import("../operators/conversations.ts").MainCandidateInspection>;
  decideOperatorCandidate(
    command: Extract<ChatDecision, { kind: "decide_operator_candidate" }>,
  ): Promise<void>;
  operatorAuthorityContext(): Promise<
    import("../../../domain/work/dialogue.ts").ChatContext[
      "operatorAuthority"
    ]
  >;
  decideOperatorChange(
    command: Extract<ChatDecision, { kind: "decide_operator_change" }>,
  ): Promise<void>;
  readonly ports: {
    clock: ClockPort;
    agents: AgentPort;
    retainedTools?: RetainedToolsPort;
    execution?: NativeExecutionPort;
    stateHistory?: RuntimeStateHistoryPort;
    model: ConversationModelPort;
    information?: DecisionInformationPort;
    behaviors?: BehaviorInvocationPort;
    modelDiagnostics?: ModelDiagnosticsPort;
  };
  nativeCandidate(
    model: ExecutableModel,
    candidate: Candidate,
    stage: Stage,
  ): boolean;
  artifactEvidence(
    candidate: Candidate,
    model?: ExecutableModel,
  ): Promise<ArtifactEvidence>;
  isPrimaryOperator(model: ExecutableModel): boolean;
  budgetView(model: ExecutableModel): Promise<WorkBudgetView | undefined>;
  agentCall<T>(
    model: ExecutableModel,
    operation: WorkBudgetOperation,
    dispatch: () => Promise<T>,
  ): Promise<T>;
}

export interface ConversationProposalHost extends ConversationCaseHost {
  executeOperatorEvolution?(
    command:
      import("../../../domain/work/dialogue.ts").OperatorEvolutionCommand,
    model: ExecutableModel,
    source: Pick<ChatContext, "modelContext" | "modelSources">,
  ): Promise<
    import("../../../domain/work/dialogue.ts").OperatorEvolutionSummary
  >;
  readonly ports: { model: ConversationModelPort };
  /** The registered Main only (4.8d D4): a recipient Case's space. */
  readonly recipientSpaceFor?: (
    caseId: string,
    recipients: readonly string[],
  ) => Promise<string>;
  build(draft?: ToolDraft, resumeId?: string): Promise<void>;
  candidate(id: string): Candidate;
  proposeChange(
    decision: Extract<ChatDecision, {
      kind: "propose_mandate_change" | "propose_agent_creation";
    }>,
  ): Promise<
    void | {
      status: "pending" | "approved";
      changeId?: string;
      proposalIntentDigest?: string;
    }
  >;
  diagnosticAddresses(
    model: ExecutableModel,
    baseVersion: string,
    addresses: ModelDiagnosticAddress[] | undefined,
  ): Promise<{ addresses?: ModelDiagnosticAddress[] }>;
}

export interface ConversationInvocationHost extends ConversationCaseHost {
  readonly ports: {
    behaviors?: BehaviorInvocationPort;
    runner: ToolRunnerPort;
    artifactSources?: ArtifactSourceServicePort;
    retainedTools?: RetainedToolsPort;
    schemaValidator: SchemaValidationPort;
  };
  behaviorInvocation?: BehaviorInvocationRequest;
  invocationAdmission(
    decision: Extract<ChatDecision, { kind: "invoke_tool" }>,
    model: ExecutableModel,
  ): Promise<InvocationAdmission>;
  candidate(id: string): Candidate;
  nativeCandidate(
    model: ExecutableModel,
    candidate: Candidate,
    stage: Stage,
  ): boolean;
}

export interface ConversationObservationHost extends ConversationCaseHost {
  candidate(id: string): Candidate;
  observeToolFailure(failure: ToolFailure): Promise<void>;
}

/** All state writes and execution-reference scopes remain owned by the façade. */
export type ConversationTurnHost =
  & ConversationDecisionHost
  & ConversationProposalHost
  & ConversationInvocationHost
  & ConversationObservationHost
  & {
    withExecutionOrigin<T>(
      origin: {
        effectKey: string;
        inputMessageId: string;
        retained?: OperatorCommandOrigin;
      },
      effect: () => Promise<T>,
    ): Promise<T>;
    finishCase(outcome: "done" | "abandoned"): Promise<void>;
    action<T>(
      node: CompiledFlowNode,
      effect: (model: ExecutableModel) => Promise<T>,
      boundaryModel?: ExecutableModel,
    ): Promise<T>;
    suspendBudget(
      error: AgentBudgetWait,
      node: CompiledFlowNode,
      operation: WorkBudgetOperation,
    ): Promise<void>;
    executionReference(
      model: ExecutableModel,
      element?: { actionId?: string; edgeId?: string },
    ): ModelExecutionReference;
  };
