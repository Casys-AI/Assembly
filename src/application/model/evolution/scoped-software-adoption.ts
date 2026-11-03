import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import type {
  NativeExecutionSnapshot,
  RuntimeRevisionReference,
} from "../../work/runtime/execution.ts";
import type {
  EvolutionAdoptionReceipt,
  EvolutionPublication,
} from "./ports.ts";
import type {
  RequestAdoptionManifest,
  RequestExecutionPin,
} from "./request-adoption-ports.ts";
import { EvolutionError } from "./ports.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

/** Captured only under the final reservation after all engaged work settles.
 * Neither this data nor its shape alone is a runtime lock or authority. */
export interface ScopedSoftwareFinalBoundaryV2 {
  readonly format: "software-evolution-final-boundary/v2";
  readonly target: Readonly<ScopedOperatorRef>;
  readonly previousPin: RequestExecutionPin;
  readonly previousRuntimeRevision: number;
  readonly previousBusinessRevision: RuntimeRevisionReference;
  readonly checkpointDigest: string;
  readonly nativeSnapshots: readonly NativeExecutionSnapshot[];
}
export interface ScopedSoftwarePublicationV2 extends EvolutionPublication {
  readonly sourceAdmission: {
    readonly revision: number;
    readonly manifestDigest: string;
  };
}
/** A fresh instance must be journalled in the admission transaction itself. */
export interface ScopedSoftwareAdoptionManifestV2 {
  readonly format: "request-software-runtime-adoption/v2";
  readonly dossierId: string;
  readonly intentDigest: string;
  readonly proposalDigest: string;
  readonly target: Readonly<ScopedOperatorRef>;
  readonly sourceAdmission: ScopedSoftwarePublicationV2["sourceAdmission"];
  readonly boundary: ScopedSoftwareFinalBoundaryV2;
  readonly adoptionAuthorization: EvolutionAuthorityExercise;
  readonly predecessor: { readonly revision: number; readonly digest: string };
  readonly authorizationRuntimeRevision: number;
  readonly committedRuntimeRevision: number;
  readonly admissionRevision: number;
  readonly nativeRetirement: RequestAdoptionManifest["nativeRetirement"];
}
export interface ScopedSoftwareAdoptionReceiptV2
  extends EvolutionAdoptionReceipt {
  readonly target: Readonly<ScopedOperatorRef>;
  readonly manifestDigest: string;
  readonly journalRevision: number;
  readonly authorizationRuntimeRevision: number;
  readonly committedRuntimeRevision: number;
}

/** Check the post-settlement sequence only; transaction ownership, current
 * authority, source evidence and native settlement remain separate checks. */
export function assertScopedSoftwareAdoptionRevisionSequence(
  manifest: ScopedSoftwareAdoptionManifestV2,
): void {
  const boundary = manifest.boundary;
  const r = boundary.previousRuntimeRevision;
  const business = boundary.previousBusinessRevision.__assemblyRuntimeRevision;
  if (
    manifest.format !== "request-software-runtime-adoption/v2" ||
    boundary.format !== "software-evolution-final-boundary/v2" ||
    canonical(manifest.target) !== canonical(boundary.target) ||
    !Number.isSafeInteger(r) || r < 0 ||
    manifest.authorizationRuntimeRevision !== r + 1 ||
    manifest.committedRuntimeRevision !== r + 2 ||
    business.systemId !==
      `request:${boundary.target.executionSpaceId}:${boundary.target.operatorId}` ||
    business.operatorId !== boundary.target.operatorId ||
    business.revision !== r ||
    business.modelDigest !== boundary.previousPin.modelDigest ||
    !/^[a-f0-9]{64}$/.test(boundary.checkpointDigest)
  ) {
    throw new EvolutionError(
      "EVOLUTION_INVALID",
      "Invalid scoped final adoption sequence",
    );
  }
}

/** Closed journal envelope. Native snapshots are subsequently checked against
 * the ledger-owned preparation packet; decoding does not authorize effects. */
export function parseScopedSoftwareAdoptionManifest(
  value: unknown,
): ScopedSoftwareAdoptionManifestV2 {
  const snapshot = structuredClone(value);
  const invalid = (): never => {
    throw new EvolutionError(
      "EVOLUTION_INVALID",
      "Invalid scoped adoption manifest",
    );
  };
  if (new TextEncoder().encode(canonical(snapshot)).length > 4 * 1_048_576) {
    invalid();
  }
  const object = (
    v: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
    const r = v as Record<string, unknown>,
      allowed = [...required, ...optional];
    if (
      Reflect.ownKeys(r).some((k) =>
        typeof k !== "string" || !allowed.includes(k)
      ) || required.some((k) => !Object.hasOwn(r, k))
    ) return invalid();
    return r;
  };
  const hash = (v: unknown) => isSha256Hex(v);
  const text = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v;
  const integer = (v: unknown, min = 1) =>
    Number.isSafeInteger(v) && Number(v) >= min;
  const m = object(snapshot, [
    "format",
    "dossierId",
    "intentDigest",
    "proposalDigest",
    "target",
    "sourceAdmission",
    "boundary",
    "adoptionAuthorization",
    "predecessor",
    "authorizationRuntimeRevision",
    "committedRuntimeRevision",
    "admissionRevision",
    "nativeRetirement",
  ]);
  const target = object(m.target, [
    "projectId",
    "systemId",
    "executionSpaceId",
    "operatorId",
  ]);
  const source = object(m.sourceAdmission, ["revision", "manifestDigest"]);
  const previous = object(m.predecessor, ["revision", "digest"]);
  const boundary = object(m.boundary, [
    "format",
    "target",
    "previousPin",
    "previousRuntimeRevision",
    "previousBusinessRevision",
    "checkpointDigest",
    "nativeSnapshots",
  ]);
  object(boundary.target, [
    "projectId",
    "systemId",
    "executionSpaceId",
    "operatorId",
  ]);
  const pin = object(boundary.previousPin, [
    "source",
    "modelDigest",
    "sourceAdmission",
    "adoption",
  ]);
  const pinSource = object(pin.source, ["repositoryId", "version"]);
  const pinAdmission = object(pin.sourceAdmission, [
    "revision",
    "manifestDigest",
  ]);
  if (pin.adoption !== null) {
    const a = object(pin.adoption, [
      "commandId",
      "receiptDigest",
      "committedRuntimeRevision",
    ]);
    if (
      !text(a.commandId) || !hash(a.receiptDigest) ||
      !integer(a.committedRuntimeRevision)
    ) invalid();
  }
  const business = object(boundary.previousBusinessRevision, [
    "__assemblyRuntimeRevision",
  ]);
  object(business.__assemblyRuntimeRevision, [
    "systemId",
    "operatorId",
    "revision",
    "modelDigest",
  ], ["invocationKey"]);
  const authority = object(m.adoptionAuthorization, [
    "act",
    "operatorNativeId",
    "systemQualifiedName",
    "authorityDigest",
    "policyId",
    "policyRevision",
    "mandateNativeId",
    "mandateId",
    "mandateRevision",
    "targets",
    "categories",
    "proposalDigest",
  ]);
  const retirement = object(m.nativeRetirement, [
    "digest",
    "predecessorThreadIds",
    "successorThreadIds",
  ]);
  const arrays = [
    retirement.predecessorThreadIds,
    retirement.successorThreadIds,
  ];
  if (
    m.format !== "request-software-runtime-adoption/v2" || !text(m.dossierId) ||
    !hash(m.intentDigest) || !hash(m.proposalDigest) ||
    Object.values(target).some((item) => !text(item)) ||
    !integer(source.revision) || !hash(source.manifestDigest) ||
    !integer(previous.revision) || !hash(previous.digest) ||
    !text(pinSource.repositoryId) || !text(pinSource.version) ||
    !hash(pin.modelDigest) ||
    !integer(pinAdmission.revision) || !hash(pinAdmission.manifestDigest) ||
    !integer(m.admissionRevision) ||
    !hash(retirement.digest) ||
    arrays.some((a) =>
      !Array.isArray(a) || a.length > 256 || new Set(a).size !== a.length ||
      a.some((id) => !text(id))
    ) ||
    (retirement.predecessorThreadIds as unknown[]).length !==
      (retirement.successorThreadIds as unknown[]).length ||
    authority.act !== "adopt" ||
    authority.proposalDigest !== m.proposalDigest ||
    !hash(authority.authorityDigest) ||
    !Array.isArray(authority.targets) || !Array.isArray(authority.categories) ||
    !Array.isArray(boundary.nativeSnapshots) ||
    boundary.nativeSnapshots.length > 256
  ) invalid();
  for (const native of boundary.nativeSnapshots as unknown[]) {
    object(native, [
      "contributionId",
      "identity",
      "threadId",
      "modelDigest",
      "flowRootId",
      "status",
      "waits",
      "unsettledEffects",
      "pendingContributions",
    ], [
      "runId",
      "checkpointNamespace",
      "budgetContinuationSource",
      "scalarBudgetProposal",
      "initialAdmissionSource",
      "repositoryVersion",
      "checkpointId",
      "refusal",
      "openImmutableConsultationGroups",
      "localState",
    ]);
  }
  assertScopedSoftwareAdoptionRevisionSequence(
    snapshot as ScopedSoftwareAdoptionManifestV2,
  );
  return snapshot as ScopedSoftwareAdoptionManifestV2;
}
