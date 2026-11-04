import { matchesExactRevision } from "../../shared-kernel/revision-id.ts";
import type { ReleasePublication } from "./release-publication.ts";
import type { ReleaseRetentionProof } from "./release-retention.ts";
import type { ReleaseTagRejection, SavedSystemTag } from "./release-tags.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../primitives/canonical-json.ts";
import { canonicalDigest } from "../../primitives/execution-digest.ts";
import type { BuildDescriptor } from "../../model/value-objects/build.ts";
import type { ArtifactSourceBindingReference } from "../artifacts/source-reference.ts";
import type { RuntimeProvenanceRecord } from "../value-objects/runtime-provenance.ts";
import type { ToolDraft } from "./candidates.ts";
import { MAX_OPERATOR_UNITS } from "./conversations.ts";

export interface SavedSystemScope {
  projectId: string;
  systemId: string;
  executionSpaceId: string;
}
/** The host resolves branch identity; a caller cannot supply a Git ref. */
export interface SavedSystemSourceSelection {
  branch: { kind: "main" } | { kind: "case"; caseId: string };
  sourceVersion: string;
}
export interface SavedSystemSourceEvidence extends SavedSystemSourceSelection {
  repositoryId: string;
  branchRef: string;
  admittedHeadVersion: string;
  sourceDigest: string;
  /** Only evolved Request sources carry this frozen admission receipt. */
  requestAdmission?: RequestReleaseAdmissionReference;
}
export interface RequestReleaseAdmissionReference {
  format: "request-release-admission/v1";
  openingId: string;
  openingBaseDigest: string;
  revision: number;
  manifestDigest: string;
}
export function assertRequestReleaseAdmissionReference(
  value: unknown,
): asserts value is RequestReleaseAdmissionReference {
  const ref = value as RequestReleaseAdmissionReference;
  if (
    !ref || typeof ref !== "object" || Array.isArray(ref) ||
    Object.keys(ref).sort().join(",") !==
      "format,manifestDigest,openingBaseDigest,openingId,revision" ||
    ref.format !== "request-release-admission/v1" ||
    typeof ref.openingId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(ref.openingId) ||
    !/^[a-f0-9]{64}$/.test(ref.openingBaseDigest) ||
    !/^[a-f0-9]{64}$/.test(ref.manifestDigest) ||
    !Number.isSafeInteger(ref.revision) || ref.revision <= 1
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Invalid Request source admission reference.",
    );
  }
}
export function assertSavedSourceSelection(
  value: unknown,
): asserts value is SavedSystemSourceSelection {
  const source = value as SavedSystemSourceSelection;
  const branch = source?.branch;
  if (
    !source || typeof source !== "object" || Array.isArray(source) ||
    Object.keys(source).sort().join(",") !== "branch,sourceVersion" ||
    typeof source.sourceVersion !== "string" ||
    !matchesExactRevision(source.sourceVersion) ||
    !branch || typeof branch !== "object" || Array.isArray(branch) ||
    !(branch.kind === "main" && Object.keys(branch).length === 1 ||
      branch.kind === "case" &&
        Object.keys(branch).sort().join(",") === "caseId,kind" &&
        typeof branch.caseId === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(branch.caseId))
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Select an exact model version and its branch.",
    );
  }
}
export interface SavedSystemMetadata {
  name: string;
  purpose: string;
}
export type SavedSystemStatus =
  | "pending"
  | "incomplete"
  | "retained"
  | "conflict";
export interface SavedSystemPrerequisite {
  kind:
    | "skill"
    | "private-resource"
    | "unsupported-dependency"
    | "host-runtime"
    | "missing-asset";
  operatorId?: string;
  code: string;
}
/** Exact selection only: no conversations, memory, grants or resource bodies. */
export interface SavedOperatorSelection {
  operatorId: string;
  nativeSystemId?: string;
  systemQualifiedName?: string;
  /** Historical runtime captures only; absent from source Releases. */
  stateRevision?: number;
  modelDigest: string;
  repositoryVersion: string;
  settingsDigest: string;
  runtime?: RuntimeProvenanceRecord;
  tools: Array<
    {
      candidateId: string;
      digest: string;
      sourceBinding?: ArtifactSourceBindingReference;
      draft: ToolDraft;
    }
  >;
}
interface SavedSystemAdmissionSelection {
  operatorIds: string[];
  prerequisites: SavedSystemPrerequisite[];
}
export interface SavedSystemCapture {
  origin: SavedSystemScope;
  /** Absent only on historical runtime-vector records. */
  source?: SavedSystemSourceEvidence;
  registeredOperatorIds: string[];
  /** Exact source members for Releases; historical records hold runtime observations. */
  operators: SavedOperatorSelection[];
  /** Source-local membership, retained with its admission evidence. */
  admission?: SavedSystemAdmissionSelection;
  prerequisites: SavedSystemPrerequisite[];
}
export interface SavedOperatorManifest {
  operatorId: string;
  nativeSystemId?: string;
  systemQualifiedName?: string;
  /** Historical runtime captures only; absent from source Releases. */
  stateRevision?: number;
  modelDigest: string;
  repositoryVersion: string;
  settingsDigest: string;
  runtime?: RuntimeProvenanceRecord;
  sourceDigest: string;
  build: BuildDescriptor | null;
  tools: Array<
    {
      candidateId: string;
      digest: string;
      sourceBinding?: ArtifactSourceBindingReference;
    }
  >;
}
export interface SavedSystemManifest {
  format: "assembly-saved-system-v1";
  origin: SavedSystemScope;
  /** Absent only on historical runtime-vector records. */
  source?: SavedSystemSourceEvidence;
  registeredOperatorIds: string[];
  operators: SavedOperatorManifest[];
  prerequisites: SavedSystemPrerequisite[];
}
export interface SavedSystemRecord {
  id: string;
  saveKey: string;
  commandDigest: string;
  /** Absent on historical records; never added to historical manifests. */
  tag?: SavedSystemTag;
  /** Exact terminal preacceptance failure, never a tag binding or reservation. */
  rejection?: ReleaseTagRejection;
  creationAuthorization?: ReleaseRetentionProof | null;
  metadata: SavedSystemMetadata;
  capture: SavedSystemCapture;
  createdAt: string;
  status: SavedSystemStatus;
  manifest: SavedSystemManifest | null;
  digest: string | null;
  issues: string[];
  revision: number;
  publication?: ReleasePublication;
}
export class SavedSystemError extends Error {
  constructor(
    readonly code:
      | "INVALID_COMMAND"
      | "SAVE_KEY_CONFLICT"
      | "CAPTURE_CONFLICT"
      | "TAG_UNAVAILABLE"
      | "SOURCE_STALE"
      | "UNAVAILABLE"
      | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "SavedSystemError";
  }
}
export function savedSystemMetadata(
  input: SavedSystemMetadata,
): SavedSystemMetadata {
  if (
    !input || typeof input.name !== "string" ||
    typeof input.purpose !== "string" || !input.name.trim() ||
    input.name.trim().length > 120 || input.purpose.trim().length > 2000 ||
    Array.from(input.name + input.purpose).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 11 || code === 12 ||
        (code >= 14 && code <= 31);
    })
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "Use a name of 1–120 characters and a purpose of at most 2000 characters.",
    );
  }
  return { name: input.name.trim(), purpose: input.purpose.trim() };
}
/** Omit the derived membership envelope when comparing immutable capture content. */
export function savedSystemObservation(
  capture: SavedSystemCapture,
): Omit<SavedSystemCapture, "admission"> {
  const { admission: _admission, ...observation } = capture;
  return observation;
}
export function assertSaveKey(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new SavedSystemError("INVALID_COMMAND", "Invalid save key.");
  }
}
export function assertSavedCapture(capture: SavedSystemCapture): void {
  const ids = capture.registeredOperatorIds;
  if (capture.source) {
    assertSavedSourceSelection({
      branch: capture.source.branch,
      sourceVersion: capture.source.sourceVersion,
    });
    if (capture.source.requestAdmission !== undefined) {
      assertRequestReleaseAdmissionReference(capture.source.requestAdmission);
      if (capture.source.branch.kind !== "case") {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "A Request admission requires a Case source.",
        );
      }
    }
    if (
      !capture.source.repositoryId || !capture.source.branchRef ||
      !matchesExactRevision(capture.source.admittedHeadVersion) ||
      !capture.source.sourceDigest ||
      capture.operators.some((operator) =>
        operator.repositoryVersion !== capture.source!.sourceVersion
      )
    ) {
      throw new SavedSystemError(
        "INVALID_COMMAND",
        "Release capture must retain one exact source version.",
      );
    }
  }
  if (
    !ids.length || ids.length > MAX_OPERATOR_UNITS ||
    new Set(ids).size !== ids.length ||
    capture.operators.length > ids.length ||
    (capture.admission !== undefined && (
      new Set(capture.admission.operatorIds).size !==
        capture.admission.operatorIds.length ||
      capture.admission.operatorIds.some((id) =>
        !capture.operators.some((operator) => operator.operatorId === id)
      ) ||
      capture.admission.prerequisites.length > 512
    )) ||
    new Set(capture.operators.map((op) => op.operatorId)).size !==
      capture.operators.length ||
    capture.operators.some((op) =>
      !ids.includes(op.operatorId) ||
      (op.stateRevision !== undefined &&
        (!Number.isSafeInteger(op.stateRevision) || op.stateRevision < 0)) ||
      (!capture.source && op.stateRevision === undefined) ||
      !op.repositoryVersion || !op.modelDigest ||
      !op.settingsDigest || op.tools.length > 256
    ) || new TextEncoder().encode(canonical(capture)).length > 4_194_304
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "The admitted system selection is invalid or exceeds its bounds.",
    );
  }
}
export async function savedSystemDigest(value: unknown): Promise<string> {
  return await canonicalDigest(value);
}
export function savedManifest(
  input: Omit<SavedSystemManifest, "format">,
): SavedSystemManifest {
  return {
    format: "assembly-saved-system-v1",
    origin: { ...input.origin },
    ...(input.source ? { source: structuredClone(input.source) } : {}),
    registeredOperatorIds: [...input.registeredOperatorIds].sort(),
    operators: structuredClone(input.operators).sort((a, b) =>
      compareCodeUnits(a.operatorId, b.operatorId)
    ).map((op) => ({
      ...op,
      tools: op.tools.sort((a, b) =>
        compareCodeUnits(a.candidateId, b.candidateId)
      ),
    })),
    prerequisites: structuredClone(input.prerequisites).sort((a, b) =>
      compareCodeUnits(canonical(a), canonical(b))
    ),
  };
}
