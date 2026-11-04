import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type {
  NeverStartedAdoptionSource,
  RetainedInertPredecessor,
} from "./native-adoption-successor.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { NativeThreadAdvanceAuthorization } from "../native-execution/contract.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  parseRequestAdoptionManifest,
  parseRequestAdoptionReceipt,
} from "../../model/evolution/request-adoption-invariants.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
  RequestExecutionPin,
} from "../../model/evolution/request-adoption-ports.ts";
import {
  parseScopedSoftwareAdoptionManifest,
  type ScopedSoftwareAdoptionManifestV2,
} from "../../model/evolution/scoped-software-adoption.ts";
import {
  parseScopedSoftwareSourceAdmission,
  scopedSoftwareSourceAdmissionDigest,
  type ScopedSoftwareSourceAdmissionV2,
} from "../../model/source-admission/scoped-software-source-admission.ts";

interface SoftwareSuccessorSelection {
  authorization: Extract<
    NativeThreadAdvanceAuthorization,
    { kind: "software-evolution-scoped-adoption" }
  >;
  source: unknown;
  target: unknown;
}

/** Exact last execution lineage. Shape/digest checks do not replace the
 * retained journal, native predecessor or Git anchor verification. */
export interface ScopedSoftwareNeverStartedSuccessorContext {
  readonly currentPin: RequestExecutionPin;
  readonly previous:
    | {
      readonly kind: "human";
      readonly manifest: RequestAdoptionManifest;
      readonly receipt: RequestAdoptionReceipt;
    }
    | {
      readonly kind: "software";
      readonly manifest: ScopedSoftwareAdoptionManifestV2;
      readonly journalRevision: number;
      readonly manifestDigest: string;
      readonly recordedAt: string;
      readonly source: ScopedSoftwareSourceAdmissionV2;
    };
}
function invalid(): never {
  throw new Error("Invalid scoped software successor lineage");
}
function object(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid();
  }
  const r = input as Record<string, unknown>;
  if (
    Reflect.ownKeys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  ) return invalid();
  return r;
}
export async function parseScopedSoftwareNeverStartedSuccessorContext(
  input: unknown,
): Promise<ScopedSoftwareNeverStartedSuccessorContext> {
  const snapshot = structuredClone(input);
  const v = object(snapshot, ["currentPin", "previous"]);
  const pin = object(v.currentPin, [
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
  const pinAdoption = object(pin.adoption, [
    "commandId",
    "receiptDigest",
    "committedRuntimeRevision",
  ]);
  const p = v.previous as Record<string, unknown>;
  if (!p || typeof p !== "object" || Array.isArray(p)) return invalid();
  if (p.kind === "human") {
    object(p, ["kind", "manifest", "receipt"]);
    const manifest = await parseRequestAdoptionManifest(p.manifest),
      receipt = await parseRequestAdoptionReceipt(p.receipt);
    if (
      receipt.commandId !== manifest.commandId ||
      receipt.journalRevision !== manifest.predecessor.revision + 1 ||
      receipt.journalDigest !== await canonicalDigest(manifest) ||
      receipt.committedRuntimeRevision !== manifest.committedRuntimeRevision ||
      pinAdoption.commandId !== receipt.commandId ||
      pinAdoption.receiptDigest !== receipt.receiptDigest ||
      pinAdoption.committedRuntimeRevision !==
        receipt.committedRuntimeRevision ||
      canonical(pinSource) !== canonical(manifest.intent.candidate.source) ||
      pin.modelDigest !== manifest.intent.candidate.model.version.digest ||
      canonical(pinAdmission) !==
        canonical(manifest.intent.candidate.sourceAdmission)
    ) invalid();
  } else if (p.kind === "software") {
    object(p, [
      "kind",
      "manifest",
      "journalRevision",
      "manifestDigest",
      "recordedAt",
      "source",
    ]);
    const manifest = parseScopedSoftwareAdoptionManifest(p.manifest),
      source = await parseScopedSoftwareSourceAdmission(p.source);
    if (
      !Number.isSafeInteger(p.journalRevision) ||
      Number(p.journalRevision) !== manifest.predecessor.revision + 1 ||
      typeof p.manifestDigest !== "string" ||
      p.manifestDigest !== await canonicalDigest(manifest) ||
      typeof p.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(p.recordedAt)) ||
      await scopedSoftwareSourceAdmissionDigest(source) !==
        manifest.sourceAdmission.manifestDigest ||
      source.evolutionDossierId !== manifest.dossierId ||
      source.evolutionIntentDigest !== manifest.intentDigest ||
      source.proposalDigest !== manifest.proposalDigest ||
      source.destination.host.projectId !== manifest.target.projectId ||
      source.destination.host.systemId !== manifest.target.systemId ||
      source.destination.executionSpaceId !==
        manifest.target.executionSpaceId ||
      canonical(pinSource) !== canonical(source.result.source) ||
      canonical(pinAdmission) !== canonical(manifest.sourceAdmission) ||
      !source.result.targets.some((t) =>
        t.operatorId === manifest.target.operatorId &&
        t.digest === pin.modelDigest
      )
    ) invalid();
    const receiptDigest = await canonicalDigest({
      commandId: manifest.dossierId,
      committedRuntimeRevision: manifest.committedRuntimeRevision,
      journalRevision: p.journalRevision,
      journalDigest: p.manifestDigest,
      recordedAt: p.recordedAt,
    });
    if (
      pinAdoption.commandId !== manifest.dossierId ||
      pinAdoption.receiptDigest !== receiptDigest ||
      pinAdoption.committedRuntimeRevision !== manifest.committedRuntimeRevision
    ) invalid();
  } else invalid();
  return snapshot as ScopedSoftwareNeverStartedSuccessorContext;
}

export function assertSoftwareSuccessorCurrentPin(
  context: ScopedSoftwareNeverStartedSuccessorContext,
  current: SystemRuntimeState,
) {
  if (
    current.executionModel?.version.digest !==
      context.currentPin.modelDigest ||
    current.executionModel.version.repositoryVersion !==
      context.currentPin.source.version
  ) throw new Error("Software successor current pin changed");
}

export function assertSoftwareSuccessorSelection(
  manifest: ScopedSoftwareAdoptionManifestV2,
  selected: SoftwareSuccessorSelection,
  authorizationJson: string,
  authorizationId: string,
) {
  if (
    canonical(selected) !== authorizationJson ||
    Object.keys(selected).sort().join(",") !==
      "authorization,source,target" ||
    selected.authorization?.kind !== "software-evolution-scoped-adoption" ||
    selected.authorization.dossierId !== manifest.dossierId ||
    selected.authorization.intentDigest !== manifest.intentDigest ||
    selected.authorization.proposalDigest !== manifest.proposalDigest ||
    selected.authorization.authorizationEventId !== authorizationId ||
    selected.authorization.businessRevision?.__assemblyRuntimeRevision
        ?.revision !== manifest.authorizationRuntimeRevision ||
    canonical(selected.authorization.adoptionAuthorization) !==
      canonical(manifest.adoptionAuthorization)
  ) throw new Error("Prior software selection authorization differs");
}

export function assertSoftwareSuccessorAuthorizationHistory(
  manifest: ScopedSoftwareAdoptionManifestV2,
  selected: SoftwareSuccessorSelection,
  authorized: SystemRuntimeState,
  authorizationId: string,
) {
  const event = authorized.events.find((e) => e.id === authorizationId);
  if (
    authorized.executionModel?.version.digest !==
      manifest.boundary.previousPin.modelDigest ||
    authorized.executionModel.version.repositoryVersion !==
      manifest.boundary.previousPin.source.version ||
    event?.kind !== "model-version-admission-authorized" ||
    event.authorityExercise ||
    canonical(event.modelAdoptionAuthorization?.softwareEvolution) !==
      canonical({
        dossierId: manifest.dossierId,
        intentDigest: manifest.intentDigest,
        proposalDigest: manifest.proposalDigest,
        exercise: manifest.adoptionAuthorization,
      }) ||
    canonical(event.modelAdoptionAuthorization?.target) !==
      canonical(selected.target)
  ) throw new Error("Prior software authorization history differs");
}

export function assertSoftwareSuccessorCommittedHistory(
  context: ScopedSoftwareNeverStartedSuccessorContext,
  prior: Extract<
    ScopedSoftwareNeverStartedSuccessorContext["previous"],
    { kind: "software" }
  >,
  operatorId: string,
  selected: SoftwareSuccessorSelection,
  committed: SystemRuntimeState,
) {
  const manifest = prior.manifest, caseId = prior.source.destination.caseId;
  const expectedIdentity = prior.source.result.targets.find((t) =>
    t.operatorId === operatorId
  )?.identity;
  if (
    canonical(committed.executionModel?.identity) !==
      canonical(expectedIdentity) ||
    committed.executionModel?.version.digest !==
      context.currentPin.modelDigest ||
    committed.executionModel.version.repositoryVersion !==
      context.currentPin.source.version ||
    canonical(selected.target) !==
      canonical({
        identity: committed.executionModel.identity,
        version: committed.executionModel.version,
      }) ||
    committed.events.filter((e) =>
        e.id ===
          `${manifest.dossierId}:software-admitted:${operatorId}` &&
        e.kind === "model-version-admitted" && e.caseId === caseId
      ).length !== 1 ||
    committed.events.filter((e) =>
        e.effectiveModelUpdate?.dossierId === manifest.dossierId &&
        e.effectiveModelUpdate.caseId === caseId &&
        e.effectiveModelUpdate.to.digest === context.currentPin.modelDigest &&
        e.effectiveModelUpdate.to.repositoryVersion ===
          context.currentPin.source.version
      ).length !== 1
  ) throw new Error("Prior committed software activation history differs");
}

export async function assertSoftwareInertSourceMarker(
  marker: NeverStartedAdoptionSource,
  earlier: RequestExecutionPin["adoption"],
  authorizationRuntimeRevision: number,
  identityDigest: string,
  retained: RetainedInertPredecessor,
) {
  if (
    !earlier || marker.threadId !== retained.threadId ||
    marker.predecessorThreadId !== retained.predecessorThreadId ||
    marker.identityDigest !== identityDigest ||
    earlier.commandId !== marker.previousCommandId ||
    earlier.receiptDigest !== marker.previousReceiptDigest ||
    earlier.committedRuntimeRevision !==
      marker.previousCommittedRuntimeRevision ||
    marker.previousAuthorizationRuntimeRevision !==
      earlier.committedRuntimeRevision - 1 ||
    earlier.committedRuntimeRevision >=
      authorizationRuntimeRevision ||
    typeof retained.authorizedPinJson !== "string" ||
    typeof retained.advanceAuthorizationJson !== "string" ||
    await sha256(retained.authorizedPinJson) !==
      marker.authorizedPinDigest ||
    await sha256(retained.advanceAuthorizationJson) !==
      marker.advanceAuthorizationDigest
  ) throw new Error("Software predecessor marker differs");
}
