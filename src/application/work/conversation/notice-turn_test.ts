import { deepStrictEqual, equal } from "node:assert/strict";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { authorityNoticeInput, noticeDecisionRecorded } from "./notice-turn.ts";

Deno.test("a local Request notice is selected only for its exact woken invocation and decision", () => {
  const notice = {
    kind: "authority-escalation",
    changeId: "change",
    requestedBy: "member",
    caseId: "case",
    recipient: "bo",
    decisionAuthority: "operator",
    reason: "request",
  } as const;
  const state = {
    activeInputMessageId: "notice",
    caseInvocation: { kind: "local", caseId: "case" },
    executionModel: { identity: { builderId: "bo" } },
    messages: [{
      id: "notice",
      role: "tool",
      caseId: "case",
      noticeWake: true,
      operatorNotice: notice,
    }],
  } as unknown as SystemRuntimeState;
  const decision = {
    kind: "decide_operator_change",
    operatorId: "member",
    changeId: "change",
  } as const;
  const result = {
    status: "succeeded",
    code: "DELEGATED_DECISION_RECORDED",
  } as const;
  deepStrictEqual(authorityNoticeInput(state, "notice"), notice);
  equal(
    noticeDecisionRecorded(state, "notice", decision as never, result as never),
    true,
  );
  equal(
    noticeDecisionRecorded(
      state,
      "notice",
      { ...decision, changeId: "other" } as never,
      result as never,
    ),
    false,
  );
  const wrong = structuredClone(state);
  wrong.messages[0].caseId = "other";
  equal(authorityNoticeInput(wrong, "notice"), undefined);
  equal(
    noticeDecisionRecorded(wrong, "notice", decision as never, result as never),
    false,
  );
  equal(authorityNoticeInput(state, "other"), undefined);
});
