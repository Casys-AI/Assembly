import assert from "node:assert/strict";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { modelContextTools } from "../context/model-tools.ts";
import { ModelNavigationError } from "../../../domain/model/consultation/context.ts";
import type { ChatDecision } from "./chat-decision.ts";
import type {
  ConversationBatchExecution,
  SystemRuntimeState,
} from "../runtime/state.ts";
import { selectDesignerInvocation } from "../cases/runtime.ts";
import { invocationKey } from "../operators/journal.ts";
import {
  nativeExecutionIdentity,
  runtimeRevisionReference,
} from "../native-execution/contract.ts";
import type { ConversationTurnHost } from "./turn-context.ts";
import {
  createImmutableConsultationHandlers,
  immutableConsultationPrefix,
} from "./immutable-consultations.ts";

const version = "commit:immutable-source";
const at = "2026-10-29T00:00:00.000Z";
const validator = {
  validate: (_schema: Record<string, unknown>, value: unknown) =>
    (value as { invalid?: boolean }).invalid
      ? { valid: false as const, errors: "invalid fixture input" }
      : { valid: true as const },
};
function read(query: string): ChatDecision {
  return {
    kind: "consult_model",
    text: `Inspect ${query}`,
    inputJson: JSON.stringify({ operation: "search", version, query }),
  };
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
function fixture(choices: ChatDecision[] = [read("first"), read("second")]) {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "native-system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.version.repositoryVersion = version;
  model.policy.mayProposeSysmlRevision = true;
  const flow = model.flows.conversation;
  flow.executionProfile = "operator-command-immutable-group-v1";
  const node = {
    ...structuredClone(flow.nodes.find((item) => item.kind === "action")!),
    id: "command-occurrence",
    nativeId: "native-command",
    name: "executeOperatorCommand",
    mechanism: "execute_operator_command" as const,
    outputs: ["outcome", "submission"],
  };
  flow.nodes.push(node);
  let state: SystemRuntimeState = {
    id: "host-system",
    revision: 1,
    catalogRevision: 1,
    busy: true,
    phase: "ready",
    provider: "test",
    messages: [],
    events: [],
    candidates: [],
    executionModel: model,
  };
  selectDesignerInvocation(state);
  state.activeInputMessageId = "input";
  state.messages.push({
    id: "input",
    role: "user",
    text: "Inspect both",
    at,
    designerScopeId: state.designer!.scopeId,
  });
  const batch: ConversationBatchExecution = {
    id: "batch",
    recordedRevision: 1,
    decisionContextCharacters: 1000,
    createdAt: at,
    inputMessageId: "input",
    invocationKey: invocationKey(state.caseInvocation!),
    designerScopeId: state.designer!.scopeId,
    modelDigest: model.version.digest,
    sourceDecision: {
      modelContext: {
        version,
        sourceDigest: "a".repeat(64),
        files: [],
        roots: { items: [], total: 0, truncated: false },
        limits: {
          maxPageSize: 50,
          maxSourceBytes: 100000,
          maxInspectSourceBytes: 10000,
        },
        coverage: "bounded-discovery-not-exhaustive-impact",
        loadedSources: [],
        maxLoadedCharacters: 100000,
      },
      modelSources: { version, sources: {} },
    },
    calls: choices.map((decision, index) => ({
      id: `call-${index}`,
      decision,
      status: index === 0 ? "started" : "queued",
    })),
  };
  state.conversationBatches = [batch];
  state.activeBatchCall = { batchId: batch.id, callId: batch.calls[0]!.id };
  const history = new Map([[1, structuredClone(state)]]);
  let writes = 0, representationChecks = 0, reads = 0;
  let consult: (request: Record<string, unknown>) => Promise<unknown> = (
    input,
  ) => Promise.resolve({ observed: input.query });
  let representable = true, pinValid = true;
  const host = {
    get state() {
      return state;
    },
    get snapshot() {
      return structuredClone(state);
    },
    currentModel: () => Promise.resolve(structuredClone(state.executionModel!)),
    executionReference: (
      current: typeof model,
      element: { actionId: string },
    ) => ({
      digest: current.version.digest,
      actionId: element.actionId,
      repositoryVersion: current.version.repositoryVersion,
      sourceIds: [...current.version.sourceIds],
    }),
    assertDecisionContextRepresentable: (
      _current: typeof model,
      prospective: SystemRuntimeState,
    ) => {
      representationChecks++;
      assert(prospective.messages.length > state.messages.length);
      if (!representable) {
        return Promise.reject(new Error("Context representation refused"));
      }
      return Promise.resolve();
    },
    update: (change: (value: SystemRuntimeState) => void) => {
      const next = structuredClone(state);
      change(next);
      next.revision++;
      state = next;
      history.set(next.revision, structuredClone(next));
      writes++;
      return Promise.resolve();
    },
    ports: {
      clock: { now: () => at },
      schemaValidator: validator,
      information: {
        modelTools: () => modelContextTools(),
        assertModelContextPin: () =>
          pinValid ? Promise.resolve() : Promise.reject(
            Object.assign(new Error("working set changed"), {
              code: "MODEL_CONTEXT_STALE_PIN",
            }),
          ),
        withModelContextPin: async (
          _model: unknown,
          _messages: unknown,
          _pin: unknown,
          operation: () => Promise<void>,
        ) => {
          if (!pinValid) {
            throw Object.assign(new Error("working set changed"), {
              code: "MODEL_CONTEXT_STALE_PIN",
            });
          }
          await operation();
        },
        consultModel: (
          _current: typeof model,
          request: Record<string, unknown>,
        ) => {
          reads++;
          return consult(request);
        },
      },
      stateHistory: {
        loadRevision: (revision: number) =>
          Promise.resolve(structuredClone(history.get(revision) ?? null)),
      },
    },
  } as unknown as ConversationTurnHost;
  const handlers = createImmutableConsultationHandlers(
    host,
    flow,
    () => structuredClone(model),
  );
  async function plan() {
    return await handlers.plan(node, {}, {}, {
      runId: "run",
      request: {
        businessRevision: runtimeRevisionReference(state),
        identity: nativeExecutionIdentity(state, "conversation", "input"),
        contribution: { id: "input", kind: "input", inputMessageId: "input" },
        model,
        flow,
        maxSteps: flow.maxSteps,
      },
      step: 3,
      segmentStep: 3,
      action: {
        effectKey: "parent",
        contributionId: "input",
        inputMessageId: "input",
        resumed: false,
        localState: {},
      },
    });
  }
  return {
    host,
    model,
    flow,
    batch,
    plan,
    handlers,
    history,
    get state() {
      return state;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    get representationChecks() {
      return representationChecks;
    },
    consult(operation: typeof consult) {
      consult = operation;
    },
    representation(value: boolean) {
      representable = value;
    },
    pin(value: boolean) {
      pinValid = value;
    },
  };
}

Deno.test("immutable prefix preserves four-call bound, barriers, exact pins, duplicates and schema refusals", () => {
  const f = fixture(
    Array.from({ length: 6 }, (_, index) => read(String(index))),
  );
  assert.equal(
    immutableConsultationPrefix(f.batch, 0, modelContextTools(), validator)
      .length,
    4,
  );
  assert.equal(
    immutableConsultationPrefix(f.batch, 4, modelContextTools(), validator)
      .length,
    2,
  );
  for (
    const barrier of [
      { kind: "reply", text: "done" },
      {
        kind: "consult_model",
        text: "load",
        inputJson: JSON.stringify({
          operation: "read_source",
          version,
          path: "model.sysml",
        }),
      },
      {
        kind: "consult_model",
        text: "unload",
        inputJson: JSON.stringify({ operation: "unload_sources", version }),
      },
      {
        kind: "consult_model",
        text: "history",
        inputJson: JSON.stringify({ operation: "network_impact", version }),
      },
      {
        kind: "consult_model",
        text: "wrong pin",
        inputJson: JSON.stringify({
          operation: "search",
          version: "commit:other",
        }),
      },
      { kind: "consult_model", text: "opaque", inputJson: "not-json" },
      {
        kind: "consult_model",
        text: "invalid",
        inputJson: JSON.stringify({
          operation: "search",
          version,
          invalid: true,
        }),
      },
      read("0"),
    ] as ChatDecision[]
  ) {
    const batch = structuredClone(f.batch);
    batch.calls[1]!.decision = barrier;
    assert.equal(
      immutableConsultationPrefix(batch, 0, modelContextTools(), validator)
        .length,
      1,
    );
  }
  const unknown = structuredClone(f.batch);
  unknown.calls[0]!.status = "unknown";
  assert.deepEqual(
    immutableConsultationPrefix(unknown, 0, modelContextTools(), validator),
    [],
  );
});

Deno.test("immutable workers stage out-of-order reads and publish exact ordered receipts once", async () => {
  const f = fixture();
  const first = deferred<unknown>(),
    second = deferred<unknown>(),
    started = deferred<void>();
  f.consult((input) => {
    if (f.reads === 2) started.resolve();
    return input.query === "first" ? first.promise : second.promise;
  });
  const manifest = (await f.plan())!;
  assert.equal(manifest.members.length, 2);
  assert.deepEqual(manifest.members.map((item) => item.flowStepOrdinal), [
    4,
    5,
  ]);
  assert.equal(manifest.limits.flowSteps, 3);
  assert(
    manifest.members.reduce(
      (sum, member) => sum + member.responseCharacters,
      0,
    ) <= manifest.limits.responseCharacters,
  );
  const pending = manifest.members.map((member) =>
    f.handlers.execute(manifest, member)
  );
  const all = Promise.all(pending);
  try {
    await Promise.race([
      started.promise,
      all.then(() => {
        throw new Error("Workers completed before both reads entered");
      }),
    ]);
    assert.equal(f.reads, 2);
    assert.equal(f.writes, 0);
    assert.equal(f.state.activeBatchCall!.callId, "call-0");
    second.reject(
      Object.assign(new Error("Known navigation refusal"), {
        code: "INDEX_UNAVAILABLE",
      }),
    );
    first.resolve({ observed: "first-result" });
    const outcomes = await all;
    assert.deepEqual(outcomes.map((item) => item.result.status), [
      "succeeded",
      "refused",
    ]);
    assert.equal(f.writes, 0);
    const published = await f.handlers.publish(
      manifest,
      [...outcomes].reverse(),
    );
    assert.deepEqual(published.action.outputs?.submission, {
      awaitingInput: false,
    });
    assert.equal(f.writes, 1);
    assert.equal(f.representationChecks, 1);
    assert.equal(f.state.messages.length, 5);
    assert.equal(f.state.events.length, 4);
    assert(f.state.messages.slice(1).every((message) => message.at === at));
    assert(f.state.events.every((event) => event.at === at));
    assert.deepEqual(
      f.state.conversationBatches![0]!.calls.map((call) => call.status),
      ["completed", "completed"],
    );
    assert.equal(f.state.activeBatchCall, undefined);
    assert(
      f.state.messages.slice(1).every((message) =>
        message.execution?.actionId === "native-command"
      ),
    );
    assert.deepEqual(
      f.state.messages.slice(1).filter((message) =>
        message.role === "assistant"
      )
        .map((message) => message.text),
      ["Inspect first", "Inspect second"],
    );
    const replay = await f.handlers.publish(manifest, outcomes);
    assert.deepEqual(replay, published);
    assert.equal(f.writes, 1);
    assert.equal(f.reads, 2);
  } finally {
    first.resolve(undefined);
    second.resolve(undefined);
    await Promise.allSettled(pending);
  }
});

for (const noticeCompletionAvailable of [false, true]) {
  Deno.test(`immutable notice reads preserve ${noticeCompletionAvailable ? "quiet completion" : "their admitted historical narration"} and exact publication replay`, async () => {
    const f = fixture();
    if (!noticeCompletionAvailable) {
      f.flow.nodes.find((node) => node.name === "executeOperatorCommand")!
        .outputs = ["outcome"];
    }
    const input = f.state.messages[0];
    input.role = "tool";
    input.noticeWake = true;
    input.operatorNotice = {
      kind: "authority-escalation",
      changeId: "change",
      requestedBy: "other",
      caseId: "other-request",
      recipient: "operator",
      decisionAuthority: "operator",
      reason: "Read the selected page",
    };
    f.history.set(f.state.revision, structuredClone(f.state));
    const manifest = (await f.plan())!;
    const outcomes = await Promise.all(
      manifest.members.map((member) => f.handlers.execute(manifest, member)),
    );
    for (const outcome of outcomes) {
      assert.deepEqual(
        outcome.messages.map((message) => message.role),
        noticeCompletionAvailable ? ["tool"] : ["assistant", "tool"],
      );
      assert.equal(outcome.result.status, "succeeded");
      assert.equal(outcome.events.length, 2);
    }
    const published = await f.handlers.publish(manifest, outcomes);
    assert.deepEqual(
      published.action.outputs?.submission,
      noticeCompletionAvailable ? { awaitingInput: false } : undefined,
    );
    assert.equal(f.state.messages.length, noticeCompletionAvailable ? 3 : 5);
    assert.equal(
      f.state.messages.filter((message) => message.role === "assistant").length,
      noticeCompletionAvailable ? 0 : 2,
    );
    assert.equal(
      f.state.messages.filter((message) =>
        message.observation?.kind === "model-context"
      ).length,
      2,
    );
    assert(
      f.state.conversationBatches![0].calls.every((call) =>
        call.status === "completed"
      ),
    );
    assert.deepEqual(await f.handlers.publish(manifest, outcomes), published);
    assert.equal(f.state.messages.length, noticeCompletionAvailable ? 3 : 5);
  });
}

Deno.test("immutable navigation refusals retain source evidence independently of the execution pin", async () => {
  const f = fixture(["known", "unavailable"].map((elementId) => ({
    kind: "consult_model" as const,
    text: `Inspect ${elementId}`,
    inputJson: JSON.stringify({ operation: "inspect", version, elementId }),
  })));
  const executionVersion = "commit:admitted-execution";
  f.model.version.repositoryVersion = executionVersion;
  f.history.set(f.state.revision, structuredClone(f.state));
  const build = {
    repositoryId: "repository",
    sourceDigest: "a".repeat(64),
    recipeDigest: "b".repeat(64),
    buildKey: "c".repeat(64),
    artifactDigest: "d".repeat(64),
  };
  const projection = {
    kind: "model-context",
    projectorVersion: "fixture-v1",
    artifactDigest: build.artifactDigest,
    projectionDigest: "e".repeat(64),
  };
  const unavailable = {
    state: "unavailable" as const,
    advisory: true as const,
    version,
    code: "INDEX_UNAVAILABLE",
    message: "The exact source index is unavailable",
    recovery: "Restore the exact source projection",
  };
  const knownError = new ModelNavigationError({
    ...unavailable,
    build,
    projection,
  });
  const missingError = new ModelNavigationError(unavailable);
  f.consult((request) =>
    Promise.reject(request.elementId === "known" ? knownError : missingError)
  );
  const manifest = (await f.plan())!;
  assert.deepEqual(manifest.sourcePin, { version, digest: build.sourceDigest });
  assert.equal(manifest.executionPin.repositoryVersion, executionVersion);
  assert.notEqual(manifest.sourcePin.version, executionVersion);
  const outcomes = await Promise.all(
    manifest.members.map((member) => f.handlers.execute(manifest, member)),
  );
  const expected = {
    status: "refused",
    operation: "inspect",
    message: unavailable.message,
    code: "INDEX_UNAVAILABLE",
    version,
    recovery: unavailable.recovery,
  };
  const expectedValues = [{ ...expected, build, projection }, expected];
  for (const [index, outcome] of outcomes.entries()) {
    const member = manifest.members[index]!;
    assert.equal(member.request.version, version);
    assert.equal(outcome.callId, member.callId);
    assert.equal(outcome.effectKey, member.effectKey);
    assert.equal(outcome.result.status, "refused");
    assert.equal(outcome.result.code, "MODEL_CONSULTATION_REFUSED");
    assert.deepEqual(outcome.result.value, expectedValues[index]);
    assert.deepEqual(JSON.parse(outcome.result.details), expectedValues[index]);
    const message = outcome.messages.find((entry) => entry.role === "tool")!;
    assert.deepEqual(message.observation, {
      kind: "model-context",
      value: expectedValues[index],
    });
    assert.equal(message.execution?.repositoryVersion, executionVersion);
    assert.equal(message.execution?.digest, manifest.executionPin.modelDigest);
  }
  assert.equal(
    Object.hasOwn(outcomes[1]!.result.value as object, "build"),
    false,
  );
  assert.equal(
    Object.hasOwn(outcomes[1]!.result.value as object, "projection"),
    false,
  );
  assert.equal(f.writes, 0);
  await f.handlers.publish(manifest, outcomes);
  assert.equal(f.reads, 2);
  assert.equal(f.writes, 1);
  assert.deepEqual(
    f.state.conversationBatches![0].calls.map((call) => call.result?.value),
    expectedValues,
  );
});

Deno.test("oversized immutable navigation refusal remains terminal without canonical publication", async () => {
  const f = fixture([read("large")]);
  const manifest = (await f.plan())!;
  f.consult(() =>
    Promise.reject(
      new ModelNavigationError({
        state: "unavailable",
        advisory: true,
        version,
        code: "INDEX_UNAVAILABLE",
        message: "The exact source index is unavailable",
        recovery: "r".repeat(manifest.members[0]!.responseCharacters + 1),
      }),
    )
  );
  const outcome = await f.handlers.execute(manifest, manifest.members[0]!);
  const exact = structuredClone(outcome);
  assert.equal(outcome.result.status, "refused");
  assert(
    JSON.stringify(outcome.result.value).length >
      manifest.members[0]!.responseCharacters,
  );
  await assert.rejects(
    () => f.handlers.publish(manifest, [outcome]),
    /reserved response budget/,
  );
  assert.deepEqual(outcome, exact);
  assert.equal(f.reads, 1);
  assert.equal(f.writes, 0);
  assert.equal(f.state.conversationBatches![0]!.calls[0]!.result, undefined);
});

Deno.test("an existing oversized immutable publication replays its exact receipt", async () => {
  const f = fixture([read("legacy")]);
  const manifest = (await f.plan())!;
  f.consult(() =>
    Promise.reject(Object.assign(
      new Error("m".repeat(manifest.members[0]!.responseCharacters + 1)),
      { code: "INDEX_UNAVAILABLE" },
    ))
  );
  const outcome = await f.handlers.execute(manifest, manifest.members[0]!);
  const businessRevision = runtimeRevisionReference(f.state);
  businessRevision.__assemblyRuntimeRevision.revision = f.state.revision + 1;
  const body = {
    groupId: manifest.groupId,
    manifestDigest: manifest.manifestDigest,
    members: [{
      callId: outcome.callId,
      effectKey: outcome.effectKey,
      receiptDigest: await executionDigest(outcome),
    }],
    businessRevision,
  };
  const publication = {
    ...body,
    publicationDigest: await executionDigest(body),
  };
  const batch = f.state.conversationBatches![0]!;
  batch.calls[0]!.result = structuredClone(outcome.result);
  batch.calls[0]!.status = "completed";
  f.state.messages.push(...structuredClone(outcome.messages));
  f.state.events.push(...structuredClone(outcome.events));
  f.state.revision++;
  batch.immutableGroup = {
    groupId: manifest.groupId,
    manifestDigest: manifest.manifestDigest,
    publication: {
      publicationDigest: publication.publicationDigest,
      revision: f.state.revision,
    },
  };
  const before = structuredClone(f.state);
  const replay = await f.handlers.publish(manifest, [outcome]);
  assert.deepEqual(replay.publication, publication);
  assert.deepEqual(f.state, before);
  assert.equal(f.writes, 0);
  assert.equal(f.reads, 1);
  const changed = structuredClone(outcome);
  changed.result.details += " changed";
  await assert.rejects(
    () => f.handlers.publish(manifest, [changed]),
    /differs from its canonical receipt/,
  );
});

Deno.test("an admission refusal without value reaches the global representation guard", async () => {
  const f = fixture();
  const manifest = (await f.plan())!;
  const other = await f.handlers.execute(manifest, manifest.members[1]!);
  const member = manifest.members[0]!;
  const refusal = {
    groupId: manifest.groupId,
    callId: member.callId,
    effectKey: member.effectKey,
    argumentsDigest: member.argumentsDigest,
    result: {
      status: "refused" as const,
      code: "NATIVE_EXECUTION_ADMISSION_REFUSED",
      details: "Admission refused",
    },
    messages: [],
    events: [],
  };
  f.representation(false);
  await assert.rejects(
    () => f.handlers.publish(manifest, [refusal, other]),
    /representation refused/,
  );
  assert.equal(f.writes, 0);
  f.representation(true);
  await f.handlers.publish(manifest, [refusal, other]);
  assert.equal(f.writes, 1);
  assert.deepEqual(
    f.state.conversationBatches![0]!.calls[0]!.result,
    refusal.result,
  );
});

Deno.test("immutable join refuses partial results, changed invocation and unrepresentable publication before save", async () => {
  const f = fixture();
  const manifest = (await f.plan())!;
  const outcomes = await Promise.all(
    manifest.members.map((member) => f.handlers.execute(manifest, member)),
  );
  await assert.rejects(
    () => f.handlers.publish(manifest, [outcomes[0]!]),
    /every terminal member/,
  );
  f.representation(false);
  await assert.rejects(
    () => f.handlers.publish(manifest, outcomes),
    /representation refused/,
  );
  assert.equal(f.writes, 0);
  f.state.activeInputMessageId = "another-input";
  await assert.rejects(
    () => f.handlers.publish(manifest, outcomes),
    /invocation or admitted pin changed/,
  );
  assert.equal(f.writes, 0);
});

Deno.test("immutable planning refuses incomplete historical batches and preserves scalar pins", async () => {
  const f = fixture();
  delete f.batch.recordedRevision;
  await assert.rejects(f.plan, /accepted batch revision/);
  f.flow.executionProfile = "operator-command-v1";
  assert.equal(await f.plan(), undefined);
  assert.equal(f.writes, 0);
});

Deno.test("a changed working set after member receipts prevents canonical publication", async () => {
  const f = fixture();
  const manifest = (await f.plan())!;
  const outcomes = await Promise.all(
    manifest.members.map((member) => f.handlers.execute(manifest, member)),
  );
  f.pin(false);
  await assert.rejects(
    () => f.handlers.publish(manifest, outcomes),
    /working set changed/,
  );
  assert.equal(f.writes, 0);
  assert(f.state.conversationBatches![0]!.calls.every((call) => !call.result));
});

Deno.test("a stale working-set error during a read is not published as a normal refusal", async () => {
  const f = fixture();
  const manifest = (await f.plan())!;
  f.consult(() =>
    Promise.reject(
      Object.assign(new Error("working set changed"), {
        code: "MODEL_CONTEXT_STALE_REQUEST",
      }),
    )
  );
  await assert.rejects(
    () => f.handlers.execute(manifest, manifest.members[0]),
    /working set changed/,
  );
  assert.equal(f.writes, 0);
});

function delegatedFixture() {
  const f = fixture([read("delegated")]);
  const record: import("../../../domain/work/entities/cases.ts").Case = {
    id: "owner-request",
    number: 7,
    type: "request",
    owner: "main",
    openedBy: "owner",
    openedFrom: {
      conversationId: "main",
      openingId: "opening",
      designerScopeId: "main-designer",
    },
    objective: "Read this exact delegated source",
    modelPin: { digest: "root-birth", repositoryVersion: "root-source" },
    status: "open",
    createdAt: at,
  };
  const work = {
    callerId: "main",
    correlationId: "delegated",
    fingerprint: "delegated",
    invocationId: "delegated",
    behaviorId: "inbox",
    targetNativeId: "operator",
    priorCandidateIds: [],
    modelVersion: {
      digest: "root-current",
      repositoryVersion: "root-current-source",
    },
    caseId: record.id,
    caseContext: {
      caseId: record.id,
      number: record.number,
      modelPin: structuredClone(record.modelPin),
      record,
    },
  } satisfies import("../../../domain/work/execution/case-context.ts").OperatorWorkReceipt;
  f.state.caseInvocation = { kind: "delegated", work };
  f.state.messages[0].role = "tool";
  f.state.messages[0].caseId = record.id;
  f.state.messages[0].work = work;
  delete f.state.messages[0].designerScopeId;
  f.batch.caseId = record.id;
  delete f.batch.designerScopeId;
  f.batch.invocationKey = invocationKey(f.state.caseInvocation);
  f.history.set(f.state.revision, structuredClone(f.state));
  return f;
}

Deno.test("immutable delegated reads use the exact captured owner Request without creating a local Case", async () => {
  const f = delegatedFixture();
  const manifest = (await f.plan())!;
  const outcome = await f.handlers.execute(manifest, manifest.members[0]);
  await f.handlers.publish(manifest, [outcome]);
  assert.equal(f.reads, 1);
  assert.equal(
    f.state.cases?.some((record) => record.id === "owner-request") ?? false,
    false,
  );
  assert.equal(f.state.conversationBatches![0].calls[0].status, "completed");
  assert(
    f.state.messages.slice(1).every((message) =>
      message.caseId === "owner-request" && !message.designerScopeId
    ),
  );
});

Deno.test("immutable delegated reads refuse missing closed or foreign Case context before reading", async () => {
  const changes: Array<
    (
      context: NonNullable<
        import("../../../domain/work/execution/case-context.ts").OperatorWorkReceipt[
          "caseContext"
        ]
      >,
    ) => void
  > = [
    (context) => {
      delete context.record;
    },
    (context) => {
      context.record!.status = "closed-done";
    },
    (context) => {
      context.record!.status = "closed-abandoned";
    },
    (context) => {
      context.record!.id = "foreign-request";
    },
    (context) => {
      context.record!.owner = "";
    },
    (context) => {
      context.number = 8;
    },
    (context) => {
      context.modelPin.digest = "foreign-birth";
    },
  ];
  for (const mutate of changes) {
    const f = delegatedFixture();
    const manifest = (await f.plan())!;
    if (f.state.caseInvocation?.kind !== "delegated") {
      throw new Error("Expected delegated fixture");
    }
    mutate(f.state.caseInvocation.work.caseContext);
    await assert.rejects(
      () => f.handlers.execute(manifest, manifest.members[0]),
      /Request is closed or its exact Case context is unavailable/,
    );
    assert.equal(f.reads, 0);
    assert.equal(f.writes, 0);
  }
});

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`immutable boundary read=${read}, revision=${revision} has one explicit coded authority refusal`, async () => {
    const f = fixture();
    f.model.policy.mayProposeSysmlRevision = revision;
    if (read !== undefined) f.model.policy.mayConsultModel = read;
    else delete f.model.policy.mayConsultModel;
    const manifest = (await f.plan())!;
    assert(manifest);
    if (allowed) await f.handlers.execute(manifest, manifest.members[0]);
    else {await assert.rejects(() =>
        f.handlers.execute(manifest, manifest.members[0]), {
        code: "MODEL_CONTEXT_AUTHORITY",
        context: { authority: "model-read" },
      });}
    assert.equal(f.reads, allowed ? 1 : 0);
  });
}

Deno.test("immutable execution rechecks read revocation on the exact admitted model before dispatch", async () => {
  const f = fixture();
  f.model.policy.mayConsultModel = true;
  const manifest = (await f.plan())!;
  f.state.executionModel!.policy.mayConsultModel = false;
  f.state.executionModel!.policy.mayProposeSysmlRevision = false;
  await assert.rejects(
    () => f.handlers.execute(manifest, manifest.members[0]),
    /read authority/,
  );
  assert.equal(f.reads, 0);
});
