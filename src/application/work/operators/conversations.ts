import {
  operatorTeamInRequest,
  type VerifiedRequestTeam,
} from "../../../domain/work/request-spaces.ts";
import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
/**
 * Supports APE 4.1 Operator Identity & Mandate and 4.2 Centralized Supervision
 * with separate conversations and admitted links. A work receipt does not establish
 * 4.4 Acknowledged Handoff.
 */
import {
  type AgentConversation,
  type AgentMessageCommand,
  type ConversationsSnapshot,
  MAX_OPERATOR_UNITS,
  MAX_USER_MESSAGE_CHARS,
  type OperatorToolsSnapshot,
} from "../../../domain/work/records/conversations.ts";
import type {
  ExecutableModel,
} from "../../../domain/model/execution/executable-model.ts";
import type { NativeToolContract } from "../../../domain/work/candidates.ts";
import type { AuthorityExercise } from "../../../domain/governance/authority.ts";
import type { CandidateDelegatedActor } from "../../../domain/governance/policies/tool-admission-policy.ts";
import {
  CandidateActivationError,
  hasActivationIntent,
} from "../../../domain/work/policies/candidate-activation.ts";
import type {
  BehaviorInvocationRequest,
  CaseExecutionContext,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import { sameCaseIdentity } from "../../../domain/work/execution/case-context.ts";
import type {
  ArtifactEvidence,
  ChatDecision,
  Message,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { effectiveModelUpdates } from "../../../domain/work/records/effective-model-update.ts";
import { networkScopeFor } from "../../../domain/governance/policies/network-policy.ts";
import {
  candidateCaseInvocation,
  changeCaseInvocation,
  invocationInput,
  invocationKey,
  isInitializationAdmission,
  operatorWorkFingerprint,
  recordedOperatorWork,
  workReceipt,
} from "./journal.ts";
import { type OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";
import {
  caseExecutionContext,
  delegatedCaseContext,
  designerExecutionContext,
  humanRequestCase,
} from "../cases/runtime.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import type { DelegatedActor } from "../../../domain/governance/policies/operator-authority-policy.ts";
import type { SkillStorePort } from "../../skills/ports.ts";
import {
  type AcceptedOperatorCommand,
  type OperatorCommandOrigin,
  type OperatorControlCommand,
  recordedCommandOutcome,
} from "./command-delivery.ts";

export class OperatorConversationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly context?: Record<string, string>,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = "OperatorConversationError";
  }
}

/** The application composes existing conversational engines through this port. */
/** An accepted work whose delivery has not settled: waiting, with no result. */
function acceptedWork(
  agentId: string,
  correlationId: string,
  proof: OperatorWorkAdmission,
  target: SystemRuntimeState,
): OperatorWorkResult {
  return {
    ...(proof.caseId ? { caseId: proof.caseId } : {}),
    agentId,
    correlationId,
    invocationId: proof.invocationId,
    status: "waiting",
    revision: target.revision,
    modelVersion: {
      digest: target.executionModel!.version.digest,
      repositoryVersion: target.executionModel!.version.repositoryVersion!,
    },
    messages: [],
    candidateIds: [],
  };
}

export interface ConversationRuntime {
  readonly snapshot: SystemRuntimeState;
  currentExecutionOrigin?():
    | import("./command-delivery.ts").OperatorCommandOrigin
    | undefined;
  onState(listener: (state: SystemRuntimeState) => void): () => void;
  submit(
    text: string,
    work?: OperatorWorkReceipt,
    caseId?: string,
    newConversation?: true,
  ): Promise<string | void>;
  refreshCaseContext?(
    context: CaseExecutionContext,
    candidateId?: string,
    changeId?: string,
  ): Promise<void>;
  restoreCaseInvocation?(
    invocation: NonNullable<SystemRuntimeState["caseInvocation"]>,
  ): Promise<void>;
  submitWork?(input: OperatorWorkContribution): Promise<void>;
  /** Observation for this operator; never a decision (4.8e E6). */
  receiveOperatorNotice?(
    notice:
      import("../../../domain/governance/operator-authority.ts").OperatorNotice,
    origin: import("../../../domain/work/entities/cases.ts").Case["openedFrom"],
    delivery?: { wake: boolean },
  ): Promise<void>;
  /** Whether a journalled work's accepted delivery still runs (queued or in
   * progress, including a decision's resume of it). */
  workDeliveryLive?(callerId: string, correlationId: string): Promise<boolean>;
  enqueueContinuation?(
    input: {
      id: string;
      invocationKey: string;
      inputMessageId: string;
      sourceOperatorId: string;
      sourceCompletionId: string;
      completedInvocationId?: string;
      completionStatus?: "completed" | "failed";
      observation?: unknown;
    },
  ): Promise<void>;
  hasAcceptedLegacyCommandNotification?(
    accepted: AcceptedOperatorCommand,
  ): Promise<boolean>;
  processAcceptedContribution?(
    delivery: import("./execution.ts").OperatorExecutionDelivery,
  ): Promise<void>;
  resumeOperatorCommand?(
    command: OperatorControlCommand,
    origin: OperatorCommandOrigin,
  ): Promise<boolean>;
  decideCandidate?(
    input: Omit<OperatorCandidateDecision, "agentId" | "expectedRevision">,
    delegated?: CandidateDelegatedActor,
    origin?: OperatorCommandOrigin,
  ): Promise<void>;
  inspectCandidate?(
    input: { candidateId: string; candidateDigest: string; caseId: string },
    delegated: CandidateDelegatedActor,
  ): Promise<CandidateInspection>;
  resumeDecidedChanges?(options?: { candidatesOnly?: boolean }): Promise<void>;
  enqueueCandidateContinuation?(candidateId: string): Promise<void>;
  settleDelegatedCandidateActivations?(
    input: { caseId: string; abandon?: boolean; closed?: boolean },
  ): Promise<void>;
  decideChange?(
    input: {
      changeId: string;
      expectedRevision: number;
      verdict: "approve" | "refuse";
    },
    delegated?: DelegatedActor,
    origin?: OperatorCommandOrigin,
  ): Promise<void>;
  idle(): Promise<void>;
}

/** Human admission is separate from the right to address an operator's inbox. */
export interface OperatorCandidateDecision {
  agentId: string;
  candidateId: string;
  candidateDigest: string;
  expectedRevision: number;
  verdict: "approve" | "refuse";
  reason: string;
  /** Required for host-bound delegated admission; local human callers retain their contract. */
  caseId?: string;
}

/** Exact bounded data, never instructions or another operator's conversation. */
export interface CandidateInspection {
  operatorId: string;
  candidate: Pick<
    Candidate,
    | "id"
    | "name"
    | "description"
    | "kind"
    | "code"
    | "digest"
    | "caseId"
    | "stage"
    | "baseCatalogRevision"
    | "requiredAuthority"
    | "tests"
  >;
  contract: NativeToolContract;
  authorityExercise: AuthorityExercise;
}

export interface MainCandidateInspection extends CandidateInspection {
  /** Use the observed revision after a possible central Request refresh. */
  decisionReference: Omit<
    Extract<ChatDecision, { kind: "inspect_operator_candidate" }>,
    "kind" | "text"
  >;
}

export interface OperatorChangeDecision {
  agentId: string;
  changeId: string;
  expectedRevision: number;
  configurationRevision: number;
  verdict: "approve" | "refuse";
}

export interface OperatorConversationUnit {
  systemQualifiedName: string;
  /** Compiled from this operator's admitted immutable source commit. */
  model: ExecutableModel;
  /** Actual performed inbox actions from this unit, never an agent-chosen ID. */
  inboxNativeIds?: readonly string[];
}

/** The one unit construction: inbox actions come from the model's own
 * native operator entries (the `.inbox` the writer binds callers to). */
export function conversationUnit(
  systemQualifiedName: string,
  model: ExecutableModel,
): OperatorConversationUnit {
  const inboxNativeIds = (model.operatorEntries || []).filter((entry) =>
    entry.kind === "inbox"
  ).map((entry) => entry.id);
  return {
    systemQualifiedName,
    model,
    ...(inboxNativeIds.length ? { inboxNativeIds } : {}),
  };
}

export interface OperatorConversationManifest {
  repositoryVersion: string;
  units: readonly OperatorConversationUnit[];
}

export interface ConversationRuntimeFactory {
  /** Opens an isolated session with this exact initial admitted contract. */
  open(unit: OperatorConversationUnit): Promise<ConversationRuntime>;
  close?(runtime: ConversationRuntime): Promise<void>;
}

/** Mutable Request progress and source-input views are not an authority binding. */
function sameWorkCaseBinding(
  left: CaseExecutionContext,
  right: CaseExecutionContext,
): boolean {
  const recordIdentity = (record: CaseExecutionContext["record"]) =>
    record && ({
      id: record.id,
      number: record.number,
      type: record.type,
      caseTypeId: record.caseTypeId,
      migratedFrom: record.migratedFrom,
      objective: record.objective,
      owner: record.owner,
      openedBy: record.openedBy,
      openedFrom: record.openedFrom,
      modelPin: record.modelPin,
      budget: record.budget,
      createdAt: record.createdAt,
    });
  return sameCaseIdentity(left, right) &&
    canonical(recordIdentity(left.record)) ===
      canonical(recordIdentity(right.record)) &&
    canonical(left.budget) === canonical(right.budget);
}

/** A native behavior admission or a host-verified Main crossing. */
type OperatorWorkContext =
  & Pick<
    BehaviorInvocationRequest,
    | "modelVersion"
    | "callerId"
    | "invocationId"
    | "caseId"
    | "caseContext"
    | "designerContext"
  >
  & {
    parentInvocation?:
      import("../../../domain/work/execution/case-context.ts").ParentInvocationAnchor;
  };
export type OperatorWorkAdmission =
  & OperatorWorkContext
  & (
    | {
      kind?: "nativeBehavior";
      behavior: BehaviorInvocationRequest["behavior"];
      mainOrder?: never;
    }
    | {
      kind: "mainOrder";
      targetNativeId: string;
      mainOrder: {
        openingId: string;
        caller:
          import("../../../domain/governance/authority.ts").ScopedOperatorRef;
      };
    }
  );

export interface OperatorWorkContribution {
  text: string;
  correlationId: string;
  proof: OperatorWorkAdmission;
}

export interface OperatorWorkResult {
  caseId?: string;
  agentId: string;
  correlationId: string;
  invocationId: string;
  status: "completed" | "waiting" | "failed";
  revision: number;
  modelVersion: BehaviorModelVersion;
  messages: Message[];
  candidateIds: string[];
  /** Recorded evidence for this contribution's exact artifacts, never a peer usage grant. */
  artifacts?: ArtifactEvidence[];
  error?: string;
}

interface RegisteredUnit {
  unit: OperatorConversationUnit;
  runtime: ConversationRuntime;
  unsubscribe: () => void;
  primaryRuntime: boolean;
}

interface OperatorMetadata {
  name: string;
  instruction: string;
  primary: boolean;
  humanInput: boolean;
}

function operator(model: ExecutableModel): OperatorMetadata | undefined {
  return (model as ExecutableModel & { operator?: OperatorMetadata }).operator;
}

/** Pure projection shared by live workspaces and inert durable Case reads. */
export function projectOperatorConversation(
  state: SystemRuntimeState,
  systemQualifiedName: string,
  primaryId: string | undefined,
  team: ExecutableModel["operatorTeam"],
): AgentConversation {
  const model = state.executionModel;
  if (!model) throw new Error("The admitted operator model is unavailable");
  const agentId = model.identity.builderId;
  const metadata = operator(model);
  const isPrimary = metadata?.primary ?? agentId === primaryId;
  const humanInput = metadata?.humanInput ?? agentId === primaryId;
  return {
    agentId,
    nativeId: agentId,
    runtimeOwned: true,
    name: metadata?.name ||
      (agentId === primaryId
        ? "Main Operator"
        : systemQualifiedName.split("::").at(-1)!),
    responsibility: metadata?.instruction || "Conversation du système",
    primary: isPrimary,
    canSend: humanInput,
    ...(!humanInput
      ? { readOnlyReason: "Ce mandat reçoit les demandes du coordinateur." }
      : {}),
    revision: state.revision,
    busy: state.busy,
    phase: state.phase,
    messages: structuredClone(state.messages),
    ...(state.designer?.scopeId
      ? { designerScopeId: state.designer.scopeId }
      : {}),
    effectiveModelUpdates: effectiveModelUpdates(state.events, agentId),
    ...(team ? { operatorTeam: structuredClone(team) } : {}),
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
    ...(state.configuration
      ? {
        proposalContext: {
          configurationRevision: state.configuration.revision,
          before: {
            network: networkScopeFor(state.configuration),
            builder: {
              admissionAuthority:
                state.configuration.builder.admissionAuthority,
            },
            ...(state.configuration.reviewer
              ? { reviewer: structuredClone(state.configuration.reviewer) }
              : {}),
            urlSelectionMode: model.policy.urlSelectionMode,
          },
          changes: structuredClone(state.configuration.changes),
        },
      }
      : {}),
  };
}

export function operatorConversationsSnapshot(
  systemId: string,
  conversations: readonly AgentConversation[],
  primaryId: string,
): ConversationsSnapshot {
  const visible = [
    ...new Map(conversations.map((entry) => [entry.agentId, entry])).values(),
  ];
  return {
    systemId,
    defaultAgentId: visible.find((entry) => entry.primary)?.agentId ??
      primaryId,
    version: canonical(visible.map((entry) => ({
      agentId: entry.agentId,
      revision: entry.revision,
      digest: entry.modelDigest,
      primary: entry.primary,
      canSend: entry.canSend,
      runtimeOwned: entry.runtimeOwned,
    }))),
    conversations: visible,
  };
}

function requireValue(
  value: unknown,
  code: string,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new OperatorConversationError(code, message, status);
}

function validateText(text: string) {
  requireValue(
    typeof text === "string" && text.trim().length > 0 &&
      text.length <= MAX_USER_MESSAGE_CHARS,
    "INVALID_MESSAGE",
    `Le message doit contenir entre 1 et ${MAX_USER_MESSAGE_CHARS} caractères.`,
  );
}

/**
 * Several modeled operators share one source repository, never a mutable turn.
 * Reading the aggregate does not construct agents or invoke an LLM.
 */
export class OperatorConversations {
  readonly #requestTeam?: VerifiedRequestTeam;
  #registered = new Map<string, RegisteredUnit>();
  readonly #mainOrders = new WeakSet<OperatorWorkAdmission>();
  readonly #pendingOrderNotices = new Map<string, { retry: boolean }>();
  #listeners = new Set<(snapshot: ConversationsSnapshot) => void>();
  #work = new Map<
    string,
    {
      fingerprint: string;
      caseId?: string;
      result: Promise<OperatorWorkResult>;
    }
  >();
  #reserved = new Set<string>();
  #caseContinuations = new Map<string, number>();
  #closingCases = new Set<string>();
  #disposed = false;
  #reconciling: Promise<void> | null = null;
  #admitting = false;

  constructor(
    readonly options: {
      primary: ConversationRuntime;
      /** Immutable roster verified at Request opening; absent in Main. */
      requestTeam?: VerifiedRequestTeam;
      factory?: ConversationRuntimeFactory;
      skillStore?: Pick<SkillStorePort, "load">;
      /** Edge hook for best-effort order-notice failures; never throws. */
      onNoticeError?(error: OperatorConversationError): void;
      evolutionRead?(): Promise<
        | import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationsSnapshot
        | undefined
      >;
    },
  ) {
    this.#requestTeam = options.requestTeam;
  }

  #teamOf(model: ExecutableModel): ExecutableModel["operatorTeam"] {
    return this.#requestTeam
      ? operatorTeamInRequest(model, this.#requestTeam)
      : model.operatorTeam;
  }

  async initialize(manifest?: OperatorConversationManifest): Promise<void> {
    if (manifest) return await this.reconcileUnits(manifest);
    const model = this.options.primary.snapshot.executionModel;
    requireValue(model, "MODEL_MISSING", "Le contrat admis est absent.", 409);
    requireValue(
      model.version.repositoryVersion,
      "MODEL_MISSING",
      "La version source admise est absente.",
      409,
    );
    await this.reconcileUnits({
      repositoryVersion: model.version.repositoryVersion,
      units: [{
        // Only the historical ASE primary omits its source scope from identity.
        systemQualifiedName: model.identity.systemQualifiedName ??
          "ASELiveBuilder::liveBuilder",
        model,
      }],
    });
  }

  async reconcileUnits(manifest: OperatorConversationManifest): Promise<void> {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    requireValue(
      !this.#reconciling,
      "RECONCILIATION_BUSY",
      "Une mise à jour des opérateurs est déjà en cours.",
      409,
    );
    // Reserve before a factory or an observer can yield and re-enter.
    this.#reconciling = Promise.resolve();
    const operation = this.#reconcile(manifest);
    this.#reconciling = operation;
    try {
      await operation;
    } finally {
      this.#reconciling = null;
    }
  }

  /** Settle admitted effects, then recover each exact persisted conversation under its Case lease. */
  async resumeCandidateContinuations(): Promise<void> {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    if (this.#reconciling || this.#admitting) return;
    const blocked = (error: unknown) =>
      error instanceof OperatorConversationError && [
          "AGENT_BUSY",
          "MODEL_ADMISSION_BUSY",
          "CASE_BUSY",
          "WORK_CASE_INACTIVE",
        ].includes(error.code) || error instanceof CaseError && [
          "AGENT_BUSY",
          "CASE_BUSY",
          "CASE_CLOSED",
          "CASE_NOT_FOUND",
          "CASE_NOT_OWNED",
          "CASE_SCOPE_MISSING",
        ].includes(error.code);
    for (const [agentId, entry] of this.#registered) {
      if (entry.primaryRuntime) continue;
      const current = entry.runtime.snapshot;
      const invocation = current.caseInvocation;
      const currentCaseId = invocation?.kind === "local"
        ? invocation.caseId
        : invocation?.kind === "delegated"
        ? invocation.work.caseContext.caseId
        : undefined;
      const pending = current.candidates.filter((candidate) =>
        candidate.admission?.authority === "delegate" &&
          hasActivationIntent(candidate) ||
        candidate.admissionContinuation
      );
      const caseIds = [
        ...new Set(
          pending.flatMap((candidate) =>
            candidate.caseId ? [candidate.caseId] : []
          ),
        ),
      ];
      if (!caseIds.length) continue;
      let reserved = false;
      try {
        this.#reserve(agentId, current);
        reserved = true;
        const resumeInvocations = new Map<string, string>();
        // Settle every Case before any conversation continuation. A busy or
        // missing Case cannot block another Case's durable publication.
        for (const caseId of caseIds) {
          let releaseCase: (() => void) | undefined;
          try {
            const records = [...this.#registered.values()].flatMap(
              (registered) => {
                const state = registered.runtime.snapshot;
                return (state.cases ?? []).filter((record) =>
                  record.id === caseId
                )
                  .map((record) => ({ state, record }));
              },
            );
            if (records.length !== 1) continue;
            const { state: owner, record } = records[0];
            if (!isOpenCase(record)) {
              // Done may finish an admitted intent; abandoned only reads the
              // catalog. Neither closed Case resumes its conversation.
              await entry.runtime.settleDelegatedCandidateActivations?.({
                caseId,
                abandon: record.status === "closed-abandoned",
                closed: true,
              });
              continue;
            }
            const selected = entry.runtime.snapshot;
            let resumesCurrent = caseId === currentCaseId;
            let context: CaseExecutionContext | undefined;
            let invocation: SystemRuntimeState["caseInvocation"];
            if (resumesCurrent) {
              const invocations = selected.candidates.filter((candidate) =>
                candidate.caseId === caseId &&
                (candidate.admissionContinuation ||
                  hasActivationIntent(candidate))
              ).map((candidate) => candidateCaseInvocation(selected, candidate))
                .filter((invocation) =>
                  invocation && selected.caseInvocation &&
                  invocationKey(invocation) ===
                    invocationKey(selected.caseInvocation)
                );
              // Another parked contribution may share this Request while the
              // selected invocation has no pending continuation of its own.
              if (!invocations.length) resumesCurrent = false;
              invocation = invocations[0];
              if (resumesCurrent) {
                requireValue(
                  invocation &&
                    canonical(invocation) ===
                      canonical(selected.caseInvocation) &&
                    invocations.every((value) =>
                      canonical(value) === canonical(invocation)
                    ),
                  "WORK_CASE_INACTIVE",
                  "La reprise du candidat ne correspond plus au Request actif.",
                  409,
                );
              }
              context = invocation?.kind === "delegated"
                ? invocation.work.caseContext
                : invocation?.kind === "local"
                ? caseExecutionContext({
                  ...selected,
                  caseInvocation: invocation,
                })
                : undefined;
            }
            if (!resumesCurrent) {
              // A settled effect belongs to its persisted Case, not whichever
              // conversation is selected now. Never refresh/select that Case.
              context = caseExecutionContext({
                ...owner,
                caseInvocation: { kind: "local", caseId },
              });
            }
            requireValue(
              context,
              "WORK_CASE_INACTIVE",
              "La reprise exige le Request exact du candidat.",
              409,
            );
            const continuation = this.#reserveCaseContinuation(context);
            releaseCase = continuation.release;
            if (resumesCurrent && invocation?.kind === "delegated") {
              const refresh = this.#refreshCaseContinuation(
                entry.runtime,
                continuation.context,
              );
              if (refresh) await refresh;
            }
            const casePending = pending.filter((candidate) =>
              candidate.caseId === caseId
            );
            if (entry.runtime.settleDelegatedCandidateActivations) {
              await entry.runtime.settleDelegatedCandidateActivations({
                caseId,
              });
            } else if (casePending.some(hasActivationIntent)) {
              continue;
            }
            for (const candidate of entry.runtime.snapshot.candidates) {
              if (
                candidate.caseId !== caseId ||
                !candidate.admissionContinuation ||
                hasActivationIntent(candidate)
              ) continue;
              const selected = entry.runtime.snapshot;
              const invocation = candidateCaseInvocation(selected, candidate);
              if (!invocation) continue;
              const key = invocationKey(invocation);
              if (
                selected.caseInvocation &&
                  invocationKey(selected.caseInvocation) === key ||
                selected.invocationContinuations?.[key]
              ) {
                resumeInvocations.set(key, candidate.id);
              }
            }
          } catch (error) {
            if (!blocked(error)) throw error;
          } finally {
            releaseCase?.();
          }
        }
        for (const candidateId of resumeInvocations.values()) {
          await entry.runtime.enqueueCandidateContinuation?.(candidateId);
        }
      } catch (error) {
        if (!blocked(error)) throw error;
      } finally {
        if (reserved) this.#reserved.delete(agentId);
      }
    }
  }

  /** Local registry lease only: the worker owns the durable operator claim. */
  async withCandidateContinuation<T>(
    caseId: string,
    action: (context: CaseExecutionContext) => Promise<T>,
  ): Promise<T> {
    const records = [...this.#registered.values()].flatMap(({ runtime }) => {
      const state = runtime.snapshot;
      return (state.cases ?? []).filter((record) => record.id === caseId)
        .map((record) => ({ state, record }));
    });
    requireValue(
      records.length === 1 && isOpenCase(records[0].record),
      "WORK_CASE_INACTIVE",
      "Le Request autoritatif du candidat est indisponible.",
      409,
    );
    const context = caseExecutionContext({
      ...records[0].state,
      caseInvocation: { kind: "local", caseId },
    });
    requireValue(
      context,
      "WORK_CASE_INACTIVE",
      "Le Request exact est indisponible.",
      409,
    );
    const lease = this.#reserveCaseContinuation(context);
    try {
      return await action(lease.context!);
    } finally {
      lease.release();
    }
  }

  /** One shared Case lease for a new delegated publication, including retries. */
  async withCandidatePublication<T>(
    input: {
      agentId: string;
      candidateId: string;
      candidateDigest: string;
      caseId: string;
    },
    publish: () => Promise<T>,
  ): Promise<T> {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    requireValue(
      !this.#reconciling && !this.#admitting,
      "MODEL_ADMISSION_BUSY",
      "La publication attend la fin de l’admission du modèle.",
      409,
    );
    const current = this.#registered.get(input.agentId)?.runtime.snapshot;
    const candidate = current?.candidates.find((value) =>
      value.id === input.candidateId
    );
    requireValue(
      candidate && candidate.digest === input.candidateDigest &&
        candidate.caseId === input.caseId &&
        candidate.admission?.authority === "delegate" &&
        hasActivationIntent(candidate) &&
        candidate.admission.candidateId === candidate.id &&
        candidate.admission.candidateDigest === candidate.digest,
      "STALE_CANDIDATE",
      "La publication exige l’intention déléguée exacte du candidat.",
      409,
    );
    const records = [...this.#registered.values()].flatMap((entry) => {
      const state = entry.runtime.snapshot;
      return (state.cases ?? []).filter((record) => record.id === input.caseId)
        .map((record) => ({ state, record }));
    });
    requireValue(
      records.length === 1,
      "WORK_CASE_INACTIVE",
      "Le Request autoritatif du candidat est indisponible.",
      409,
    );
    const { state: owner, record } = records[0];
    if (record.status === "closed-abandoned") {
      throw new CandidateActivationError("CASE_ABANDONED", {
        candidateId: candidate.id,
        caseId: input.caseId,
      }, "The candidate's Request was abandoned before publication");
    }
    if (record.status === "closed-done") {
      return await this.withCaseClosure(input.caseId, publish);
    }
    const context = caseExecutionContext({
      ...owner,
      caseInvocation: { kind: "local", caseId: input.caseId },
    });
    requireValue(
      context,
      "WORK_CASE_INACTIVE",
      "Le Request autoritatif du candidat est indisponible.",
      409,
    );
    const continuation = this.#reserveCaseContinuation(context);
    try {
      // The target already holds its control/reservation. This lease changes no
      // cursor, invocation or budget, including another selected Case.
      return await publish();
    } finally {
      continuation.release();
    }
  }

  /** Reserve normal commands while one explicitly selected contract is admitted. */
  async withAdmission<T>(action: () => Promise<T>): Promise<T> {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    requireValue(
      !this.#admitting && !this.#reconciling && !this.#reserved.size &&
        [...this.#registered.values()].every((entry) =>
          !entry.runtime.snapshot.busy
        ),
      "AGENT_BUSY",
      "Les opérateurs doivent être au repos avant une admission de modèle.",
      409,
    );
    this.#admitting = true;
    try {
      return await action();
    } finally {
      this.#admitting = false;
    }
  }

  /** Closing and delegated resumptions reserve the same Case before yielding. */
  async withCaseClosure<T>(
    caseId: string,
    action: () => Promise<T>,
    options: { abandonContributions?: boolean } = {},
  ): Promise<T> {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    requireValue(
      !this.#closingCases.has(caseId) && !this.#caseContinuations.has(caseId),
      "CASE_BUSY",
      "Une reprise ou une clôture de ce Case est déjà en cours.",
      409,
    );
    // Durable acceptance releases the submit-time lease before the worker
    // starts; a contributor still executing this exact Case keeps it open
    // until its contribution settles at a wait or a terminal completion.
    requireValue(
      ![...this.#registered.values()].some((entry) => {
        const state = entry.runtime.snapshot;
        const invocation = state.caseInvocation;
        return state.busy && invocation?.kind === "delegated" &&
          invocation.work.caseContext.caseId === caseId;
      }),
      "CASE_BUSY",
      "Une contribution déléguée de ce Case est encore en cours.",
      409,
    );
    this.#closingCases.add(caseId);
    const reserved: string[] = [];
    try {
      if (options.abandonContributions) {
        requireValue(
          !this.#reconciling && !this.#admitting,
          "MODEL_ADMISSION_BUSY",
          "La clôture attend la fin de l’admission du modèle.",
          409,
        );
        const contributors = [...this.#registered].filter(([, entry]) => {
          const state = entry.runtime.snapshot;
          return !state.cases?.some((record) => record.id === caseId) &&
            state.candidates.some((candidate) => candidate.caseId === caseId);
        });
        // Reserve every contributor before the first settlement can yield.
        // A different selected Case never changes durable candidate ownership.
        for (const [agentId, entry] of contributors) {
          requireValue(
            entry.runtime.settleDelegatedCandidateActivations,
            "RUNTIME_UNAVAILABLE",
            "Le contributeur ne peut pas terminer les candidats du Request.",
            409,
          );
          this.#reserve(agentId, entry.runtime.snapshot, caseId);
          reserved.push(agentId);
        }
        for (const [, entry] of contributors) {
          await entry.runtime.settleDelegatedCandidateActivations!({
            caseId,
            abandon: true,
            closed: true,
          });
        }
      }
      return await action();
    } finally {
      for (const agentId of reserved) this.#reserved.delete(agentId);
      this.#closingCases.delete(caseId);
    }
  }

  #reserveCaseContinuation(
    delegated: CaseExecutionContext | undefined,
    exactWorkBinding = false,
  ): {
    release: () => void;
    context?: CaseExecutionContext;
  } {
    if (!delegated) return { release: () => {} };
    const caseId = delegated.caseId;
    requireValue(
      !this.#closingCases.has(caseId),
      "CASE_BUSY",
      "La clôture du Case propriétaire de ce travail est en cours.",
      409,
    );
    const owners = [...this.#registered.values()].map((registered) =>
      registered.runtime.snapshot
    ).filter((state) =>
      state.cases?.some((caseRecord) =>
        caseRecord.id === caseId &&
        caseRecord.owner === state.executionModel?.identity.builderId
      )
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    const active = owner?.cases?.find((record) => record.id === caseId);
    const context = owner && caseExecutionContext({
      ...owner,
      caseInvocation: { kind: "local", caseId },
    });
    requireValue(
      active && active.id === caseId && isOpenCase(active) &&
        context && sameCaseIdentity(context, delegated) &&
        (!exactWorkBinding || sameWorkCaseBinding(context, delegated)),
      "WORK_CASE_INACTIVE",
      "Le Case propriétaire de ce travail est clos ou n’est plus actif.",
      409,
    );
    this.#caseContinuations.set(
      caseId,
      (this.#caseContinuations.get(caseId) ?? 0) + 1,
    );
    return {
      context,
      release: () => {
        const remaining = this.#caseContinuations.get(caseId)! - 1;
        if (remaining) this.#caseContinuations.set(caseId, remaining);
        else this.#caseContinuations.delete(caseId);
      },
    };
  }

  #refreshCaseContinuation(
    runtime: ConversationRuntime,
    context: CaseExecutionContext | undefined,
    candidateId?: string,
    changeId?: string,
  ): Promise<void> | undefined {
    if (!context) return;
    const selected = runtime.snapshot;
    const candidate = candidateId &&
      selected.candidates.find((value) => value.id === candidateId);
    const change = changeId &&
      selected.configuration?.changes.find((entry) => entry.id === changeId);
    const invocation = change
      ? changeCaseInvocation(selected, change)
      : candidate
      ? candidateCaseInvocation(selected, candidate)
      : undefined;
    const sameInvocation = !candidateId && !changeId ||
      invocation && selected.caseInvocation &&
        invocationKey(invocation) === invocationKey(selected.caseInvocation);
    if (
      !context ||
      sameInvocation &&
        canonical(delegatedCaseContext(selected)) === canonical(context)
    ) return;
    requireValue(
      runtime.refreshCaseContext,
      "RUNTIME_UNAVAILABLE",
      "La continuation ne peut pas actualiser la politique du Case central.",
      409,
    );
    return runtime.refreshCaseContext(context, candidateId, changeId);
  }

  async #reconcile(manifest: OperatorConversationManifest): Promise<void> {
    const primaryState = this.options.primary.snapshot;
    const admitted = primaryState.executionModel;
    requireValue(
      admitted,
      "MODEL_MISSING",
      "Le contrat admis est absent.",
      409,
    );
    requireValue(
      manifest.repositoryVersion === admitted.version.repositoryVersion,
      "MODEL_MISMATCH",
      "Le manifeste doit provenir de la version source admise.",
      409,
    );
    requireValue(
      manifest.units.length > 0 && manifest.units.length <= MAX_OPERATOR_UNITS,
      "INVALID_MANIFEST",
      `Le manifeste doit contenir entre 1 et ${MAX_OPERATOR_UNITS} opérateurs.`,
    );
    const seenActors = new Set<string>(), seenScopes = new Set<string>();
    let hasPrimary = false, declaredPrimary = 0;
    for (const unit of manifest.units) {
      const { identity, version } = unit.model;
      requireValue(
        typeof unit.systemQualifiedName === "string" &&
          unit.systemQualifiedName.length > 0 &&
          !seenScopes.has(unit.systemQualifiedName) &&
          identity.builderId && !seenActors.has(identity.builderId) &&
          identity.projectId === admitted.identity.projectId &&
          identity.rootId === admitted.identity.rootId &&
          typeof version.repositoryVersion === "string" &&
          version.repositoryVersion.length > 0 &&
          Boolean(version.digest),
        "INVALID_MANIFEST",
        "Les identités et versions des opérateurs doivent être natives et uniques.",
      );
      if (identity.builderId === admitted.identity.builderId) {
        requireValue(
          identity.systemId === admitted.identity.systemId &&
            version.digest === admitted.version.digest,
          "MODEL_MISMATCH",
          "Le manifeste remplace le contrat du point de contact admis.",
          409,
        );
        hasPrimary = true;
      }
      if (operator(unit.model)?.primary) declaredPrimary++;
      requireValue(
        unit.inboxNativeIds === undefined ||
          unit.inboxNativeIds.length > 0 &&
            unit.inboxNativeIds.every((id) =>
              typeof id === "string" && id.length > 0
            ) &&
            new Set(unit.inboxNativeIds).size === unit.inboxNativeIds.length,
        "INVALID_MANIFEST",
        "Une entrée d’opérateur doit désigner des actions natives uniques.",
      );
      seenScopes.add(unit.systemQualifiedName);
      seenActors.add(identity.builderId);
    }
    requireValue(
      hasPrimary && declaredPrimary <= 1,
      "INVALID_MANIFEST",
      "Le manifeste doit conserver un point de contact principal unique.",
    );
    const removed = [...this.#registered.entries()].filter(([id]) =>
      !seenActors.has(id)
    );
    requireValue(
      removed.every(([, entry]) => !entry.runtime.snapshot.busy) &&
        [...this.#reserved].every((id) => seenActors.has(id)),
      "AGENT_BUSY",
      "Un opérateur en activité ne peut pas être retiré.",
      409,
    );
    const opened: RegisteredUnit[] = [];
    const next = new Map<string, RegisteredUnit>();
    try {
      for (const supplied of manifest.units) {
        const unit = structuredClone(supplied);
        const id = unit.model.identity.builderId;
        const existing = this.#registered.get(id);
        if (existing) {
          requireValue(
            existing.unit.systemQualifiedName === unit.systemQualifiedName &&
              existing.unit.model.identity.systemId ===
                unit.model.identity.systemId,
            "MODEL_MISMATCH",
            "L’identité native d’un opérateur ne peut pas changer de portée.",
            409,
          );
          requireValue(
            existing.runtime.snapshot.executionModel?.version.digest ===
              unit.model.version.digest,
            "MODEL_MISMATCH",
            "La nouvelle version doit être admise par la session avant son exposition.",
            409,
          );
          next.set(id, { ...existing, unit });
          continue;
        }
        const primaryRuntime = id === admitted.identity.builderId;
        const runtime = primaryRuntime
          ? this.options.primary
          : await this.options.factory?.open(unit);
        requireValue(
          runtime,
          "RUNTIME_UNAVAILABLE",
          "Aucun moteur n’est disponible pour cet opérateur déclaré.",
          409,
        );
        const actual = runtime.snapshot.executionModel;
        try {
          requireValue(
            actual?.identity.builderId === id &&
              actual.identity.systemId === unit.model.identity.systemId &&
              actual.version.digest === unit.model.version.digest,
            "MODEL_MISMATCH",
            "La session ne possède pas le contrat admis de son opérateur.",
            409,
          );
        } catch (error) {
          if (!primaryRuntime) await this.options.factory?.close?.(runtime);
          throw error;
        }
        const entry = {
          unit,
          runtime,
          primaryRuntime,
          unsubscribe: runtime.onState(() => this.#emit()),
        };
        opened.push(entry);
        next.set(id, entry);
      }
      const latest = this.options.primary.snapshot.executionModel;
      requireValue(
        !this.#disposed,
        "RUNTIME_DISPOSED",
        "Atelier fermé pendant l’ouverture des sessions.",
        409,
      );
      requireValue(
        latest?.version.digest === admitted.version.digest &&
          latest.version.repositoryVersion === manifest.repositoryVersion,
        "MODEL_MISMATCH",
        "Le modèle admis a changé pendant l’ouverture des sessions.",
        409,
      );
      requireValue(
        removed.every(([, entry]) => !entry.runtime.snapshot.busy) &&
          [...this.#reserved].every((id) => seenActors.has(id)),
        "AGENT_BUSY",
        "Un opérateur a commencé un travail pendant la mise à jour.",
        409,
      );
    } catch (error) {
      for (const entry of opened) {
        entry.unsubscribe();
        if (!entry.primaryRuntime) {
          await this.options.factory?.close?.(entry.runtime);
        }
      }
      throw error;
    }
    this.#registered = next;
    for (const [, entry] of removed) {
      entry.unsubscribe();
      if (!entry.primaryRuntime) {
        await this.options.factory?.close?.(entry.runtime);
      }
    }
    this.#emit();
  }

  get snapshot(): ConversationsSnapshot {
    const primary = this.options.primary.snapshot;
    const primaryId = primary.executionModel?.identity.builderId;
    const conversations: AgentConversation[] = [];
    for (const entry of this.#registered.values()) {
      const state = entry.runtime.snapshot;
      const model = state.executionModel;
      if (!model) continue;
      conversations.push(projectOperatorConversation(
        state,
        entry.unit.systemQualifiedName,
        primaryId,
        this.#teamOf(model),
      ));
      const audit = reviewerConversation(state);
      if (audit && !this.#registered.has(audit.agentId)) {
        conversations.push(audit);
      }
    }
    return operatorConversationsSnapshot(
      primary.id,
      conversations,
      primaryId ?? "",
    );
  }

  conversations(): Promise<ConversationsSnapshot> {
    return this.withReadContext(this.snapshot);
  }

  /** Async read enrichments have their own identity, separate from command CAS. */
  async withReadContext(
    snapshot: ConversationsSnapshot,
  ): Promise<ConversationsSnapshot> {
    const enriched = await this.withSkills(snapshot);
    let evolutions:
      | import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationsSnapshot
      | undefined;
    try {
      evolutions = await this.options.evolutionRead?.();
    } catch {
      // A failed advisory read must not hide the conversations of other units.
      // Never substitute unverified sources or a guessed current dossier state.
      evolutions = {
        version: "evolutions:unavailable",
        items: [],
        truncated: true,
        error: "Evolution dossier details are unavailable.",
      };
    }
    return evolutions
      ? {
        ...enriched,
        evolutions,
        version: canonical({
          conversations: enriched.version,
          evolutions: evolutions.version,
        }),
      }
      : enriched;
  }

  /** Notify live readers of a committed external read-model change. */
  notifyReadChange(): void {
    this.#emit();
  }

  /** Adds each agent's skill metadata to a snapshot; never the skill texts. */
  async withSkills(
    snapshot: ConversationsSnapshot,
  ): Promise<ConversationsSnapshot> {
    const store = this.options.skillStore;
    if (!store) return snapshot;
    await Promise.all(snapshot.conversations.map(async (conversation) => {
      const catalog = await store.load(conversation.nativeId);
      if (!catalog) return;
      conversation.skills = catalog.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        loaded: skill.loaded,
        ...(skill.sourceBinding
          ? { sourceBinding: structuredClone(skill.sourceBinding) }
          : {}),
      })).sort((a, b) =>
        Number(b.loaded) - Number(a.loaded) || persistedOrder(a.name, b.name)
      );
    }));
    return snapshot;
  }

  /** Occurrences are collected by owner; equal names or digests do not merge them. */
  get catalogSnapshot(): OperatorToolsSnapshot {
    const primary = this.options.primary.snapshot;
    const states = [...this.#registered.entries()].map(([agentId, entry]) => ({
      agentId,
      entry,
      state: entry.runtime.snapshot,
    }));
    const tools = states.flatMap(
      ({ agentId, entry, state }) => {
        const metadata = state.executionModel && operator(state.executionModel);
        const name = metadata?.name ||
          (agentId === primary.executionModel?.identity.builderId
            ? "Main Operator"
            : entry.unit.systemQualifiedName.split("::").at(-1)!);
        return state.candidates.map((candidate) => ({
          agentId,
          agentName: name,
          revision: state.revision,
          candidate: structuredClone(candidate),
        }));
      },
    );
    const modelTools = states.flatMap(({ agentId, entry, state }) => {
      const metadata = state.executionModel && operator(state.executionModel);
      const name = metadata?.name ||
        (agentId === primary.executionModel?.identity.builderId
          ? "Main Operator"
          : entry.unit.systemQualifiedName.split("::").at(-1)!);
      return (state.modelTools ?? []).map((tool) => ({
        agentId,
        agentName: name,
        tool: structuredClone(tool),
      }));
    });
    return {
      systemId: primary.id,
      version: canonical(
        states.map(({ agentId, state }) => ({
          agentId,
          revision: state.revision,
          modelDigest: state.executionModel?.version.digest,
          modelTools: state.modelTools ?? [],
        })),
      ),
      tools,
      modelTools,
    };
  }

  async inspectCandidate(
    command:
      & Pick<
        OperatorCandidateDecision,
        "agentId" | "candidateId" | "candidateDigest" | "expectedRevision"
      >
      & { caseId: string },
    delegated: CandidateDelegatedActor,
  ): Promise<CandidateInspection> {
    const entry = this.#registered.get(command.agentId);
    requireValue(
      entry,
      "UNKNOWN_AGENT",
      "Opérateur propriétaire introuvable.",
      404,
    );
    const current = entry.runtime.snapshot;
    requireValue(
      Number.isSafeInteger(command.expectedRevision) &&
        command.expectedRevision === current.revision,
      "STALE_CONVERSATION",
      "Le candidat a changé ; rechargez-le.",
      409,
    );
    const candidate = current.candidates.find((value) =>
      value.id === command.candidateId
    );
    requireValue(
      candidate && candidate.digest === command.candidateDigest &&
        candidate.caseId === command.caseId,
      "STALE_CANDIDATE",
      "L’inspection exige le candidat et le Request exacts.",
      409,
    );
    const invocation = candidateCaseInvocation(current, candidate);
    requireValue(
      invocation,
      "WORK_CASE_INACTIVE",
      "Le Request du candidat n’est plus actif.",
      409,
    );
    requireValue(
      entry.runtime.inspectCandidate,
      "RUNTIME_UNAVAILABLE",
      "L’inspection de cet opérateur est absente.",
      409,
    );
    this.#reserve(command.agentId, current);
    let releaseCase: (() => void) | undefined;
    try {
      const continuation = this.#reserveCaseContinuation(
        invocation.kind === "delegated"
          ? invocation.work.caseContext
          : undefined,
      );
      releaseCase = continuation.release;
      const refresh = this.#refreshCaseContinuation(
        entry.runtime,
        continuation.context,
        candidate.id,
      );
      if (refresh) await refresh;
      return await entry.runtime.inspectCandidate({
        candidateId: command.candidateId,
        candidateDigest: command.candidateDigest,
        caseId: command.caseId,
      }, delegated);
    } finally {
      releaseCase?.();
      this.#reserved.delete(command.agentId);
    }
  }

  async decideCandidate(
    command: OperatorCandidateDecision,
    delegated?: CandidateDelegatedActor,
    origin?: OperatorCommandOrigin,
  ): Promise<void> {
    const entry = this.#registered.get(command.agentId);
    requireValue(
      entry,
      "UNKNOWN_AGENT",
      "Opérateur propriétaire introuvable.",
      404,
    );
    if (origin) {
      requireValue(
        entry.runtime.resumeOperatorCommand,
        "RUNTIME_UNAVAILABLE",
        "The durable operator command inspector is unavailable",
        409,
      );
      if (
        await entry.runtime.resumeOperatorCommand({
          kind: "decide-candidate",
          input: {
            candidateId: command.candidateId,
            candidateDigest: command.candidateDigest,
            verdict: command.verdict,
            reason: command.reason.trim(),
            ...(command.caseId ? { caseId: command.caseId } : {}),
          },
          ...(delegated ? { delegated } : {}),
        }, origin)
      ) return;
    }
    const current = entry.runtime.snapshot;
    requireValue(
      Number.isSafeInteger(command.expectedRevision) &&
        command.expectedRevision === current.revision,
      "STALE_CONVERSATION",
      "Le catalogue de cet opérateur a changé ; rechargez-le.",
      409,
    );
    const candidate = current.candidates.find((entry) =>
      entry.id === command.candidateId
    );
    requireValue(
      candidate,
      "UNKNOWN_CANDIDATE",
      "Ce candidat n’appartient pas à cet opérateur.",
      404,
    );
    requireValue(
      candidate.digest === command.candidateDigest,
      "STALE_CANDIDATE",
      "La décision doit viser la version exacte du candidat.",
      409,
    );
    requireValue(
      !delegated ||
        typeof command.caseId === "string" &&
          command.caseId === candidate.caseId,
      "STALE_CANDIDATE",
      "La décision déléguée exige le Request exact du candidat.",
      409,
    );
    const initialAdmission = isInitializationAdmission(current, candidate);
    const invocation = candidateCaseInvocation(current, candidate);
    requireValue(
      initialAdmission || invocation,
      "WORK_CASE_INACTIVE",
      "Le candidat appartient à un Case qui n’est plus actif.",
      409,
    );
    requireValue(
      ["approve", "refuse"].includes(command.verdict) &&
        typeof command.reason === "string" &&
        command.reason.trim().length > 0 && command.reason.length <= 2000,
      "INVALID_DECISION",
      "La décision exige un verdict et une justification courte.",
    );
    requireValue(
      entry.runtime.decideCandidate,
      "RUNTIME_UNAVAILABLE",
      "Le contrôle d’admission de cet opérateur est absent.",
      409,
    );
    this.#reserve(command.agentId, current);
    let releaseCase: (() => void) | undefined;
    try {
      const continuation = this.#reserveCaseContinuation(
        invocation?.kind === "delegated"
          ? invocation.work.caseContext
          : undefined,
      );
      releaseCase = continuation.release;
      const refresh = !origin && this.#refreshCaseContinuation(
        entry.runtime,
        continuation.context,
        candidate.id,
      );
      if (refresh) await refresh;
      // The existing modeled gate verifies stage, authority, digest and cursor.
      await entry.runtime.decideCandidate(
        {
          candidateId: command.candidateId,
          candidateDigest: command.candidateDigest,
          verdict: command.verdict,
          reason: command.reason.trim(),
          ...(command.caseId ? { caseId: command.caseId } : {}),
        },
        delegated,
        origin,
      );
    } finally {
      releaseCase?.();
      this.#reserved.delete(command.agentId);
    }
  }

  async decideChange(
    command: OperatorChangeDecision,
    delegated?: DelegatedActor,
    origin?: OperatorCommandOrigin,
  ): Promise<void> {
    try {
      await this.#decideChange(command, delegated, origin);
    } catch (error) {
      if (
        delegated && error instanceof OperatorConversationError && [
          "AGENT_BUSY",
          "WORK_CASE_INACTIVE",
          "STALE_CHANGE",
          "STALE_CONVERSATION",
        ].includes(error.code)
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          error.message,
          {
            ...error.context,
            changeId: command.changeId,
            operatorId: command.agentId,
            reason: error.code,
          },
        );
      }
      throw error;
    }
  }

  async #decideChange(
    command: OperatorChangeDecision,
    delegated?: DelegatedActor,
    origin?: OperatorCommandOrigin,
  ): Promise<void> {
    const entry = this.#registered.get(command.agentId);
    requireValue(
      entry,
      "UNKNOWN_AGENT",
      "Opérateur propriétaire introuvable.",
      404,
    );
    if (origin) {
      requireValue(
        entry.runtime.resumeOperatorCommand,
        "RUNTIME_UNAVAILABLE",
        "The durable operator command inspector is unavailable",
        409,
      );
      if (
        await entry.runtime.resumeOperatorCommand({
          kind: "decide-change",
          input: {
            changeId: command.changeId,
            expectedRevision: command.configurationRevision,
            verdict: command.verdict,
          },
          ...(delegated ? { delegated } : {}),
        }, origin)
      ) return;
    }
    const current = entry.runtime.snapshot;
    const configuration = current.configuration;
    requireValue(
      current.executionModel && configuration && entry.runtime.decideChange,
      "RUNTIME_UNAVAILABLE",
      "Le contrôle de configuration de cet opérateur est absent.",
      409,
    );
    requireValue(
      Number.isSafeInteger(command.expectedRevision) &&
        command.expectedRevision === current.revision &&
        Number.isSafeInteger(command.configurationRevision),
      "STALE_CONVERSATION",
      "La proposition a changé ; rechargez-la.",
      409,
    );
    const change = configuration.changes.find((value) =>
      value.id === command.changeId
    );
    requireValue(
      change,
      "UNKNOWN_CHANGE",
      "Cette proposition n’appartient pas à cet opérateur.",
      404,
    );
    requireValue(
      change.baseRevision === command.configurationRevision &&
        (change.status === "pending" || change.status === "approved"),
      "STALE_CHANGE",
      "Cette proposition n’attend plus de décision à cette révision.",
      409,
    );
    requireValue(
      command.verdict === "approve" || command.verdict === "refuse",
      "INVALID_DECISION",
      "Le verdict est invalide.",
    );
    this.#reserve(command.agentId, current);
    let releaseCase: (() => void) | undefined;
    try {
      const selected = change.requestedBy
        ? changeCaseInvocation(current, change)
        : undefined;
      const continuation = this.#reserveCaseContinuation(
        selected?.kind === "delegated"
          ? selected.work.caseContext
          : selected
          ? undefined
          : delegatedCaseContext(current),
      );
      releaseCase = continuation.release;
      const refresh = !origin && this.#refreshCaseContinuation(
        entry.runtime,
        continuation.context,
        undefined,
        selected ? change.id : undefined,
      );
      if (refresh) await refresh;
      await entry.runtime.decideChange(
        {
          changeId: command.changeId,
          expectedRevision: command.configurationRevision,
          verdict: command.verdict,
        },
        delegated,
        origin,
      );
    } finally {
      releaseCase?.();
      this.#reserved.delete(command.agentId);
    }
  }

  async notifyCommandCompletion(
    accepted: AcceptedOperatorCommand,
  ): Promise<void> {
    const origin = accepted.origin;
    if (!origin) return;
    const source = origin.businessRevision.__assemblyRuntimeRevision;
    const target = this.#registered.get(accepted.identity.operatorId);
    const eventId = `operator-command-completed:${accepted.id}`;
    const snapshot = target?.runtime.snapshot;
    const result = snapshot && await recordedCommandOutcome(snapshot, accepted);
    if (!result) {
      throw new Error("The command has no exact target completion receipt");
    }
    const parent = this.#registered.get(source.operatorId);
    if (!source.invocationKey || !parent?.runtime.enqueueContinuation) {
      throw new Error("The original command contribution is unavailable");
    }
    if (!result.outcome) {
      if (!parent.runtime.hasAcceptedLegacyCommandNotification) {
        throw new Error(
          "The legacy command notification receipt reader is unavailable",
        );
      }
      // Keep an already accepted historical observation byte-for-byte. A
      // legacy success event cannot supply an invented historical revision.
      if (await parent.runtime.hasAcceptedLegacyCommandNotification(accepted)) {
        return;
      }
    }
    await parent.runtime.enqueueContinuation({
      id: `operator-command-result:${accepted.id}`,
      invocationKey: source.invocationKey,
      inputMessageId: origin.inputMessageId,
      sourceOperatorId: accepted.identity.operatorId,
      sourceCompletionId: eventId,
      observation: {
        format: "operator-command-completion/v1",
        commandId: accepted.id,
        kind: accepted.command.kind,
        operatorId: accepted.identity.operatorId,
        status: result.outcome?.result.status === "refused"
          ? "refused"
          : "completed",
        ...(result.outcome
          ? {
            revision: result.outcome.revision,
            result: structuredClone(result.outcome.result),
          }
          : {}),
      },
    });
  }

  async notifyWorkCompletion(
    work: OperatorWorkReceipt,
    completion: import("./journal.ts").OperatorWorkCompletion,
  ): Promise<void> {
    const anchor = work.parentInvocation;
    if (!anchor || completion.work.status === "waiting") return;
    if (work.mainOrder) {
      throw new OperatorConversationError(
        "RUNTIME_UNAVAILABLE",
        "A Main-order continuation needs its Main execution-space dispatcher",
        409,
        { openingId: work.mainOrder.openingId, caller: work.callerId },
        "Read the delegated-work receipt from Main; do not resume a branch operator by native ID",
      );
    }
    const child = [...this.#registered.values()].find((entry) =>
      entry.runtime.snapshot.events.some((event) =>
        event.id === completion.id && canonical(event) === canonical(completion)
      )
    );
    if (
      !child ||
      !child.runtime.snapshot.messages.some((message) =>
        canonical(workReceipt(message)) === canonical(work)
      )
    ) {
      throw new OperatorConversationError(
        "WORK_CONFLICT",
        "The child completion has no exact canonical work receipt",
        409,
      );
    }
    const parent = this.#registered.get(anchor.operatorId);
    if (!parent?.runtime.enqueueContinuation) {
      throw new OperatorConversationError(
        "RUNTIME_UNAVAILABLE",
        "The parent continuation dispatcher is unavailable",
        409,
      );
    }
    const result = recordedOperatorWork(
      child.runtime.snapshot,
      child.runtime.snapshot.executionModel!.identity.builderId,
      work.callerId,
      work.correlationId,
    )?.result;
    const reply = result?.messages.findLast((message) =>
      message.role === "assistant"
    );
    const observation = result
      ? {
        format: "operator-contribution-completion/v1",
        completionId: completion.id,
        agentId: result.agentId,
        correlationId: result.correlationId,
        invocationId: result.invocationId,
        status: result.status,
        revision: result.revision,
        modelVersion: result.modelVersion,
        candidateIds: result.candidateIds.slice(0, 8),
        omittedCandidateIds: Math.max(0, result.candidateIds.length - 8),
        ...(reply
          ? {
            reply: {
              messageId: reply.id,
              text: reply.text.slice(0, 4000),
              truncated: reply.text.length > 4000,
            },
          }
          : {}),
      }
      : undefined;
    await parent.runtime.enqueueContinuation({
      id: `child-completion:${completion.id}`,
      invocationKey: anchor.invocationKey,
      inputMessageId: anchor.inputMessageId,
      sourceOperatorId:
        child.runtime.snapshot.executionModel!.identity.builderId,
      sourceCompletionId: completion.id,
      completedInvocationId: work.invocationId,
      completionStatus: completion.work.status === "failed"
        ? "failed"
        : "completed",
      ...(observation ? { observation } : {}),
    });
  }

  onChange(listener: (snapshot: ConversationsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    if (this.#disposed || !this.#registered.size) return;
    for (const listener of this.#listeners) {
      try {
        listener(this.snapshot);
      } catch { /* A disconnected observer cannot alter an execution. */ }
    }
  }

  async submitHuman(command: AgentMessageCommand): Promise<string | void> {
    validateText(command.text);
    const visible = this.snapshot.conversations.find((conversation) =>
      conversation.agentId === command.agentId
    );
    requireValue(visible, "UNKNOWN_AGENT", "Opérateur introuvable.", 404);
    const entry = this.#registered.get(command.agentId);
    requireValue(entry, "UNKNOWN_AGENT", "Opérateur introuvable.", 404);
    const current = entry.runtime.snapshot;
    if (
      command.newConversation !== undefined &&
        command.newConversation !== true ||
      command.newConversation && command.caseId !== undefined ||
      command.caseId !== undefined &&
        (typeof command.caseId !== "string" || !command.caseId.trim())
    ) {
      throw new OperatorConversationError(
        "INVALID_MESSAGE",
        "Sélection de conversation invalide.",
        400,
        { agentId: command.agentId },
        "Send caseId to resume a Request, newConversation: true for a new Request, or neither for the designer.",
      );
    }
    if (!visible.canSend) {
      requireValue(
        command.caseId !== undefined && !command.newConversation,
        "READ_ONLY_AGENT",
        "Le modèle admis n’autorise pas de consigne humaine à cet opérateur.",
        403,
      );
      humanRequestCase(current, command.caseId!);
    }
    // Busy wins over a stale view: no message is queued for a later turn.
    this.#reserve(command.agentId, current, command.caseId);
    try {
      if (
        !Number.isSafeInteger(command.expectedRevision) ||
        command.expectedRevision !== current.revision
      ) {
        throw new OperatorConversationError(
          "STALE_CONVERSATION",
          "La conversation a changé ; rechargez-la.",
          409,
          { agentId: command.agentId },
          "Reload /api/conversations and retry with the agent's current revision.",
        );
      }
      if (command.caseId !== undefined) {
        const owner = [...this.#registered.values()].find((unit) =>
          unit.runtime.snapshot.cases?.some((record) =>
            record.id === command.caseId
          )
        );
        if (owner && owner !== entry) {
          throw new CaseError(
            "CASE_NOT_OWNED",
            "Request belongs to another agent",
            { caseId: command.caseId, agentId: command.agentId },
            "Select an open Request owned by this agent or send newConversation: true.",
          );
        }
        humanRequestCase(current, command.caseId);
        requireValue(
          !this.#closingCases.has(command.caseId),
          "CASE_BUSY",
          "La clôture de ce Case est en cours.",
          409,
        );
      }
      return await entry.runtime.submit(
        command.text.trim(),
        undefined,
        command.caseId,
        command.newConversation,
      );
    } finally {
      this.#reserved.delete(command.agentId);
    }
  }

  #reserve(agentId: string, state: SystemRuntimeState, caseId?: string) {
    requireValue(!this.#disposed, "RUNTIME_DISPOSED", "Atelier fermé.", 409);
    requireValue(
      !this.#admitting,
      "MODEL_ADMISSION_BUSY",
      "Une admission de modèle est en cours.",
      409,
    );
    if (state.busy || this.#reserved.has(agentId)) {
      throw new OperatorConversationError(
        "AGENT_BUSY",
        "Une réponse est déjà en cours pour cet opérateur.",
        409,
        { agentId, ...(caseId !== undefined ? { caseId } : {}) },
        "retry after the current reply",
      );
    }
    this.#reserved.add(agentId);
  }

  /** Host-only entry for a Main order already authorized by the opening host. */
  async submitMainWork(
    agentId: string,
    text: string,
    correlationId: string,
    proof: OperatorWorkAdmission,
  ): Promise<OperatorWorkResult> {
    requireValue(
      proof.kind === "mainOrder" && proof.mainOrder,
      "WORK_NOT_AUTHORIZED",
      "A Main order requires its host crossing proof.",
      403,
    );
    const trusted = structuredClone(proof);
    this.#mainOrders.add(trusted);
    try {
      return await this.submitWork(agentId, text, correlationId, trusted);
    } finally {
      this.#mainOrders.delete(trusted);
    }
  }

  async submitWork(
    agentId: string,
    text: string,
    correlationId: string,
    proof: OperatorWorkAdmission,
  ): Promise<OperatorWorkResult> {
    validateText(text);
    requireValue(
      typeof correlationId === "string" && correlationId.length > 0 &&
        correlationId.length <= 512,
      "INVALID_WORK",
      "L’identifiant de travail est absent ou trop long.",
    );
    // Bind the actual caller invocation before handing work to another runtime.
    // Historical receipts without this field remain readable, but never imply a deeper parent.
    const admittedEntry = this.#authorizedTarget(agentId, proof);
    const entry = admittedEntry;
    requireValue(
      entry.runtime.submitWork,
      "RUNTIME_UNAVAILABLE",
      "Cette session ne possède pas d’entrée de travail qualifiée.",
      409,
    );
    const before = entry.runtime.snapshot;
    const recorded = recordedOperatorWork(
      before,
      agentId,
      proof.callerId,
      correlationId,
    );
    const fingerprint = operatorWorkFingerprint(
      agentId,
      text,
      correlationId,
      proof,
      recorded?.legacyMainBehaviorId,
    );
    if (recorded) {
      requireValue(
        recorded.fingerprint === fingerprint &&
          this.#matchesRecordedCase(recorded.result.caseId, proof),
        "WORK_CONFLICT",
        "Ce travail existe déjà avec un autre contenu.",
        409,
      );
      this.#queueSubordinateOrderNotice(agentId, text, proof);
      // Without its terminal receipt, the work is still waiting while its
      // accepted delivery runs (a closed plan re-reading a running sibling);
      // only without a live delivery was it interrupted (crash recovery).
      if (!recorded.settled) {
        requireValue(
          entry.runtime.workDeliveryLive,
          "RUNTIME_UNAVAILABLE",
          "The work delivery inspector is unavailable",
          409,
        );
        if (
          await entry.runtime.workDeliveryLive(proof.callerId, correlationId)
        ) {
          return acceptedWork(agentId, correlationId, proof, before);
        }
      }
      return structuredClone(recorded.result);
    }
    requireValue(
      proof.designerContext && proof.caseId === undefined &&
          proof.caseContext === undefined ||
        proof.caseContext && proof.caseId === proof.caseContext.caseId &&
          proof.designerContext === undefined,
      "WORK_CASE_MISMATCH",
      "Une nouvelle délégation exige le Case explicite de son appelant.",
      403,
    );
    if (!proof.mainOrder) {
      const callerState =
        this.#registered.get(proof.callerId)!.runtime.snapshot;
      const callerInvocation = callerState.caseInvocation;
      const callerInput = invocationInput(callerState, callerInvocation);
      const parentInvocation = callerInvocation && callerInput
        ? {
          operatorId: proof.callerId,
          invocationKey: invocationKey(callerInvocation),
          inputMessageId: callerInput.id,
        }
        : undefined;
      requireValue(
        !proof.parentInvocation ||
          canonical(proof.parentInvocation) === canonical(parentInvocation),
        "WORK_CASE_MISMATCH",
        "The parent invocation anchor does not match this dispatch",
        403,
      );
      proof = { ...proof, ...(parentInvocation ? { parentInvocation } : {}) };
    }
    this.#reserve(agentId, before);
    let releaseCase: (() => void) | undefined;
    try {
      const continuation = this.#reserveCaseContinuation(
        proof.caseContext,
        true,
      );
      releaseCase = continuation.release;
      await entry.runtime.submitWork!({
        text,
        correlationId,
        proof: structuredClone({
          ...proof,
          ...(continuation.context
            ? { caseContext: continuation.context }
            : {}),
        }),
      });
      this.#queueSubordinateOrderNotice(agentId, text, proof);
      // Acceptance is durable, while the target worker may not have started.
      // Return the exact correlation as waiting instead of retaining a worker.
      return acceptedWork(agentId, correlationId, proof, before);
    } finally {
      releaseCase?.();
      this.#reserved.delete(agentId);
    }
  }

  /** The parent of a sub-operator learns of an order another operator gave
   * it, after the order was accepted (4.8e E6). The notice ID is the order's
   * invocation. Accepted replays retry delivery without waiting for it. */
  #queueSubordinateOrderNotice(
    agentId: string,
    text: string,
    proof: OperatorWorkAdmission,
  ): void {
    const key = JSON.stringify([agentId, proof.invocationId]);
    const pending = this.#pendingOrderNotices.get(key);
    if (pending) {
      pending.retry = true;
      return;
    }
    const delivery = { retry: false };
    this.#pendingOrderNotices.set(key, delivery);
    void this.#noticeSubordinateOrder(agentId, text, proof).then(
      (delivered) => {
        this.#pendingOrderNotices.delete(key);
        if (!delivered && delivery.retry) {
          this.#queueSubordinateOrderNotice(agentId, text, proof);
        }
      },
    );
  }

  /** Deliver a deterministic observation of the accepted order. */
  async #noticeSubordinateOrder(
    agentId: string,
    text: string,
    proof: OperatorWorkAdmission,
  ): Promise<boolean> {
    const targetModel = this.#registered.get(agentId)?.runtime.snapshot
      .executionModel;
    const team = targetModel &&
      this.#teamOf(targetModel);
    if (
      !team || (!proof.mainOrder && team.parentOperatorId === proof.callerId)
    ) return true;
    const noticeRecipient = proof.mainOrder
      ? team.requestOwnerId
      : team.parentOperatorId;
    const parent = this.#registered.get(noticeRecipient)?.runtime;
    try {
      requireValue(
        parent?.receiveOperatorNotice,
        "RUNTIME_UNAVAILABLE",
        "The sub-operator's parent cannot receive the order notice.",
        409,
      );
      await parent!.receiveOperatorNotice!(
        {
          kind: "subordinate-order",
          invocationId: proof.invocationId,
          caseId: team.requestId,
          subordinate: agentId,
          orderedBy: {
            operatorId: proof.callerId,
            ...(proof.mainOrder
              ? { executionSpaceId: proof.mainOrder.caller.executionSpaceId }
              : {}),
          },
          summary: text,
        },
        { conversationId: parent!.snapshot.id, caseId: team.requestId },
        {
          wake: false,
        },
      );
      return true;
    } catch (error) {
      this.options.onNoticeError?.(
        new OperatorConversationError(
          "SUBORDINATE_ORDER_NOTICE_FAILED",
          "The accepted order's notice could not be delivered to its parent.",
          409,
          {
            agentId,
            parentOperatorId: noticeRecipient,
            callerId: proof.callerId,
            caseId: team.requestId,
            invocationId: proof.invocationId,
            cause: error instanceof Error ? error.message : String(error),
          },
          "The order is accepted; restore the parent's notice delivery and replay the same order to retry the notice.",
        ),
      );
      return false;
    }
  }

  #matchesRecordedCase(
    caseId: string | undefined,
    proof: OperatorWorkAdmission,
  ) {
    if (caseId === proof.caseId) return true;
    if (caseId !== undefined) return false;
    const callerState = this.#registered.get(proof.callerId)?.runtime.snapshot;
    const migrated = callerState?.cases?.find((record) =>
      record.id === proof.caseId && record.owner === proof.callerId &&
      record.migratedFrom === "legacy-dossier"
    );
    return !!migrated && isOpenCase(migrated);
  }

  #authorizedTarget(agentId: string, proof: OperatorWorkAdmission) {
    const caller = this.#registered.get(proof.callerId);
    const callerState = caller?.runtime.snapshot;
    const callerModel = callerState?.executionModel;
    const target = this.#registered.get(agentId);
    requireValue(target, "UNKNOWN_AGENT", "Opérateur introuvable.", 404);
    const targetModel = target.runtime.snapshot.executionModel;
    const team = targetModel &&
      this.#teamOf(targetModel);
    if (proof.kind === "mainOrder") {
      const crossing = proof.mainOrder;
      const parent = team &&
        this.#registered.get(team.requestOwnerId)?.runtime.snapshot;
      const record = parent?.cases?.find((entry) =>
        entry.id === team?.requestId
      );
      requireValue(
        this.#mainOrders.has(proof) &&
          crossing.caller.executionSpaceId === "main" &&
          crossing.caller.operatorId === proof.callerId &&
          !!crossing.openingId?.trim() &&
          !!proof.invocationId?.trim() && proof.designerContext === undefined &&
          (target.unit.inboxNativeIds ??
            [target.unit.model.flows.conversation.rootNativeId]).includes(
              proof.targetNativeId,
            ) &&
          !!team && proof.caseId === team.requestId &&
          proof.caseContext?.caseId === proof.caseId &&
          proof.caseContext.record?.owner === team.requestOwnerId &&
          !!record && isOpenCase(record) && record.type === "request" &&
          record.owner === team.requestOwnerId &&
          parent?.executionModel?.identity.builderId === team.requestOwnerId,
        "WORK_NOT_AUTHORIZED",
        "This Main order does not match an admitted Request team.",
        403,
      );
      return target;
    }
    const exposure = callerModel?.behaviors?.find((behavior) =>
      behavior.id === proof.behavior.id
    );
    const inboxes = target.unit.inboxNativeIds ??
      [target.unit.model.flows.conversation.rootNativeId];
    requireValue(
      proof.mainOrder === undefined && callerModel && exposure &&
        proof.callerId === callerModel.identity.builderId &&
        exposure.callerNativeId === proof.callerId &&
        canonical(exposure) === canonical(proof.behavior) &&
        proof.modelVersion.digest === callerModel.version.digest &&
        Boolean(proof.modelVersion.repositoryVersion) &&
        typeof proof.invocationId === "string" &&
        proof.invocationId.length > 0 &&
        inboxes.includes(exposure.targetNativeId),
      "WORK_NOT_AUTHORIZED",
      "Ce travail ne correspond pas à une entrée native exposée à l’appelant admis.",
      403,
    );
    const context = callerState && caseExecutionContext(callerState);
    const designer = callerState && designerExecutionContext(callerState);
    if (targetModel?.operatorTeam) {
      // The explicit exposure above is the rule that lets a caller order this
      // member: its parent's, or another one the source declares (4.8e E6).
      // The order stays inside the member's current admitted Request.
      requireValue(
        team !== undefined && proof.caseId === team.requestId &&
          proof.caseId === context?.caseId &&
          team.requestOwnerId ===
            (context?.record?.owner ?? context?.budget?.ownerId) &&
          proof.designerContext === undefined,
        "WORK_CASE_MISMATCH",
        "This team operator can only contribute to its admitted Request",
        403,
      );
    }
    requireValue(
      proof.designerContext !== undefined
        ? designer !== undefined && proof.caseId === undefined &&
          proof.caseContext === undefined &&
          canonical(proof.designerContext) === canonical(designer)
        : proof.caseId === undefined && proof.caseContext === undefined ||
          proof.caseId === context?.caseId && proof.caseContext !== undefined &&
            context !== undefined &&
            sameWorkCaseBinding(proof.caseContext, context) &&
            (context?.number === undefined ||
              Number.isSafeInteger(context.number) && context.number > 0),
      "WORK_CASE_MISMATCH",
      "Le case et son budget doivent provenir du contexte actif de l’appelant.",
      403,
    );
    return target;
  }

  async idle(): Promise<void> {
    await Promise.all(
      [...this.#registered.values()].map((entry) => entry.runtime.idle()),
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    await this.#reconciling?.catch(() => {});
    await this.idle();
    for (const entry of this.#registered.values()) {
      entry.unsubscribe();
      if (!entry.primaryRuntime) {
        await this.options.factory?.close?.(entry.runtime);
      }
    }
    this.#registered.clear();
  }
}

/** Review records are evidence, not an invented peer-to-peer conversation. */
export function reviewerConversation(
  state: SystemRuntimeState,
): AgentConversation | null {
  const model = state.executionModel;
  const reviewer = model?.configuration.reviewer;
  const nativeId = model?.identity.reviewerId;
  if (!model || !reviewer || !nativeId) return null;
  const messages: Message[] = [];
  for (const candidate of state.candidates) {
    const review = candidate.review;
    const evidence = candidate.reviewExecution;
    if (
      !review || !evidence || review.candidateDigest !== candidate.digest ||
      evidence.reviewerId !== reviewer.id
    ) continue;
    const event = state.events.find((entry) =>
      entry.kind === "review-decided" && entry.candidateId === candidate.id &&
      entry.execution?.actionId === evidence.actionId &&
      entry.execution.digest === evidence.modelDigest
    );
    if (!event) continue;
    messages.push({
      id: `review:${event.id}`,
      role: "assistant",
      text: `${candidate.name} · ${review.verdict}\n${review.reason}`,
      at: event.at,
      ...(event.caseId ? { caseId: event.caseId } : {}),
      execution: structuredClone(event.execution),
    });
  }
  return {
    agentId: nativeId,
    nativeId,
    name: reviewer.name,
    responsibility: "Revue des candidats enregistrée dans le système",
    primary: false,
    runtimeOwned: false,
    canSend: false,
    readOnlyReason:
      "Ce mandat prévoit une revue de candidats, sans entrée conversationnelle humaine.",
    revision: state.revision,
    busy: state.busy &&
      state.candidates.some((candidate) => candidate.stage === "reviewing"),
    phase: state.candidates.some((candidate) => candidate.stage === "reviewing")
      ? "Revue en cours"
      : "Revues enregistrées",
    messages,
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  };
}
