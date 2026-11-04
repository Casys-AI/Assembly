import type { PublicationEdit } from "./compatibility.ts";
import type { AuthorityExercise } from "../../governance/authority.ts";
import type { ExecutableModel } from "../execution/executable-model.ts";
import type { AdmissionRecord } from "../../work/records/candidates.ts";
import type { PendingChange } from "../../governance/records/pending-change.ts";
import { canonical } from "../../primitives/canonical-json.ts";

/** Immutable commit receipt. The Git ref is only its lookup index. */
export interface ChangePublication {
  type?: never;
  changeId: string;
  authorityExercise: AuthorityExercise;
  baseModelDigest: string;
  baseRevision: number;
  adoptedPin: Pick<ExecutableModel["version"], "digest" | "repositoryVersion">;
  /** Host-captured displayed source base. Distinct from the actual execution
   * pin retained for adoption/recovery. Missing historical fields stay missing. */
  approvedSourceBase?: NonNullable<PendingChange["diff"]>["base"];
  decidedAt: string;
  /** Exact new proposal and provenance, absent only from historical receipts. */
  proposal?: ReturnType<typeof proposalIdentity>;
  /** Filled under the writer lock, then frozen in the commit.
   * Operations carry op; legacy names are paths relative to their owner. */
  edits: PublicationEdit[];
}

/** Activation records the actual admission, including non-owner admission. */
export interface CandidateActivationPublication {
  type: "candidate-activation";
  changeId: string;
  systemId: string;
  builderId: string;
  candidateId: string;
  candidateDigest: string;
  admission: AdmissionRecord;
  baseModelDigest: string;
  baseRevision: number;
  adoptedPin: Pick<ExecutableModel["version"], "digest" | "repositoryVersion">;
  decidedAt: string;
  edits: PublicationEdit[];
}
export type SourcePublication =
  | ChangePublication
  | CandidateActivationPublication;

function validApprovedSourceBase(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 3 &&
    ["repositoryVersion", "sourceDigest", "modelDigest"].every((key) =>
      typeof fields[key] === "string" && fields[key].length > 0
    );
}

/** New receipts bind the exact displayed source base; legacy receipts retain
 * their original strict execution-pin source semantics. Never synthesize a base. */
export function publicationSourceVersion(
  publication: SourcePublication,
): string | undefined {
  const value = (publication as ChangePublication).approvedSourceBase;
  if (
    value !== undefined && (publication.type === "candidate-activation" ||
      !validApprovedSourceBase(value) ||
      value.modelDigest !== publication.baseModelDigest)
  ) {
    throw new ChangePublicationError(
      "PUBLICATION_RECEIPT_MISMATCH",
      { changeId: publication.changeId },
      "Approved source base is malformed or belongs to another execution contract.",
    );
  }
  return value?.repositoryVersion ?? publication.adoptedPin?.repositoryVersion;
}
export function publicationSystemId(publication: SourcePublication): string {
  return publication.type === "candidate-activation"
    ? publication.systemId
    : publication.authorityExercise.systemId;
}
export function publicationAuthor(publication: SourcePublication): string {
  return publication.type === "candidate-activation"
    ? `ase:activate-candidate:${publication.builderId}`
    : `ase:approved-change:${publication.changeId}`;
}

export interface ApprovedChangePublication {
  model: ExecutableModel;
  /** Absent only for historical commits predating the trailer. */
  receipt?: ChangePublication;
}

export class ChangePublicationError extends Error {
  readonly recovery: "refuse" | "retry" | { readonly action: "reload" };
  constructor(
    readonly code:
      | "PUBLICATION_ALREADY_APPLIED"
      | "PUBLICATION_RECEIPT_MISMATCH"
      | "PUBLICATION_RECEIPT_MISSING"
      | "PUBLICATION_NOT_APPLICABLE"
      | "PUBLICATION_FAILED"
      | "PUBLICATION_RECEIPT_TOO_LARGE",
    readonly context: { changeId: string; systemId?: string },
    message: string,
  ) {
    super(message);
    this.name = "ChangePublicationError";
    this.recovery = (code === "PUBLICATION_NOT_APPLICABLE" ||
        code === "PUBLICATION_RECEIPT_TOO_LARGE")
      ? "refuse"
      : code === "PUBLICATION_FAILED"
      ? "retry"
      : { action: "reload" };
  }
}

function proposalIdentity(change: PendingChange) {
  // Omit absent fields so an in-memory receipt matches its durable JSON form.
  return {
    kind: change.kind,
    reason: change.reason,
    ...(change.requestedBy !== undefined
      ? { requestedBy: change.requestedBy }
      : {}),
    ...(change.caseId !== undefined ? { caseId: change.caseId } : {}),
    ...(change.designerScopeId !== undefined
      ? { designerScopeId: change.designerScopeId }
      : {}),
    ...(change.requestedRights !== undefined
      ? { requestedRights: change.requestedRights }
      : {}),
    ...(change.name !== undefined ? { name: change.name } : {}),
    ...(change.role !== undefined ? { role: change.role } : {}),
    ...(change.operator !== undefined ? { operator: change.operator } : {}),
    ...(change.teamOrigin !== undefined
      ? { teamOrigin: change.teamOrigin }
      : {}),
    ...(change.diff !== undefined
      ? { sourceDigest: change.diff.sourceDigest }
      : {}),
  };
}

/** Compare recorded facts, never reissue authority from a historical model. */
export function assertPublicationMatches(
  change: PendingChange,
  receipt: ChangePublication,
): void {
  if (
    receipt.proposal !== undefined &&
      canonical(receipt.proposal) !== canonical(proposalIdentity(change)) ||
    receipt.changeId !== change.id ||
    receipt.baseRevision !== change.baseRevision ||
    change.baseModelDigest !== undefined &&
      receipt.baseModelDigest !== change.baseModelDigest ||
    receipt.authorityExercise.baseModelDigest !== receipt.baseModelDigest ||
    receipt.authorityExercise.action !== "mandate-change" ||
    receipt.authorityExercise.outOfMandate !== false ||
    receipt.adoptedPin.digest !== receipt.baseModelDigest ||
    receipt.approvedSourceBase !== undefined && (
        !validApprovedSourceBase(receipt.approvedSourceBase) ||
        receipt.approvedSourceBase.modelDigest !== receipt.baseModelDigest ||
        canonical(receipt.approvedSourceBase) !== canonical(change.diff?.base)
      ) ||
    change.authorityExercise &&
      canonical(receipt.authorityExercise) !==
        canonical(change.authorityExercise) ||
    change.decidedAt !== undefined && receipt.decidedAt !== change.decidedAt
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: change.id,
    }, "Le reçu publié diffère de la décision enregistrée.");
  }
}

/** Called only for a new approval, before the publication attempt. */
export function changePublication(
  change: PendingChange,
  pin: ExecutableModel["version"],
): ChangePublication {
  if (
    !change.authorityExercise || !change.decidedAt ||
    change.status !== "approved"
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISSING", {
      changeId: change.id,
    }, "L’approbation exige son reçu d’autorité.");
  }
  const receipt = {
    changeId: change.id,
    proposal: structuredClone(proposalIdentity(change)),
    authorityExercise: structuredClone(change.authorityExercise),
    baseModelDigest: change.baseModelDigest ?? pin.digest,
    baseRevision: change.baseRevision,
    adoptedPin: {
      digest: pin.digest,
      repositoryVersion: pin.repositoryVersion,
    },
    ...(change.diff
      ? { approvedSourceBase: structuredClone(change.diff.base) }
      : {}),
    decidedAt: change.decidedAt,
    edits: [],
  };
  assertPublicationMatches(change, receipt);
  return receipt;
}

/** Evidence that scope, preconditions and authority were re-checked on the
 * execution base named here. It never reissues the original approval. */
export interface RevalidationEvidence {
  readonly checkedAt: string;
  readonly executionBaseVersion: string;
  /** Digest of the admitted edit-scope facts checked on the execution base. */
  readonly scopeDigest: string;
  readonly authorityStillValid: true;
  readonly preconditionsChecked: number;
  /** True when the execution base is the approved base itself. */
  readonly baseUnchanged: boolean;
}

/** Versioned receipt (W3): the original approval, byte-identical in its own
 * fields, plus one execution attempt on a possibly newer base. The approval
 * keeps its original actor/mandate/decidedAt/approvedBase/intent and is never
 * rewritten for a rebase; when its validity on the new base cannot be proven
 * the outcome is an explicit refusal or a new decision, never this receipt. */
export interface PreparedPublication {
  readonly v: 2;
  /** Original v1 receipt exactly as approved; its edits stay as approved. */
  readonly approval: SourcePublication;
  readonly executionBase: {
    readonly repositoryVersion: string;
    readonly sourceDigest: string;
  };
  /** Operations actually applied on the execution base. */
  readonly replayedEdits: readonly PublicationEdit[];
  /** M1b journal these operations were replayed from, when journal-based. */
  readonly journalDigest?: string;
  readonly revalidation: RevalidationEvidence;
  /** Build identity of the prepared candidate: S, then R/K/A when computed. */
  readonly result: {
    readonly sourceDigest: string;
    readonly recipeDigest?: string;
    readonly buildKey?: string;
    readonly artifactDigest?: string;
  };
  /** Durable write-command anchor (W4); an index, never extra authority. */
  readonly command?: {
    readonly commandId: string;
    readonly commandDigest: string;
  };
}
export type AnySourcePublication = SourcePublication | PreparedPublication;

export function isPreparedPublication(
  publication: AnySourcePublication,
): publication is PreparedPublication {
  return (publication as PreparedPublication).v === 2;
}
function anyPublicationChangeId(
  publication: AnySourcePublication,
): string {
  return isPreparedPublication(publication)
    ? publication.approval.changeId
    : publication.changeId;
}
function anyPublicationSystemId(
  publication: AnySourcePublication,
): string {
  return publicationSystemId(
    isPreparedPublication(publication) ? publication.approval : publication,
  );
}
/** Same author strings as v1, so historical lookup keeps working on v2. */
export function anyPublicationAuthor(
  publication: AnySourcePublication,
): string {
  return publicationAuthor(
    isPreparedPublication(publication) ? publication.approval : publication,
  );
}

const HEX64 = /^[0-9a-f]{64}$/;

function preparedMismatch(
  publication: AnySourcePublication,
  message: string,
): never {
  throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
    changeId: anyPublicationChangeId(publication),
    systemId: anyPublicationSystemId(publication),
  }, message);
}

/** Structural invariants of one execution attempt; authority itself is proved
 * by the revalidation port, never inferred here. */
function assertPreparedPublication(
  prepared: PreparedPublication,
): void {
  const fail = (message: string) => preparedMismatch(prepared, message);
  if (prepared.v !== 2) fail("Prepared publication version differs.");
  if (
    !prepared.executionBase?.repositoryVersion ||
    !HEX64.test(prepared.executionBase?.sourceDigest ?? "") ||
    !Array.isArray(prepared.replayedEdits) ||
    prepared.journalDigest !== undefined &&
      !HEX64.test(prepared.journalDigest) ||
    !prepared.revalidation?.checkedAt ||
    prepared.revalidation?.executionBaseVersion !==
      prepared.executionBase?.repositoryVersion ||
    !HEX64.test(prepared.revalidation?.scopeDigest ?? "") ||
    prepared.revalidation?.authorityStillValid !== true ||
    !Number.isSafeInteger(prepared.revalidation?.preconditionsChecked) ||
    prepared.revalidation.preconditionsChecked < 0 ||
    typeof prepared.revalidation?.baseUnchanged !== "boolean" ||
    !HEX64.test(prepared.result?.sourceDigest ?? "") ||
    prepared.result?.recipeDigest !== undefined &&
      !HEX64.test(prepared.result.recipeDigest) ||
    prepared.result?.buildKey !== undefined &&
      !HEX64.test(prepared.result.buildKey) ||
    prepared.result?.artifactDigest !== undefined &&
      !HEX64.test(prepared.result.artifactDigest) ||
    prepared.command !== undefined &&
      (!prepared.command.commandId ||
        !HEX64.test(prepared.command.commandDigest) ||
        prepared.command.commandId !== prepared.approval.changeId)
  ) {
    fail("Prepared publication attempt is malformed.");
  }
  const approvedBaseVersion = publicationSourceVersion(prepared.approval);
  if (
    prepared.revalidation.baseUnchanged &&
    approvedBaseVersion !== undefined &&
    prepared.executionBase.repositoryVersion !== approvedBaseVersion
  ) {
    fail("Execution claims the approved base but names another version.");
  }
}

/** Build one attempt around an untouched approval. The approval must be the
 * receipt as approved (edits not yet filled by a publication): execution
 * operations belong to `replayedEdits`, never injected into the approval. */
export function preparePublication(
  approval: SourcePublication,
  attempt: Omit<PreparedPublication, "v" | "approval">,
): PreparedPublication {
  if (approval.edits.length !== 0) {
    throw new ChangePublicationError("PUBLICATION_NOT_APPLICABLE", {
      changeId: approval.changeId,
      systemId: publicationSystemId(approval),
    }, "Prepare from the original approval, not from a filled receipt.");
  }
  const prepared: PreparedPublication = {
    v: 2,
    approval: structuredClone(approval),
    executionBase: { ...attempt.executionBase },
    replayedEdits: structuredClone(attempt.replayedEdits),
    ...(attempt.journalDigest !== undefined
      ? { journalDigest: attempt.journalDigest }
      : {}),
    revalidation: { ...attempt.revalidation },
    result: { ...attempt.result },
    ...(attempt.command !== undefined
      ? { command: { ...attempt.command } }
      : {}),
  };
  assertPreparedPublication(prepared);
  return prepared;
}

/** Read any durable trailer value: no `v` means a historical v1 receipt, read
 * back identically; `v: 2` is validated as a prepared publication. */
export function parseAnyPublication(value: unknown): AnySourcePublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISSING", {
      changeId: "",
    }, "Approval receipt is missing.");
  }
  const record = value as Record<string, unknown>;
  if (record.v === undefined) {
    if (typeof record.changeId !== "string" || !record.changeId) {
      throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
        changeId: "",
      }, "Historical approval receipt is malformed.");
    }
    publicationSourceVersion(value as SourcePublication);
    return value as SourcePublication;
  }
  if (record.v !== 2) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: typeof record.changeId === "string" ? record.changeId : "",
    }, "Unknown approval receipt version.");
  }
  const prepared = value as PreparedPublication;
  if (
    !prepared.approval || typeof prepared.approval !== "object" ||
    typeof prepared.approval.changeId !== "string" ||
    !Array.isArray(prepared.approval.edits)
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: "",
    }, "Prepared publication approval is malformed.");
  }
  assertPreparedPublication(prepared);
  return prepared;
}

/** The whole UTF-8 trailer, including its prefix and newline, is bounded. */
export const MAX_APPROVAL_RECEIPT_BYTES = 65_536;
/** Space retained at proposal time for decision metadata not yet recorded. */
export const APPROVAL_RECEIPT_RESERVE_BYTES = 8192;
export function assertPublicationSize(
  publication: SourcePublication,
  reserveBytes = 0,
): void {
  if (
    new TextEncoder().encode(`ASE-Approval: ${canonical(publication)}\n`)
          .length + reserveBytes > MAX_APPROVAL_RECEIPT_BYTES
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_TOO_LARGE", {
      changeId: publication.changeId,
      systemId: publicationSystemId(publication),
    }, "Approval receipt exceeds the trailer size limit");
  }
}

/** Same trailer bound for either receipt version. */
export function assertAnyPublicationSize(
  publication: AnySourcePublication,
  reserveBytes = 0,
): void {
  if (!isPreparedPublication(publication)) {
    assertPublicationSize(publication, reserveBytes);
    return;
  }
  assertPreparedPublication(publication);
  if (
    new TextEncoder().encode(`ASE-Approval: ${canonical(publication)}\n`)
          .length + reserveBytes > MAX_APPROVAL_RECEIPT_BYTES
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_TOO_LARGE", {
      changeId: publication.approval.changeId,
      systemId: publicationSystemId(publication.approval),
    }, "Approval receipt exceeds the trailer size limit");
  }
}
