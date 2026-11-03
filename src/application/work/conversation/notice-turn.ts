import type {
  ChatCallResult,
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";

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
