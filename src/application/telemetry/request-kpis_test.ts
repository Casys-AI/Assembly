import { deepStrictEqual, equal } from "node:assert/strict";
import type { Case } from "../../domain/work/entities/cases.ts";
import type { Message, SystemRuntimeState } from "../work/runtime/state.ts";
import { requestKpis } from "./request-kpis.ts";

const openedAt = "2026-11-03T00:00:00.000Z";
const record: Case = {
  id: "request",
  number: 1,
  type: "request",
  objective: "Work",
  owner: "operator",
  openedBy: "person",
  status: "open",
  createdAt: openedAt,
  openedFrom: { conversationId: "owner-journal", messageId: "opening" },
  modelPin: { digest: "model" },
};
const message: Message = {
  id: "opening",
  caseId: record.id,
  role: "user",
  text: "Work",
  at: openedAt,
};

Deno.test("Request duration is unknown while open and spans creation to closure", () => {
  equal(requestKpis(record, []).durationMs, null);
  equal(
    requestKpis({
      ...record,
      status: "closed-abandoned",
      closedAt: "2026-11-03T00:01:00.000Z",
    }, []).durationMs,
    60_000,
  );
});

Deno.test("human messages exclude the opening, other Requests and generated inputs", () => {
  const result = requestKpis(record, [{
    id: "owner-journal",
    messages: [
      message,
      { ...message, id: "follow-up" },
      { ...message, id: "foreign", caseId: "other-request" },
      { ...message, id: "assistant", role: "assistant" },
      { ...message, id: "work", work: {} as NonNullable<Message["work"]> },
      {
        ...message,
        id: "notice",
        operatorNotice: {} as NonNullable<Message["operatorNotice"]>,
      },
      {
        ...message,
        id: "observation",
        observation: { kind: "behavior-result", value: {} },
      },
    ],
  }, {
    // Message IDs belong to their journal; a member's own message still counts.
    id: "member-journal",
    messages: [message],
  }]);
  deepStrictEqual(result.humanInterventions, { messages: 2, decisions: 0 });
});

Deno.test("human decisions count exact Request cards even while publication is pending", () => {
  const change = {
    id: "approved",
    caseId: record.id,
    kind: "mandate-change" as const,
    status: "approved" as const,
    baseRevision: 1,
    reason: "Test",
    requestedAt: openedAt,
    decidedAt: openedAt,
    authority: "human" as const,
  };
  const configuration = {
    changes: [
      change,
      { ...change, id: "pending-publication", status: "pending" },
      { ...change, id: "operator", authority: "builder" },
      {
        ...change,
        id: "automatic-refusal",
        status: "refused",
        authority: undefined,
      },
      { ...change, id: "foreign", caseId: "other-request" },
      { ...change, id: "undecided", decidedAt: undefined },
    ],
  } as NonNullable<SystemRuntimeState["configuration"]>;
  equal(
    requestKpis(record, [{ id: "owner-journal", messages: [], configuration }])
      .humanInterventions.decisions,
    2,
  );
});
