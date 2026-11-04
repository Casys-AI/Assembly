import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationMemberOutcome,
} from "../native-execution/contract.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

/** Keys encode both components without permitting separator collisions. */
export function immutableReceiptKey(groupId: string, callId: string): string {
  return JSON.stringify([groupId, callId]);
}

export type ImmutableReceiptUpdate =
  | {
    kind: "merge";
    receipts: Record<string, ImmutableConsultationMemberOutcome>;
  }
  | { kind: "clear"; groupId: string };

/** The join's clear runs in the next superstep after every worker write.
 * Replaying the preceding checkpoint restores its receipts and repeats the
 * idempotent join; writes for other groups are retained. */
export function mergeImmutableReceipts(
  previous: Record<string, ImmutableConsultationMemberOutcome>,
  update: ImmutableReceiptUpdate,
): Record<string, ImmutableConsultationMemberOutcome> {
  const result = { ...previous };
  if (update.kind === "clear") {
    for (const [key, value] of Object.entries(result)) {
      if (value.groupId === update.groupId) delete result[key];
    }
    return result;
  }
  for (const [key, value] of Object.entries(update.receipts)) {
    if (key !== immutableReceiptKey(value.groupId, value.callId)) {
      throw new Error("Immutable consultation receipt key mismatch");
    }
    if (result[key] && canonical(result[key]) !== canonical(value)) {
      throw new Error("Conflicting immutable consultation receipt");
    }
    result[key] = structuredClone(value);
  }
  return result;
}

/** Structural checks supplement, never replace, durable ledger admission. */
export function assertImmutableGroupShape(
  manifest: ImmutableConsultationGroupManifest,
): void {
  const members = manifest.members;
  if (
    !manifest.groupId || !manifest.manifestDigest || members.length < 1 ||
    members.length > 4 ||
    !Number.isSafeInteger(manifest.firstOrdinal) || manifest.firstOrdinal < 0 ||
    !Number.isSafeInteger(manifest.limits.flowSteps) ||
    manifest.limits.flowSteps < members.length + 1 ||
    !Number.isSafeInteger(manifest.limits.responseCharacters) ||
    manifest.limits.responseCharacters < 0 ||
    !manifest.sourcePin.version || !manifest.sourcePin.digest ||
    new Set(members.map((member) => member.callId)).size !== members.length ||
    new Set(members.map((member) => member.effectKey)).size !==
      members.length ||
    new Set(members.map((member) => member.flowStepOrdinal)).size !==
      members.length ||
    members.some((member, index) =>
      !member.callId || !member.effectKey || !member.argumentsDigest ||
      member.ordinal !== manifest.firstOrdinal + index ||
      member.choice.kind !== "consult_model" ||
      member.request.version !== manifest.sourcePin.version ||
      !Number.isSafeInteger(member.responseCharacters) ||
      member.responseCharacters < 0 ||
      !Number.isSafeInteger(member.flowStepOrdinal) ||
      member.flowStepOrdinal < 1
    ) ||
    members.reduce((sum, member) => sum + member.responseCharacters, 0) >
      manifest.limits.responseCharacters
  ) {
    throw new Error("Invalid immutable consultation group descriptor");
  }
}
