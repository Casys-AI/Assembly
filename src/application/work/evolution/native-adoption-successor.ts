/** Adapter-only lineage facts. A prior receipt or an inert row grants no current
 * adoption authority and is never represented as an executed native snapshot. */
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
  RequestExecutionPin,
} from "../../model/evolution/request-adoption-ports.ts";
import {
  parseRequestAdoptionManifest,
  parseRequestAdoptionReceipt,
} from "../../model/evolution/request-adoption-invariants.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";

export interface RequestNeverStartedSuccessorContext {
  readonly currentPin: RequestExecutionPin;
  readonly adoptions: readonly {
    readonly manifest: RequestAdoptionManifest;
    readonly receipt: RequestAdoptionReceipt;
  }[];
}
export interface NeverStartedAdoptionSource {
  readonly v: 1;
  readonly kind: "never-started-adoption-successor";
  readonly threadId: string;
  readonly predecessorThreadId: string;
  readonly identityDigest: string;
  readonly previousCommandId: string;
  readonly previousReceiptDigest: string;
  readonly previousAuthorizationRuntimeRevision: number;
  readonly previousCommittedRuntimeRevision: number;
  readonly authorizedPinDigest: string;
  readonly advanceAuthorizationDigest: string;
}
const fields = [
  "v",
  "kind",
  "threadId",
  "predecessorThreadId",
  "identityDigest",
  "previousCommandId",
  "previousReceiptDigest",
  "previousAuthorizationRuntimeRevision",
  "previousCommittedRuntimeRevision",
  "authorizedPinDigest",
  "advanceAuthorizationDigest",
] as const;
export function parseNeverStartedAdoptionSource(
  input: unknown,
): NeverStartedAdoptionSource {
  const value = structuredClone(input);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) throw new Error("Closed never-started adoption source required");
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || row.kind !== "never-started-adoption-successor") {
    throw new Error("Unknown never-started adoption source");
  }
  for (
    const key of [
      "threadId",
      "predecessorThreadId",
      "previousCommandId",
    ] as const
  ) {
    if (
      typeof row[key] !== "string" || !row[key] || row[key].length > 1024 ||
      [...row[key]].some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    ) throw new Error("Invalid never-started source identity");
  }
  for (
    const key of [
      "identityDigest",
      "previousReceiptDigest",
      "authorizedPinDigest",
      "advanceAuthorizationDigest",
    ] as const
  ) {
    if (!isSha256Hex(row[key])) {
      throw new Error("Invalid never-started source digest");
    }
  }
  if (
    !Number.isSafeInteger(row.previousAuthorizationRuntimeRevision) ||
    Number(row.previousAuthorizationRuntimeRevision) < 1 ||
    row.previousCommittedRuntimeRevision !==
      Number(row.previousAuthorizationRuntimeRevision) + 1 ||
    row.threadId === row.predecessorThreadId
  ) throw new Error("Invalid never-started source revision lineage");
  return value as NeverStartedAdoptionSource;
}
export async function parseRequestNeverStartedSuccessorContext(
  input: RequestNeverStartedSuccessorContext,
): Promise<RequestNeverStartedSuccessorContext> {
  const value = structuredClone(input);
  if (
    !value || Object.keys(value).sort().join(",") !== "adoptions,currentPin" ||
    !value.currentPin || !Array.isArray(value.adoptions) ||
    value.adoptions.length > 1 ||
    (value.currentPin.adoption === null
      ? value.adoptions.length !== 0
      : value.adoptions.length !== 1)
  ) {
    throw new Error("Only the exact latest executing adoption is permitted");
  }
  if (value.currentPin.adoption === null) return value;
  for (const entry of value.adoptions) {
    if (!entry || Object.keys(entry).sort().join(",") !== "manifest,receipt") {
      throw new Error("Closed prior adoption proof required");
    }
    const manifest = await parseRequestAdoptionManifest(entry.manifest),
      receipt = await parseRequestAdoptionReceipt(entry.receipt);
    if (
      receipt.commandId !== manifest.commandId ||
      receipt.committedRuntimeRevision !== manifest.committedRuntimeRevision ||
      receipt.journalRevision !== manifest.predecessor.revision + 1 ||
      receipt.journalDigest !== await canonicalDigest(manifest)
    ) throw new Error("Prior adoption receipt and manifest disagree");
  }
  const latest = value.adoptions.at(-1)!, pin = value.currentPin;
  if (
    canonical(pin.adoption) !==
      canonical({
        commandId: latest.receipt.commandId,
        receiptDigest: latest.receipt.receiptDigest,
        committedRuntimeRevision: latest.receipt.committedRuntimeRevision,
      }) ||
    pin.modelDigest !== latest.manifest.intent.candidate.model.version.digest ||
    canonical(pin.source) !==
      canonical(latest.manifest.intent.candidate.source) ||
    canonical(pin.sourceAdmission) !==
      canonical(latest.manifest.intent.candidate.sourceAdmission) ||
    value.adoptions.some((entry) =>
      canonical(entry.manifest.intent.target) !==
        canonical(latest.manifest.intent.target)
    )
  ) {
    throw new Error(
      "Never-started proof is not the exact latest executing adoption",
    );
  }
  return value;
}
