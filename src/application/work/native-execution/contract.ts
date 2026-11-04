import type {
  NativeObservationEmission,
  NativeObservationRecord,
} from "../../../domain/model/execution/native-observation.ts";
/** Framework-neutral execution of an admitted native flow. Business journals,
 * permissions and budgets remain owned by the supplied application handlers. */
import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  CompiledFlow,
  CompiledFlowNode,
  FlowActionResult,
  FlowExecutionEvent,
  FlowValues,
  OperatorExecutionProfile,
} from "../../../domain/model/execution/flow.ts";
import type { StateHistoryPort } from "../runtime/ports/out/state-history.port.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import type { EvolutionDossier } from "../../model/evolution/ports.ts";

export type NativeExecutionScope =
  | { kind: "request"; scopeId: string; rootRequestId: string }
  | { kind: "designer"; scopeId: string; ownerId: string };

export interface NativeExecutionIdentity {
  operatorId: string;
  /** Host-selected invocation key; not supplied by a provider or client. */
  invocationKey: string;
  scope: NativeExecutionScope;
  /** Separate promotion subthreads retain the same operator and Request. */
  purpose: "conversation" | "promotion";
  subjectId?: string;
}

export interface NativeExecutionContribution {
  /** Authenticated canonical business message or command receipt. */
  id: string;
  kind: "input" | "resume";
  inputMessageId?: string;
  networkAdoptionContinuation?: RequestNetworkContinuation;
  networkRefusalContinuation?: RequestNetworkRefusalContinuation;
  teamAdoptionContinuation?: RequestTeamContinuation;
  teamRefusalContinuation?: RequestTeamRefusalContinuation;
}

/** Host evidence attached only after the proposal effect has completed. */
export interface NativeChangeApprovalWait {
  version: 1;
  identity: NativeExecutionIdentity;
  contributionId: string;
  inputMessageId: string;
  modelDigest: string;
  repositoryVersion: string;
  flowRootId: string;
  flowOccurrenceId: string;
  nodeId: string;
  actionId: string;
  effectKey: string;
  changeId: string;
  proposalIntentDigest: string;
}

/** Native input selected for an invocation, carried to the durable start fence. */
export interface NativeEffectTarget {
  kind: "invocation";
  admitted: boolean;
  toolId: string | null;
  behaviorId: string | null;
  retainedTool?: {
    resourceId: string;
    descriptorDigest: string;
    toolId: string;
    toolDigest: string;
  };
}

/** Only a separated pre-dispatch admission callback may produce this outcome. */
export class NativeExecutionAdmissionRefused extends Error {
  constructor(readonly code: string, readonly nodeId: string, message: string) {
    super(message);
    this.name = "NativeExecutionAdmissionRefused";
  }
}

export type ImmutableConsultationJson =
  | null
  | boolean
  | number
  | string
  | ImmutableConsultationJson[]
  | { [key: string]: ImmutableConsultationJson };

/** Immutable membership is registered before dispatch. Digests cover the complete
 * canonical manifest, including order, arguments, scope, pins and reservations. */
export interface ImmutableConsultationGroupMember {
  ordinal: number;
  callId: string;
  effectKey: string;
  argumentsDigest: string;
  choice: Extract<
    import("../conversation/chat-decision.ts").ChatDecision,
    { kind: "consult_model" }
  >;
  request: Record<string, ImmutableConsultationJson> & {
    operation: "search" | "inspect" | "references" | "query";
    version: string;
  };
  responseCharacters: number;
  flowStepOrdinal: number;
}

export interface ImmutableConsultationGroupManifest {
  groupId: string;
  manifestDigest: string;
  runId: string;
  occurrenceId: string;
  batchId: string;
  firstOrdinal: number;
  identity: NativeExecutionIdentity;
  contribution: NativeExecutionContribution;
  businessRevision: RuntimeRevisionReference;
  executionPin: { modelDigest: string; repositoryVersion?: string };
  /** Resolve digest through the host source port before registration; a version alone is insufficient. */
  sourcePin: { version: string; digest: string };
  members:
    | readonly [ImmutableConsultationGroupMember]
    | readonly [
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
    ]
    | readonly [
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
    ]
    | readonly [
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
      ImmutableConsultationGroupMember,
    ];
  limits: { responseCharacters: number; flowSteps: number };
}

/** A terminal receipt is staged, never directly published by a worker. */
export interface ImmutableConsultationMemberOutcome {
  groupId: string;
  callId: string;
  effectKey: string;
  argumentsDigest: string;
  result: import("../conversation/chat-decision.ts").ChatCallResult;
  messages: import("../runtime/state.ts").Message[];
  events: import("../runtime/state.ts").Event[];
}

export interface ImmutableConsultationGroupPublication {
  groupId: string;
  manifestDigest: string;
  publicationDigest: string;
  /** Ordered member identities and receipt digests included in the canonical save. */
  members: Array<{ callId: string; effectKey: string; receiptDigest: string }>;
  businessRevision: RuntimeRevisionReference;
}

/** Narrow group-only ledger contract; scalar effects remain fail-closed.
 * Implementations fence every call, compare exact membership and reject unknown
 * started receipts. Duplicate identical registration, receipt or publication
 * returns the stored value; conflicting replay refuses. Registration and member
 * admission revalidate the session identity, pins, membership and reservations.
 * A member effect must never run inside a scalar parent effect: the latter
 * would be an unsettled effect and correctly block group admission. */
export interface ImmutableConsultationGroupSession {
  register(
    manifest: ImmutableConsultationGroupManifest,
  ): Promise<ImmutableConsultationGroupManifest>;
  /** Propagate this exact group's claim/epoch/checkpoint fence into canonical CAS writes. */
  withPublicationFence<T>(
    groupId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  memberEffect(
    groupId: string,
    member: ImmutableConsultationGroupMember,
    node: CompiledFlowNode,
    operation: () => Promise<ImmutableConsultationMemberOutcome>,
    admit?: () => Promise<void>,
  ): Promise<ImmutableConsultationMemberOutcome>;
  publish(
    publication: ImmutableConsultationGroupPublication,
  ): Promise<ImmutableConsultationGroupPublication>;
  /** Includes registered groups awaiting publication, even when all members settled. */
  pending(): Promise<ImmutableConsultationGroupManifest[]>;
}

/** Completed declared-read result, never an admission or a provider reply.
 * Its enclosing durable snapshot binds it to the selected input checkpoint. */
export interface NativeDeclaredConsultationRefusal {
  version: 1;
  identity: NativeExecutionIdentity;
  contributionId: string;
  inputMessageId: string;
  modelDigest: string;
  repositoryVersion: string;
  flowRootId: string;
  flowOccurrenceId: string;
  nodeId: string;
  actionId: string;
  effectKey: string;
  code: string;
}

export interface NativeExecutionSnapshot {
  /** Durable predecessor identity required for budget continuation planning. */
  runId?: string;
  checkpointNamespace?: string;
  /** Recomputed selected preparation; a projection, not an effect receipt. */
  budgetContinuationSource?: {
    sourceKind: "settled-budget-wait" | "unconsumed-input-wait";
    occurrenceId: string;
    preparedNodeId: string;
    settledEffectKey: string;
  };
  /** Verified official scalar proposal input and its completed effect receipt. */
  scalarBudgetProposal?: {
    decisionDigest: string;
    draftDigest: string;
    childSubjectId: string;
    effectResultDigest: string;
  };
  /** Exact settled initial admission projection; ledger still verifies tuple and receipt. */
  initialAdmissionSource?: {
    occurrenceId: string;
    actionId: string;
    preparedNodeId: string;
    settledEffectKey: string;
  };
  contributionId: string;
  identity: NativeExecutionIdentity;
  threadId: string;
  modelDigest: string;
  repositoryVersion?: string;
  flowRootId: string;
  status:
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "uncertain"
    | "advancing"
    | "refused";
  checkpointId?: string;
  refusal?: { code: string; nodeId: string; message: string };
  waits: Array<{
    nodeId: string;
    mechanism?: string;
    kind: "input" | "budget" | "decision" | "contribution";
  }>;
  /** Business effect receipts, not a graph output cache. */
  unsettledEffects: string[];
  /** Registered groups remain open until canonical publication is acknowledged. */
  openImmutableConsultationGroups?: string[];
  pendingContributions: string[];
  /** Bounded handler outcome needed by the calling use case after replay. */
  localState?: FlowValues;
}

export interface NativeExecutionRequest {
  networkRefusalContinuation?: RequestNetworkRefusalContinuation;
  /** Host-reconstructed receipt for one approved Request continuation. */
  networkAdoptionContinuation?: RequestNetworkContinuation;
  teamRefusalContinuation?: RequestTeamRefusalContinuation;
  teamAdoptionContinuation?: RequestTeamContinuation;
  /** Explicit cross-thread initial admission only; never resolved by subject. */
  initialAdmissionTransfer?:
    import("../../../domain/work/records/candidates.ts").InitialToolAdmissionTransfer;
  businessRevision: RuntimeRevisionReference;
  identity: NativeExecutionIdentity;
  contribution: NativeExecutionContribution;
  model: ExecutableModel;
  flow: CompiledFlow;
  maxSteps: number;
}

export interface RequestNetworkContinuation {
  readonly commandId: string;
  readonly receiptDigest: string;
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly predecessorThreadId: string;
  readonly checkpointId: string;
  readonly successorThreadId: string;
  readonly originalInputMessageId: string;
}

/** The team twin (4.8e E4): same exact shape, its own delivery lineage. */
export interface RequestTeamContinuation {
  readonly commandId: string;
  readonly receiptDigest: string;
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly predecessorThreadId: string;
  readonly checkpointId: string;
  readonly successorThreadId: string;
  readonly originalInputMessageId: string;
}
export interface RequestTeamRefusalContinuation {
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly decisionDigest: string;
  readonly threadId: string;
  readonly checkpointId: string;
  readonly originalInputMessageId: string;
}

/** The exact recorded human refusal and the original same-thread wait. */
export interface RequestNetworkRefusalContinuation {
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly decisionDigest: string;
  readonly threadId: string;
  readonly checkpointId: string;
  readonly originalInputMessageId: string;
}

export function parseRequestTeamRefusalContinuation(
  input: unknown,
): RequestTeamRefusalContinuation {
  return parseRequestNetworkRefusalContinuation(
    input,
  ) as unknown as RequestTeamRefusalContinuation;
}

export function parseRequestNetworkRefusalContinuation(
  input: unknown,
): RequestNetworkRefusalContinuation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid Request network refusal continuation");
  }
  const value = structuredClone(input) as Record<string, unknown>;
  const keys = [
    "changeId",
    "checkpointId",
    "decisionDigest",
    "originalInputMessageId",
    "proposalIntentDigest",
    "threadId",
  ];
  if (
    Object.keys(value).sort().join(",") !== keys.join(",") ||
    keys.some((key) =>
      typeof value[key] !== "string" || !(value[key] as string).trim() ||
      (value[key] as string).length > 512 ||
      // Exact refusal identifiers intentionally reject control characters.
      // deno-lint-ignore no-control-regex
      /[\x00-\x1f\x7f]/.test(value[key] as string)
    ) ||
    !isSha256Hex(value.decisionDigest) ||
    !isSha256Hex(value.proposalIntentDigest)
  ) throw new Error("Invalid Request network refusal continuation");
  return value as unknown as RequestNetworkRefusalContinuation;
}

export function parseRequestTeamContinuation(
  input: unknown,
): RequestTeamContinuation {
  return parseRequestNetworkContinuation(
    input,
  ) as unknown as RequestTeamContinuation;
}

export function parseRequestNetworkContinuation(
  input: unknown,
): RequestNetworkContinuation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid Request network continuation");
  }
  const value = structuredClone(input) as Record<string, unknown>;
  const keys = [
    "changeId",
    "checkpointId",
    "commandId",
    "originalInputMessageId",
    "predecessorThreadId",
    "proposalIntentDigest",
    "receiptDigest",
    "successorThreadId",
  ];
  if (
    Object.keys(value).sort().join(",") !== keys.join(",") ||
    keys.some((key) =>
      typeof value[key] !== "string" || !(value[key] as string).trim() ||
      (value[key] as string).length > 512 ||
      // Exact continuation identifiers intentionally reject control characters.
      // deno-lint-ignore no-control-regex
      /[\x00-\x1f\x7f]/.test(value[key] as string)
    ) ||
    !isSha256Hex(value.receiptDigest) ||
    !isSha256Hex(value.proposalIntentDigest) ||
    value.predecessorThreadId === value.successorThreadId
  ) throw new Error("Invalid Request network continuation");
  return value as unknown as RequestNetworkContinuation;
}

export interface NativeExecutionAction {
  effectKey: string;
  contributionId: string;
  inputMessageId?: string;
  /** Framework resume is authenticated before it reaches a business primitive. */
  resumed: boolean;
  localState: FlowValues;
}

export interface NativeExecutionActionResult extends FlowActionResult {
  suspensionKind?: "budget" | "decision" | "contribution";
  modelAdvance?: NativeModelAdvanceEvidence;
  /** Small contribution-local handler data; never canonical business state. */
  localState?: FlowValues;
}

/** Application-owned planning, isolated reads and idempotent business publication.
 * Plan resolves source pins and deterministic reservations without business effects.
 * Execute stages a terminal known outcome; publish revalidates current authority
 * and saves each result exactly once before returning its ledger receipt. */
export interface NativeImmutableConsultationHandlers {
  plan(
    node: CompiledFlowNode,
    inputs: FlowValues,
    values: FlowValues,
    context: {
      request: NativeExecutionRequest;
      runId: string;
      action: NativeExecutionAction;
      step: number;
      segmentStep: number;
    },
  ): Promise<ImmutableConsultationGroupManifest | undefined>;
  execute(
    manifest: ImmutableConsultationGroupManifest,
    member: ImmutableConsultationGroupMember,
  ): Promise<ImmutableConsultationMemberOutcome>;
  publish(
    manifest: ImmutableConsultationGroupManifest,
    outcomes: ImmutableConsultationMemberOutcome[],
  ): Promise<{
    publication: ImmutableConsultationGroupPublication;
    action: NativeExecutionActionResult;
  }>;
}

export interface NativeExecutionHandlers {
  immutableConsultations?: NativeImmutableConsultationHandlers;
  /** Called before each node and again before an interrupted node resumes. */
  assertBoundary(node: CompiledFlowNode): Promise<void>;
  handle(
    node: CompiledFlowNode,
    inputs: FlowValues,
    values: FlowValues,
    execution: NativeExecutionAction,
  ): Promise<NativeExecutionActionResult>;
  onEvent(event: FlowExecutionEvent): Promise<void>;
  /** Restore the selected run's verified historical observations into a local
   * projection buffer only. Must not write business state, execute effects or
   * grant authority; completed runs have no new execution selection fence. */
  recoverEvents?(
    events: readonly {
      event: FlowExecutionEvent;
      firstRecordedAt: string;
    }[],
  ): Promise<void>;
  /** Hydrate exact immutable business revisions without checkpoint duplication. */
  resolveValues?(values: FlowValues): Promise<FlowValues>;
  /** An already decided batch may drain without demanding phantom user input. */
  shouldAwait?(): boolean | Promise<boolean>;
  pendingContributions?(): string[];
  readAdoptedModel?(): Promise<ExecutableModel>;
  modelAdvanced?(model: ExecutableModel): Promise<void>;
  /** Called after durable successor selection, never after the business effect. */
  continuationSelected?(receipt: NativeContinuationReceipt): Promise<void>;
}

export interface NativeModelPin {
  identity: ExecutableModel["identity"];
  version: ExecutableModel["version"];
}

export interface NativeExecutionModelPin extends NativeModelPin {
  rootNativeId: string;
  rootOccurrenceId: string;
  executionProfile?: OperatorExecutionProfile;
}

export interface ResolvedOperatorScope {
  projectId: string;
  systemId: string;
  executionSpaceId: string;
  caseId?: string;
}

interface NativeModelAdvanceBase {
  businessRevision: RuntimeRevisionReference;
  from: NativeModelPin;
  to: NativeModelPin;
}

/** A catalog publication admits exactly one tool; the owned contract is unchanged. */
export interface NativeCatalogAdvanceEvidence extends NativeModelAdvanceBase {
  kind: "verified-catalog-advance";
  publicationEventId: string;
  candidateId: string;
  candidateDigest: string;
  unchangedContractDigest: string;
}

/** An approved mandate change advanced the pin; the resumed native flows are unchanged. */
export interface NativeMandateAdvanceEvidence extends NativeModelAdvanceBase {
  kind: "verified-mandate-advance";
  changeId: string;
  decidedAt: string;
  flowContractDigest: string;
}

/** A creator's own team publication, decided under its admitted creation grant
 * inside its originating Request, advanced the pin mid-turn; flows unchanged. */
export interface NativeTeamAdvanceEvidence extends NativeModelAdvanceBase {
  kind: "verified-team-advance";
  changeId: string;
  caseId: string;
  decidedAt: string;
  flowContractDigest: string;
}

export interface NativeBudgetCeilingAdvanceEvidence
  extends NativeModelAdvanceBase {
  kind: "verified-budget-ceiling-advance";
  transitionId: string;
  manifestDigest: string;
  authorizationEventId: string;
  memberId: string;
  unchangedContractDigest: string;
  budget: {
    scopeId: string;
    ownerId: string;
    originRevision: number;
    originDigest: string;
    policyRevision: number;
    policyDigest: string;
    refusedAttemptId: string;
  };
  originalContributionId: string;
  originalInputMessageId: string;
  resume: NativeExecutionContribution;
}

export type NativeModelAdvanceEvidence =
  | NativeCatalogAdvanceEvidence
  | NativeMandateAdvanceEvidence
  | NativeTeamAdvanceEvidence
  | NativeBudgetCeilingAdvanceEvidence;

export interface NativeContinuationReceipt {
  id: string;
  predecessorRunId: string;
  source: {
    threadId: string;
    checkpointNamespace: string;
    checkpointId: string;
    preparedNodeId: string;
    settledEffectKey: string;
  };
  evidence: NativeModelAdvanceEvidence;
  successorRunId: string;
}

export interface NativeScopeClosure {
  kind: "closed-case";
  businessRevision: RuntimeRevisionReference;
  caseId: string;
  status: "closed-done" | "closed-abandoned";
  closedAt: string;
}

export type NativeThreadAdvanceAuthorization =
  | {
    kind: "software-evolution-scoped-adoption";
    dossierId: string;
    intentDigest: string;
    proposalDigest: string;
    businessRevision: RuntimeRevisionReference;
    authorizationEventId: string;
    adoptionAuthorization: NonNullable<
      EvolutionDossier["adoptionAuthorization"]
    >;
  }
  | {
    kind: "evolution-adoption";
    dossierId: string;
    adoptionAuthorization: NonNullable<
      EvolutionDossier["adoptionAuthorization"]
    >;
  }
  | {
    kind: "owner-adoption";
    businessRevision: RuntimeRevisionReference;
    authorizationEventId: string;
    network?:
      import("../../model/evolution/request-adoption-ports.ts").RequestNetworkAdoptionProof;
    networkCompatibilityDigest?: string;
    creationPolicy?:
      import("../../model/evolution/request-adoption-ports.ts").RequestCreationPolicyAdoptionProof;
    creationPolicyCompatibilityDigest?: string;
    networkCheckpointDigest?: string;
    team?:
      import("../../model/evolution/request-adoption-ports.ts").RequestTeamAdoptionProof;
    teamCompatibilityDigest?: string;
    teamCheckpointDigest?: string;
  };

/** Read only one selected current run; neither selector grants execution. */
export interface NativeExecutionSelection {
  threadId: string;
  contributionId: string;
}

export interface NativeExecutionPort {
  /** Run one durable contribution. Only this adapter advances the native graph. */
  run(
    request: NativeExecutionRequest,
    handlers: NativeExecutionHandlers,
  ): Promise<NativeExecutionSnapshot>;
  closeScope(
    snapshot: NativeExecutionSnapshot,
    closure: NativeScopeClosure,
  ): Promise<void>;
  /** All scopes, including parked Request and promotion threads. */
  inspect(
    operatorId: string,
    selection?: NativeExecutionSelection,
  ): Promise<NativeExecutionSnapshot[]>;
  /** Prove one nonterminal native contribution belongs to the current claimed
   * recovery delivery. False never authorizes opening another origin. */
  ownsCandidateRecoveryContribution?(input: {
    snapshot: NativeExecutionSnapshot;
    acceptedDigest: string;
  }): Promise<boolean>;
  /** Explicit safe-boundary adoption retires only verified empty input waits. */
  retireAndAdvance(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ): Promise<void>;
}

export type RuntimeStateHistoryPort = Pick<StateHistoryPort, "loadRevision">;

export interface RuntimeRevisionReference {
  __assemblyRuntimeRevision: {
    systemId: string;
    operatorId: string;
    invocationKey?: string;
    revision: number;
    modelDigest: string;
  };
}

export function runtimeRevisionReference(
  state: SystemRuntimeState,
): RuntimeRevisionReference {
  if (!state.executionModel) {
    throw new Error(
      "Business revision reference requires an admitted operator",
    );
  }
  return {
    __assemblyRuntimeRevision: {
      systemId: state.id,
      operatorId: state.executionModel.identity.builderId,
      ...(state.caseInvocation
        ? { invocationKey: invocationKey(state.caseInvocation) }
        : {}),
      revision: state.revision,
      modelDigest: state.executionModel.version.digest,
    },
  };
}

/** Resolve only accepted immutable revisions in the current operator's store.
 * This is a technical checkpoint representation, never an information grant. */
export async function hydrateRuntimeValues(
  values: FlowValues,
  history: RuntimeStateHistoryPort,
  identity: NativeExecutionIdentity,
): Promise<FlowValues> {
  const revisions = new Map<string, Promise<FlowValues>>();
  async function hydrate(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return await Promise.all(value.map(hydrate));
    if (!value || typeof value !== "object") return value;
    const ref = (value as RuntimeRevisionReference).__assemblyRuntimeRevision;
    if (ref) {
      if (
        Object.keys(value).length !== 1 ||
        ref.operatorId !== identity.operatorId ||
        ref.invocationKey !== identity.invocationKey ||
        !Number.isSafeInteger(ref.revision)
      ) {
        throw new Error("Business checkpoint reference scope mismatch");
      }
      const key = JSON.stringify(ref);
      let accepted = revisions.get(key);
      if (!accepted) {
        accepted = (async () => {
          const state = await history.loadRevision(ref.revision);
          if (
            !state || state.id !== ref.systemId ||
            state.revision !== ref.revision ||
            state.executionModel?.identity.builderId !== ref.operatorId ||
            state.executionModel.version.digest !== ref.modelDigest ||
            !state.caseInvocation ||
            invocationKey(state.caseInvocation) !== ref.invocationKey
          ) {
            throw new Error(
              "Exact accepted business checkpoint revision is unavailable",
            );
          }
          // References never recursively hydrate historical private checkpoints.
          const {
            conversationContext: _context,
            conversationCursor: _cursor,
            conversationFlow: _flow,
            invocationContinuations: _continuations,
            changeWorkContinuations: _changes,
            conversationBatches: _batches,
            activeBatchCall: _active,
            ...record
          } = state;
          return { ...record, sessionId: state.id };
        })();
        revisions.set(key, accepted);
      }
      return await accepted;
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async (
          [key, item],
        ) => [key, await hydrate(item)]),
      ),
    );
  }
  return await hydrate(values) as FlowValues;
}

/** Capture scope from admitted host state, never infer designer from no Case. */
export function nativeExecutionIdentity(
  state: SystemRuntimeState,
  purpose: NativeExecutionIdentity["purpose"],
  subjectId?: string,
): NativeExecutionIdentity {
  if (!state.executionModel || !state.caseInvocation) {
    throw new Error("Native execution requires an admitted invocation scope");
  }
  const request = caseExecutionContext(state);
  const designer = designerExecutionContext(state);
  const scope: NativeExecutionScope = request
    ? {
      kind: "request",
      scopeId: request.caseId,
      rootRequestId: request.caseId,
    }
    : designer
    ? { kind: "designer", scopeId: designer.scopeId, ownerId: designer.ownerId }
    : (() => {
      throw new Error("Native execution scope is unavailable");
    })();
  return {
    operatorId: state.executionModel.identity.builderId,
    invocationKey: invocationKey(state.caseInvocation),
    scope,
    purpose,
    ...(subjectId ? { subjectId } : {}),
  };
}

export function nativeExecutionContribution(
  state: SystemRuntimeState,
  kind: NativeExecutionContribution["kind"] = "input",
): NativeExecutionContribution {
  if (!state.caseInvocation) {
    throw new Error("Native contribution has no scope");
  }
  const message = invocationInput(state, state.caseInvocation);
  if (!message?.id) {
    throw new Error("Native contribution has no authenticated input receipt");
  }
  return { id: message.id, kind, inputMessageId: message.id };
}

/** Mandatory awaited journal on every production execution session. A missing
 * journal or a persistence error refuses; nothing falls back to logging, a
 * business event, or dropping the detail. */
export interface NativeObservationJournal {
  append(
    emission: NativeObservationEmission,
  ): Promise<NativeObservationRecord>;
  /** Only this session's run, ordered by emission step, phase and ordinal. */
  read(): Promise<NativeObservationRecord[]>;
}
