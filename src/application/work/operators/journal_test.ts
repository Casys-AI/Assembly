import { deepStrictEqual, equal, notEqual, throws } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { Case } from "../../../domain/work/entities/cases.ts";
import {
  candidateCaseInvocation,
  invocationKey,
  type OperatorWorkCompletion,
  recordedOperatorWork,
  requestChangeInvocation,
  waitingOperatorWork,
} from "./journal.ts";
import { type OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";

Deno.test("a member change continuation uses only its recorded work and rejects a lost or changed origin", () => {
  const f = fixture();
  const { receipt } = f.contribution("member-input");
  const record = { id: "root-request", owner: "main", status: "open" } as Case;
  receipt.caseContext.record = record;
  f.state.executionModel!.operatorTeam = {
    parentOperatorId: "main",
    requestOwnerId: "main",
    requestId: "root-request",
  };
  const change = {
    id: "change",
    requestedBy: "worker",
    caseId: "root-request",
  } as never;
  f.state.configuration = {
    ...f.state.executionModel!.configuration,
    changes: [change],
  };
  const invocation = { kind: "delegated" as const, work: receipt };
  f.state.changeWorkContinuations = {
    change: {
      inputMessageId: "member-input",
      invocationKey: invocationKey(invocation),
    },
  };
  deepStrictEqual(
    requestChangeInvocation(f.state, "change", "root-request", "member-input"),
    invocation,
  );
  throws(
    () =>
      requestChangeInvocation(f.state, "change", "root-request", "other-input"),
    { code: "CASE_CONFLICT" },
  );
  delete f.state.changeWorkContinuations;
  f.state.cases!.push({ ...record, owner: "worker" });
  throws(
    () =>
      requestChangeInvocation(
        f.state,
        "change",
        "root-request",
        "member-input",
      ),
    { code: "CASE_SCOPE_MISSING" },
  );
});

Deno.test("a retained Release member continues recorded work in its current Request", () => {
  const { state, contribution } = fixture();
  const { receipt } = contribution("member-input");
  receipt.caseContext.record = {
    id: "root-request",
    owner: "main",
    status: "open",
  } as Case;
  state.executionModel!.operatorTeam = {
    parentOperatorId: "main",
    requestOwnerId: "main",
    requestId: "origin-request",
  };
  state.configuration = {
    ...state.executionModel!.configuration,
    changes: [
      { id: "change", requestedBy: "worker", caseId: "root-request" } as never,
    ],
  };
  const invocation = { kind: "delegated" as const, work: receipt };
  state.changeWorkContinuations = {
    change: {
      inputMessageId: "member-input",
      invocationKey: invocationKey(invocation),
    },
  };
  deepStrictEqual(
    requestChangeInvocation(state, "change", "root-request", "member-input"),
    invocation,
  );
});

function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "worker",
  });
  const state: SystemRuntimeState = {
    id: "session",
    revision: 3,
    catalogRevision: 0,
    executionModel: model,
    cases: [],
    candidates: [],
    messages: [],
    events: [],
    busy: false,
    phase: "waiting",
    provider: "test",
  };
  function contribution(id: string) {
    const candidate: Candidate = {
      id: `candidate-${id}`,
      caseId: "root-request",
      name: id,
      description: id,
      code: "export default () => ({})",
      kind: "read_web_page",
      digest: id,
      stage: "awaiting-admission",
      createdAt: "now",
      baseCatalogRevision: 0,
    };
    const receipt: OperatorWorkReceipt & {
      caseContext: NonNullable<OperatorWorkReceipt["caseContext"]>;
    } = {
      caseId: "root-request",
      caseContext: {
        caseId: "root-request",
        number: 1,
        modelPin: { digest: "pin" },
      },
      callerId: "main",
      correlationId: id,
      fingerprint: id,
      invocationId: id,
      behaviorId: "inbox",
      targetNativeId: "worker",
      priorCandidateIds: [],
      modelVersion: { digest: "pin", repositoryVersion: "source" },
    };
    state.candidates.push(candidate);
    state.messages.push({
      id,
      role: "tool",
      text: id,
      at: "now",
      caseId: receipt.caseId,
      work: receipt,
    });
    const completion: OperatorWorkCompletion = {
      id: `completed-${id}`,
      kind: "operator-work-waiting",
      label: id,
      at: "now",
      work: {
        caseId: receipt.caseId,
        callerId: receipt.callerId,
        correlationId: id,
        fingerprint: id,
        status: "waiting",
        messageCount: state.messages.length,
        continuation: `continuation-${id}`,
        candidateIds: [candidate.id],
        revision: state.revision,
        modelVersion: receipt.modelVersion,
      },
    };
    state.events.push(completion);
    return { candidate, receipt, completion };
  }
  return { state, contribution };
}

Deno.test("delegated invocation identity remains stable across refreshed Case budget but separates independent contributions", () => {
  const { contribution } = fixture();
  const a = contribution("A");
  const b = contribution("B");
  const original = { kind: "delegated" as const, work: a.receipt };
  const refreshed = structuredClone(original);
  refreshed.work.caseContext.budget = {
    scopeId: "root-request-budget",
    ownerId: "root-owner",
    policy: {
      id: "invocations",
      revision: 1,
      unit: "agent-invocation",
      limit: 30,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
    },
  };
  equal(invocationKey(original), invocationKey(refreshed));
  notEqual(
    invocationKey(original),
    invocationKey({ kind: "delegated", work: b.receipt }),
  );
  notEqual(
    invocationKey({ kind: "local", caseId: "A" }),
    invocationKey({ kind: "local", caseId: "B" }),
  );
  notEqual(
    invocationKey({ kind: "designer", scopeId: "A" }),
    invocationKey({ kind: "designer", scopeId: "B" }),
  );
});

Deno.test("candidate lookup and waiting receipts isolate multiple contributions to one Request", () => {
  const { state, contribution } = fixture();
  const a = contribution("A");
  const b = contribution("B");
  state.caseInvocation = { kind: "delegated", work: b.receipt };
  for (const value of [b, a]) {
    deepStrictEqual(candidateCaseInvocation(state, value.candidate), {
      kind: "delegated",
      work: value.receipt,
    });
    deepStrictEqual(
      waitingOperatorWork(state, value.candidate.id)?.receipt,
      value.receipt,
    );
    equal(
      recordedOperatorWork(state, "worker", "main", value.receipt.correlationId)
        ?.result.status,
      "waiting",
    );
  }
  state.messages.push({
    id: "other-request",
    role: "user",
    text: "Other",
    at: "now",
    caseId: "other",
  });
  equal(
    recordedOperatorWork(state, "worker", "main", "A")?.result.status,
    "waiting",
  );
});

Deno.test("ambiguous persisted candidate associations cannot select an invocation", () => {
  const { state, contribution } = fixture();
  const a = contribution("A");
  const b = contribution("B");
  b.completion.work.candidateIds.push(a.candidate.id);
  state.caseInvocation = { kind: "delegated", work: b.receipt };
  equal(candidateCaseInvocation(state, a.candidate), undefined);
  equal(waitingOperatorWork(state, a.candidate.id), undefined);
});

Deno.test("a candidate without an exact recorded association cannot borrow the selected contribution", () => {
  const { state, contribution } = fixture();
  const a = contribution("A");
  const b = contribution("B");
  state.events.length = 0;
  state.caseInvocation = { kind: "delegated", work: b.receipt };
  equal(candidateCaseInvocation(state, a.candidate), undefined);
});

Deno.test("a later same-scope human input supersedes unparked legacy delegated work", () => {
  const { state, contribution } = fixture();
  const a = contribution("A");
  state.caseInvocation = { kind: "delegated", work: a.receipt };
  state.messages.push({
    id: "superseding",
    role: "user",
    text: "New",
    at: "now",
    caseId: "root-request",
  });
  equal(waitingOperatorWork(state, a.candidate.id), undefined);
  equal(
    recordedOperatorWork(state, "worker", "main", "A")?.result.status,
    "failed",
  );
});

// The model-context observations are the contributor's private reads, not
// its contribution: they grow at each step, so the work receipt leaves them
// out (the plan's receipt bound), while the contributor's journal keeps them.
Deno.test("a work receipt leaves out the contributor's model reads, its journal keeps them", () => {
  const { state, contribution } = fixture();
  const { receipt } = contribution("A");
  state.events = [];
  const start = state.messages.length - 1;
  state.messages.push(
    {
      id: "read",
      role: "tool",
      text: "Mandatory declared model consultation; versioned observed data.",
      at: "now",
      caseId: receipt.caseId,
      observation: { kind: "model-context", value: { result: "large" } },
    },
    {
      id: "page",
      role: "tool",
      text: "Tool result",
      at: "now",
      caseId: receipt.caseId,
      observation: { kind: "tool-result", value: { url: "page" } },
    },
    {
      id: "reply",
      role: "assistant",
      text: "Contribution",
      at: "now",
      caseId: receipt.caseId,
    },
  );
  state.events.push({
    id: "completed-A",
    kind: "operator-work-completed",
    label: "A",
    at: "now",
    work: {
      caseId: receipt.caseId,
      callerId: receipt.callerId,
      correlationId: "A",
      fingerprint: "A",
      status: "completed",
      messageCount: state.messages.length,
      messageRanges: [{ start, end: state.messages.length }],
      candidateIds: [],
      revision: state.revision,
      modelVersion: receipt.modelVersion,
    },
  } as OperatorWorkCompletion);
  const recorded = recordedOperatorWork(state, "worker", "main", "A")!;
  equal(recorded.result.status, "completed");
  deepStrictEqual(recorded.result.messages.map((message) => message.id), [
    "A",
    "page",
    "reply",
  ]);
  equal(
    state.messages.filter((message) =>
      message.observation?.kind === "model-context"
    ).length,
    1,
    "the journal keeps the read",
  );
});
