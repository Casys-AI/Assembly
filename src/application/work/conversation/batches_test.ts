import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { DecisionContextPolicy } from "../../../domain/work/policies/context-separation.ts";
import type {
  ChatCallResult,
  ChatContext,
  ConversationBatchExecution,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import {
  batchHistory,
  cancelQueuedAfterTeamPublication,
  nativeCallResult,
  retireCompletedCheckpoint,
} from "./batches.ts";
import {
  ContextRepresentationLimitError,
  projectDecisionContext,
} from "../context/separation.ts";
import {
  caseExecutionContext,
  caseMessages,
  createRequestCase,
  designerExecutionContext,
  selectDesignerInvocation,
} from "../cases/runtime.ts";

const policy: DecisionContextPolicy = {
  kind: "separated-context",
  pattern: "5.1",
  recentMessages: 5,
  maxMessageCharacters: 512,
  maxCollectionItems: 8,
  maxContextCharacters: 8192,
};
const at = "2026-10-26T01:00:00.000Z";

Deno.test("operator-command routing preserves its exact business value while native outcomes retain their envelope", () => {
  const value = {
    code: "AUTHORITY_REQUEST_STALE",
    context: { operatorId: "peer", requestId: "17" },
    recovery: { action: "refuse-and-repropose" },
    message: "Exact authority was refused",
    value: { correlation: "nested-value-is-business-data" },
  };
  const outcome = {
    succeeded: false,
    refused: true,
    code: value.code,
    details: value.message,
    value,
  };
  const output = { outputs: { outcome } };
  deepStrictEqual(nativeCallResult(output, undefined, "operator-command"), {
    status: "refused",
    code: value.code,
    details: value.message,
    value,
  });
  deepStrictEqual(nativeCallResult(output), {
    status: "refused",
    code: value.code,
    details: value.message,
    value: outcome,
  });
  const succeeded = {
    succeeded: true,
    refused: false,
    code: "DELEGATED_DECISION_RECORDED",
    details: "The delegated decision was recorded.",
    value: { operatorId: "peer", changeId: "change-17" },
  };
  deepStrictEqual(
    nativeCallResult(
      { outputs: { outcome: succeeded } },
      undefined,
      "operator-command",
    ),
    {
      status: "succeeded",
      code: succeeded.code,
      details: succeeded.details,
      value: succeeded.value,
    },
  );
  deepStrictEqual(output.outputs.outcome, outcome);
});

function scopedState(scope: "Request" | "designer"): SystemRuntimeState {
  const model = executableFixture({
    projectId: "batch-project",
    editingContextId: "batch-context",
    rootId: "batch-root",
    systemId: "batch-system",
    catalogId: "batch-catalog",
    builderId: "batch-builder",
  });
  const state: SystemRuntimeState = {
    id: "batch-conversation",
    revision: 1,
    catalogRevision: 1,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
    executionModel: model,
    cases: [],
  };
  if (scope === "Request") {
    createRequestCase(
      state,
      {
        id: "current-request",
        objective: "Continue the Request after observing results.",
        messageId: "request-message",
      },
      { now: () => at },
      1,
    );
  } else {
    selectDesignerInvocation(state);
  }
  state.messages.push({
    id: "request-message",
    role: "user",
    text: "Continue after observing the complete exchange.",
    at,
    ...(scope === "Request"
      ? { caseId: "current-request" }
      : { designerScopeId: state.designer!.scopeId }),
  });
  return state;
}

function completedBatch(
  state: SystemRuntimeState,
  id: string,
  details = "Exact observed data.",
  statuses: ChatCallResult["status"][] = ["succeeded"],
): ConversationBatchExecution {
  const caseId = caseExecutionContext(state)?.caseId;
  const calls = statuses.map((status, index) => ({
    id: `${id}:provider-call:${index}`,
    decision: {
      kind: "consult_model" as const,
      text: "Inspect the admitted model.",
      inputJson: JSON.stringify({
        operation: "search",
        query: `${id}:${index}`,
      }),
    },
    status: status === "unknown"
      ? "unknown" as const
      : status === "cancelled"
      ? "cancelled" as const
      : "completed" as const,
    result: {
      status,
      code: `EXACT_${status}`,
      details,
      value: { index, nested: [null, false, { receipt: `${id}:résultat` }] },
    },
  }));
  return {
    id,
    ...(caseId
      ? { caseId }
      : { designerScopeId: designerExecutionContext(state)!.scopeId }),
    modelDigest: state.executionModel!.version.digest,
    createdAt: at,
    sourceDecision: {},
    assistantBlocks: [
      {
        type: "thinking",
        thinking: `Opaque reasoning for ${id}.`,
        signature: `signed:${id}:exact+/=`,
      },
      { type: "redacted_thinking", data: `opaque:${id}` },
      ...calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.decision.kind,
        input: JSON.parse(call.decision.inputJson),
      })),
    ],
    calls,
  };
}

function context(
  state: SystemRuntimeState,
  history = batchHistory(state),
): ChatContext {
  const model = state.executionModel!;
  const request = caseExecutionContext(state)?.record;
  const designer = designerExecutionContext(state);
  return {
    ...(history ? { toolCallHistory: history } : {}),
    ...(request ? { case: request } : {}),
    ...(designer ? { designer } : {}),
    modelVersion: model.version,
    admittedModelVersion: model.version,
    executionPolicy: model.policy,
    mandate: model.mandate,
    messages: caseMessages(state),
    activeTools: [],
    candidates: [],
  };
}

Deno.test("native history appends complete exchanges across inputs without repeating observations", () => {
  const state = scopedState("Request");
  state.activeInputMessageId = "second-input";
  const first = completedBatch(state, "first");
  first.inputMessageId = "first-input";
  first.providerTurn = {
    inputMessageId: "first-input",
    brief: { input: "First" },
  };
  first.providerRepairs = [{
    assistantBlocks: [{
      type: "tool_use",
      id: "invalid",
      name: "reply",
      input: {},
    }],
    userBlocks: [{
      type: "tool_result",
      tool_use_id: "invalid",
      content: "INVALID_TOOL_INPUT",
      is_error: true,
    }],
  }];
  const observation = { source: "Observed exactly once" };
  first.calls[0].result!.value = observation;
  first.calls[0].result!.details = JSON.stringify(observation);
  const second = completedBatch(state, "second");
  second.inputMessageId = "second-input";
  second.providerTurn = {
    inputMessageId: "second-input",
    brief: { input: "Next" },
  };
  state.conversationBatches = [first];
  const before = batchHistory(state)!;
  state.conversationBatches.push(second);
  const after = batchHistory(state)!;
  deepStrictEqual(after.slice(0, before.length), before);
  equal(after.length, 2);
  deepStrictEqual(after[0].repairs, first.providerRepairs);
  equal(JSON.stringify(after).split("Observed exactly once").length - 1, 1);
  deepStrictEqual(after.map((entry) => entry.turn), [
    {
      inputMessageId: "first-input",
      brief: { input: "First" },
    },
    second.providerTurn,
  ]);
  equal(first.calls[0].result!.details, JSON.stringify(observation));
});

Deno.test("native history bounds large observations and retains a durable evidence reference", () => {
  const state = scopedState("Request");
  const batch = completedBatch(state, "large");
  batch.providerTurn = {
    inputMessageId: "request-message",
    brief: { input: "Read" },
  };
  batch.calls[0].result!.value = { source: "Exact large read ".repeat(3000) };
  batch.calls[0].result!.reference = {
    messageId: "read-receipt",
    messageDigest: "a".repeat(64),
  };
  state.conversationBatches = [batch];
  const retained = structuredClone(batch);
  const result = batchHistory(state)![0].results[0].result;
  ok(result.length <= 8192);
  deepStrictEqual(
    JSON.parse(result).reference,
    batch.calls[0].result!.reference,
  );
  equal(JSON.parse(result).truncated, true);
  deepStrictEqual(batch, retained);
});

for (
  const protection of [
    "started",
    "unknown",
    "awaiting-admission",
    "parked",
    "foreign-scope",
    "none",
  ] as const
) {
  Deno.test(`checkpoint retirement preserves ${protection} recovery and exact receipts`, () => {
    const state = scopedState("Request");
    const batch = completedBatch(state, "checkpointed");
    state.conversationBatches = [batch];
    state.activeBatchCall = { batchId: batch.id, callId: batch.calls[0].id };
    const call = batch.calls[0];
    call.checkpoint = { nodeId: "observed", context: { exact: "resume data" } };
    call.actionResults = { observed: { outputs: { observed: true } } };
    if (protection === "started" || protection === "unknown") {
      call.status = protection;
    } else if (protection === "awaiting-admission") {
      call.result!.status = "awaiting-admission";
    } else if (protection === "parked") {
      state.invocationContinuations = {
        parked: {
          invocation: state.caseInvocation!,
          activeBatchCall: structuredClone(state.activeBatchCall),
        },
      };
    } else if (protection === "foreign-scope") {
      batch.caseId = "another-request";
    }
    const before = structuredClone(state);
    retireCompletedCheckpoint(state);
    if (protection === "none") {
      delete before.conversationBatches![0].calls[0].checkpoint;
    }
    deepStrictEqual(state, before);
  });
}

for (const scope of ["Request", "designer"] as const) {
  Deno.test(`${scope} long batch history permits the next decision with only the latest complete exchange`, async () => {
    const state = scopedState(scope);
    state.conversationBatches = Array.from(
      { length: 24 },
      (_, index) =>
        completedBatch(
          state,
          `batch-${index}`,
          "Old exact receipt. ".repeat(200),
        ),
    );
    const latest = completedBatch(state, "latest-complete");
    state.conversationBatches.push(latest);
    const before = structuredClone(state);
    // Project each durable exchange independently to reconstruct the formerly
    // unbounded replay, using the same production serialization as the runtime.
    const unbounded = state.conversationBatches.flatMap((batch) =>
      batchHistory({ ...state, conversationBatches: [batch] })!
    );
    equal(unbounded.length, 25);
    ok(JSON.stringify(unbounded).length > policy.maxContextCharacters);
    await rejects(
      projectDecisionContext(context(state, unbounded), policy),
      ContextRepresentationLimitError,
    );

    const nextDecision = await projectDecisionContext(context(state), policy);
    ok(JSON.stringify(nextDecision).length <= policy.maxContextCharacters);
    equal(nextDecision.toolCallHistory!.length, 1);
    deepStrictEqual(
      nextDecision.toolCallHistory![0].assistantBlocks,
      latest.assistantBlocks,
    );
    deepStrictEqual(nextDecision.toolCallHistory![0].results, [{
      id: latest.calls[0].id,
      result: JSON.stringify(latest.calls[0].result),
    }]);
    deepStrictEqual(state, before);
  });

  Deno.test(`${scope} replay skips a newer incomplete group and isolates other scopes`, () => {
    const state = scopedState(scope);
    const latest = completedBatch(state, "latest-complete");
    const incomplete = completedBatch(state, "newer-incomplete", "Partial.", [
      "succeeded",
      "succeeded",
    ]);
    incomplete.calls[1].status = "queued";
    delete incomplete.calls[1].result;
    const foreignRequest = {
      ...completedBatch(state, "other-request"),
      caseId: "other-request",
      designerScopeId: undefined,
    };
    const foreignDesigner = {
      ...completedBatch(state, "other-designer"),
      caseId: undefined,
      designerScopeId: "other-designer",
    };
    const ambiguous = {
      ...completedBatch(state, "ambiguous-scope"),
      caseId: "current-request",
      designerScopeId: state.designer?.scopeId ?? "other-designer",
    };
    state.conversationBatches = [
      latest,
      incomplete,
      foreignRequest,
      foreignDesigner,
      ambiguous,
    ];
    const before = structuredClone(state);
    deepStrictEqual(
      batchHistory(state)![0].results.map((result) => result.id),
      [
        latest.calls[0].id,
      ],
    );
    deepStrictEqual(state, before);
    state.conversationBatches.shift();
    equal(batchHistory(state), undefined);
  });

  Deno.test(`${scope} an individually oversized exchange remains whole and is refused by the context limit`, async () => {
    const state = scopedState(scope);
    const oversized = completedBatch(state, "oversized", "x".repeat(20000));
    state.conversationBatches = [
      completedBatch(state, "older-small"),
      oversized,
    ];
    const before = structuredClone(state);
    equal(
      batchHistory(state)![0].results[0].result,
      JSON.stringify(oversized.calls[0].result),
    );
    await rejects(
      projectDecisionContext(context(state), policy),
      ContextRepresentationLimitError,
    );
    deepStrictEqual(state, before);
  });
}

Deno.test("batch replay preserves every exact provider ID, result, error flag and opaque assistant block", () => {
  const state = scopedState("Request");
  const batch = completedBatch(
    state,
    "exact-exchange",
    "All fields stay exact.",
    [
      "succeeded",
      "awaiting-admission",
      "failed",
      "refused",
      "unknown",
      "cancelled",
    ],
  );
  state.conversationBatches = [batch];
  const before = structuredClone(state);
  const history = batchHistory(state)!;
  deepStrictEqual(history[0].assistantBlocks, batch.assistantBlocks);
  notStrictEqual(history[0].assistantBlocks, batch.assistantBlocks);
  deepStrictEqual(history[0].results.map((result) => result.isError), [
    undefined,
    undefined,
    true,
    true,
    true,
    true,
  ]);
  deepStrictEqual(
    history[0].results.map((result) => result.id),
    batch.calls.map((call) => call.id),
  );
  deepStrictEqual(
    history[0].results.map((result) => JSON.parse(result.result)),
    batch.calls.map((call) => call.result),
  );
  history[0].assistantBlocks.splice(0, 1);
  deepStrictEqual(state, before);
});

Deno.test("batch replay requires an explicitly selected scope", () => {
  const state = scopedState("designer");
  equal(batchHistory(state), undefined);
  state.conversationBatches = [completedBatch(state, "designer-receipt")];
  delete state.caseInvocation;
  equal(batchHistory(state), undefined);
});

Deno.test("verified team publication cancels only queued siblings of the linked call", () => {
  const state = scopedState("Request");
  const batch = completedBatch(state, "team", "done", [
    "succeeded",
    "succeeded",
    "succeeded",
    "unknown",
  ]);
  batch.calls[0] = {
    id: "creation",
    status: "started",
    effectStarted: true,
    changeId: "change-1",
    decision: {
      kind: "propose_agent_creation",
      role: "operator",
      name: "child",
      text: "create",
      reason: "work",
      operator: {
        kind: "request-team-member",
        instruction: "help",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 0,
            maxFlowSteps: 1,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
    },
  };
  batch.calls[1].status = "queued";
  delete batch.calls[1].result;
  state.conversationBatches = [batch];
  state.activeBatchCall = { batchId: batch.id, callId: "creation" };
  const original = structuredClone(state);
  cancelQueuedAfterTeamPublication(
    state,
    "wrong-change",
    batch.modelDigest,
    "current-request",
  );
  deepStrictEqual(state, original);
  cancelQueuedAfterTeamPublication(
    state,
    "change-1",
    batch.modelDigest,
    "current-request",
  );
  equal(batch.calls[0].status, "started");
  equal(batch.calls[1].status, "cancelled");
  equal(
    state.conversationBatches![0].calls[1].result?.code,
    "BATCH_REPLAN_REQUIRED",
  );
  deepStrictEqual(batch.calls[2], original.conversationBatches![0].calls[2]);
  deepStrictEqual(batch.calls[3], original.conversationBatches![0].calls[3]);
  equal(batch.modelDigest, original.conversationBatches![0].modelDigest);
});

for (const scope of ["Request", "designer"] as const) {
  Deno.test(`${scope} delivered final reply ends native batch replay without an older fallback`, () => {
    const state = scopedState(scope);
    const prior = completedBatch(state, "older-live-exchange");
    const delivered = completedBatch(state, "delivered-final");
    delivered.calls[0].decision = { kind: "reply", text: "Already delivered" };
    delivered.calls[0].result = {
      status: "succeeded",
      code: "REPLY_RECORDED",
      details: "Already delivered",
    };
    state.conversationBatches = [prior, delivered];
    const before = structuredClone(state);
    equal(batchHistory(state), undefined);
    deepStrictEqual(state, before);
  });

  Deno.test(`${scope} reply replay boundary requires every native delivery attestation`, () => {
    const state = scopedState(scope);
    const batch = completedBatch(state, "unattested-final");
    batch.calls[0].decision = { kind: "reply", text: "Not attested delivered" };
    state.conversationBatches = [batch];
    for (
      const [status, resultStatus, code] of [
        ["cancelled", "cancelled", "BATCH_REPLAN_REQUIRED"],
        ["completed", "refused", "REPLY_RECORDED"],
        ["completed", "succeeded", "OTHER_COMPLETION"],
        ["started", "succeeded", "REPLY_RECORDED"],
      ] as const
    ) {
      batch.calls[0].status = status;
      batch.calls[0].result = {
        status: resultStatus,
        code,
        details: "Exact receipt",
      };
      const before = structuredClone(state);
      const history = batchHistory(state)!;
      deepStrictEqual(history[0].assistantBlocks, batch.assistantBlocks);
      equal(
        history[0].results[0].result,
        JSON.stringify(batch.calls[0].result),
      );
      equal(
        history[0].results[0].isError,
        resultStatus === "cancelled" || resultStatus === "refused"
          ? true
          : undefined,
      );
      deepStrictEqual(state, before);
    }
  });

  Deno.test(`${scope} refused command retains its complete exchange even when rendered as a reply`, () => {
    const state = scopedState(scope);
    const batch = completedBatch(state, "refused-command");
    batch.calls[0].decision = {
      kind: "decide_operator_change",
      text: "Attempt the exact decision",
      operatorId: "target",
      changeId: "change",
      expectedRevision: 1,
      policyId: "grant",
      policyRevision: 1,
      verdict: "approve",
    };
    batch.calls[0].result = {
      status: "succeeded",
      code: "REPLY_RECORDED",
      details: "The request remains with the person: AUTHORITY_REQUEST_STALE.",
      value: { code: "AUTHORITY_REQUEST_STALE" },
    };
    state.conversationBatches = [batch];
    const before = structuredClone(state);
    const history = batchHistory(state)!;
    deepStrictEqual(history[0].assistantBlocks, batch.assistantBlocks);
    equal(history[0].results[0].result, JSON.stringify(batch.calls[0].result));
    deepStrictEqual(state, before);
  });
}
