import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationGroupMember,
  ImmutableConsultationMemberOutcome,
  NativeExecutionRequest,
} from "./contract.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import { immutableModelConsultation } from "../../../domain/model/consultation/context.ts";
import { invocationKey } from "../operators/journal.ts";

const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export const digest = (value: unknown): value is string => isSha256Hex(value);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Shared by production persistence and its explicit memory double. */
export async function assertImmutableConsultationManifest(
  manifest: ImmutableConsultationGroupManifest,
  request: NativeExecutionRequest,
  runId: string,
): Promise<void> {
  const { manifestDigest, ...body } = manifest;
  const command = request.flow.nodes.find((node) =>
    node.id === manifest.occurrenceId
  );
  if (
    request.flow.executionProfile !== "operator-command-immutable-group-v1" ||
    !nonblank(manifest.groupId) || manifest.groupId.length > 512 ||
    !digest(manifestDigest) || await executionDigest(body) !== manifestDigest ||
    manifest.runId !== runId || !nonblank(manifest.batchId) ||
    !nonblank(manifest.contribution.inputMessageId) ||
    !natural(manifest.firstOrdinal) ||
    command?.mechanism !== "execute_operator_command" ||
    canonical(manifest.identity) !== canonical(request.identity) ||
    canonical(manifest.contribution) !== canonical(request.contribution) ||
    manifest.executionPin.modelDigest !== request.model.version.digest ||
    manifest.executionPin.repositoryVersion !==
      request.model.version.repositoryVersion ||
    !nonblank(manifest.sourcePin.version) ||
    !digest(manifest.sourcePin.digest) ||
    !Array.isArray(manifest.members) || !manifest.members.length ||
    manifest.members.length > 4 ||
    !natural(manifest.limits.responseCharacters) ||
    !natural(manifest.limits.flowSteps) ||
    manifest.limits.flowSteps > request.maxSteps ||
    manifest.limits.flowSteps < manifest.members.length
  ) throw new Error("IMMUTABLE_CONSULTATION_MANIFEST_INVALID");
  const ids = new Set<string>(),
    keys = new Set<string>(),
    argumentsSeen = new Set<string>();
  let characters = 0;
  for (const [index, member] of manifest.members.entries()) {
    if (!member) throw new Error("IMMUTABLE_CONSULTATION_MEMBER_INVALID");
    if (
      member.ordinal !== manifest.firstOrdinal + index ||
      !nonblank(member.callId) || member.callId.length > 256 ||
      ids.has(member.callId) ||
      !nonblank(member.effectKey) || keys.has(member.effectKey) ||
      !digest(member.argumentsDigest) ||
      argumentsSeen.has(member.argumentsDigest) ||
      !immutableModelConsultation(member.request) ||
      member.request.version !== manifest.sourcePin.version ||
      await executionDigest(member.request) !== member.argumentsDigest ||
      member.choice.kind !== "consult_model" ||
      typeof member.choice.text !== "string" ||
      typeof member.choice.inputJson !== "string" ||
      member.choice.inputJson.length > 65_536 ||
      canonical(JSON.parse(member.choice.inputJson)) !==
        canonical(member.request) ||
      !natural(member.responseCharacters) || !natural(member.flowStepOrdinal) ||
      member.flowStepOrdinal < 1 ||
      index > 0 &&
        member.flowStepOrdinal !==
          manifest.members[index - 1]!.flowStepOrdinal + 1
    ) throw new Error("IMMUTABLE_CONSULTATION_MEMBER_INVALID");
    ids.add(member.callId);
    keys.add(member.effectKey);
    argumentsSeen.add(member.argumentsDigest);
    characters += member.responseCharacters;
  }
  if (
    !Number.isSafeInteger(characters) ||
    characters > manifest.limits.responseCharacters
  ) {
    throw new Error("IMMUTABLE_CONSULTATION_RESERVATION_EXCEEDED");
  }
}

/** Registration must come from an exact, already-recorded provider response. */
export function assertImmutableConsultationBusinessSource(
  manifest: ImmutableConsultationGroupManifest,
  state: SystemRuntimeState,
): void {
  const batch = state.conversationBatches?.find((entry) =>
    entry.id === manifest.batchId
  );
  const scope = manifest.identity.scope;
  if (
    !batch || batch.modelDigest !== manifest.executionPin.modelDigest ||
    !state.caseInvocation ||
    invocationKey(state.caseInvocation) !== manifest.identity.invocationKey ||
    state.activeInputMessageId !== manifest.contribution.inputMessageId ||
    state.executionModel?.identity.builderId !== manifest.identity.operatorId ||
    batch.invocationKey !== manifest.identity.invocationKey ||
    batch.inputMessageId !== manifest.contribution.inputMessageId ||
    (scope.kind === "request"
      ? batch.caseId !== scope.scopeId || !!batch.designerScopeId
      : batch.designerScopeId !== scope.scopeId || !!batch.caseId) ||
    batch.sourceDecision.modelContext?.version !== manifest.sourcePin.version ||
    batch.sourceDecision.modelContext.sourceDigest !==
      manifest.sourcePin.digest ||
    state.executionModel?.version.digest !==
      manifest.executionPin.modelDigest ||
    state.executionModel.version.repositoryVersion !==
      manifest.executionPin.repositoryVersion
  ) throw new Error("IMMUTABLE_CONSULTATION_SOURCE_MISMATCH");
  for (const member of manifest.members) {
    const call = member && batch.calls[member.ordinal];
    if (
      !member || !call || call.id !== member.callId ||
      canonical(call.decision) !== canonical(member.choice) ||
      call.status !== "queued" && call.status !== "started" || call.result
    ) {
      throw new Error("IMMUTABLE_CONSULTATION_SOURCE_MEMBER_MISMATCH");
    }
  }
}

export function assertImmutableConsultationOutcome(
  manifest: ImmutableConsultationGroupManifest,
  member: ImmutableConsultationGroupMember,
  outcome: ImmutableConsultationMemberOutcome,
): void {
  const scope = manifest.identity.scope;
  const validMessageScope = (
    message: ImmutableConsultationMemberOutcome["messages"][number],
  ) =>
    scope.kind === "request"
      ? message.caseId === scope.scopeId && !message.designerScopeId
      : message.designerScopeId === scope.scopeId && !message.caseId;
  const validPin = (
    reference:
      ImmutableConsultationMemberOutcome["messages"][number]["execution"],
  ) =>
    !reference || reference.digest === manifest.executionPin.modelDigest &&
      reference.repositoryVersion === manifest.executionPin.repositoryVersion;
  if (
    !outcome || outcome.groupId !== manifest.groupId ||
    outcome.callId !== member.callId ||
    outcome.effectKey !== member.effectKey ||
    outcome.argumentsDigest !== member.argumentsDigest ||
    !["succeeded", "failed", "refused", "cancelled"].includes(
      outcome.result?.status,
    ) ||
    !nonblank(outcome.result.code) ||
    typeof outcome.result.details !== "string" ||
    !Array.isArray(outcome.messages) || !Array.isArray(outcome.events) ||
    outcome.messages.some((message) =>
      !nonblank(message.id) || !validMessageScope(message) ||
      !validPin(message.execution) ||
      !["assistant", "tool"].includes(message.role) ||
      typeof message.text !== "string" || typeof message.at !== "string"
    ) ||
    outcome.events.some((event) =>
      !nonblank(event.id) || !validPin(event.execution) ||
      (scope.kind === "request"
        ? event.caseId !== scope.scopeId
        : !!event.caseId)
    ) ||
    new Set(outcome.messages.map((message) => message.id)).size !==
      outcome.messages.length ||
    new Set(outcome.events.map((event) => event.id)).size !==
      outcome.events.length
  ) throw new Error("IMMUTABLE_CONSULTATION_RECEIPT_MISMATCH");
}
