import type { RunnableTool } from "../tools/active-tools.ts";
import type {
  ApprovedChangePublication,
  ChangePublication,
} from "../../../domain/model/publication/change.ts";
import type {
  AdmissionContext,
  Candidate,
  ModelBinding,
  PageResult,
  ReviewContext,
  ReviewDecision,
  TestReport,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type {
  ChatContext,
  ChatDecision,
  ChatDecisionBatch,
  ModelIdentity,
  ModelRevisionProposal,
  ModelRevisionRequest,
  ModelSourceProposalStatus,
  ModelSourceRevision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type {
  NetworkScope,
  SystemConfiguration,
} from "../../../domain/governance/records/system-configuration.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import type { ModelDelegationRequest } from "../../../domain/governance/records/model-delegation-request.ts";
import type { ModelDiagnostic } from "../../../domain/model/policies/diagnostics.ts";
import {
  type CreationScope,
  mainCreationScope,
} from "../../../domain/governance/policies/operator-creation-policy.ts";

/** Instance-aware lint observations; they never grant or deny execution authority. */
export interface ModelDiagnosticsPort {
  read(
    model: ExecutableModel,
    /** Immutable source base to validate proposal addresses, independent of HEAD. */
    version?: string,
  ): Promise<readonly (ModelDiagnostic & { masked: boolean })[]>;
}

export interface AgentPort {
  readonly label: string;
  /** Prepare once before reserving budget; may refuse with AgentPreparationError.
   * The returned closure alone performs provider dispatch and result validation. */
  prepareDecision?(
    context: ChatContext,
    batch: false,
  ): Promise<() => Promise<ChatDecision>>;
  prepareDecision?(
    context: ChatContext,
    batch: true,
  ): Promise<() => Promise<ChatDecisionBatch>>;
  decide(context: ChatContext): Promise<ChatDecision>;
  /** Optional correlated transport; legacy single-choice agents remain supported. */
  decideBatch?(context: ChatContext): Promise<ChatDecisionBatch>;
  review(
    candidate: Candidate,
    tests: TestReport,
    context?: ReviewContext,
  ): Promise<ReviewDecision>;
  admit?(
    candidate: Candidate,
    tests: TestReport,
    context: AdmissionContext,
  ): Promise<ReviewDecision>;
}
export interface StorePort {
  load(): Promise<SystemRuntimeState | null>;
  save(
    state: SystemRuntimeState,
    expectedRevision: number | null,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface ToolRunnerPort {
  test(draft: ToolDraft): Promise<TestReport>;
  run(
    candidate: RunnableTool,
    input: { url: string },
    policy?: NetworkScope,
  ): Promise<PageResult>;
}
/**
 * The explicit creation scope of a runtime bound to this model port: a
 * Request-space port reads creation in its branch with the whole-team
 * size it recorded at handle open; any other port reads it in main. The
 * domain validates the scope where it is read.
 */
export function creationScopeOf(
  port: Pick<ModelPort, "requestChangeScope">,
  identity: Pick<ModelIdentity, "projectId" | "systemId">,
): CreationScope {
  const scoped = port.requestChangeScope;
  if (!scoped) return mainCreationScope(identity);
  return {
    space: {
      projectId: identity.projectId,
      systemId: identity.systemId,
      executionSpaceId: scoped.executionSpaceId,
    },
    branchTeamSize: scoped.branchTeamSize,
  };
}

export interface ModelPort {
  /** Scoped publications are completed by the Request coordinator, never generic adopt/recovery. */
  readonly requestChangeScope?: {
    readonly caseId: string;
    readonly operatorId: string;
    /** Branch space and whole-team size at handle open, for creation reads. */
    readonly executionSpaceId: string;
    readonly branchTeamSize: number;
  };
  /** Compile actual model values, bindings and flows, never host expectations. */
  readExecutableModel(
    identity: ModelIdentity,
    repositoryVersion?: string,
  ): Promise<ExecutableModel>;
  /** Prepare the exact source diff with the required Toolkit. */
  previewApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
  ): Promise<
    import("../../../domain/governance/operator-authority.ts").PreparedChangeDiff
  >;
  /** Apply an exact admitted source edit and return the compiled readback. */
  applyApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
    publication: ChangePublication,
  ): Promise<ExecutableModel>;
  /** Recover the exact host publication after an interrupted approved change. */
  findApprovedChange?(
    identity: ModelIdentity,
    changeId: string,
  ): Promise<ApprovedChangePublication | null>;
  readSourceRevision?(identity: ModelIdentity): Promise<ModelSourceRevision>;
  /** Native status metadata for proposals authored by this exact operator only. */
  readSourceProposals?(
    identity: ModelIdentity,
  ): Promise<ModelSourceProposalStatus[]>;
  proposeRevision?(
    identity: ModelIdentity,
    request: ModelRevisionRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal>;
  /** Required source editor; an edit creates a proposal, never an admission. */
  proposeEdit(
    identity: ModelIdentity,
    request: ModelEditRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal>;
  /** A bounded grant/revocation proposal; never direct admission or activation. */
  proposeDelegation?(
    identity: ModelIdentity,
    request: ModelDelegationRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal>;
  initialize(
    existing?: ModelIdentity,
    configuration?: SystemConfiguration,
  ): Promise<ModelIdentity>;
  /** Verify the native projection before runtime authority is committed. */
  syncConfiguration?(
    identity: ModelIdentity,
    configuration: SystemConfiguration,
  ): Promise<ModelIdentity>;
  /** Publish the admitted candidate once; retries return its exact active binding.
   * The publication is pinned to `admittedModelDigest`, the contract under which
   * tests, review and admission were made. An exact active entry is returned
   * unchanged for any digest; otherwise a different HEAD digest, whatever the
   * authority, is refused with the coded error ADMITTED_MODEL_CHANGED. */
  activateCandidate(
    identity: ModelIdentity,
    candidate: Candidate,
    admittedModelDigest: string,
  ): Promise<ModelBinding>;
  findCandidate?(
    identity: ModelIdentity,
    candidate: Candidate,
  ): Promise<ModelBinding | null>;
  graph(identity: ModelIdentity): Promise<unknown>;
}

/** Time is supplied by the host, including Case creation and closure. */
export interface ClockPort {
  now(): string;
}

/** Bound by the workspace registry; never exposed as an external command. */
export interface TaskSourceInputPort {
  verify(input: {
    context:
      import("../../../domain/work/execution/modeled-behavior.ts").CaseExecutionContext;
    inputs:
      import("../../../domain/work/task-source-input.ts").TaskSourceInput[];
  }): Promise<boolean>;
}

/** Bound by the trusted workspace, separate from native model transport. */
export interface OperatorEvolutionCommandPort {
  context(model: ExecutableModel): Promise<ChatContext["operatorEvolution"]>;
  execute(
    command:
      import("../../../domain/work/dialogue.ts").OperatorEvolutionCommand,
    model: ExecutableModel,
    source: Pick<ChatContext, "modelContext" | "modelSources">,
    native?: { effectKey: string; inputMessageId: string },
  ): Promise<
    import("../../../domain/work/dialogue.ts").OperatorEvolutionSummary
  >;
}
