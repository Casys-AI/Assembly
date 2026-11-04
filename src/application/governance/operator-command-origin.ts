import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../work/operators/command-delivery.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import type { ChatDecision } from "../work/conversation/chat-decision.ts";
import type { Message, SystemRuntimeState } from "../work/runtime/state.ts";
import type { ExecutableModelVersion } from "../../domain/model/execution/executable-model.ts";

/** Select canonical host-recorded evidence; candidate source text never grants
 * permission. Current policy and durable source-effect checks remain required. */
export function exactCandidateInspection(
  state: {
    messages: readonly Message[];
    caseInvocation?: SystemRuntimeState["caseInvocation"];
    executionModel?: { version: ExecutableModelVersion };
  },
  expected: Record<string, unknown>,
): Message | undefined {
  const candidateId = expected.candidateId;
  if (
    typeof candidateId !== "string" || !candidateId.trim() ||
    typeof expected.operatorId !== "string"
  ) return;
  const invocation = state.caseInvocation;
  if (!invocation || !state.executionModel) return;
  const caseId = invocation.kind === "local"
    ? invocation.caseId
    : invocation.kind === "delegated"
    ? invocation.work.caseId
    : undefined;
  const designerScopeId = invocation.kind === "designer"
    ? invocation.scopeId
    : invocation.kind === "delegated-designer"
    ? invocation.work.designerContext.scopeId
    : undefined;
  for (const message of [...state.messages].reverse()) {
    if (message.observation?.kind !== "candidate-inspection") continue;
    const value = message.observation.value as {
      status?: string;
      operatorId?: string;
      candidate?: { id?: string };
      context?: { candidateId?: string; operatorId?: string };
      decisionReference?: Record<string, unknown>;
    } | undefined;
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      (value.candidate?.id ?? value.decisionReference?.candidateId ??
          value.context?.candidateId) !== candidateId
    ) continue;
    const owners = [
      value.operatorId,
      value.decisionReference?.operatorId,
      value.context?.operatorId,
    ].filter((owner) => typeof owner === "string");
    if (owners.length && !owners.includes(expected.operatorId)) continue;
    if (owners.some((owner) => owner !== expected.operatorId)) return;
    // The latest inspection for this scoped candidate invalidates earlier successes,
    // including a refused or different Request/version inspection.
    if (
      value.status === "refused" || !value.decisionReference ||
      canonical(value.decisionReference) !== canonical(expected) ||
      message.role !== "tool" ||
      message.execution?.digest !== state.executionModel.version.digest ||
      message.execution?.repositoryVersion !==
        state.executionModel.version.repositoryVersion ||
      (caseId ? message.caseId !== caseId : message.caseId !== undefined ||
        message.designerScopeId !== designerScopeId)
    ) return;
    return message;
  }
}

/** The actual source choice is a canonical started batch member. A copied
 * primitive key or actor DTO cannot substitute a different control intent. */
export function exactDelegatedCommandDecision(
  state: Pick<SystemRuntimeState, "activeBatchCall" | "conversationBatches">,
  targetOperatorId: string,
  command: Extract<
    OperatorControlCommand,
    { kind: "decide-candidate" | "decide-change" }
  >,
  origin: OperatorCommandOrigin,
):
  | Extract<
    ChatDecision,
    { kind: "decide_operator_candidate" | "decide_operator_change" }
  >
  | undefined {
  const pointer = state.activeBatchCall;
  const batch = state.conversationBatches?.find((value) =>
    value.id === pointer?.batchId
  );
  const call = batch?.calls.find((value) => value.id === pointer?.callId);
  const delegated = command.delegated;
  if (
    !batch || !call || !delegated || call.status !== "started" ||
    call.effectStarted !== true ||
    batch.inputMessageId !== origin.inputMessageId ||
    batch.invocationKey !==
      origin.businessRevision.__assemblyRuntimeRevision.invocationKey ||
    batch.modelDigest !==
      origin.businessRevision.__assemblyRuntimeRevision.modelDigest
  ) return;
  const chosen = call.decision;
  if (
    chosen.kind !== "decide_operator_candidate" &&
    chosen.kind !== "decide_operator_change"
  ) return;
  if (
    chosen.operatorId !== targetOperatorId ||
    chosen.policyId !== delegated.policyId ||
    chosen.policyRevision !== delegated.policyRevision ||
    chosen.verdict !== command.input.verdict
  ) return;
  if (command.kind === "decide-candidate") {
    return chosen.kind === "decide_operator_candidate" &&
        chosen.candidateId === command.input.candidateId &&
        chosen.candidateDigest === command.input.candidateDigest &&
        chosen.caseId === command.input.caseId &&
        typeof chosen.reason === "string" &&
        chosen.reason.trim() === command.input.reason.trim()
      ? chosen
      : undefined;
  }
  return chosen.kind === "decide_operator_change" &&
      chosen.changeId === command.input.changeId &&
      chosen.expectedRevision === command.input.expectedRevision
    ? chosen
    : undefined;
}
