import type { RequestAuthorityRoute } from "../../../domain/governance/operator-authority.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { AuthorityExercise } from "../../../domain/governance/authority.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";
import type { ModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import type { RequestModelWriteLocator } from "../../../domain/model/editing/request-write-destination.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  OpeningRecord,
  SpaceController,
  SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import type { EvolutionBlocker } from "./ports.ts";

/** Complete server-resolved destination. An operator ID alone never selects a Request. */
export interface RequestAdoptionTarget extends RequestModelWriteLocator {
  readonly operatorId: string;
}
export interface RequestExecutionPin {
  readonly source: ModelRevisionRef;
  readonly modelDigest: string;
  readonly sourceAdmission: {
    readonly revision: number;
    readonly manifestDigest: string;
  };
  readonly adoption: null | {
    readonly commandId: string;
    readonly receiptDigest: string;
    readonly committedRuntimeRevision: number;
  };
}
export interface RequestExecutionBinding {
  readonly state: SystemRuntimeState;
  readonly pin: RequestExecutionPin;
  readonly admission: SpaceExecutionAdmission;
}
export interface RequestExecutionBindingPort {
  /** One coherent read-only snapshot. No initialization, backfill, readiness probe or writes. */
  read(
    opening: OpeningRecord,
    requester?: ScopedOperatorRef,
  ): Promise<RequestExecutionBinding>;
}
export interface RequestHumanAdoptionDecision {
  readonly kind: "request-human-adoption-decision";
  readonly controller: SpaceController;
  readonly sessionRevision: number;
  readonly exercise: AuthorityExercise;
  readonly capturedAt: string;
}
/** Spec 4.8c: the Main Operator's recorded delegated network decision
 * authorizes adopting exactly its approved host delta. It names that decision
 * by digest and carries its delegated exercise; no human session exists. */
export interface RequestDelegatedAdoptionDecision {
  readonly kind: "request-delegated-adoption-decision";
  readonly authorityDigest: string;
  readonly exercise: AuthorityExercise;
  /** Required for new captures and member/same-space decisions. Historical
   * Main-to-BO decisions retain their original serialized bytes. */
  readonly route?: RequestAuthorityRoute;
  readonly capturedAt: string;
}
/** Spec 4.8e: the creator's recorded creation-grant decision authorizes
 * adopting exactly its one provisioned teammate. No human session exists. */
export interface RequestCreationGrantAdoptionDecision {
  readonly kind: "request-creation-grant-adoption-decision";
  readonly authorityDigest: string;
  readonly exercise: AuthorityExercise;
  readonly capturedAt: string;
}
export type RequestAdoptionDecision =
  | RequestHumanAdoptionDecision
  | RequestDelegatedAdoptionDecision
  | RequestCreationGrantAdoptionDecision;
/** Immutable references; each is reconstructed from persisted host evidence. */
export interface RequestNetworkAdoptionProof {
  readonly kind: "request-network-host-adoption/v1";
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly approvedChangeDigest: string;
  readonly addedHosts: readonly string[];
  readonly sourceAdmission: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly commandId: string;
    readonly publicationReceiptDigest: string;
    readonly resultVersion: string;
  };
}
/** The exact approved first creation grant; it adds no team member. */
export interface RequestCreationPolicyAdoptionProof
  extends Omit<RequestNetworkAdoptionProof, "kind" | "addedHosts"> {
  readonly kind: "request-creation-policy-adoption/v1";
}
/** Immutable team-creation proof (4.8e): the published child system of the
 * one provisioned teammate, bound to the recorded decision by digests. */
export interface RequestTeamAdoptionProof {
  readonly kind: "request-team-creation-adoption/v1";
  readonly changeId: string;
  readonly proposalIntentDigest: string;
  readonly approvedChangeDigest: string;
  readonly childSystemId: string;
  /** Exact publication predecessor A when a member still executes at R.
   * Already published sibling roots do not become this creation's delta. */
  readonly publicationBase?: ExecutableModel;
  /** The whole verified branch team at the candidate source, in admission
   * order: the transition writes exactly these permissions. */
  readonly team: readonly {
    readonly operatorId: string;
    readonly modelDigest: string;
  }[];
  readonly sourceAdmission: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly commandId: string;
    readonly publicationReceiptDigest: string;
    readonly resultVersion: string;
  };
}
export interface RequestAdoptionIntent {
  readonly target: RequestAdoptionTarget;
  readonly openingBaseDigest: string;
  readonly adoptionKey: string;
  readonly commandDigest: string;
  readonly accountingDigest: string;
  readonly previous: {
    readonly pin: RequestExecutionPin;
    readonly identity: ExecutableModel["identity"];
    readonly admission: SpaceExecutionAdmission;
  };
  readonly candidate: {
    readonly source: ModelRevisionRef;
    readonly sourceDigest: string;
    readonly sourceAdmission: {
      readonly revision: number;
      readonly manifestDigest: string;
    };
    readonly build: BuildDescriptor;
    readonly model: ExecutableModel;
    readonly compatibilityDigest: string;
  };
  readonly decision: RequestAdoptionDecision;
  readonly network?: RequestNetworkAdoptionProof;
  readonly team?: RequestTeamAdoptionProof;
  readonly creationPolicy?: RequestCreationPolicyAdoptionProof;
}
/** Manifest contains exact immutable intent and independently current completion authority.
 * Its digest is computed before the dossier receipt references it. */
export interface RequestAdoptionManifest {
  readonly format: "request-runtime-adoption/v2";
  readonly commandId: string;
  readonly intent: RequestAdoptionIntent;
  readonly completion: RequestAdoptionDecision;
  readonly predecessor: { readonly revision: number; readonly digest: string };
  readonly sourceHead: {
    readonly revision: number;
    readonly manifestDigest: string;
  };
  readonly previousRuntimeRevision: number;
  readonly authorizationRuntimeRevision: number;
  readonly committedRuntimeRevision: number;
  readonly admissionRevision: number;
  readonly nativeRetirement: {
    readonly digest: string;
    readonly predecessorThreadIds: readonly string[];
    readonly successorThreadIds: readonly string[];
  };
}
export interface RequestAdoptionReceipt {
  readonly commandId: string;
  readonly receiptDigest: string;
  readonly committedRuntimeRevision: number;
  readonly journalRevision: number;
  readonly journalDigest: string;
  readonly recordedAt: string;
}
export type RequestAdoptionPhase =
  | "prepared"
  | "armed"
  | "adopted"
  | "refused"
  | "cancelled";
export interface RequestOwnerAdoptionDossier {
  readonly v: 2;
  readonly kind: "request-owner-adoption";
  readonly id: string;
  readonly repositoryId: string;
  readonly revision: number;
  readonly status: RequestAdoptionPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly intent: RequestAdoptionIntent;
  readonly blockers: readonly EvolutionBlocker[];
  readonly completion?: RequestAdoptionDecision;
  readonly receipt?: RequestAdoptionReceipt;
}
/** Typed Request facade; existing EvolutionStorePort remains v1 and Main only. */
export interface RequestOwnerAdoptionStorePort {
  create(
    target: RequestAdoptionTarget,
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<RequestOwnerAdoptionDossier>;
  get(
    target: RequestAdoptionTarget,
    id: string,
  ): Promise<RequestOwnerAdoptionDossier | null>;
  listPending(
    target: RequestAdoptionTarget,
  ): Promise<RequestOwnerAdoptionDossier[]>;
  listRecent(
    target: RequestAdoptionTarget,
    limit: number,
  ): Promise<RequestOwnerAdoptionDossier[]>;
  compareAndSwap(
    target: RequestAdoptionTarget,
    id: string,
    expectedRevision: number,
    next: RequestOwnerAdoptionDossier,
  ): Promise<RequestOwnerAdoptionDossier>;
  targetOwner(target: RequestAdoptionTarget): Promise<string | null>;
  onChange?(target: RequestAdoptionTarget, listener: () => void): () => void;
}
export interface RequestAdoptionSelection {
  readonly version: string;
  readonly digest: string;
}
export interface RequestAdoptionStatus {
  readonly caseId: string;
  readonly adoptionKey: string;
  readonly status: RequestAdoptionPhase;
  readonly before: RequestAdoptionSelection;
  readonly target: RequestAdoptionSelection;
  readonly blockers: readonly {
    readonly code: string;
    readonly detail: string;
  }[];
  readonly receipt?: RequestAdoptionReceipt;
}
export interface RequestAdoptionEligibility {
  readonly caseId: string;
  readonly eligible: boolean;
  readonly executing: RequestAdoptionSelection;
  readonly admitted: RequestAdoptionSelection;
  readonly blockers: readonly {
    readonly code: string;
    readonly detail: string;
  }[];
}
export interface RequestAdoptionPrepare {
  readonly caseId: string;
  readonly adoptionKey: string;
  readonly expectedAdmittedVersion: string;
  readonly expectedExecutingDigest: string;
}
export interface RequestAdoptionLookup {
  readonly caseId: string;
  readonly adoptionKey: string;
}
export interface RequestRuntimeAdoptionPort {
  eligibility(
    secret: string,
    caseId: string,
  ): Promise<RequestAdoptionEligibility>;
  prepare(
    secret: string,
    input: RequestAdoptionPrepare,
  ): Promise<RequestAdoptionStatus>;
  prepareNetwork(
    secret: string,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus>;
  prepareTeam(
    secret: string,
    input: RequestAdoptionPrepare & { changeId: string },
  ): Promise<RequestAdoptionStatus>;
  resume(
    secret: string,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus>;
  status(
    secret: string,
    input: RequestAdoptionLookup,
  ): Promise<RequestAdoptionStatus | null>;
}
export class RequestAdoptionError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "FORBIDDEN"
      | "CONFLICT"
      | "UNAVAILABLE"
      | "BLOCKED",
    message: string,
    options?: ErrorOptions & {
      context?: Record<string, unknown>;
      recovery?: string;
    },
  ) {
    super(message, options);
    this.name = "RequestAdoptionError";
    this.context = options?.context;
    this.recovery = options?.recovery;
  }
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;
}

export interface RequestAdoptionSession {
  readonly controller: SpaceController;
  readonly sessionRevision: number;
}
export interface RequestAdoptionContext {
  readonly opening: OpeningRecord;
  readonly target: RequestAdoptionTarget;
  readonly binding: RequestExecutionBinding;
  readonly candidate: RequestAdoptionIntent["candidate"];
  readonly network?: RequestNetworkAdoptionProof;
  readonly team?: RequestTeamAdoptionProof;
  readonly creationPolicy?: RequestCreationPolicyAdoptionProof;
}
export interface RequestAdoptionContextPort {
  authenticate(secret: string): Promise<RequestAdoptionSession>;
  ownedOpening(
    controller: SpaceController,
    caseId: string,
  ): Promise<OpeningRecord>;
  resolve(
    session: RequestAdoptionSession,
    opening: OpeningRecord,
    networkChangeId?: string,
  ): Promise<RequestAdoptionContext>;
  revalidateRead(
    session: RequestAdoptionSession,
    opening: OpeningRecord,
  ): Promise<void>;
  /** Host-internal (4.8c): the Request of a Case, read without any session. */
  hostOpening(caseId: string): Promise<OpeningRecord>;
  /** Host-internal (4.8c): the same proof as `resolve` for one network change
   * whose recorded decision and publication both carry the MO's delegated
   * authority `authorityDigest`. Never reached from a person's API. */
  resolveDelegated(
    opening: OpeningRecord,
    networkChangeId: string,
    authorityDigest: string,
    requester?: ScopedOperatorRef,
  ): Promise<RequestAdoptionContext>;
  /** Host-internal (4.8e): the same proof as `resolve` for one team creation
   * whose recorded decision and publication both carry the creator's
   * creation grant `authorityDigest`. Never reached from a person's API. */
  resolveCreationGrant(
    opening: OpeningRecord,
    teamChangeId: string,
    authorityDigest: string,
    requester?: ScopedOperatorRef,
  ): Promise<RequestAdoptionContext>;
}
export interface RequestAdoptionTransitionPort {
  /** Explicit same-key resume may release an obsolete inert intent only after
   * durable no-effect proof. Read-only status never invokes this operation. */
  settleObsolete(
    dossier: RequestOwnerAdoptionDossier,
    /** Absent only for a delegated dossier, which no session owns. */
    session?: RequestAdoptionSession,
  ): Promise<RequestOwnerAdoptionDossier | null>;
  /** Preserve prepared/unarmed on accepted R0 work. A real quiet checkpoint,
   * independent current human authorization and one final atomic commit only. */
  attempt(
    dossier: RequestOwnerAdoptionDossier,
    completion: RequestAdoptionDecision,
  ): Promise<RequestOwnerAdoptionDossier>;
}
