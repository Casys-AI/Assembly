import type {
  ChatCallResult,
  ChatDecision,
  RequestOpeningOutcome,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import { activeBatchCall } from "./batches.ts";

/** Receipt of the host's dispatched opening, never a claim about its work. */
export function requestOpeningReceipt(
  state: SystemRuntimeState,
  inputMessageId: string | undefined,
  decision: ChatDecision | undefined,
  result: ChatCallResult,
): string | undefined {
  if (
    decision?.kind !== "open_request" ||
    result.status !== "succeeded" ||
    result.code !== "REQUEST_OPENING_RECORDED" ||
    state.caseInvocation?.kind !== "designer" ||
    !inputMessageId || state.activeInputMessageId !== inputMessageId
  ) return undefined;
  const input = invocationInput(state);
  if (input?.id !== inputMessageId || input.role !== "user" || input.work) {
    return undefined;
  }
  const opening = result.value as RequestOpeningOutcome | undefined;
  if (opening?.status !== "opened" || opening.phase !== "dispatched") {
    return undefined;
  }
  const href = `/cases?${new URLSearchParams({ case: opening.caseId })}`;
  return `[Request ${opening.caseNumber}](${href}) opened: ${decision.objective}`;
}

/** The recorded terminal command ends this response. Keep explicit receipts
 * for queued siblings so neither the wait nor a later input can run them. */
export function cancelCompletedTurnSiblings(
  state: SystemRuntimeState,
  inputMessageId: string,
  code: "NOTICE_DECISION_RECORDED" | "REQUEST_OPENING_RECORDED",
): void {
  const active = activeBatchCall(state);
  if (
    !active || active.call.status !== "started" ||
    active.batch.inputMessageId !== inputMessageId ||
    !state.caseInvocation ||
    active.batch.invocationKey !== invocationKey(state.caseInvocation)
  ) return;
  for (const call of active.batch.calls) {
    if (call.status !== "queued") continue;
    call.status = "cancelled";
    call.result = {
      status: "cancelled",
      code,
      details: code === "NOTICE_DECISION_RECORDED"
        ? "The exact notice decision was recorded; this turn awaits input."
        : "The Request opening was recorded; this turn awaits input.",
    };
  }
}
