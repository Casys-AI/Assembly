import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { MAX_CASE_OBJECTIVE_CHARS } from "../../../domain/work/entities/cases.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { caseTypesForModel } from "../../../domain/work/records/case-types.ts";
import type { ModelPort, StorePort } from "../runtime/ports.ts";
import {
  assertContinuationCases,
  caseBudgetPolicy,
  caseExecutionContext,
  caseMessages,
  closeCaseById,
  closeCurrentCase,
  currentCase,
  designerScopeId,
  ensureRequestCase,
  migrateCases,
  selectCaseInvocation,
  selectDesignerInvocation,
  selectHumanRequestCase,
} from "./runtime.ts";
import { invocationKey } from "../operators/journal.ts";
import { pendingBatch } from "../conversation/batches.ts";

function modelFixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.version.repositoryVersion = "source-1";
  return model;
}
const clock = { now: () => "2026-10-24T03:00:00.000Z" };
function stateFixture(): SystemRuntimeState {
  const model = modelFixture();
  return {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
}

Deno.test("an orphan continuation cannot implicitly acquire the designer scope", () => {
  const state = stateFixture();
  state.cases = [];
  state.conversationCursor = { nodeId: "pending" };
  throws(() => assertContinuationCases(state), { code: "CASE_SCOPE_MISSING" });
  state.designer = { scopeId: "session:designer" };
  throws(() => assertContinuationCases(state), { code: "CASE_SCOPE_MISSING" });
  state.caseInvocation = { kind: "designer", scopeId: "foreign" };
  throws(() => assertContinuationCases(state), { code: "CASE_SCOPE_MISSING" });
  state.caseInvocation = { kind: "designer", scopeId: state.designer.scopeId };
  assertContinuationCases(state);
});

Deno.test("the design scope is known before the first designer turn and that turn persists the same one", () => {
  const state = stateFixture();
  const before = designerScopeId(state);
  equal("designer" in state, false, "reading the scope persists nothing");
  selectDesignerInvocation(state);
  equal(state.designer?.scopeId, before);
  equal(designerScopeId(state), before);
  equal(designerScopeId(structuredClone(state)), before, "stable on reload");
  state.designer = { scopeId: "legacy:designer" };
  equal(designerScopeId(state), "legacy:designer");
});

Deno.test("a pending legacy dossier with a lost admitted budget binding cannot receive fresh credit", () => {
  const state = stateFixture();
  state.executionModel!.workBudgetPolicy = {
    id: "legacy-budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 3,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "budget",
    sourceIds: [],
  };
  state.conversationCursor = { nodeId: "pending" };
  throws(() => migrateCases(state, clock, 1), { code: "CASE_SCOPE_MISSING" });
  equal(state.cases, undefined);
});

Deno.test("Request preserves the legacy reservation and immutable birth provenance", () => {
  const state = stateFixture();
  state.workBudgetBinding = { budgetId: "legacy-budget", scopeId: state.id };
  ensureRequestCase(
    state,
    {
      objective: "  Premier objectif  ",
      messageId: "m1",
    },
    clock,
    1,
  );
  const first = currentCase(state)!;
  const birthDigest = first.modelPin.digest;
  equal(first.id, "session:case:1");
  equal(first.objective, "Premier objectif");
  equal(first.createdAt, clock.now());
  deepStrictEqual(first.budget, state.workBudgetBinding);
  deepStrictEqual(first.openedFrom, {
    conversationId: "session",
    messageId: "m1",
  });
  state.executionModel!.version.digest = "new-digest";
  ensureRequestCase(
    state,
    { objective: "Continuation", messageId: "m2" },
    clock,
    1,
  );
  equal(state.cases!.length, 1);
  equal(first.modelPin.digest, birthDigest);
  equal(first.openedFrom.messageId, "m1");
  for (const type of ["job", "watch"] as const) {
    throws(() => ensureRequestCase(state, { objective: "No", type }, clock), {
      code: "INVALID_CASE_ACTION",
    });
  }
});

Deno.test("a 100 000-character request opens a Case with a compacted objective while its journal text stays complete", () => {
  const state = stateFixture();
  state.cases = [];
  const long = "y".repeat(100_000);
  state.messages.push({
    id: "m1",
    role: "user",
    text: long,
    at: clock.now(),
  });
  selectHumanRequestCase(
    state,
    { objective: long, messageId: "m1" },
    clock,
    1,
  );
  const record = currentCase(state)!;
  equal(record.objective.length, MAX_CASE_OBJECTIVE_CHARS);
  ok(record.objective.endsWith("[Truncated; see journal evidence.]"));
  equal(record.openedFrom.messageId, "m1");
  equal(state.messages[0]!.text, long);
});

/** The operator opening as the trusted host runs it: the same runtime, one Request type. */
async function operatorOpeningFixture() {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.version.repositoryVersion = "admitted";
  let saved: SystemRuntimeState | null = null;
  let allocations = 0;
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state, expected) => {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const source = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    findApprovedChange: () => Promise.resolve(null),
  } as unknown as ModelPort;
  const service = new SystemRuntime({
    model: source,
    store,
    caseNumbers: {
      allocate: () => {
        allocations++;
        return Promise.resolve(allocations);
      },
    },
    agents: {
      label: "Scripted operator",
      decide: () =>
        Promise.resolve({ kind: "reply", text: "Request accepted" } as const),
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      run: () => {
        throw new Error("Unexpected tool invocation");
      },
      test: () => {
        throw new Error("Unexpected tool test");
      },
    },
  });
  await service.initialize();
  return {
    service,
    input: {
      changeId: "approved-creation",
      caseTypeId:
        caseTypesForModel(model).find((entry) => entry.type === "request")!.id,
      openedBy: "designer",
      openedFrom: {
        conversationId: "designer-conversation",
        designerScopeId: "designer-scope",
      },
    },
  };
}

Deno.test("an operator objective of 2 000 code points keeps its exact text, emoji included", async () => {
  const f = await operatorOpeningFixture();
  // Each emoji is one code point and two UTF-16 units: the bound is on code points.
  const objective = "😀".repeat(2_000);
  equal([...objective].length, 2_000);
  equal(objective.length, 4_000);
  const input = { ...f.input, objective };
  const id = await f.service.openOperatorRequest(input);
  const record = f.service.snapshot.cases!.find((entry) => entry.id === id)!;
  equal(record.objective, objective);
  // The replay compares the recorded objective with the approved one: a cut copy would conflict here.
  equal(await f.service.openOperatorRequest(input), id);
});

Deno.test("human Request selection never falls back and rejects closed or foreign Cases", () => {
  const state = stateFixture();
  state.cases = [];
  const first = selectHumanRequestCase(
    state,
    { objective: "First", messageId: "m1" },
    clock,
    1,
  );
  const second = selectHumanRequestCase(
    state,
    { objective: "Second", messageId: "m2" },
    clock,
    2,
  );
  equal(state.cases.length, 2);
  equal(currentCase(state)?.id, second);
  selectHumanRequestCase(state, {
    objective: "Follow up",
    messageId: "m3",
    caseId: first,
  }, clock);
  equal(currentCase(state)?.id, first);
  equal(currentCase(state)?.objective, "First");
  closeCurrentCase(state, "done", clock);
  throws(
    () =>
      selectHumanRequestCase(state, {
        objective: "Closed",
        messageId: "m4",
        caseId: first,
      }, clock),
    { code: "CASE_CLOSED", context: { caseId: first, agentId: "operator" } },
  );
  state.cases[1].owner = "other-agent";
  throws(
    () =>
      selectHumanRequestCase(state, {
        objective: "Foreign",
        messageId: "m5",
        caseId: second,
      }, clock),
    { code: "CASE_NOT_OWNED" },
  );
  throws(
    () =>
      selectHumanRequestCase(state, {
        objective: "Unknown",
        messageId: "m6",
        caseId: "missing",
      }, clock),
    { code: "CASE_NOT_FOUND" },
  );
  equal(state.cases.length, 2);
});

Deno.test("switching Requests parks exact execution data across serialization and closure removes only its checkpoint", () => {
  let state = stateFixture();
  state.cases = [];
  const a = selectHumanRequestCase(
    state,
    { objective: "A", messageId: "a" },
    clock,
    1,
  );
  state.conversationCursor = { nodeId: "suspended-A" };
  state.conversationContext = { acquiredEffect: "A-receipt" };
  state.conversationFlow = structuredClone(
    state.executionModel!.flows.conversation,
  );
  state.workBudgetBinding = { budgetId: "budget", scopeId: a };
  state.budgetSuspension = {
    nodeId: "suspended-A",
    operation: "decide",
    recipient: "local-control",
    reason: "exhausted",
    diagnostic: "No credit",
    dispatchStarted: true,
  };
  const original: SystemRuntimeState = JSON.parse(JSON.stringify(state));
  const b = selectHumanRequestCase(
    state,
    { objective: "B", messageId: "b" },
    clock,
    2,
  );
  equal(state.conversationCursor, undefined);
  equal(state.budgetSuspension, undefined);
  state.conversationContext = { acquiredEffect: "B-receipt" };
  state = JSON.parse(JSON.stringify(state));
  selectCaseInvocation(state, { kind: "local", caseId: a });
  for (
    const field of [
      "conversationCursor",
      "conversationContext",
      "conversationFlow",
      "budgetSuspension",
      "workBudgetBinding",
    ] as const
  ) {
    deepStrictEqual(state[field], original[field]);
  }
  closeCurrentCase(state, "abandoned", clock);
  equal(
    state.invocationContinuations
      ?.[invocationKey({ kind: "local", caseId: a })],
    undefined,
  );
  selectCaseInvocation(state, { kind: "local", caseId: b });
  deepStrictEqual(state.conversationContext, { acquiredEffect: "B-receipt" });
});

Deno.test("delegated contributions to one Request keep independent batches and budget continuations", () => {
  const state = stateFixture();
  state.cases = [];
  const work = (correlationId: string) => ({
    caseId: "root-request",
    callerId: "main",
    correlationId,
    invocationId: correlationId,
    behaviorId: "inbox",
    targetNativeId: "operator",
    modelVersion: { digest: "pin", repositoryVersion: "source" },
    fingerprint: correlationId,
    priorCandidateIds: [],
    caseContext: {
      caseId: "root-request",
      number: 1,
      modelPin: { digest: "pin" },
    },
  });
  const a = { kind: "delegated" as const, work: work("A") };
  const b = { kind: "delegated" as const, work: work("B") };
  selectCaseInvocation(state, a);
  state.conversationCursor = { nodeId: "A" };
  state.activeBatchCall = { batchId: "batch-A", callId: "call-A" };
  state.conversationBatches = [{
    id: "batch-A",
    invocationKey: invocationKey(a),
    caseId: "root-request",
    modelDigest: "pin",
    createdAt: "now",
    sourceDecision: {},
    calls: [{
      id: "call-A",
      decision: { kind: "reply", text: "A" },
      status: "started",
    }],
  }];
  selectCaseInvocation(state, b);
  equal(state.activeBatchCall, undefined);
  equal(pendingBatch(state), undefined);
  state.conversationCursor = { nodeId: "B" };
  selectCaseInvocation(state, a);
  deepStrictEqual(state.conversationCursor, { nodeId: "A" });
  equal(pendingBatch(state)?.id, "batch-A");
  selectCaseInvocation(state, b);
  deepStrictEqual(state.conversationCursor, { nodeId: "B" });
});

Deno.test("legacy dossier migration is idempotent and does not rewrite historical journals", () => {
  const state = stateFixture();
  state.messages.push({
    id: "m1",
    role: "user",
    text: "Dossier existant",
    at: "2026-10-20T00:00:00.000Z",
  });
  state.workBudgetBinding = { budgetId: "budget", scopeId: "session" };
  state.conversationCursor = { nodeId: "suspended-native-node" };
  state.budgetSuspension = {
    nodeId: "suspended-native-node",
    operation: "decide",
    recipient: "local-control",
    reason: "exhausted",
    diagnostic: "No credit",
    dispatchStarted: false,
  };
  const suspension = structuredClone(state.budgetSuspension);
  const messages = structuredClone(state.messages);
  migrateCases(state, clock, 1);
  deepStrictEqual(state.conversationCursor, {
    nodeId: "suspended-native-node",
  });
  deepStrictEqual(state.budgetSuspension, suspension);
  deepStrictEqual(state.messages, messages);
  deepStrictEqual(caseMessages(state), []);
  equal(currentCase(state)?.status, "waiting");
  equal(currentCase(state)?.budget?.scopeId, "session");
  migrateCases(state, {
    now() {
      throw new Error("must not migrate twice");
    },
  });
  equal(state.cases!.length, 1);
  selectDesignerInvocation(state);
  deepStrictEqual(caseMessages(state), messages);
  selectHumanRequestCase(
    state,
    { objective: "New conversation", messageId: "new" },
    clock,
    2,
  );
  deepStrictEqual(caseMessages(state), []);
  const fresh = stateFixture();
  migrateCases(fresh, clock);
  deepStrictEqual(fresh.cases, []);
});

Deno.test("initialize gives a pending legacy specialist receipt an explicit local Case", async () => {
  const state = stateFixture();
  state.messages.push({
    id: "receipt",
    role: "tool",
    text: "Travail confié",
    at: clock.now(),
    work: {
      callerId: "central",
      correlationId: "task",
      invocationId: "invocation",
      behaviorId: "inbox",
      targetNativeId: "worker",
      modelVersion: { digest: "pin", repositoryVersion: "source" },
    },
  });
  state.conversationCursor = {
    nodeId: state.executionModel!.flows.conversation.nodes[0].id,
  };
  const messages = structuredClone(state.messages);
  const cursor = structuredClone(state.conversationCursor);
  let saved = structuredClone(state);
  const forbidden = () => {
    throw new Error("Migration must not execute work or grant authority");
  };
  const runtime = new SystemRuntime({
    clock,
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save: (next) => {
        saved = structuredClone(next);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(state.model!),
      readExecutableModel: () => Promise.resolve(state.executionModel!),
      applyApprovedChange: forbidden,
      activateCandidate: forbidden,
      graph: () => Promise.resolve({}),
    },
    agents: { label: "test", decide: forbidden, review: forbidden },
    runner: { test: forbidden, run: forbidden },
  });
  await runtime.initialize();
  const migrated = runtime.snapshot;
  equal(migrated.cases!.length, 1);
  equal(currentCase(migrated)?.objective, "Travail confié");
  equal(currentCase(migrated)?.openedBy, "central");
  equal(currentCase(migrated)?.migratedFrom, "legacy-dossier");
  equal(caseExecutionContext(migrated)?.caseId, migrated.cases![0].id);
  deepStrictEqual(migrated.messages, messages);
  deepStrictEqual(migrated.conversationCursor, cursor);
  equal(migrated.budgetSuspension, undefined);
});

Deno.test("typed invocation ceiling narrows legacy policy and supports zero without a legacy policy", () => {
  const model = modelFixture();
  model.caseTypes = [{
    id: "typed-request",
    name: "Request",
    type: "request",
    envelope: "conversational",
    ownerId: model.identity.builderId,
    behaviorId: model.flows.conversation.rootNativeId,
    sourceIds: [],
    maxInvocations: 2,
  }];
  equal(caseBudgetPolicy(model)?.limit, 2);
  equal(caseBudgetPolicy(model)?.id, "typed-request:invocations");
  model.workBudgetPolicy = {
    id: "legacy",
    revision: 1,
    unit: "agent-invocation",
    limit: 1,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "legacy",
    sourceIds: [],
  };
  equal(caseBudgetPolicy(model)?.id, "legacy");
  equal(caseBudgetPolicy(model)?.limit, 1);
  model.caseTypes[0].maxInvocations = 0;
  equal(caseBudgetPolicy(model)?.limit, 0);
});

Deno.test("Request selection skips another behavior before choosing its Case type and budget", () => {
  const state = stateFixture();
  const model = state.executionModel!;
  model.caseTypes = [{
    id: "another-request",
    name: "Another Request",
    type: "request",
    envelope: "conversational",
    ownerId: model.identity.builderId,
    behaviorId: "another-behavior",
    maxInvocations: 0,
    sourceIds: [],
  }, {
    id: "conversation-request",
    name: "Conversation Request",
    type: "request",
    envelope: "conversational",
    ownerId: model.identity.builderId,
    behaviorId: model.flows.conversation.rootNativeId,
    maxInvocations: 2,
    sourceIds: [],
  }];
  ensureRequestCase(
    state,
    { objective: "Use the conversation behavior" },
    clock,
    1,
  );
  equal(currentCase(state)?.caseTypeId, "conversation-request");
  equal(
    currentCase(state)?.budget?.budgetId,
    "conversation-request:invocations",
  );
  equal(caseExecutionContext(state)?.budget?.policy.limit, 2);
  closeCurrentCase(state, "done", clock);
  model.caseTypes.pop();
  throws(
    () =>
      ensureRequestCase(state, { objective: "No matching behavior" }, clock),
    {
      code: "NOT_SUPPORTED_YET",
    },
  );
});

Deno.test("a new Case retains conversation identity and gets a distinct budget reservation scope", () => {
  const state = stateFixture();
  state.executionModel!.caseTypes = [{
    id: "typed-request",
    name: "Request",
    type: "request",
    envelope: "conversational",
    ownerId: "operator",
    behaviorId: state.executionModel!.flows.conversation.rootNativeId,
    maxInvocations: 2,
    sourceIds: [],
  }];
  ensureRequestCase(state, { objective: "First" }, clock, 1);
  const first = currentCase(state)!;
  closeCurrentCase(state, "done", clock);
  ensureRequestCase(state, { objective: "Second" }, clock, 2);
  equal(currentCase(state)?.number, 2);
  equal(
    currentCase(state)?.openedFrom.conversationId,
    first.openedFrom.conversationId,
  );
  equal(currentCase(state)?.budget?.scopeId, "session:case:2");
  equal(state.caseBudgetPending, true);
  equal(caseExecutionContext(state)?.number, 2);
});

Deno.test("superseded changes neither block completion nor flip on abandon", () => {
  const state = stateFixture();
  selectHumanRequestCase(
    state,
    { objective: "Bounded request", messageId: "m1" },
    clock,
    1,
  );
  const record = currentCase(state)!;
  state.configuration = structuredClone(state.executionModel!.configuration);
  state.configuration.changes = [{
    id: "change",
    kind: "mandate-change",
    status: "superseded",
    requestedBy: record.owner,
    caseId: record.id,
    baseRevision: 0,
    requestedAt: clock.now(),
    reason: "Need a host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  }];
  closeCurrentCase(state, "done", clock);
  equal(state.cases![0].status, "closed-done");
  equal(state.configuration.changes[0].status, "superseded");
  const abandoned = stateFixture();
  selectHumanRequestCase(
    abandoned,
    { objective: "Bounded request", messageId: "m1" },
    clock,
    1,
  );
  const abandonedRecord = currentCase(abandoned)!;
  abandoned.configuration = structuredClone(
    abandoned.executionModel!.configuration,
  );
  abandoned.configuration.changes = [{
    id: "change",
    kind: "mandate-change",
    status: "superseded",
    requestedBy: abandonedRecord.owner,
    caseId: abandonedRecord.id,
    baseRevision: 0,
    requestedAt: clock.now(),
    reason: "Need a host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  }];
  closeCurrentCase(abandoned, "abandoned", clock);
  equal(abandoned.cases![0].status, "closed-abandoned");
  equal(abandoned.configuration.changes[0].status, "superseded");
});

Deno.test("closeCaseById refuses an unknown Case without touching state", () => {
  const state = stateFixture();
  state.cases = [];
  selectHumanRequestCase(
    state,
    { objective: "Kept", messageId: "m1" },
    clock,
    1,
  );
  const before = structuredClone(state);
  throws(() => closeCaseById(state, "missing", "done", clock), {
    code: "NOT_FOUND",
  });
  deepStrictEqual(state, before);
});

Deno.test("closing one Case by id settles only its queued work and keeps the current invocation", () => {
  const state = stateFixture();
  state.cases = [];
  const first = selectHumanRequestCase(
    state,
    { objective: "First", messageId: "m1" },
    clock,
    1,
  );
  const second = selectHumanRequestCase(
    state,
    { objective: "Second", messageId: "m2" },
    clock,
    2,
  );
  const reply = (text: string) => ({ kind: "reply" as const, text });
  state.conversationBatches = [{
    id: "batch-closed",
    caseId: first,
    modelDigest: "pin",
    createdAt: clock.now(),
    sourceDecision: {},
    calls: [
      { id: "queued", decision: reply("Q"), status: "queued" },
      { id: "started", decision: reply("S"), status: "started" },
      {
        id: "effect",
        decision: reply("E"),
        status: "started",
        effectStarted: true,
      },
      { id: "done", decision: reply("D"), status: "completed" },
    ],
  }, {
    id: "batch-live",
    caseId: second,
    modelDigest: "pin",
    createdAt: clock.now(),
    sourceDecision: {},
    calls: [{ id: "live-queued", decision: reply("L"), status: "queued" }],
  }];
  state.configuration = structuredClone(state.executionModel!.configuration);
  state.configuration.changes = [{
    id: "closed-change",
    caseId: first,
    kind: "mandate-change",
    status: "superseded",
    baseRevision: 0,
    requestedAt: clock.now(),
    reason: "Settled before close",
  }, {
    id: "live-change",
    caseId: second,
    kind: "mandate-change",
    status: "superseded",
    baseRevision: 0,
    requestedAt: clock.now(),
    reason: "Settled before close",
  }];
  state.changeWorkContinuations = {
    "closed-change": { inputMessageId: "m1", invocationKey: "closed" },
    "live-change": { inputMessageId: "m2", invocationKey: "live" },
  };
  state.changeDecisionContinuations = {
    "closed-change": "pending",
    "live-change": "pending",
  };
  state.invocationContinuations = {
    [invocationKey({ kind: "local", caseId: first })]: {
      invocation: { kind: "local", caseId: first },
      messageCount: 1,
    },
    [invocationKey({ kind: "local", caseId: second })]: {
      invocation: { kind: "local", caseId: second },
      messageCount: 2,
    },
  };
  closeCaseById(state, first, "done", clock);
  equal(state.cases![0].status, "closed-done");
  equal(state.cases![1].status, "open");
  deepStrictEqual(state.caseInvocation, { kind: "local", caseId: second });
  equal(currentCase(state)?.id, second);
  const closed = state.conversationBatches[0].calls;
  deepStrictEqual(
    closed.map((call) => [call.id, call.status]),
    [
      ["queued", "cancelled"],
      ["started", "cancelled"],
      ["effect", "unknown"],
      ["done", "completed"],
    ],
  );
  equal(closed[0].result?.code, "CASE_CLOSED");
  equal(closed[2].result?.code, "BATCH_EFFECT_UNKNOWN");
  equal(closed[3].result, undefined);
  equal(state.conversationBatches[1].calls[0].status, "queued");
  deepStrictEqual(state.changeWorkContinuations, {
    "live-change": { inputMessageId: "m2", invocationKey: "live" },
  });
  deepStrictEqual(state.changeDecisionContinuations, {
    "live-change": "pending",
  });
  deepStrictEqual(
    Object.keys(state.invocationContinuations!),
    [invocationKey({ kind: "local", caseId: second })],
  );
});

Deno.test("Case completion rejects pending changes and abandonment closes them without authority", () => {
  const state = stateFixture();
  selectHumanRequestCase(
    state,
    { objective: "Bounded request", messageId: "m1" },
    clock,
    1,
  );
  const record = currentCase(state)!;
  state.configuration = structuredClone(state.executionModel!.configuration);
  state.configuration.changes = [{
    id: "change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: record.owner,
    caseId: record.id,
    baseRevision: 0,
    requestedAt: clock.now(),
    reason: "Need a host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  }];
  throws(() => closeCurrentCase(state, "done", clock), { code: "CASE_BUSY" });
  equal(record.status, "open");
  closeCurrentCase(state, "abandoned", clock);
  equal(state.cases![0].status, "closed-abandoned");
  equal(state.configuration.changes[0].status, "refused");
  equal(state.configuration.changes[0].authority, undefined);
  equal(state.configuration.changes[0].authorityExercise, undefined);
});
