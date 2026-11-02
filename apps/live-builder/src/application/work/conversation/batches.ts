import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { FlowActionResult } from "../../../domain/model/execution/flow.ts";
import type {
  ChatCallResult,
  ChatContext,
  ChatDecisionBatch,
  ConversationBatchCall,
  ConversationBatchExecution,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import type { ConversationDecisionHost } from "./turn-context.ts";
import { now } from "../runtime/values.ts";
import { invocationKey } from "../operators/journal.ts";

const MAX_BATCH_CALLS = 8;
export const MAX_PARALLEL_READS = 4;

export function batchInScope(
  state: SystemRuntimeState,
  batch: ConversationBatchExecution,
): boolean {
  if (!state.caseInvocation) return false;
  if (
    batch.inputMessageId && state.activeInputMessageId &&
    batch.inputMessageId !== state.activeInputMessageId
  ) return false;
  if (batch.invocationKey !== undefined) {
    if (batch.invocationKey !== invocationKey(state.caseInvocation)) {
      return false;
    }
  } else if (
    state.caseInvocation.kind === "delegated" ||
    state.caseInvocation.kind === "delegated-designer"
  ) {
    // A legacy root Case alone cannot prove which of several contributions owns it.
    // Unkeyed delegated work requires explicit effect reconciliation, never inference from a pointer.
    return false;
  }
  const caseId = caseExecutionContext(state)?.caseId;
  const designer = designerExecutionContext(state)?.scopeId;
  return caseId
    ? batch.caseId === caseId && !batch.designerScopeId
    : !!designer && batch.designerScopeId === designer && !batch.caseId;
}

export function activeBatchCall(state: SystemRuntimeState): {
  batch: ConversationBatchExecution;
  call: ConversationBatchCall;
} | undefined {
  const pointer = state.activeBatchCall;
  const batch = state.conversationBatches?.find((entry) =>
    entry.id === pointer?.batchId && batchInScope(state, entry)
  );
  const call = batch?.calls.find((entry) => entry.id === pointer?.callId);
  return batch && call ? { batch, call } : undefined;
}

/** Called only when native progress replaces or releases the active call pointer.
 * Keep its exact receipts and outputs; only the no-longer-addressable resume
 * context is disposable. Parked work and pending admission retain their cursor. */
export function retireCompletedCheckpoint(state: SystemRuntimeState): void {
  const active = activeBatchCall(state);
  if (
    !active || active.call.status !== "completed" ||
    !active.call.result ||
    ["awaiting-admission", "unknown"].includes(active.call.result.status) ||
    Object.values(state.invocationContinuations ?? {}).some((continuation) =>
      continuation.activeBatchCall?.batchId === active.batch.id &&
      continuation.activeBatchCall.callId === active.call.id
    )
  ) return;
  delete active.call.checkpoint;
}

export function pendingBatch(state: SystemRuntimeState) {
  return state.conversationBatches?.find((batch) =>
    batchInScope(state, batch) &&
    (batch.immutableGroup && !batch.immutableGroup.publication ||
      batch.calls.some((call) =>
        call.status === "queued" || call.status === "started" ||
        call.status === "unknown"
      ))
  );
}

export function hasQueuedBatchCall(state: SystemRuntimeState): boolean {
  return !!pendingBatch(state)?.calls.some((call) => call.status === "queued");
}

/** Host checks supplement the transport's complete argument/schema validation. */
function validateBatch(
  value: ChatDecisionBatch,
  model: ExecutableModel,
  priorProposals: number,
): void {
  if (
    !value || !Array.isArray(value.calls) || !value.calls.length ||
    value.calls.length > MAX_BATCH_CALLS
  ) throw new Error("A response requires between one and eight tool calls.");
  const ids = new Set<string>();
  let proposals = priorProposals;
  for (const [index, call] of value.calls.entries()) {
    if (
      !call || typeof call.id !== "string" || !call.id.trim() ||
      call.id.length > 256 || ids.has(call.id) || !call.decision ||
      typeof call.decision.kind !== "string" ||
      typeof call.decision.text !== "string"
    ) throw new Error("Every tool call requires its own exact, unique ID.");
    ids.add(call.id);
    const kind = call.decision.kind;
    if (
      ["reply"].includes(
        kind,
      ) && index !== value.calls.length - 1
    ) {
      throw new Error(
        "A terminal response must be the final call in its group.",
      );
    }
    if (
      kind === "propose_tool" && ++proposals > model.policy.maxToolProposals
    ) {
      throw new Error("The group exceeds the admitted tool proposal ceiling.");
    }
    if (
      kind === "reply" && call.decision.caseClosure &&
      value.calls.slice(0, index).some((member) =>
        member.decision.kind.startsWith("propose_")
      )
    ) {
      throw new Error(
        "A response cannot close a Case while submitting proposals for admission.",
      );
    }
  }
}

export async function recordBatch(
  host: ConversationDecisionHost,
  model: ExecutableModel,
  response: ChatDecisionBatch,
  sourceDecision: ConversationBatchExecution["sourceDecision"],
  priorProposals: number,
  decisionContextCharacters?: number,
): Promise<ConversationBatchExecution> {
  validateBatch(response, model, priorProposals);
  const caseId = caseExecutionContext(host.state)?.caseId;
  const designerScopeId = designerExecutionContext(host.state)?.scopeId;
  if (!caseId && !designerScopeId) {
    throw new Error("A correlated response requires an explicit Case scope.");
  }
  const batch: ConversationBatchExecution = {
    id: crypto.randomUUID(),
    ...(host.state.activeInputMessageId
      ? { inputMessageId: host.state.activeInputMessageId }
      : {}),
    invocationKey: invocationKey(host.state.caseInvocation!),
    ...(caseId ? { caseId } : { designerScopeId }),
    modelDigest: model.version.digest,
    createdAt: now(),
    ...(decisionContextCharacters === undefined
      ? {}
      : { decisionContextCharacters }),
    ...(response.assistantBlocks
      ? { assistantBlocks: structuredClone(response.assistantBlocks) }
      : {}),
    sourceDecision: structuredClone(sourceDecision),
    calls: response.calls.map((call) => ({
      ...structuredClone(call),
      status: "queued",
    })),
  };
  await host.update((state) => {
    batch.recordedRevision = state.revision + 1;
    (state.conversationBatches ??= []).push(batch);
  });
  return batch;
}

export async function selectBatchCall(
  host: ConversationDecisionHost,
): Promise<ReturnType<typeof activeBatchCall>> {
  const batch = pendingBatch(host.state);
  if (!batch) return undefined;
  if (batch.immutableGroup && !batch.immutableGroup.publication) {
    throw new Error(
      "An immutable consultation group still awaits its complete publication",
    );
  }
  if (batch.calls.some((call) => call.status === "unknown")) {
    throw new Error(
      "BATCH_EFFECT_UNKNOWN: inspect the exact recorded effect before explicit recovery; automatic replay is refused.",
    );
  }
  const call = batch.calls.find((call) =>
    call.status === "started" || call.status === "queued"
  )!;
  await host.update((state) => {
    const record = state.conversationBatches!.find((item) =>
      item.id === batch.id
    )!;
    record.calls.find((item) => item.id === call.id)!.status = "started";
    state.activeBatchCall = { batchId: batch.id, callId: call.id };
  });
  return activeBatchCall(host.state);
}

export async function completeBatchCall(
  host: Pick<ConversationDecisionHost, "state" | "update">,
  batchId: string,
  callId: string,
  result: ChatCallResult,
  action?: { nodeId: string; output: FlowActionResult },
): Promise<void> {
  await host.update((state) => {
    const call = state.conversationBatches!.find((batch) =>
      batch.id === batchId
    )!
      .calls.find((call) => call.id === callId)!;
    call.result = structuredClone(result);
    call.status = result.status === "unknown"
      ? "unknown"
      : result.status === "cancelled"
      ? "cancelled"
      : "completed";
    if (action) {
      (call.actionResults ??= {})[action.nodeId] = structuredClone(
        action.output,
      );
    }
  });
}

/** Only a verified publication may invalidate unstarted siblings of its exact call. */
export function cancelQueuedAfterTeamPublication(
  state: SystemRuntimeState,
  changeId: string,
  priorDigest: string,
  caseId: string,
): void {
  const active = activeBatchCall(state);
  if (
    !active || active.batch.modelDigest !== priorDigest ||
    active.batch.caseId !== caseId || active.call.status !== "started" ||
    !active.call.effectStarted || active.call.changeId !== changeId ||
    active.call.decision.kind !== "propose_agent_creation"
  ) return;
  for (const call of active.batch.calls) {
    if (call.status !== "queued") continue;
    call.status = "cancelled";
    call.result = {
      status: "cancelled",
      code: "BATCH_REPLAN_REQUIRED",
      details:
        "The admitted model changed after verified team creation. Replan this call using the current context.",
    };
  }
}

export function batchHistory(
  state: SystemRuntimeState,
): ChatContext["toolCallHistory"] {
  // Replay one whole recent exchange; older receipts remain in durable state.
  const batch = state.conversationBatches?.findLast((batch) =>
    batchInScope(state, batch) && batch.calls.every((call) => !!call.result)
  );
  if (!batch) return undefined;
  const last = batch.calls.at(-1);
  if (
    last?.decision.kind === "reply" && last.status === "completed" &&
    last.result?.status === "succeeded" &&
    last.result.code === "REPLY_RECORDED"
  ) {
    // The native reply primitive attests this response was delivered. Replaying
    // its tool exchange after a fresh input would place an old terminal answer
    // after that input. Keep its durable receipt, without reviving an older group.
    return undefined;
  }
  return [{
    assistantBlocks: structuredClone(batch.assistantBlocks ?? []),
    results: batch.calls.map((call) => ({
      id: call.id,
      result: JSON.stringify(call.result),
      ...(["failed", "refused", "unknown", "cancelled"].includes(
          call.result!.status,
        )
        ? { isError: true }
        : {}),
    })),
  }];
}

export function nativeCallResult(
  output: FlowActionResult,
  candidate?: {
    id: string;
    stage: string;
    digest: string;
    error?: string;
    errorCode?: string;
  },
  representation: "native-outcome" | "operator-command" = "native-outcome",
): ChatCallResult | undefined {
  const outcome = output.outputs?.outcome as {
    succeeded?: boolean;
    refused?: boolean;
    code?: string;
    details?: string;
    value?: unknown;
  } | undefined;
  if (!outcome || typeof outcome.succeeded !== "boolean") return undefined;
  return {
    status: outcome.code === "BEHAVIOR_RESULT_UNCONFIRMED"
      ? "unknown"
      : candidate?.stage === "awaiting-admission"
      ? "awaiting-admission"
      : candidate?.stage === "refused"
      ? "refused"
      : candidate?.stage === "failed"
      ? "failed"
      : outcome.refused
      ? "refused"
      : outcome.succeeded
      ? "succeeded"
      : "failed",
    code: candidate?.errorCode ?? outcome.code ?? "CALL_COMPLETED",
    details: candidate?.error ?? outcome.details ?? "",
    // executeOperatorCommand already owns the exact business result value. Its
    // flow outcome is only a routing envelope, not another result payload.
    // Other primitives retain their established full native-outcome format.
    value: representation === "operator-command"
      ? structuredClone(outcome.value)
      : { ...structuredClone(outcome), ...(candidate ? { candidate } : {}) },
  };
}
