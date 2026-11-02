import type { ToolDraft } from "../../../domain/work/candidates.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  HostSpaceController,
  OpeningBase,
  OpeningCommand,
  OpeningPhase,
  OpeningRecord,
  OpeningSourceChoice,
  RequestSpaceScope,
  SpaceControlAdoptedState,
  SpaceControlAuthority,
  SpaceController,
  SpaceControlPrincipal,
  SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";

export interface SpaceControlPort {
  /** Secret is supplied by the owned session cookie, never actor/scope DTOs. */
  authenticateSession(secret: string): Promise<SpaceController>;
  /** Host-internal controller of a Main Operator opening: no session. The
   * owner's current control policy must admit `opener`'s native operator. */
  hostController?(
    ownerId: string,
    opener: ScopedOperatorRef,
  ): Promise<HostSpaceController>;
  revalidate(controller: SpaceControlPrincipal): Promise<void>;
}
/** The Main Operator's own authority to open a Request (4.8d D3, settled Q1):
 * the `open-request` act of its current admitted mandate. */
export interface MainOpenerAuthorityPort {
  /** The system owner whose space the Main Operator opens, or FORBIDDEN when
   * `operator` is not the registered Main or its mandate lacks the act. */
  current(operator: ScopedOperatorRef): Promise<string>;
}
export interface SpaceControlAuthorityPort {
  /** Host binds this to the CURRENT admitted control source, independently of
   * the Request base, source visibility, runtime role and browser identity. */
  current(ownerId: string): Promise<SpaceControlAuthority>;
}
/** Only local capability issuance needs the atomic adopted-state precondition. */
export interface SpaceCapabilityAuthorityPort
  extends SpaceControlAuthorityPort {
  capture(
    ownerId: string,
  ): Promise<
    { authority: SpaceControlAuthority; adoptedState: SpaceControlAdoptedState }
  >;
}
export interface OpeningSourcePort {
  /** Exact retained tool bytes only; optional historical fixtures support no tools. */
  readTool?(
    base: OpeningBase,
    operatorId: string,
    candidateId: string,
  ): Promise<ToolDraft>;
  /** Called only while an intention has no selected base. No synthetic Release. */
  resolve(
    choice: OpeningSourceChoice,
    controller?: SpaceControlPrincipal,
  ): Promise<OpeningBase>;
  /** Exact retained-source verification; never reread current main on recovery. */
  verify(base: OpeningBase): Promise<void>;
  /** Verify the exact retained base, current host support and retained assets
   * afresh, then return its admitted models from that same verified traversal.
   * Callers need not precede this operation with a separate verify call. */
  readModels(base: OpeningBase): Promise<readonly ExecutableModel[]>;
  /** Read-only historical inspection verifies the recorded base, retained assets
   * and exact models, independently of current execution-host readiness. It
   * neither prepares bundles nor supplies authority to execute or open work. */
  readModelsForInspection(
    base: OpeningBase,
  ): Promise<readonly ExecutableModel[]>;
}
export interface OpeningStorePort {
  /** Uniqueness includes host scope + owner + openingKey. Existing command
   * digest mismatch refuses before mutation or Case number allocation.
   * Uses the existing system CaseSequence, never a parallel counter. */
  begin(
    input: { ownerId: string; command: OpeningCommand; commandDigest: string },
  ): Promise<OpeningRecord>;
  /** Immutable resolve-once CAS. Returns the recorded winner on a lost CAS. */
  selectBase(
    input: {
      id: string;
      ownerId: string;
      expectedRevision: number;
      base: OpeningBase;
      baseDigest: string;
    },
  ): Promise<OpeningRecord>;
  advance(
    input: {
      id: string;
      ownerId: string;
      expectedRevision: number;
      from: OpeningPhase;
      to: OpeningPhase;
      admissionId?: string;
    },
  ): Promise<OpeningRecord>;
  issue(
    input: {
      id: string;
      ownerId: string;
      expectedRevision: number;
      code: string;
    },
  ): Promise<OpeningRecord>;
  get(id: string): Promise<OpeningRecord | null>;
  forCase(caseId: string): Promise<OpeningRecord | null>;
}
export interface RequestBranchPort {
  /** Must share the authoritative repository writer lock. Create only this
   * host-issued branch at base.sourceVersion; never move main or an old ref. */
  ensure(record: OpeningRecord): Promise<void>;
  /** Resolve the actual retained Case ref, never current main. */
  sourceVersion(record: OpeningRecord): Promise<string>;
  /** Exact historical consultation must belong to this branch first-parent history. */
  assertVersion(record: OpeningRecord, version: string): Promise<void>;
  /** Runtime-only retained ancestry, even during a later in-flight publication.
   * Caller independently proves version is immutable B0 or the exact coherent
   * execution binding. Git ancestry alone never proves source admission. */
  assertRetainedExecutionVersion(
    record: OpeningRecord,
    version: string,
  ): Promise<void>;
}
export interface RequestSpaceRuntimePort {
  /** Strictly inert provisioning/restoration: fresh scoped state, no provider,
   * tool, scheduled work, model publication, seed activation or enqueue. */
  provision(record: OpeningRecord): Promise<void>;
  /** Explicit idempotent seed preparation after inert birth, before admission.
   * This operation may retain the exact source-declared bundled instructions. */
  prepareInitialSkills(record: OpeningRecord): Promise<void>;
  /** Native queue idempotency binds initialContributionId + exact recorded base.
   * Runtime MUST enforce admission again at each actual effect start. */
  enqueue(
    record: OpeningRecord,
    admission: SpaceExecutionAdmission,
  ): Promise<void>;
  /** The Main Operator's own input to an open Request's BO (settled Q3). */
  submitFromMain?(
    record: OpeningRecord,
    written: {
      resumeId: string;
      instruction: string;
      at: string;
      operatorId?: string;
    },
    admission: SpaceExecutionAdmission,
    opener?: import("../../../domain/work/request-spaces.ts").MainOpener,
  ): Promise<void>;
}
export interface SpaceAdmissionPort {
  /** Existing revoked/expired admission never becomes active on retry. */
  ensure(
    record: OpeningRecord,
    controller: SpaceControlPrincipal,
  ): Promise<SpaceExecutionAdmission>;
  assertDispatch(
    record: OpeningRecord,
    admission: SpaceExecutionAdmission,
  ): Promise<void>;
  /** The recorded admission of a dispatched opening, read without a
   * controller; every use still passes `assertDispatch`. */
  recorded?(record: OpeningRecord): Promise<SpaceExecutionAdmission>;
  revoke(
    id: string,
    controller: SpaceController,
  ): Promise<SpaceExecutionAdmission>;
}
export interface RequestSpaceHostOptions {
  scope: RequestSpaceScope;
  /** Bound once Main registers; absent, Main Operator openings refuse. */
  mainOpener?: MainOpenerAuthorityPort;
  source: OpeningSourcePort;
  store: OpeningStorePort;
  control: SpaceControlPort;
  branches: RequestBranchPort;
  runtime: RequestSpaceRuntimePort;
  admissions: SpaceAdmissionPort;
}
