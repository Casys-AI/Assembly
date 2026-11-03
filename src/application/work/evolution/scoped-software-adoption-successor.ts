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
