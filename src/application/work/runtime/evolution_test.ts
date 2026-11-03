import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  invocationKey,
  type OperatorWorkMessage,
} from "../operators/journal.ts";
import {
  captureEvolutionOrigin,
  emptyEvolutionAwait,
  emptyNativeEvolutionAwait,
  evolutionCheckpoint,
  evolutionHumanSettlement,
  evolutionNetworkCheckpoint,
  exactNativeChangeApprovalWait,
  retireEvolutionAwaits,
} from "./evolution.ts";
import {
  type NativeDeclaredConsultationRefusal,
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "./execution.ts";
import { requestNetworkProposalDigest } from "../../../domain/governance/records/request-network-change.ts";
import { requestChangeProposalDigest } from "../../../domain/governance/records/request-change.ts";
import { recordRequestNetworkOutcome } from "../operators/request-network-outcome.ts";
import type { OperatorExecutionDelivery } from "../operators/execution.ts";
import {
  nativeSettledActionAdvanceEvidence,
  rederiveSettledAdvanceEvidence,
} from "./model-advance.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import {
  type OperatorWorkHost,
  processAcceptedContribution,
} from "../operators/coordination.ts";

function fixture(): SystemRuntimeState {
  const model = artifactModel("owner");
  const flow = structuredClone(model.flows.conversation);
  flow.nodes = [{
    ...flow.nodes[0],
    id: "await",
    nativeId: "native-await-action",
    name: "await",
    kind: "action",
    mechanism: "await_input",
    assertions: [],
    inputs: [],
    outputs: [],
  }];
  return {
    id: "runtime",
    revision: 2,
    catalogRevision: 0,
    provider: "test",
    phase: "ready",
    busy: false,
    executionModel: model,
    configuration: { ...model.configuration, changes: [] },
    candidates: [],
    events: [],
    caseInvocation: { kind: "local", caseId: "request-A" },
    conversationCursor: { nodeId: "await" },
    conversationFlow: flow,
    conversationContext: {},
    messages: [{
      id: "request-A:objective",
      role: "tool",
      text: "Investigate",
      at: "now",
      caseId: "request-A",
    }, {
      id: "reply",
      role: "assistant",
      text: "Finished",
      at: "now",
      caseId: "request-A",
    }],
    cases: [{
      id: "request-A",
      number: 1,
      owner: "owner",
      openedBy: "Main",
      type: "request",
      objective: "Investigate",
      modelPin: { digest: model.version.digest },
      status: "open",
      createdAt: "now",
      openedFrom: {
        conversationId: "main",
        openingId: "opening",
        designerScopeId: "designer",
      },
      firstRequestDispatched: true,
    }],
  };
}

Deno.test("evolution retires the exact completed host-opening input while keeping the Request open", () => {
  const state = fixture();
  assert.equal(evolutionCheckpoint(state).safe, true);
  retireEvolutionAwaits(state, "dossier", "now");
  assert.equal(state.conversationCursor, undefined);
  assert.equal(state.cases![0].status, "open");
  assert.equal(state.events.length, 1);
  assert.equal(
    JSON.parse(state.events[0].label).inputMessageId,
    "request-A:objective",
  );
  assert.equal("invocation" in state, false);
});

function declaredRefusalFixture() {
  const state = fixture();
  state.messages = state.messages.slice(0, 1);
  state.activeInputMessageId = state.messages[0].id;
  const flow = state.conversationFlow!;
  const consult = {
    ...structuredClone(flow.nodes[0]),
    id: "consult",
    nativeId: "consult-native",
    name: "consult",
    mechanism: "consult_declared_source" as const,
  };
  flow.nodes.push(consult);
  state.executionModel!.flows.conversation = structuredClone(flow);
  state.executionModel!.version.repositoryVersion = "commit:old";
  delete state.conversationCursor;
  delete state.conversationFlow;
  const identity = nativeExecutionIdentity(
    state,
    "conversation",
    state.activeInputMessageId,
  );
  const refusal: NativeDeclaredConsultationRefusal = {
    version: 1,
    identity,
    contributionId: "accepted-opening",
    inputMessageId: state.activeInputMessageId,
    modelDigest: state.executionModel!.version.digest,
    repositoryVersion: "commit:old",
    flowRootId: flow.rootNativeId,
    flowOccurrenceId: flow.rootOccurrenceId,
    nodeId: consult.id,
    actionId: consult.nativeId,
    effectKey: `native-effect:${"a".repeat(64)}`,
    code: "MODEL_CONSULTATION_REFUSED",
  };
  const execution: NativeExecutionSnapshot = {
    identity: structuredClone(identity),
    contributionId: refusal.contributionId,
    threadId: "native-thread",
    modelDigest: refusal.modelDigest,
    repositoryVersion: refusal.repositoryVersion,
    flowRootId: flow.rootNativeId,
    checkpointId: "native-checkpoint",
    status: "waiting",
    waits: [{ nodeId: "await", mechanism: "await_input", kind: "input" }],
    unsettledEffects: [],
    pendingContributions: [],
    localState: { declaredConsultationRefusal: refusal },
  };
  return { state, execution, refusal };
}

Deno.test("network approval wait requires exact native proposal and input evidence", () => {
  const { state, execution, refusal } = declaredRefusalFixture();
  const model = state.executionModel!;
  const node = model.flows.conversation.nodes.find((item) =>
    item.id === "consult"
  )!;
  node.mechanism = "submit_proposal";
  state.configuration!.changes.push({
    id: "change",
    kind: "mandate-change",
    status: "approved",
    baseRevision: 1,
    requestedAt: "now",
    reason: "network",
    requestedBy: model.identity.builderId,
    caseId: "request-A",
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const wait = {
    ...refusal,
    changeId: "change",
    proposalIntentDigest: "b".repeat(64),
  };
  delete (wait as Partial<typeof wait>).code;
  execution.localState = { changeApprovalWait: wait };
  const expected = {
    changeId: "change",
    proposalIntentDigest: "b".repeat(64),
    caseId: "request-A",
  };
  assert.deepEqual(
    exactNativeChangeApprovalWait(state, execution, model, expected),
    wait,
  );
  assert.equal(
    exactNativeChangeApprovalWait(state, execution, model, {
      ...expected,
      changeId: "foreign",
    }),
    undefined,
  );
  const wrong = structuredClone(execution);
  (wrong.localState!.changeApprovalWait as typeof wait).inputMessageId =
    "foreign";
  assert.equal(
    exactNativeChangeApprovalWait(state, wrong, model, expected),
    undefined,
  );
  execution.unsettledEffects = [wait.effectKey];
  assert.equal(
    exactNativeChangeApprovalWait(state, execution, model, expected),
    undefined,
  );
  assert.equal(evolutionCheckpoint(state, [execution]).safe, false);
});

async function networkApprovalFixture() {
  const { state, execution, refusal } = declaredRefusalFixture();
  const model = state.executionModel!;
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = `commit:${"1".repeat(40)}`;
  model.flows.conversation.nodes.find((item) => item.id === "consult")!
    .mechanism = "submit_proposal";
  const change = {
    id: "change",
    kind: "mandate-change" as const,
    status: "approved" as const,
    authority: "human" as const,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-10-30T00:00:00.000Z",
    decidedAt: "2026-10-30T00:01:00.000Z",
    reason: "network",
    requestedBy: model.identity.builderId,
    caseId: "request-A",
    requestedRights: { addNetworkHosts: ["example.org"] },
    diff: {
      title: "Network",
      author: "owner",
      base: {
        repositoryVersion: model.version.repositoryVersion,
        modelDigest: model.version.digest,
        sourceDigest: "c".repeat(64),
      },
      sourceDigest: "d".repeat(64),
      files: [],
      patch: "",
      additions: 1,
      deletions: 1,
    },
  };
  state.configuration!.changes.push(change);
  state.changeDecisionContinuations = { change: "pending" };
  const { code: _code, ...baseWait } = refusal;
  const wait = {
    ...baseWait,
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
    changeId: change.id,
    proposalIntentDigest: await requestNetworkProposalDigest(change),
  };
  execution.modelDigest = wait.modelDigest;
  execution.repositoryVersion = wait.repositoryVersion;
  execution.localState = { changeApprovalWait: wait };
  state.id = `request:space:${model.identity.builderId}`;
  state.requestNetworkDecisions = {
    change: {
      openingId: "opening",
      executionSpaceId: "space",
      caseId: "request-A",
      commandId: "change",
      expectedRevision: 1,
      configurationRevision: change.baseRevision,
      proposalIntentDigest: wait.proposalIntentDigest,
      verdict: "approve",
    },
  };
  return { state, execution, wait, model };
}

Deno.test("4.8d D1: network readiness admits the Main Operator's delegated decision, never a bare builder one", async () => {
  const { state, execution } = await networkApprovalFixture();
  const change = state.configuration!.changes.find((entry) =>
    entry.id === "change"
  )!;
  const ready = async () =>
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe;
  change.authority = "builder";
  assert.equal(await ready(), false, "builder without a delegated receipt");
  change.authorityExercise = {
    delegation: { actorId: "main" },
  } as unknown as typeof change.authorityExercise;
  assert.equal(await ready(), true);
});

Deno.test("network readiness keeps unrelated and opaque work blocked", async () => {
  const { state, execution, wait } = await networkApprovalFixture();
  assert.equal(
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe,
    true,
  );
  state.requestNetworkDecisions!.change.proposalIntentDigest = "f".repeat(64);
  assert.equal(
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe,
    false,
  );
  state.requestNetworkDecisions!.change.proposalIntentDigest =
    wait.proposalIntentDigest;
  state.changeDecisionContinuations!.other = "pending";
  assert.equal(
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe,
    false,
  );
  delete state.changeDecisionContinuations!.other;
  delete execution.localState!.changeApprovalWait;
  assert.equal(
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe,
    false,
  );
});

Deno.test("network readiness preserves the exact approval context beside a completed ordinary native wait", async () => {
  const { state, execution: approval, model } = await networkApprovalFixture();
  const inputId = "completed-input", replyText = "Completed ordinary input";
  // An earlier input in the same scoped Request has its own completed reply.
  // The later host objective remains the exact network proposal's input.
  state.messages.unshift({
    id: inputId,
    role: "user",
    text: "Earlier Request input",
    at: "before",
    caseId: "request-A",
  }, {
    id: "completed-reply",
    role: "assistant",
    text: replyText,
    at: "before",
    caseId: "request-A",
  });
  const ordinary: NativeExecutionSnapshot = {
    ...structuredClone(approval),
    identity: nativeExecutionIdentity(
      { ...state, activeInputMessageId: inputId },
      "conversation",
      inputId,
    ),
    contributionId: "completed-ordinary-contribution",
    threadId: "completed-ordinary-thread",
    checkpointId: "completed-ordinary-checkpoint",
    localState: { reply: { kind: "reply", text: replyText } },
  };
  assert.equal(emptyNativeEvolutionAwait(state, ordinary, model), true);
  assert.equal(emptyNativeEvolutionAwait(state, approval, model), false);
  const combined = await evolutionNetworkCheckpoint(
    state,
    [ordinary, approval],
    "change",
    "request-A",
    [model],
  );
  assert.deepEqual(combined, { safe: true, blockers: [] });
  const isolated = evolutionCheckpoint(state, [ordinary], [model]);
  assert.equal(isolated.safe, false);
  assert.deepEqual(isolated.blockers.map((blocker) => blocker.code), [
    "EVOLUTION_CHANGE_CONTINUATION",
  ]);
  // A missing proposal snapshot cannot grant its exception to another wait.
  const missingApproval = await evolutionNetworkCheckpoint(
    state,
    [ordinary],
    "change",
    "request-A",
    [model],
  );
  assert.deepEqual(missingApproval, isolated);
  const opaque = structuredClone(ordinary);
  opaque.localState = {};
  const unsettled = await evolutionNetworkCheckpoint(
    state,
    [opaque, approval],
    "change",
    "request-A",
    [model],
  );
  assert.equal(unsettled.safe, false);
  assert.deepEqual(unsettled.blockers.map((blocker) => blocker.code), [
    "EVOLUTION_NATIVE_EXECUTION_UNSETTLED",
  ]);
});

function historicalReplyFixture() {
  const { state, execution } = declaredRefusalFixture();
  delete execution.localState!.declaredConsultationRefusal;
  execution.localState!.reply = {
    kind: "reply",
    text: "Finished under source zero",
  };
  state.messages.push({
    id: "old-reply",
    role: "assistant",
    text: "Finished under source zero",
    at: "then",
    caseId: "request-A",
  });
  const historical = structuredClone(state.executionModel!);
  state.executionModel = structuredClone(historical);
  state.executionModel.version = {
    ...historical.version,
    digest: "source-one",
    repositoryVersion: "commit:one",
  };
  state.messages.push({
    id: "new-input",
    role: "user",
    text: "Mandate approved",
    at: "later",
    caseId: "request-A",
  }, {
    id: "new-reply",
    role: "assistant",
    text: "Finished under source one",
    at: "later",
    caseId: "request-A",
  });
  state.activeInputMessageId = "new-input";
  return { state, execution, historical };
}

Deno.test("historical terminal native await requires its exact immutable source and never changes current admission", () => {
  const { state, execution, historical } = historicalReplyFixture();
  const current = structuredClone(state.executionModel);
  assert.equal(
    emptyNativeEvolutionAwait(state, execution),
    false,
    "The current pin cannot stand in for the old source",
  );
  assert.equal(evolutionCheckpoint(state, [execution]).safe, false);
  assert.equal(emptyNativeEvolutionAwait(state, execution, historical), true);
  assert.equal(
    evolutionCheckpoint(state, [execution], [historical]).safe,
    true,
  );
  retireEvolutionAwaits(state, "authorized-source-one-to-two", "now", [
    execution,
  ], [historical]);
  assert.deepEqual(
    state.executionModel,
    current,
    "Historical evidence never becomes current authority",
  );
  assert.equal(state.cases![0].status, "open");
  const receipt = JSON.parse(
    state.events.find((event) =>
      event.id.startsWith("evolution-native-retirement:")
    )!.label,
  );
  assert.equal(receipt.dossierId, "authorized-source-one-to-two");
  assert.equal(receipt.threadId, execution.threadId);
  assert.equal(receipt.checkpointId, execution.checkpointId);
  assert.equal(receipt.contributionId, execution.contributionId);
  assert.equal(receipt.inputMessageId, execution.identity.subjectId);
  assert.equal(receipt.modelDigest, historical.version.digest);
  assert.equal(receipt.repositoryVersion, historical.version.repositoryVersion);
});

Deno.test("historical native wait rejects foreign pins, inputs, terminal replies and unsettled owners", () => {
  const changes: Array<(f: ReturnType<typeof historicalReplyFixture>) => void> =
    [
      (f) => {
        f.historical.version.digest = "foreign";
      },
      (f) => {
        f.historical.version.repositoryVersion = "commit:foreign";
      },
      (f) => {
        delete f.historical.version.repositoryVersion;
        delete f.execution.repositoryVersion;
      },
      (f) => {
        f.historical.identity.builderId = "foreign-owner";
      },
      (f) => {
        f.execution.identity.subjectId = "missing-input";
      },
      (f) => {
        f.execution.identity.scope.scopeId = "another-request";
      },
      (f) => {
        f.execution.contributionId = "";
      },
      (f) => {
        delete f.execution.checkpointId;
      },
      (f) => {
        f.execution.flowRootId = "foreign-flow";
      },
      (f) => {
        f.execution.waits[0].nodeId = "foreign-wait";
      },
      (f) => {
        f.execution.waits[0].nodeId = "native-await-action";
      },
      (f) => {
        f.state.messages = f.state.messages.filter((message) =>
          message.id !== "old-reply"
        );
        f.state.messages.at(-1)!.text = "Finished under source zero";
      },
      (f) => {
        f.state.messages.find((message) => message.id === "old-reply")!.caseId =
          "another-request";
      },
      (f) => {
        f.execution.localState!.reply = {
          kind: "reply",
          text: "Unrecorded result",
        };
      },
      (f) => {
        f.execution.localState!.reply = "Finished under source zero";
      },
      (f) => {
        f.execution.status = "uncertain";
      },
      (f) => {
        f.execution.unsettledEffects = ["unknown-effect"];
      },
      (f) => {
        f.execution.openImmutableConsultationGroups = ["open-group"];
      },
      (f) => {
        f.execution.pendingContributions = ["unsettled-child"];
      },
      (f) => {
        f.state.activeBatchCall = {
          batchId: "open-batch",
          callId: "open-call",
        };
      },
      (f) => {
        f.state.error = "Unsettled owner";
      },
      (f) => {
        f.state.workBudget = {
          budgetId: "reserved",
          scopeId: "request-A",
          unit: "agent-invocation",
          limit: 3,
          consumed: 0,
          reserved: 1,
          remaining: 2,
          exhausted: false,
          suspended: false,
          onExhausted: "wait",
          exhaustionRecipient: "local-control",
        };
      },
    ];
  for (const [index, change] of changes.entries()) {
    const f = historicalReplyFixture();
    change(f);
    assert.equal(
      emptyNativeEvolutionAwait(f.state, f.execution, f.historical),
      false,
      `Unproved historical owner ${index}`,
    );
  }
});

function delegatedHistoricalReplyFixture(designer: boolean) {
  const f = historicalReplyFixture();
  const caseContext = {
    caseId: "request-A",
    number: 1,
    modelPin: {
      digest: f.historical.version.digest,
      repositoryVersion: f.historical.version.repositoryVersion,
    },
  };
  const designerContext = { scopeId: "designer", ownerId: "owner" };
  const work = {
    callerId: "Main",
    correlationId: "A",
    fingerprint: "fingerprint-A",
    invocationId: "work-A",
    behaviorId: "inbox",
    targetNativeId: "owner",
    modelVersion: {
      digest: f.historical.version.digest,
      repositoryVersion: f.historical.version.repositoryVersion!,
    },
    priorCandidateIds: [],
    ...(designer ? { designerContext } : { caseId: "request-A", caseContext }),
  };
  const peer = {
    ...work,
    correlationId: "B",
    fingerprint: "fingerprint-B",
    invocationId: "work-B",
  };
  const invocation = designer
    ? {
      kind: "delegated-designer" as const,
      work: { ...work, designerContext },
    }
    : { kind: "delegated" as const, work: { ...work, caseContext } };
  const selected = designer
    ? {
      kind: "delegated-designer" as const,
      work: { ...peer, designerContext },
    }
    : { kind: "delegated" as const, work: { ...peer, caseContext } };
  const messageScope = designer
    ? { designerScopeId: "designer" }
    : { caseId: "request-A" };
  f.state.designer = { scopeId: "designer" };
  const inputA: OperatorWorkMessage = {
    id: "input-A",
    role: "tool",
    text: "Work A",
    at: "first",
    ...messageScope,
    work,
  };
  const inputB: OperatorWorkMessage = {
    id: "input-B",
    role: "tool",
    text: "Work B",
    at: "second",
    ...messageScope,
    work: peer,
  };
  f.state.messages = [
    inputA,
    {
      id: "reply-A",
      role: "assistant",
      text: "Identical reply text",
      at: "first",
      ...messageScope,
    },
    inputB,
    {
      id: "reply-B",
      role: "assistant",
      text: "Identical reply text",
      at: "second",
      ...messageScope,
    },
  ];
  f.state.caseInvocation = selected;
  f.state.activeInputMessageId = "input-B";
  f.state.invocationContinuations = {
    [invocationKey(invocation)]: {
      invocation,
      inputMessageId: "input-A",
      messageCount: 2,
    },
  };
  f.execution.identity = nativeExecutionIdentity(
    { ...f.state, caseInvocation: invocation },
    "conversation",
    "input-A",
  );
  f.execution.localState!.reply = {
    kind: "reply",
    text: "Identical reply text",
  };
  const completion = {
    id: "actual-completion-A",
    kind: "operator-work-completed",
    label: "A completed",
    at: "first",
    work: {
      ...work,
      status: "completed" as const,
      messageCount: 2,
      messageRanges: [{ start: 0, end: 2 }],
      candidateIds: [],
      revision: 2,
    },
  };
  f.state.events.push(completion);
  return { ...f, completion };
}

Deno.test("historical delegated retirement accepts only its exact completed message ranges for Request and designer", () => {
  for (const designer of [false, true]) {
    const f = delegatedHistoricalReplyFixture(designer);
    assert.equal(
      emptyNativeEvolutionAwait(f.state, f.execution, f.historical),
      true,
    );
    // A may finish after B ran, with an exact disjoint continuation segment.
    const lateReply = f.state.messages.splice(1, 1)[0];
    f.state.messages.push(lateReply);
    f.completion.work.messageCount = 4;
    f.completion.work.messageRanges = [{ start: 0, end: 1 }, {
      start: 3,
      end: 4,
    }];
    assert.equal(
      emptyNativeEvolutionAwait(f.state, f.execution, f.historical),
      true,
    );
  }
});

Deno.test("historical delegated retirement cannot borrow an identical B reply or ambiguous completion ranges", () => {
  for (const designer of [false, true]) {
    const mutations: Array<
      (f: ReturnType<typeof delegatedHistoricalReplyFixture>) => void
    > = [
      (f) => {
        f.state.messages[1].text = "A has no native terminal reply";
      },
      (f) => {
        f.completion.work.messageRanges = [];
      },
      (f) => {
        Reflect.deleteProperty(f.completion.work, "messageRanges");
      },
      (f) => {
        f.state.events = [];
      },
      (f) => {
        f.completion.work.messageRanges = [{ start: 1, end: 2 }];
      },
      (f) => {
        f.completion.work.messageRanges = [{ start: 0, end: 4 }];
        f.completion.work.messageCount = 4;
      },
      (f) => {
        f.completion.work.messageRanges = [{ start: 0, end: 2 }, {
          start: 1,
          end: 2,
        }];
      },
      (f) => {
        f.completion.work.messageRanges = [{ start: 0, end: 5 }];
      },
      (f) => {
        f.completion.work.modelVersion = {
          ...f.completion.work.modelVersion,
          digest: "foreign",
        };
      },
      (f) => {
        const conflicting = {
          ...structuredClone(f.completion),
          id: "conflicting-completion",
          work: {
            ...f.completion.work,
            messageCount: 4,
            messageRanges: [{ start: 0, end: 4 }],
          },
        };
        f.state.events.push(conflicting);
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const f = delegatedHistoricalReplyFixture(designer);
      mutate(f);
      assert.equal(
        emptyNativeEvolutionAwait(f.state, f.execution, f.historical),
        false,
        `Ambiguous ${designer ? "designer" : "Request"} range ${index}`,
      );
    }
  }
});

Deno.test("native declared refusal proves only its exact input wait without an assistant reply", () => {
  const { state, execution } = declaredRefusalFixture();
  assert.equal(
    state.messages.some((message) => message.role === "assistant"),
    false,
  );
  assert.equal(emptyNativeEvolutionAwait(state, execution), true);
  assert.equal(evolutionCheckpoint(state, [execution]).safe, true);
  assert.equal(
    emptyEvolutionAwait(state, {
      invocation: state.caseInvocation!,
      conversationCursor: { nodeId: "await" },
      conversationFlow: state.executionModel!.flows.conversation,
    }),
    false,
    "Legacy terminalReceipt still requires its original evidence",
  );
});

Deno.test("native declared refusal rejects absent, forged and superseded receipt bindings", () => {
  const changes: Array<(f: ReturnType<typeof declaredRefusalFixture>) => void> =
    [
      (f) => {
        delete f.execution.localState!.declaredConsultationRefusal;
      },
      (f) => {
        f.refusal.version = 2 as 1;
      },
      (f) => {
        f.refusal.identity = {
          ...f.refusal.identity,
          subjectId: "another-input",
        };
      },
      (f) => {
        f.refusal.contributionId = "another-contribution";
      },
      (f) => {
        f.refusal.inputMessageId = "another-input";
      },
      (f) => {
        f.refusal.modelDigest = "another-model";
      },
      (f) => {
        f.refusal.repositoryVersion = "commit:other";
      },
      (f) => {
        f.refusal.flowRootId = "another-flow";
      },
      (f) => {
        f.refusal.flowOccurrenceId = "another-occurrence";
      },
      (f) => {
        f.refusal.nodeId = "await";
      },
      (f) => {
        f.refusal.actionId = "another-action";
      },
      (f) => {
        f.refusal.effectKey = "unattested-effect";
      },
      (f) => {
        f.refusal.code = "";
      },
      (f) => {
        delete f.execution.checkpointId;
      },
      (f) => {
        f.execution.waits[0].nodeId = "not-the-native-wait";
      },
      (f) => {
        f.state.messages.push({
          id: "new-input",
          role: "user",
          text: "Another decision",
          at: "later",
          caseId: "request-A",
        });
        f.state.activeInputMessageId = "new-input";
      },
    ];
  for (const [index, change] of changes.entries()) {
    const f = declaredRefusalFixture();
    change(f);
    assert.equal(
      emptyNativeEvolutionAwait(f.state, f.execution),
      false,
      `Invalid refusal variant ${index}`,
    );
  }
});

Deno.test("native declared refusal does not settle unknown effects, pending work, batches or budgets", () => {
  const changes: Array<(f: ReturnType<typeof declaredRefusalFixture>) => void> =
    [
      (f) => {
        f.execution.status = "uncertain";
      },
      (f) => {
        f.execution.unsettledEffects = ["unknown-effect"];
      },
      (f) => {
        f.execution.pendingContributions = ["pending-child"];
      },
      (f) => {
        f.execution.waits[0].kind = "decision";
      },
      (f) => {
        f.state.error = "unsettled error";
      },
      (f) => {
        f.state.workBudget = {
          budgetId: "budget",
          scopeId: "request-A",
          unit: "agent-invocation",
          limit: 3,
          consumed: 0,
          reserved: 1,
          remaining: 2,
          exhausted: false,
          suspended: false,
          onExhausted: "wait",
          exhaustionRecipient: "local-control",
        };
      },
      (f) => {
        f.state.conversationBatches = [{
          id: "batch",
          modelDigest: f.execution.modelDigest,
          createdAt: "now",
          sourceDecision: {},
          calls: [{
            id: "call",
            decision: { kind: "reply", text: "unfinished" },
            status: "unknown",
          }],
        }];
      },
      (f) => {
        f.state.configuration!.changes.push({
          id: "pending",
          kind: "mandate-change",
          status: "pending",
          reason: "not settled",
          requestedAt: "now",
          baseRevision: 0,
        });
      },
    ];
  for (const [index, change] of changes.entries()) {
    const f = declaredRefusalFixture();
    change(f);
    assert.equal(
      evolutionCheckpoint(f.state, [f.execution]).safe,
      false,
      `Unsettled variant ${index}`,
    );
  }
});

Deno.test("evolution recognizes a completed exact tool-origin Request resume and rejects its unfinished receipt", () => {
  const state = fixture();
  state.messages.push({
    id: "request-A:resume:resume-1",
    role: "tool",
    text: "Continue",
    at: "now",
    caseId: "request-A",
  }, {
    id: "reply-2",
    role: "assistant",
    text: "Finished again",
    at: "now",
    caseId: "request-A",
  });
  state.requestResumptions = [{
    caseId: "request-A",
    resumeId: "resume-1",
    instruction: "Continue",
    openedBy: "Main",
    conversationId: "main",
    designerScopeId: "designer",
    status: "completed",
    outcome: { caseId: "request-A", operatorId: "owner", status: "open" },
  }];
  assert.equal(evolutionCheckpoint(state).safe, true);
  retireEvolutionAwaits(state, "dossier", "now");
  assert.equal(
    JSON.parse(state.events[0].label).inputMessageId,
    "request-A:resume:resume-1",
  );
  state.requestResumptions[0].status = "started";
  assert.equal(evolutionCheckpoint(state).safe, false);
});

Deno.test("retained settled change origins do not block; unfinished attempts do", () => {
  const state = fixture();
  state.configuration!.changes.push({
    id: "change",
    kind: "mandate-change",
    status: "approved",
    reason: "permission",
    requestedAt: "now",
    baseRevision: 0,
    publication: { completed: true },
  });
  state.changeDecisionContinuations = { change: "resumed" };
  state.changeWorkContinuations = {
    change: { inputMessageId: "input", invocationKey: "origin" },
  };
  assert.equal(evolutionCheckpoint(state).safe, true);
  state.changeWorkContinuations.change.attempt = {
    messageStart: 0,
    priorCandidateIds: [],
    messageRanges: [],
    candidateIds: [],
  };
  assert.ok(
    evolutionCheckpoint(state).blockers.some((blocker) =>
      blocker.code === "EVOLUTION_CHANGE_CONTINUATION"
    ),
  );
});

Deno.test("a pending proposal in A cannot admit a new input in B across the evolution barrier", () => {
  const state = fixture();
  state.messages.unshift({
    id: "input-A",
    role: "user",
    text: "A",
    at: "now",
    caseId: "request-A",
  });
  state.configuration!.changes.push({
    id: "change-A",
    caseId: "request-A",
    kind: "mandate-change",
    status: "pending",
    reason: "permission",
    requestedAt: "now",
    baseRevision: 0,
    baseModelDigest: state.executionModel!.version.digest,
  });
  assert.ok(evolutionHumanSettlement(state, "request-A"));
  assert.equal(evolutionHumanSettlement(state, "request-B"), undefined);
  assert.equal(evolutionHumanSettlement(state, undefined, true), undefined);
  state.invocationContinuations = {
    [invocationKey({ kind: "local", caseId: "request-B" })]: {
      invocation: { kind: "local", caseId: "request-B" },
      conversationCursor: { nodeId: "await" },
      conversationFlow: state.conversationFlow,
    },
  };
  state.messages.push({
    id: "input-B",
    role: "user",
    text: "B",
    at: "now",
    caseId: "request-B",
  });
  assert.equal(evolutionHumanSettlement(state, "request-B"), undefined);
});

Deno.test("all parked continuations are checked, including orphan state and unknown batches", () => {
  const state = fixture();
  state.invocationContinuations = {
    parked: {
      invocation: { kind: "local", caseId: "request-B" },
      conversationContext: { effect: "unknown" },
    },
  };
  assert.ok(
    evolutionCheckpoint(state).blockers.some((blocker) =>
      blocker.code === "EVOLUTION_ORPHAN_CONTINUATION"
    ),
  );
  state.invocationContinuations = {};
  state.conversationBatches = [{
    id: "batch",
    modelDigest: state.executionModel!.version.digest,
    createdAt: "now",
    sourceDecision: {},
    calls: [{
      id: "call",
      decision: { kind: "reply", text: "result" },
      status: "unknown",
    }],
  }];
  assert.ok(
    evolutionCheckpoint(state).blockers.some((blocker) =>
      blocker.code === "EVOLUTION_BATCH_UNSETTLED"
    ),
  );
});

Deno.test("real runtime reads the durable barrier before new inputs without invoking a model", async () => {
  const { SystemRuntime } = await import(
    "../../../../test/support/system-runtime.ts"
  );
  const { unexpectedModelAuthoring } = await import(
    "../../../../test/support/model-authoring.ts"
  );
  const { createTestNativeExecution } = await import(
    "../../../../test/support/native-execution.ts"
  );
  const model = artifactModel("owner");
  let saved: SystemRuntimeState | null = null;
  let calls = 0, owner: string | null = null;
  let rejectAcceptance = false, acceptanceAttempts = 0;
  let ownerLookupPause: Promise<void> | undefined;
  const duringProvider: { current?: () => Promise<void> } = {};
  const businessStore = {
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state: SystemRuntimeState, expected: number | null) => {
      assert.equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const native = createTestNativeExecution(businessStore);
  const runtime = new SystemRuntime({
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(model.identity),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      applyApprovedChange: () => {
        throw new Error("Unexpected change");
      },
      activateCandidate: () => {
        throw new Error("Unexpected activation");
      },
      graph: () => Promise.resolve({}),
    },
    store: native.store,
    execution: native.execution,
    stateHistory: native.stateHistory,
    dispatch: {
      ...native.dispatch,
      enqueue: (delivery) => {
        acceptanceAttempts++;
        if (rejectAcceptance) {
          throw new Error("Controlled durable acceptance failure");
        }
        return native.dispatch.enqueue(delivery);
      },
    },
    agents: {
      label: "test",
      decide: async () => {
        calls++;
        await duringProvider.current?.();
        return { kind: "reply", text: "Done" };
      },
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      test: () => {
        throw new Error("Unexpected test");
      },
      run: () => {
        throw new Error("Unexpected effect");
      },
    },
  });
  await runtime.initialize();
  native.bind(runtime);
  const localIdle = runtime.idle.bind(runtime);
  runtime.idle = async () => {
    await localIdle();
    await native.idle();
    await localIdle();
  };
  const store: import("../../model/evolution/ports.ts").EvolutionStorePort = {
    targetOwner: async () => {
      await ownerLookupPause;
      return owner;
    },
    create: () => {
      throw new Error("unused");
    },
    get: () => Promise.resolve(null),
    listPending: () => Promise.resolve([]),
    compareAndSwap: () => {
      throw new Error("unused");
    },
  };
  runtime.bindEvolutionBarrier("repository", store);
  owner = "dossier";
  const before = runtime.snapshot;
  await assert.rejects(
    () => runtime.submit("New work", undefined, undefined, true),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_BARRIER",
  );
  await assert.rejects(
    () => runtime.submit("New designer input"),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_BARRIER",
  );
  await assert.rejects(
    () =>
      runtime.adoptModelVersion({
        expectedDigest: "published-candidate",
        expectedVersion: "published",
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_BARRIER",
  );
  assert.equal(calls, 0);
  assert.deepEqual(runtime.snapshot.events, before.events);
  assert.deepEqual(runtime.snapshot.executionModel, before.executionModel);
  assert.deepEqual(runtime.snapshot.messages, before.messages);
  assert.deepEqual(runtime.snapshot.cases, before.cases);
  assert.equal(runtime.snapshot.error, before.error);
  // Prepared dossiers own no durable target. Normal input becomes available
  // when the durable owner transaction is released/cancelled.
  owner = null;
  await runtime.submit("Allowed designer work");
  await runtime.idle();
  assert.equal(calls, 1);
  rejectAcceptance = true;
  const { caseTypesForModel } = await import(
    "../../../domain/work/records/case-types.ts"
  );
  const opening = {
    changeId: "undispatched",
    objective: "Open work",
    openedBy: "Main",
    caseTypeId:
      caseTypesForModel(model).find((entry) => entry.type === "request")!.id,
    openedFrom: { conversationId: "main", designerScopeId: "main:designer" },
  };
  await assert.rejects(
    () => runtime.openOperatorRequest(opening),
    /Controlled durable acceptance failure/,
  );
  const undispatched = runtime.snapshot;
  assert.equal(undispatched.cases!.at(-1)!.firstRequestDispatched, undefined);
  assert.deepEqual(undispatched.cases!.at(-1)!.firstRequestDispatch, {
    modelDigest: model.version.digest,
    providerPending: false,
    progressed: false,
  });
  assert.equal(
    calls,
    1,
    "The unaccepted Request has never reached a provider or acquired effect",
  );
  const attempts = calls;
  const enqueueAttempts = acceptanceAttempts;
  owner = "dossier";
  rejectAcceptance = false;
  await assert.rejects(
    () => runtime.openOperatorRequest(opening),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_BARRIER",
  );
  assert.equal(calls, attempts);
  assert.equal(
    acceptanceAttempts,
    enqueueAttempts,
    "The durable barrier refuses retry before queue acceptance",
  );
  assert.deepEqual(runtime.snapshot, undispatched);
  // Arming wins first: ordinary pin adoption is rejected before its control.
  owner = null;
  let releaseArming!: () => void;
  const armingPause = new Promise<void>((resolve) => {
    releaseArming = resolve;
  });
  const arming = runtime.withEvolutionArming(async () => {
    await armingPause;
    owner = "dossier";
  });
  await assert.rejects(
    () => runtime.adoptModelVersion({ expectedDigest: "candidate" }),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_BARRIER",
  );
  assert.deepEqual(runtime.snapshot, undispatched);
  releaseArming();
  await arming;
  // An ordinary pin command wins first, even while its first durable read is
  // yielding: arming may not perform its store transaction.
  owner = null;
  let releaseLookup!: () => void;
  ownerLookupPause = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const pin = runtime.adoptModelVersion({
    expectedDigest: "deliberately-stale",
  }).catch((error) => error);
  let armedWrites = 0;
  await assert.rejects(
    () =>
      runtime.withEvolutionArming(() => {
        armedWrites++;
        return Promise.resolve();
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "EVOLUTION_PIN_MUTATION_BUSY",
  );
  assert.equal(armedWrites, 0);
  releaseLookup();
  await pin;
  ownerLookupPause = undefined;
  await runtime.withEvolutionArming(() => {
    armedWrites++;
    return Promise.resolve();
  });
  assert.equal(armedWrites, 1);
  let busyArmingWrites = 0;
  duringProvider.current = () =>
    runtime.withEvolutionArming(() => {
      assert.equal(runtime.snapshot.busy, true);
      busyArmingWrites++;
      return Promise.resolve();
    });
  await runtime.submit("Existing contribution can settle while arming");
  await runtime.idle();
  assert.equal(busyArmingWrites, 1);
});

Deno.test("origin capture rejects foreign/closed Request claims and ignores caller-supplied destination scopes", () => {
  const actor = fixture();
  const other = fixture();
  other.executionModel!.identity.builderId = "other";
  other.id = "other-runtime";
  other.caseInvocation = { kind: "local", caseId: "other-request" };
  other.cases![0].id = "other-request";
  other.cases![0].owner = "other";
  const proposal: import("../../model/evolution/ports.ts").EvolutionProposal = {
    id: "proposal",
    version: "candidate",
    baseVersion: "base",
    sourceDigest: "source",
    recipeDigest: "recipe",
    digest: "digest",
    categories: ["instructions"],
    targets: [{
      operatorId: "owner",
      previousDigest: "old",
      candidateDigest: "next",
    }, {
      operatorId: "other",
      previousDigest: "old-other",
      candidateDigest: "next-other",
    }],
  };
  const captured = captureEvolutionOrigin(
    {
      actorId: "owner",
      origin: {
        operatorId: "owner",
        requestId: "request-A",
        targetScopes: [{ operatorId: "other", requestId: "forged" }],
      },
    },
    proposal,
    [actor, other],
  );
  assert.deepEqual(captured.targetScopes, [{
    operatorId: "owner",
    requestId: "request-A",
  }]);
  assert.throws(
    () =>
      captureEvolutionOrigin(
        {
          actorId: "owner",
          origin: { operatorId: "owner", requestId: "other-request" },
        },
        proposal,
        [actor, other],
      ),
    /actual invocation/,
  );
  actor.cases![0].status = "closed-done";
  assert.throws(
    () =>
      captureEvolutionOrigin(
        {
          actorId: "owner",
          origin: { operatorId: "owner", requestId: "request-A" },
        },
        proposal,
        [actor, other],
      ),
    /live host provenance/,
  );
});

Deno.test("a parked designer await cannot claim a later unscoped reply after its invocation boundary", () => {
  const state = fixture();
  state.designer = { scopeId: "designer" };
  const invocation = { kind: "designer" as const, scopeId: "designer" };
  state.messages = [{
    id: "designer-input",
    role: "user",
    text: "Question",
    at: "now",
    designerScopeId: "designer",
  }];
  state.invocationContinuations = {
    [invocationKey(invocation)]: {
      invocation,
      inputMessageId: "designer-input",
      messageCount: 1,
      conversationCursor: { nodeId: "await" },
      conversationFlow: state.conversationFlow,
      conversationContext: {},
    },
  };
  state.conversationCursor = undefined;
  state.conversationFlow = undefined;
  state.conversationContext = undefined;
  state.messages.push({
    id: "unrelated-reply",
    role: "assistant",
    text: "Other work",
    at: "later",
  });
  assert.ok(
    evolutionCheckpoint(state).blockers.some((blocker) =>
      blocker.code === "EVOLUTION_SAVED_CONTINUATION"
    ),
  );
});

Deno.test("real runtime adopts the exact evolution pin and refuses divergent or unsafe adoptions without mutation", async (t) => {
  const { SystemRuntime } = await import(
    "../../../../test/support/system-runtime.ts"
  );
  const { unexpectedModelAuthoring } = await import(
    "../../../../test/support/model-authoring.ts"
  );
  const { EvolutionError } = await import("../../model/evolution/ports.ts");
  const model = artifactModel("owner");
  const candidateDigest = "candidate-evolved-digest";
  const publicationVersion = `commit:${"c".repeat(40)}`;
  function materials(previousDigest: string) {
    const proposal = {
      id: "proposal-1",
      version: "candidate",
      baseVersion: "base",
      sourceDigest: "sources",
      recipeDigest: "recipe",
      digest: "exact-proposal-1",
      targets: [{
        operatorId: "owner",
        previousDigest,
        candidateDigest,
      }],
      categories: ["flow"] as Array<"flow">,
    };
    const exercise = {
      operatorNativeId: "finalizer",
      systemQualifiedName: "System::owner",
      authorityDigest: "prior",
      policyId: "policy",
      policyRevision: 1,
      mandateNativeId: "mandate-native",
      mandateId: "mandate",
      mandateRevision: 1,
      targets: ["owner"],
      categories: ["flow"] as Array<"flow">,
      proposalDigest: proposal.digest,
    };
    const dossier: import("../../model/evolution/ports.ts").EvolutionDossier = {
      v: 1,
      id: "dossier-1",
      repositoryId: "repository",
      revision: 0,
      status: "published-awaiting-adoption",
      origin: { operatorId: "owner" },
      finalizerActorId: "finalizer",
      accounting: { id: "evolution:repository:dossier-1", agentInvocations: 0 },
      createdAt: "2026-10-27T00:00:00Z",
      updatedAt: "2026-10-27T00:00:00Z",
      proposal,
      preparation: { ...exercise, act: "prepare", operatorNativeId: "owner" },
      acceptance: { ...exercise, act: "accept", operatorNativeId: "decider" },
      adoptionAuthorization: { ...exercise, act: "adopt" },
      publication: {
        commandId: proposal.id,
        commandDigest: "command-1",
        version: publicationVersion,
        sourceDigest: proposal.sourceDigest,
        proposalDigest: proposal.digest,
      },
      adoptions: [],
      blockers: [],
    };
    const target = { operatorId: "owner", previousDigest, candidateDigest };
    const publication = dossier.publication!;
    const native = {
      ...structuredClone(model),
      version: {
        ...structuredClone(model.version),
        digest: candidateDigest,
        repositoryVersion: publicationVersion,
      },
    };
    return { dossier, target, publication, native };
  }
  async function open(
    decide: () => Promise<{ kind: "reply"; text: string }>,
  ) {
    let saved: SystemRuntimeState | null = null;
    const runtime = new SystemRuntime({
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(model.identity),
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        applyApprovedChange: () => {
          throw new Error("Unexpected change");
        },
        activateCandidate: () => {
          throw new Error("Unexpected activation");
        },
        graph: () => Promise.resolve({}),
      },
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (state, expected) => {
          assert.equal(saved?.revision ?? null, expected);
          saved = structuredClone(state);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      agents: {
        label: "test",
        decide,
        review: () => {
          throw new Error("Unexpected review");
        },
      },
      runner: {
        test: () => {
          throw new Error("Unexpected test");
        },
        run: () => {
          throw new Error("Unexpected effect");
        },
      },
    });
    await runtime.initialize();
    return runtime;
  }

  await t.step("exact-pin adoption succeeds", async () => {
    const runtime = await open(() =>
      Promise.resolve({ kind: "reply", text: "Done" })
    );
    const { dossier, target, publication, native } = materials(
      runtime.snapshot.executionModel!.version.digest,
    );
    await runtime.withEvolutionReservation(
      dossier.id,
      () => runtime.adoptEvolution(dossier, target, publication, native),
    );
    assert.equal(
      runtime.snapshot.executionModel!.version.digest,
      candidateDigest,
    );
    assert.equal(
      runtime.snapshot.executionModel!.version.repositoryVersion,
      publicationVersion,
    );
  });

  await t.step(
    "divergent-pin adoption is refused without mutation",
    async () => {
      const runtime = await open(() =>
        Promise.resolve({ kind: "reply", text: "Done" })
      );
      const { dossier, target, publication, native } = materials(
        runtime.snapshot.executionModel!.version.digest,
      );
      const forged = {
        ...structuredClone(native),
        version: { ...native.version, digest: "forged-digest" },
      };
      const before = runtime.snapshot;
      await assert.rejects(
        () =>
          runtime.withEvolutionReservation(
            dossier.id,
            () => runtime.adoptEvolution(dossier, target, publication, forged),
          ),
        (error: unknown) =>
          error instanceof EvolutionError &&
          error.code === "EVOLUTION_ADOPTION_MISMATCH",
      );
      assert.deepEqual(runtime.snapshot, before);
    },
  );

  await t.step(
    "unsafe-ledger adoption is refused without mutation",
    async () => {
      // A pending mandate change keeps the ledger unsafe: the checkpoint must
      // refuse adoption even though every pin matches exactly.
      const pending = {
        id: "change-1",
        kind: "mandate-change" as const,
        status: "pending" as const,
        baseRevision: 0,
        reason: "Undecided ledger",
        requestedAt: "now",
      };
      let saved: SystemRuntimeState | null = {
        id: "session",
        revision: 0,
        catalogRevision: 0,
        messages: [],
        candidates: [],
        events: [],
        busy: false,
        phase: "ready",
        provider: "test",
        model: structuredClone(model.identity),
        executionModel: structuredClone(model),
        configuration: {
          ...structuredClone(model.configuration),
          changes: [pending],
        },
        cases: [],
      };
      const runtime = new SystemRuntime({
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(model.identity),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          findApprovedChange: () => Promise.resolve(null),
          applyApprovedChange: () => {
            throw new Error("Unexpected change");
          },
          activateCandidate: () => {
            throw new Error("Unexpected activation");
          },
          graph: () => Promise.resolve({}),
        },
        store: {
          load: () => Promise.resolve(structuredClone(saved)),
          save: (state, expected) => {
            assert.equal(saved?.revision ?? null, expected);
            saved = structuredClone(state);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        },
        agents: {
          label: "test",
          decide: () => Promise.resolve({ kind: "reply", text: "Done" }),
          review: () => {
            throw new Error("Unexpected review");
          },
        },
        runner: {
          test: () => {
            throw new Error("Unexpected test");
          },
          run: () => {
            throw new Error("Unexpected effect");
          },
        },
      });
      await runtime.initialize();
      const { dossier, target, publication, native } = materials(
        runtime.snapshot.executionModel!.version.digest,
      );
      assert.ok(
        runtime.snapshot.configuration!.changes.some((change) =>
          change.status === "pending"
        ),
        "The pending change must survive the restart",
      );
      const before = runtime.snapshot;
      await assert.rejects(
        () =>
          runtime.withEvolutionReservation(
            dossier.id,
            () => runtime.adoptEvolution(dossier, target, publication, native),
          ),
        (error: unknown) =>
          error instanceof EvolutionError &&
          error.code === "EVOLUTION_BOUNDARY_UNSAFE",
      );
      assert.deepEqual(runtime.snapshot, before);
    },
  );
});

Deno.test("4.8e E4: a team creation decided by its grant is a ready approval wait; a bare builder one is not", async () => {
  const { state, execution, model } = await networkApprovalFixture();
  const { requestChangeProposalDigest } = await import(
    "../../../domain/governance/records/request-change.ts"
  );
  const network = state.configuration!.changes.pop()!;
  const team = {
    ...network,
    id: "change",
    kind: "operator-creation" as const,
    authority: "builder" as const,
    name: "Helper",
    role: "operator" as const,
    operator: {
      kind: "request-team-member" as const,
      instruction: "Extract one passage.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 1, maxFlowSteps: 8 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: {
      operatorId: model.identity.builderId,
      requestId: "request-A",
    },
  } as unknown as typeof network;
  delete (team as { requestedRights?: unknown }).requestedRights;
  state.configuration!.changes.push(team);
  const digest = await requestChangeProposalDigest(team);
  (execution.localState as {
    changeApprovalWait: { proposalIntentDigest: string };
  })
    .changeApprovalWait.proposalIntentDigest = digest;
  state.requestNetworkDecisions!.change.proposalIntentDigest = digest;
  const ready = async () =>
    (await evolutionNetworkCheckpoint(
      state,
      [execution],
      "change",
      "request-A",
    )).safe;
  assert.equal(await ready(), false, "builder without a creation receipt");
  team.authorityExercise = {
    creationDelegation: { actorId: model.identity.builderId },
  } as unknown as typeof team.authorityExercise;
  assert.equal(await ready(), true);
  // The person's per-creation decision is ready too.
  team.authority = "human";
  delete team.authorityExercise;
  assert.equal(await ready(), true);

  // A member owns no local Case: its approved creation must adopt before its
  // exact delegated contribution can resume and produce a terminal receipt.
  const owner = structuredClone(state.cases![0]);
  owner.owner = "branch-owner";
  model.operatorTeam = {
    requestId: owner.id,
    requestOwnerId: owner.owner,
    parentOperatorId: owner.owner,
  };
  team.authority = "builder";
  team.authorityExercise = {
    creationDelegation: { actorId: model.identity.builderId },
  } as unknown as typeof team.authorityExercise;
  Object.assign(team.teamOrigin!, { operatorId: owner.owner });
  // The sibling publication advanced A without changing the member's model R.
  team.diff!.base.repositoryVersion = `commit:${"2".repeat(40)}`;
  const work = {
    callerId: owner.owner,
    correlationId: "member-contribution",
    fingerprint: "member-fingerprint",
    invocationId: "member-work",
    targetNativeId: model.identity.builderId,
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion!,
    },
    priorCandidateIds: [],
    caseId: owner.id,
    caseContext: {
      caseId: owner.id,
      number: owner.number,
      record: owner,
      modelPin: owner.modelPin!,
    },
  };
  const input: OperatorWorkMessage = {
    id: "member-input",
    role: "tool",
    text: "Create a teammate",
    at: "now",
    caseId: owner.id,
    work,
  };
  state.messages = [input];
  state.cases = [];
  state.caseInvocation = { kind: "delegated", work };
  state.activeInputMessageId = input.id;
  state.changeWorkContinuations = {
    change: {
      inputMessageId: input.id,
      invocationKey: invocationKey(state.caseInvocation),
    },
  };
  const memberDigest = await requestChangeProposalDigest(team);
  state.requestNetworkDecisions!.change.proposalIntentDigest = memberDigest;
  execution.identity = nativeExecutionIdentity(state, "conversation", input.id);
  Object.assign(execution.localState!.changeApprovalWait as object, {
    identity: execution.identity,
    inputMessageId: input.id,
    proposalIntentDigest: memberDigest,
  });
  assert.equal(
    await ready(),
    true,
    "exact delegated member wait retains pin R while publication uses A",
  );
  state.requestNetworkDecisions!.change.openingId = "other-opening";
  assert.equal(
    await ready(),
    false,
    "a foreign opening cannot lend its decision",
  );
  state.requestNetworkDecisions!.change.openingId = "opening";
  const memberNetwork = {
    ...network,
    authority: "builder" as const,
    authorityExercise: {
      delegation: { actorId: "main" },
    } as unknown as typeof network.authorityExercise,
  };
  state.configuration!.changes = [memberNetwork];
  for (const retained of [false, true]) {
    memberNetwork.diff!.base.repositoryVersion = retained
      ? `commit:${"2".repeat(40)}`
      : model.version.repositoryVersion!;
    const digest = await requestChangeProposalDigest(memberNetwork);
    state.requestNetworkDecisions!.change.proposalIntentDigest = digest;
    Object.assign(execution.localState!.changeApprovalWait as object, {
      proposalIntentDigest: digest,
    });
    assert.equal(
      await ready(),
      !retained,
      "delegated network readiness keeps its exact source bound",
    );
  }
  state.configuration!.changes = [team];
  state.requestNetworkDecisions!.change.proposalIntentDigest = memberDigest;
  Object.assign(execution.localState!.changeApprovalWait as object, {
    proposalIntentDigest: memberDigest,
  });
  state.messages.push(
    {
      ...input,
      id: "other-input",
      work: { ...work, correlationId: "unsettled-other" },
    } as OperatorWorkMessage,
  );
  const blocked = await evolutionNetworkCheckpoint(
    state,
    [execution],
    "change",
    owner.id,
  );
  assert.deepEqual(blocked.blockers.map((entry) => entry.code), [
    "EVOLUTION_CONTRIBUTION_UNSETTLED",
  ]);
});

Deno.test("two sequential team creations settle their own continuation and retain exact native advance evidence", async () => {
  const { state, execution, model: initial } = await networkApprovalFixture();
  const network = state.configuration!.changes.pop()!;
  const team = (id: string, base: typeof initial) => {
    const change = {
      ...structuredClone(network),
      id,
      kind: "operator-creation" as const,
      authority: "builder" as const,
      name: id,
      role: "operator" as const,
      baseRevision: base.configuration.revision,
      baseModelDigest: base.version.digest,
      operator: {
        kind: "request-team-member" as const,
        instruction: "Contribute one passage.",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 1,
            maxFlowSteps: 8,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
      teamOrigin: {
        operatorId: initial.identity.builderId,
        requestId: "request-A",
      },
      diff: {
        ...structuredClone(network.diff!),
        base: {
          ...network.diff!.base,
          modelDigest: base.version.digest,
          repositoryVersion: base.version.repositoryVersion!,
        },
      },
    } as unknown as typeof network;
    delete change.requestedRights;
    const owner = exerciseOwnerAuthority(base, "mandate-change");
    change.authorityExercise = {
      ...owner,
      creationDelegation: {
        actorId: initial.identity.builderId,
        policyId: "team-grant",
        policyRevision: 1,
        policyElementId: "team-grant-native",
        policyIssuer: owner,
        requestedBy: initial.identity.builderId,
        changeId: id,
        caseId: "request-A",
        teamOrigin: change.teamOrigin!,
        operator: change.operator!,
      },
    };
    return change;
  };
  const first = team("first-team", initial);
  const afterFirst = structuredClone(initial);
  afterFirst.version.digest = "b".repeat(64);
  afterFirst.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  afterFirst.configuration.revision++;
  first.publishedCommit = afterFirst.version.repositoryVersion;
  state.executionModel = afterFirst;
  state.configuration = { ...afterFirst.configuration, changes: [first] };
  state.changeDecisionContinuations = { [first.id]: "pending" };
  const firstDigest = await requestChangeProposalDigest(first);
  const firstDecision = {
    ...state.requestNetworkDecisions!.change,
    commandId: first.id,
    proposalIntentDigest: firstDigest,
    authority: {
      kind: "creation-grant" as const,
      digest: "d".repeat(64),
      envelope: {},
    },
  };
  state.requestNetworkDecisions = { [first.id]: firstDecision };
  const scope = execution.identity.scope;
  const firstEvidence = await nativeSettledActionAdvanceEvidence(
    initial,
    state,
    scope,
  );
  assert.equal(firstEvidence?.kind, "verified-team-advance");
  assert.equal(
    firstEvidence?.kind === "verified-team-advance" && firstEvidence.changeId,
    first.id,
  );
  assert.deepEqual(
    await rederiveSettledAdvanceEvidence(initial, state, firstEvidence!, scope),
    firstEvidence,
  );
  const delivery = (
    changeId: string,
    digest: string,
    index: number,
  ): OperatorExecutionDelivery => {
    const receiptDigest = String(index).repeat(64);
    return {
      id: `team-adoption:${receiptDigest}`,
      kind: "continuation",
      identity: execution.identity,
      modelPin: { modelDigest: state.executionModel!.version.digest },
      payload: {
        teamAdoption: {
          commandId: `adoption-${index}`,
          receiptDigest,
          changeId,
          proposalIntentDigest: digest,
          predecessorThreadId: `before-${index}`,
          checkpointId: `checkpoint-${index}`,
          successorThreadId: `after-${index}`,
          originalInputMessageId: `input-${index}`,
        },
      },
    };
  };
  recordRequestNetworkOutcome(
    state,
    delivery(first.id, firstDigest, 1),
    "request-A",
    "now",
  );
  assert.equal(state.changeDecisionContinuations[first.id], "resumed");

  const second = team("second-team", afterFirst);
  const secondDigest = await requestChangeProposalDigest(second);
  state.configuration.changes.push(second);
  state.changeDecisionContinuations[second.id] = "pending";
  state.requestNetworkDecisions[second.id] = {
    ...firstDecision,
    commandId: second.id,
    configurationRevision: afterFirst.configuration.revision,
    proposalIntentDigest: secondDigest,
  };
  state.messages.push({
    id: "input-2",
    role: "user",
    caseId: "request-A",
    text: "Create another teammate",
    at: "later",
  });
  state.activeInputMessageId = "input-2";
  const identity = nativeExecutionIdentity(state, "conversation", "input-2");
  execution.identity = identity;
  execution.contributionId = "input-2";
  execution.threadId = "second-thread";
  execution.modelDigest = afterFirst.version.digest;
  execution.repositoryVersion = afterFirst.version.repositoryVersion;
  Object.assign(execution.localState!.changeApprovalWait as object, {
    identity,
    contributionId: "input-2",
    inputMessageId: "input-2",
    modelDigest: afterFirst.version.digest,
    repositoryVersion: afterFirst.version.repositoryVersion,
    changeId: second.id,
    proposalIntentDigest: secondDigest,
  });
  assert.deepEqual(
    await evolutionNetworkCheckpoint(
      state,
      [execution],
      second.id,
      "request-A",
    ),
    { safe: true, blockers: [] },
  );
  // Reproduce the delivery ordering of the explicit-grant witness: admission
  // of the first member is visible before its continuation runs, and the next
  // human turn has already produced a second approval wait. Use the real
  // contribution processor; this boundary double executes no native primitive.
  const lateState = structuredClone(state);
  lateState.changeDecisionContinuations![first.id] = "pending";
  const lateDelivery = delivery(first.id, firstDigest, 1);
  lateState.messages = lateState.messages.filter((message) =>
    message.id !== `request-network-outcome:${lateDelivery.id}`
  );
  const firstInput = "request-A:objective";
  lateDelivery.identity = nativeExecutionIdentity(
    { ...lateState, activeInputMessageId: firstInput },
    "conversation",
    firstInput,
  );
  lateDelivery.payload = {
    ...lateDelivery.payload,
    inputMessageId: firstInput,
    invocation: { kind: "local", caseId: "request-A" },
  };
  const beforeLateDelivery = await evolutionNetworkCheckpoint(
    lateState,
    [execution],
    second.id,
    "request-A",
  );
  assert.deepEqual(beforeLateDelivery.blockers.map((entry) => entry.code), [
    "EVOLUTION_CHANGE_CONTINUATION",
  ]);
  let resumedInput: string | undefined;
  const lateHost = {
    state: lateState,
    ports: { clock: { now: () => "later" } },
    update: (change: (state: SystemRuntimeState) => void) => {
      change(lateState);
      return Promise.resolve();
    },
    resumeActivations: () => Promise.resolve(),
    runTurn: (_reply: unknown, contribution: { inputMessageId: string }) => {
      resumedInput = contribution.inputMessageId;
      return Promise.resolve();
    },
  } as unknown as OperatorWorkHost;
  await processAcceptedContribution.call(lateHost, lateDelivery);
  assert.equal(resumedInput, firstInput);
  assert.equal(lateState.changeDecisionContinuations![first.id], "resumed");
  assert.equal(lateState.changeDecisionContinuations![second.id], "pending");
  assert.equal(lateState.activeInputMessageId, firstInput);
  const afterLateDelivery = await evolutionNetworkCheckpoint(
    lateState,
    [execution],
    second.id,
    "request-A",
  );
  assert.deepEqual(afterLateDelivery.blockers.map((entry) => entry.code), [
    "EVOLUTION_CHANGE_CONTINUATION",
    "EVOLUTION_NATIVE_EXECUTION_UNSETTLED",
  ]);
  // The second receipt's pin and digest still match. Only the processor's
  // selection of the older input invalidated its exact approval context.
  assert.equal(execution.modelDigest, afterFirst.version.digest);
  assert.equal(
    execution.repositoryVersion,
    afterFirst.version.repositoryVersion,
  );
  assert.equal(
    (execution.localState!.changeApprovalWait as {
      proposalIntentDigest: string;
    })
      .proposalIntentDigest,
    secondDigest,
  );
  lateState.activeInputMessageId = "input-2";
  assert.deepEqual(
    await evolutionNetworkCheckpoint(
      lateState,
      [execution],
      second.id,
      "request-A",
    ),
    { safe: true, blockers: [] },
  );
  state.changeDecisionContinuations.unrelated = "pending";
  const blocked = await evolutionNetworkCheckpoint(
    state,
    [execution],
    second.id,
    "request-A",
  );
  assert.equal(blocked.safe, false);
  assert.deepEqual(blocked.blockers.map((entry) => entry.code), [
    "EVOLUTION_CHANGE_CONTINUATION",
  ]);
  delete state.changeDecisionContinuations.unrelated;

  const afterSecond = structuredClone(afterFirst);
  afterSecond.version.digest = "c".repeat(64);
  afterSecond.version.repositoryVersion = `commit:${"3".repeat(40)}`;
  afterSecond.configuration.revision++;
  second.publishedCommit = afterSecond.version.repositoryVersion;
  state.executionModel = afterSecond;
  const secondEvidence = await nativeSettledActionAdvanceEvidence(
    afterFirst,
    state,
    scope,
  );
  assert.equal(secondEvidence?.kind, "verified-team-advance");
  assert.equal(
    secondEvidence?.kind === "verified-team-advance" && secondEvidence.changeId,
    second.id,
  );
  assert.deepEqual(
    await rederiveSettledAdvanceEvidence(
      afterFirst,
      state,
      secondEvidence!,
      scope,
    ),
    secondEvidence,
  );
  assert.equal(secondEvidence!.from.version.digest, afterFirst.version.digest);
  assert.equal(secondEvidence!.to.version.digest, afterSecond.version.digest);
  recordRequestNetworkOutcome(
    state,
    delivery(second.id, secondDigest, 2),
    "request-A",
    "later",
  );
  assert.deepEqual(state.changeDecisionContinuations, {
    [first.id]: "resumed",
    [second.id]: "resumed",
  });
});
