import type {
  ChatCallResult,
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { invocationKey } from "../operators/journal.ts";
import { activeBatchCall } from "./batches.ts";

/** A notice is a turn input only through its persisted wake and exact selection.
 * Its content remains an observation, never evidence that a decision succeeded. */
export function authorityNoticeInput(
  state: SystemRuntimeState,
  inputMessageId: string | undefined,
) {
  const invocation = state.caseInvocation;
  if (
    !inputMessageId || state.activeInputMessageId !== inputMessageId ||
    (invocation?.kind !== "designer" && invocation?.kind !== "local")
  ) return undefined;
  const message = state.messages.find((entry) => entry.id === inputMessageId);
  const notice = message?.operatorNotice;
  return message?.role === "tool" && message.noticeWake === true &&
      (invocation.kind === "designer"
        ? message.caseId === undefined &&
          message.designerScopeId === invocation.scopeId
        : message.caseId === invocation.caseId &&
          message.designerScopeId === undefined &&
          notice?.caseId === invocation.caseId) &&
      notice?.kind === "authority-escalation" &&
      notice.decisionAuthority === "operator" &&
      notice.recipient === state.executionModel?.identity.builderId
    ? notice
    : undefined;
}

export function noticeDecisionRecorded(
  state: SystemRuntimeState,
  inputMessageId: string | undefined,
  decision: ChatDecision | undefined,
  result: ChatCallResult,
): boolean {
  const notice = authorityNoticeInput(state, inputMessageId);
  return !!notice && decision?.kind === "decide_operator_change" &&
    decision.operatorId === notice.requestedBy &&
    decision.changeId === notice.changeId &&
    result.status === "succeeded" &&
    result.code === "DELEGATED_DECISION_RECORDED";
}

/** The recorded decision ends this notice's response. Retain explicit receipts
 * for unstarted siblings so neither the wait nor a later input can run them. */
export function cancelNoticeDecisionSiblings(
  state: SystemRuntimeState,
  inputMessageId: string,
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
      code: "NOTICE_DECISION_RECORDED",
      details:
        "The exact notice decision was recorded; this turn awaits input.",
    };
  }
}
