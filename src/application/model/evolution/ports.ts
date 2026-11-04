import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { SystemRuntime } from "../../work/runtime/system.ts";
import type { NativeExecutionSnapshot } from "../../work/native-execution/contract.ts";
import type { RequestExecutionBinding } from "./request-adoption-ports.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "./scoped-software-dossier.ts";
import type { ScopedSoftwareFinalBoundaryV2 } from "./scoped-software-adoption.ts";
import type { EvolutionService } from "./service.ts";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
  EvolutionCategory,
} from "../../../domain/model/evolution/policy.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";

export interface EvolutionOrigin {
  operatorId: string;
  requestId?: string;
  designerScopeId?: string;
  /** Host-proven destination scopes. The preparer's scope alone never scopes
   * another target's effective-change event. Absent entries remain unscoped. */
  targetScopes?: {
    operatorId: string;
    requestId?: string;
    designerScopeId?: string;
  }[];
}

export interface EvolutionTarget {
  operatorId: string;
  previousDigest: string;
  candidateDigest: string;
}

/** Exact immutable proposal on a non-admitted branch. */
export interface EvolutionProposal {
  id: string;
  version: string;
  baseVersion: string;
  sourceDigest: string;
  recipeDigest: string;
  digest: string;
  /** Production staging freezes the source/recipe/artifact/contract identities. */
  build?: BuildDescriptor;
  /** Closed scoped preimage; omitted by the historical Main v1 path. */
  scoped?: import("./scoped-software-proposal.ts").ScopedSoftwareProposalV2;
  targets: EvolutionTarget[];
  categories: EvolutionCategory[];
}

interface EvolutionPreparationBase {
  id: string;
  repositoryId: string;
  actorId: string;
  finalizerActorId: string;
  origin: EvolutionOrigin;
  expectedVersion: string;
  reason: string;
  /** Native host-only command identity, absent from Main v1. */
  callerCommandId?: string;
  callerCommandDigest?: string;
}
/** Public targeted editing is resolved against the exact base by native tooling.
 * Raw source replacement remains available only under its distinct real grant. */
export type EvolutionPreparationInput =
  & EvolutionPreparationBase
  & (
    | { edit: ModelEditRequest; sources?: never }
    | { sources: Record<string, string>; edit?: never }
  );

export interface EvolutionPublication {
  commandId: string;
  commandDigest: string;
  version: string;
  sourceDigest: string;
  proposalDigest: string;
}

export interface EvolutionAdoptionReceipt {
  operatorId: string;
  previousDigest: string;
  candidateDigest: string;
  version: string;
  proposalDigest: string;
  effectiveAt: string;
}

export interface EvolutionBlocker {
  code: string;
  operatorId?: string;
  detail: string;
}

export type EvolutionStatus =
  | "prepared"
  | "accepted"
  | "armed"
  | "publishing"
  | "published-awaiting-adoption"
  | "adopted"
  | "cancelled"
  | "superseded"
  | "refused"
  | "needs-decision";

/** Outside CaseInvocation: origin is provenance, never an executable context. */
export interface EvolutionDossier {
  v: 1;
  id: string;
  repositoryId: string;
  revision: number;
  status: EvolutionStatus;
  origin: EvolutionOrigin;
  finalizerActorId: string;
  accounting: { id: string; agentInvocations: 0 };
  createdAt: string;
  updatedAt: string;
  proposal: EvolutionProposal;
  preparation: EvolutionAuthorityExercise;
  acceptance?: EvolutionAuthorityExercise;
  adoptionAuthorization?: EvolutionAuthorityExercise;
  cancellation?: EvolutionAuthorityExercise;
  publication?: EvolutionPublication;
  adoptions: EvolutionAdoptionReceipt[];
  blockers: EvolutionBlocker[];
}

export function hasEvolutionBarrier(status: EvolutionStatus): boolean {
  return status === "armed" || status === "publishing" ||
    status === "published-awaiting-adoption";
}

export type EvolutionDossierBase = Omit<EvolutionDossier, "v">;
/** Closed software families; human Request adoption has its separate service. */
export type SoftwareEvolutionDossier =
  | EvolutionDossier
  | import("./scoped-software-dossier.ts").ScopedSoftwareEvolutionDossierV2;

export interface EvolutionStorePort<
  D extends SoftwareEvolutionDossier = EvolutionDossier,
> {
  /** Post-commit read notifications; never part of the durable write transaction. */
  onChange?(listener: () => void): () => void;
  create(dossier: D): Promise<D>;
  get(id: string): Promise<D | null>;
  listPending(repositoryId: string): Promise<D[]>;
  /** Bounded read-only history, including terminal receipts after restart. */
  listRecent?(repositoryId: string, limit: number): Promise<D[]>;
  /** CAS and all target ownership changes happen in one durable transaction.
   * Armed/publishing/published targets have one owner; terminal transitions
   * release them. Failure leaves the prior dossier and every owner intact. */
  compareAndSwap(
    id: string,
    expectedRevision: number,
    next: D,
  ): Promise<D>;
  targetOwner(repositoryId: string, operatorId: string): Promise<string | null>;
}

export interface EvolutionAuthorityPort {
  authorize(
    act: EvolutionAct,
    actorId: string,
    proposal: EvolutionProposal,
  ): Promise<EvolutionAuthorityExercise>;
  /** Current prior grant must reproduce the exact stored receipt; candidate
   * grants cannot authorize their own proposal. Throw on revocation or drift. */
  revalidate(
    receipt: EvolutionAuthorityExercise,
    proposal: EvolutionProposal,
  ): Promise<void>;
}

export interface EvolutionRepositoryPort<
  D extends SoftwareEvolutionDossier = EvolutionDossier,
> {
  /** Compiles/validates exact scope and stages a proposal without changing HEAD.
   * Must enforce ordinary source editing plus native prepare authority. */
  prepare(input: EvolutionPreparationInput): Promise<EvolutionProposal>;
  /** Exact source base, identities, recipe and supported constructs. No rebase. */
  revalidate(dossier: D): Promise<void>;
  /** Existing durable shared writer / Git CAS. Idempotence by command anchor. */
  publish(dossier: D): Promise<EvolutionPublication>;
  findPublication(
    dossier: D,
  ): Promise<EvolutionPublication | null>;
}

export interface EvolutionCheckpoint {
  safe: boolean;
  blockers: EvolutionBlocker[];
}

export interface EvolutionTargetPort<
  D extends SoftwareEvolutionDossier = EvolutionDossier,
> {
  /** Verify the claimed origin against the preparer's actual current host
   * invocation and real Request/designer provenance. Return canonical origin
   * plus only target scopes proven by actual contribution/team context.
   * Caller-supplied targetScopes are never an authority source. The proof is
   * frozen now; finalization does not require the origin to remain open. */
  captureOrigin(
    input: { actorId: string; origin: EvolutionOrigin },
    proposal: EvolutionProposal,
  ): Promise<EvolutionOrigin>;
  /** Hold sorted, transient target gates against ordinary owner pin mutation
   * until the durable arming CAS completes. Existing normal contributions may
   * keep running; this is not a completed-contribution reservation. An owner
   * adoption already in progress must produce a visible retry refusal. */
  withArmingTargets<T>(
    dossier: D,
    saveArmed: () => Promise<T>,
  ): Promise<T>;
  /** Reserve targets in stable order using the command admission exclusion.
   * Re-read durable contribution/cursor/batch/effect/budget state afterwards.
   * Keep runtime exclusion through callback, including publication/adoption.
   * This MUST NOT acquire or retain a Git repository lock while waiting. */
  withReservedTargets<T>(
    dossier: D,
    operation: (
      checkpoint: EvolutionCheckpoint,
      revalidate?: () => Promise<EvolutionCheckpoint>,
    ) => Promise<T>,
  ): Promise<T>;
  /** Idempotent exact adoption preserving accounting/history. Every effect
   * uses the dossier's prior authorization, never owner/Main fallback. */
  adoptExact(
    dossier: D,
    target: EvolutionTarget,
    publication: EvolutionPublication,
  ): Promise<EvolutionAdoptionReceipt>;
  /** Read actual durable target receipt after a crash, without replaying work. */
  inspectAdoption(
    dossier: D,
    target: EvolutionTarget,
    publication: EvolutionPublication,
  ): Promise<EvolutionAdoptionReceipt | null>;
}

export class EvolutionError extends Error {
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions & {
      context?: Record<string, unknown>;
      recovery?: string;
    },
  ) {
    super(message, options);
    this.name = "EvolutionError";
    this.context = options?.context;
    this.recovery = options?.recovery;
  }
}

/** A real, admitted instance. Root obtains these from RequestSpaceRuntime's
 * composite resolver; no native-ID-only lookup or OpeningOwner substitution. */
export interface ScopedSoftwareRuntimeTarget<TStores = unknown> {
  readonly ref: Readonly<ScopedOperatorRef>;
  readonly opening: OpeningRecord;
  readonly runtime: Pick<
    SystemRuntime,
    | "snapshot"
    | "withEvolutionArming"
    | "withEvolutionReservation"
    | "evolutionBoundary"
    | "readPersistedState"
    | "configureOperatorEvolution"
    | "bindEvolutionBarrier"
    | "onState"
    | "prepareSoftwareEvolutionStates"
    | "evolutionValidationTarget"
  >;
  readonly stores: TStores;
  readBinding(): Promise<RequestExecutionBinding>;
  inspectNative(): Promise<NativeExecutionSnapshot[]>;
}
export interface ScopedSoftwareAdoptionPort<TStores = unknown> {
  adopt(input: {
    dossier: ScopedSoftwareEvolutionDossierV2;
    target: EvolutionTarget;
    publication: EvolutionPublication;
    runtime: ScopedSoftwareRuntimeTarget<TStores>;
    candidate: ExecutableModel;
    boundary: ScopedSoftwareFinalBoundaryV2;
    /** Called again by the transaction bridge under its durable locks. */
    revalidate(): Promise<void>;
  }): Promise<EvolutionAdoptionReceipt>;
  inspect(input: {
    dossier: ScopedSoftwareEvolutionDossierV2;
    target: EvolutionTarget;
    publication: EvolutionPublication;
    runtime: ScopedSoftwareRuntimeTarget<TStores>;
  }): Promise<EvolutionAdoptionReceipt | null>;
}
export interface ScopedSoftwareEvolutionBinding {
  readonly service: EvolutionService<ScopedSoftwareEvolutionDossierV2>;
  recover(): Promise<void>;
  requestFinalization(): void;
  dispose(): void;
}
