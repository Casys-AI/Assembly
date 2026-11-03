import {
  type NativeExecutionLedger,
  NativeGraphExecution,
} from "../../src/adapters/work/runtime/conversation.ts";
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import type {
  NativeExecutionHandlers,
  NativeExecutionRequest,
} from "../../src/application/work/runtime/execution.ts";
import type { CompiledFlow } from "../../src/domain/model/execution/flow.ts";
import {
  createTestNativeExecution,
  nativeCaseFixtureModel,
} from "./native-execution.ts";
import { immutableConsultationFixture } from "./immutable-consultation-fixture.ts";
import {
  assertNoMemoryImmutableConsultations,
  memoryImmutableConsultationSession,
  memoryImmutableConsultationState,
} from "./immutable-consultations.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { runtimeRevisionReference } from "../../src/application/work/runtime/execution.ts";
import { valueDigest } from "../../src/application/work/runtime/values.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { compileNativeFixtureFlows } from "./execution-fixture.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import { Command, MemorySaver } from "@langchain/langgraph";
import {
  compileNativeOperatorGraph,
  type NativeTrace,
} from "../../src/adapters/work/runtime/native-graph.ts";
import type { NativeObservationEmission } from "../../src/adapters/work/runtime/native-observation.ts";

async function immutableLedgerFixture() {
  const f = immutableConsultationFixture(), runId = "immutable-memory-run";
  const revisions = new Map([[f.state.revision, structuredClone(f.state)]]);
  const thread = {
    request: f.request,
    runId,
    effects: new Map<string, unknown>(),
    groupLedger: memoryImmutableConsultationState(),
  };
  const session = memoryImmutableConsultationSession(thread, revisions);
  return { ...f, revisions, thread, session, group: await f.manifest(runId) };
}

Deno.test("immutable ledger overlaps exact registered siblings and preserves an admission refusal without releasing the group", async () => {
  const f = await immutableLedgerFixture();
  const [first, second] = f.group.members;
  await f.session.register(f.group);
  deepStrictEqual(await f.session.register(structuredClone(f.group)), f.group);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = f.session.memberEffect(
    f.group.groupId,
    first,
    f.node,
    async () => {
      entered();
      await gate;
      return f.outcome(f.group, first);
    },
    () => Promise.resolve(),
  );
  await Promise.race([
    started,
    pending.then(() => {}, (error) => Promise.reject(error)),
  ]);
  const refused = await f.session.memberEffect(
    f.group.groupId,
    second!,
    f.node,
    () => {
      throw new Error("Refused member must not run");
    },
    () => Promise.reject(new Error("Current read authority refused")),
  );
  equal(refused.result.status, "refused");
  equal(f.thread.effects.get(first.effectKey), undefined);
  equal((await f.session.pending()).length, 1);
  await rejects(
    () =>
      f.session.memberEffect(
        f.group.groupId,
        first,
        f.node,
        () => Promise.resolve(f.outcome(f.group, first)),
        () => Promise.resolve(),
      ),
    /already started/,
  );
  release();
  const successful = await pending;
  equal(successful.result.status, "succeeded");
  equal(
    (await f.session.pending()).length,
    1,
    "settled reads still await publication",
  );
  let blocked = false;
  try {
    assertNoMemoryImmutableConsultations(f.thread);
  } catch {
    blocked = true;
  }
  equal(blocked, true);
  const publication = await f.publication(f.group, [successful, refused]);
  await rejects(
    () => f.session.publish(publication.receipt),
    /CANONICAL_PUBLICATION_MISSING/,
  );
  f.revisions.set(publication.state.revision, publication.state);
  deepStrictEqual(
    await f.session.publish(publication.receipt),
    publication.receipt,
  );
  deepStrictEqual(
    await f.session.publish(structuredClone(publication.receipt)),
    publication.receipt,
  );
  const conflict = structuredClone(publication.receipt);
  conflict.businessRevision.__assemblyRuntimeRevision.revision++;
  const { publicationDigest: _publicationDigest, ...conflictBody } = conflict;
  conflict.publicationDigest = await executionDigest(conflictBody);
  await rejects(() => f.session.publish(conflict), /PUBLICATION_CONFLICT/);
  equal((await f.session.pending()).length, 0);
  assertNoMemoryImmutableConsultations(f.thread);
  deepStrictEqual(
    await f.session.memberEffect(f.group.groupId, first, f.node, () => {
      throw new Error("Completed read must not repeat");
    }),
    successful,
  );
});

Deno.test("immutable ledger refuses changed arguments, foreign groups, scalar parents and publication conflicts", async () => {
  const f = await immutableLedgerFixture();
  f.thread.effects.set("opaque-parent", undefined);
  await rejects(() => f.session.register(f.group), /Unsettled native effects/);
  equal(f.thread.groupLedger.groups.size, 0);
  f.thread.effects.delete("opaque-parent");
  await f.session.register(f.group);
  const changed = structuredClone(f.group.members[0]);
  changed.request.query = "different";
  changed.argumentsDigest = await executionDigest(changed.request);
  await rejects(
    () =>
      f.session.memberEffect(
        f.group.groupId,
        changed,
        f.node,
        () => Promise.resolve(f.outcome(f.group, changed)),
        () => Promise.resolve(),
      ),
    /MEMBER_MISMATCH/,
  );
  const foreign = structuredClone(f.group);
  foreign.groupId = "foreign-group";
  const { manifestDigest: _digest, ...body } = foreign;
  foreign.manifestDigest = await executionDigest(body);
  await rejects(() => f.session.register(foreign), /Unpublished immutable/);
  await rejects(
    () =>
      f.session.memberEffect(
        "foreign-group",
        f.group.members[0],
        f.node,
        () => Promise.resolve(f.outcome(f.group, f.group.members[0])),
        () => Promise.resolve(),
      ),
    /UNREGISTERED/,
  );
  equal(f.thread.effects.size, 0);
});

Deno.test("immutable ledger keeps interrupted started reads unknown and refuses a new sibling or replacement group", async () => {
  const f = await immutableLedgerFixture();
  await f.session.register(f.group);
  await rejects(
    () =>
      f.session.memberEffect(
        f.group.groupId,
        f.group.members[0],
        f.node,
        () =>
          Promise.reject(new Error("Read interrupted before durable result")),
        () => Promise.resolve(),
      ),
    /Read interrupted/,
  );
  await rejects(
    () =>
      f.session.memberEffect(
        f.group.groupId,
        f.group.members[0],
        f.node,
        () => Promise.resolve(f.outcome(f.group, f.group.members[0])),
        () => Promise.resolve(),
      ),
    /EXECUTION_EFFECT_UNKNOWN/,
  );
  await rejects(
    () =>
      f.session.memberEffect(
        f.group.groupId,
        f.group.members[1]!,
        f.node,
        () => Promise.resolve(f.outcome(f.group, f.group.members[1]!)),
        () => Promise.resolve(),
      ),
    /Unsettled native effects/,
  );
  equal((await f.session.pending()).length, 1);
  equal(f.thread.effects.size, 1);
});

function fixture(uncertain: boolean) {
  const model = nativeCaseFixtureModel("native-retry-fixture");
  const source = { file: "native-retry.sysml", line: 1, native: true };
  const flow: CompiledFlow = {
    executionProfile: "operator-command-v1",
    rootNativeId: "retry-flow",
    rootOccurrenceId: "retry-flow",
    name: "retryFlow",
    source,
    startNodeId: "start",
    maxSteps: 16,
    nodes: [
      {
        id: "start",
        nativeId: "start",
        name: "start",
        kind: "start",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
      {
        id: "effect",
        nativeId: "effect",
        name: "effect",
        kind: "action",
        mechanism: "fixture_effect",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
      {
        id: "wait",
        nativeId: "wait",
        name: "wait",
        kind: "action",
        mechanism: "await_input",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
    ],
    edges: [["start", "effect"], ["effect", "wait"], ["wait", "effect"]].map((
      [from, to],
    ) => ({
      id: `${from}-${to}`,
      nativeId: `${from}-${to}`,
      source: from,
      target: to,
      guardIds: [],
      sourceEvidence: source,
    })),
    bindings: [],
  };
  model.flows.conversation = flow;
  const native = createTestNativeExecution({
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const request: NativeExecutionRequest = {
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: model.identity.systemId,
        operatorId: model.identity.builderId,
        invocationKey: "retry-fixture",
        revision: 0,
        modelDigest: model.version.digest,
      },
    },
    identity: {
      operatorId: model.identity.builderId,
      invocationKey: "retry-fixture",
      scope: { kind: "designer", scopeId: "retry-scope", ownerId: "owner" },
      purpose: "conversation",
      subjectId: "input-one",
    },
    contribution: {
      id: "input-one",
      kind: "input",
      inputMessageId: "input-one",
    },
    model,
    flow,
    maxSteps: 16,
  };
  let effects = 0;
  let acceptances = 0;
  const keys: string[] = [];
  const handlers: NativeExecutionHandlers = {
    assertBoundary: () => Promise.resolve(),
    onEvent: () => Promise.resolve(),
    handle(node, _inputs, _values, execution) {
      if (node.mechanism === "await_input") {
        acceptances++;
        return Promise.resolve({});
      }
      equal(node.mechanism, "fixture_effect");
      effects++;
      keys.push(execution.effectKey);
      if (uncertain) throw new Error("Interrupted after the fixture effect");
      return Promise.resolve({});
    },
  };
  return {
    native,
    request,
    handlers,
    keys,
    effects: () => effects,
    acceptances: () => acceptances,
  };
}

Deno.test("memory native execution retains an uncertain contribution identity and blocks replay or new dispatch", async () => {
  const f = fixture(true);
  await rejects(
    () => f.native.execution.run(f.request, f.handlers),
    /Interrupted after the fixture effect/,
  );
  equal(f.effects(), 1);
  const [before] = await f.native.execution.inspect(
    f.request.identity.operatorId,
  );
  equal(before.status, "uncertain");
  deepStrictEqual(before.unsettledEffects, f.keys);
  await rejects(
    () => f.native.execution.run(f.request, f.handlers),
    /Native effect was already started under this invocation/,
  );
  equal(f.effects(), 1);
  const [after] = await f.native.execution.inspect(
    f.request.identity.operatorId,
  );
  equal(after.status, "uncertain");
  equal(after.threadId, before.threadId);
  equal(after.contributionId, before.contributionId);
  equal(after.modelDigest, before.modelDigest);
  equal(after.flowRootId, before.flowRootId);
  deepStrictEqual(after.unsettledEffects, before.unsettledEffects);
  await rejects(() =>
    f.native.execution.run({
      ...f.request,
      contribution: { ...f.request.contribution, kind: "resume" },
    }, f.handlers), /Test contribution conflict/);
  await rejects(() =>
    f.native.execution.run({
      ...f.request,
      contribution: {
        id: "input-two",
        kind: "resume",
        inputMessageId: "input-one",
      },
    }, f.handlers), /Unsettled native effects block new operation dispatch/);
  equal(f.effects(), 1);
  equal(f.acceptances(), 0);
  deepStrictEqual(
    await f.native.execution.inspect(f.request.identity.operatorId),
    [after],
  );
});

Deno.test("memory native execution reuses settled receipts and gives a real next contribution a fresh effect", async () => {
  const f = fixture(false);
  const first = await f.native.execution.run(f.request, f.handlers);
  equal(first.status, "waiting");
  equal(f.effects(), 1);
  equal(f.acceptances(), 0);
  deepStrictEqual(await f.native.execution.run(f.request, f.handlers), first);
  equal(f.effects(), 1);
  equal(f.acceptances(), 0);
  const changedCompletedPin = structuredClone(f.request);
  changedCompletedPin.model.identity.catalogId = "different-catalog";
  // An exact completed receipt is returned before evaluating a new pin.
  deepStrictEqual(
    await f.native.execution.run(changedCompletedPin, f.handlers),
    first,
  );
  equal(f.effects(), 1);
  await rejects(() =>
    f.native.execution.run({
      ...f.request,
      contribution: { ...f.request.contribution, kind: "resume" },
    }, f.handlers), /Test contribution conflict/);
  const next = await f.native.execution.run({
    ...f.request,
    contribution: {
      id: "input-two",
      kind: "resume",
      inputMessageId: "input-one",
    },
  }, f.handlers);
  equal(next.threadId, first.threadId);
  equal(next.modelDigest, first.modelDigest);
  equal(next.contributionId, "input-two");
  equal(next.status, "waiting");
  deepStrictEqual(next.unsettledEffects, []);
  equal(f.effects(), 2);
  equal(f.keys.length, 2);
  notEqual(f.keys[0], f.keys[1]);
  equal(f.acceptances(), 1);
});

Deno.test("R4b memory execution journals observations without checkpoint trace growth", async () => {
  const f = fixture(false);
  const delivered: NativeTrace[] = [];
  const handlers: NativeExecutionHandlers = {
    ...f.handlers,
    onEvent: (event) => {
      delivered.push(structuredClone(event) as NativeTrace);
      return Promise.resolve();
    },
  };
  const first = await f.native.execution.run(f.request, handlers);
  equal(first.status, "waiting");
  const [checkpoint] = await f.native.checkpoints();
  deepStrictEqual(checkpoint.values.trace, []);
  ok(checkpoint.history.length > 2);
  for (const retained of checkpoint.history) {
    deepStrictEqual(retained.trace ?? [], []);
  }
  deepStrictEqual(
    checkpoint.nativeObservations.map((record) => [
      record.producerPhase,
      record.event.kind,
      record.event.actionId ?? record.event.edgeId,
      record.event.step,
      record.emissionStep,
      record.eventOrdinal,
    ]),
    [
      ["node-commit", "edge", "start-effect", 1, 1, 0],
      ["preparation", "action", "effect", 2, 2, 0],
      ["node-commit", "edge", "effect-wait", 2, 2, 0],
      ["preparation", "action", "wait", 3, 3, 0],
      ["preparation", "suspended", "wait", 3, 3, 1],
    ],
  );
  // The awaited business projection received exactly the journaled events.
  deepStrictEqual(
    delivered,
    checkpoint.nativeObservations.map((record) => record.event),
  );
  for (const record of checkpoint.nativeObservations) {
    ok(!Number.isNaN(Date.parse(record.firstRecordedAt)));
  }
  const retainedValues = structuredClone(checkpoint.values);
  const retainedHistory = checkpoint.history.length;
  const firstRunRecords = structuredClone(checkpoint.nativeObservations);

  const next = await f.native.execution.run({
    ...f.request,
    contribution: {
      id: "input-two",
      kind: "resume",
      inputMessageId: "input-one",
    },
  }, handlers);
  equal(next.status, "waiting");
  notEqual(next.runId, first.runId);
  const [resumed] = await f.native.checkpoints();
  ok(resumed.history.length > retainedHistory);
  for (const retained of resumed.history) {
    deepStrictEqual(retained.trace ?? [], []);
  }
  // The earlier selected checkpoint survives byte-for-byte in history.
  ok(
    resumed.history.some((entry) =>
      JSON.stringify(entry) === JSON.stringify(retainedValues)
    ),
  );
  // The successor run owns only its own emissions, at continuing steps.
  ok(resumed.nativeObservations.length > 0);
  ok(resumed.nativeObservations.every((record) => record.emissionStep > 3));
  deepStrictEqual(
    resumed.nativeObservations.map((record) => record.firstRecordedAt),
    resumed.nativeObservations.map((record) => record.firstRecordedAt),
  );
  ok(firstRunRecords.length === 5);
});

Deno.test("R4b memory callback failure retains the committed prefix; replay conflicts refuse and settled effects are not repeated", async () => {
  const f = fixture(false);
  const delivered: string[] = [];
  let failures = 1;
  const handlers: NativeExecutionHandlers = {
    ...f.handlers,
    onEvent: (event) => {
      delivered.push(`${event.kind}:${event.actionId ?? event.edgeId}`);
      if (delivered.length === 2 && failures > 0) {
        failures--;
        return Promise.reject(new Error("business callback failed"));
      }
      return Promise.resolve();
    },
  };
  await rejects(
    () => f.native.execution.run(f.request, handlers),
    /business callback failed/,
  );
  equal(f.effects(), 1);
  const [failed] = await f.native.checkpoints();
  deepStrictEqual(failed.values.trace, []);
  equal(failed.nativeObservations.length, 2);
  const prefix = structuredClone(failed.nativeObservations);

  // Same producer key with changed payload refuses; the prefix is immutable
  // and the settled effect is not replayed to reach the refusal.
  const changed = structuredClone(f.request);
  changed.flow.nodes.find((node) => node.id === "effect")!.source = {
    file: "native-retry.sysml",
    line: 99,
    native: true,
  };
  await rejects(
    () => f.native.execution.run(changed, handlers),
    /NATIVE_OBSERVATION_CONFLICT/,
  );
  equal(f.effects(), 1);
  const [conflicted] = await f.native.checkpoints();
  deepStrictEqual(conflicted.nativeObservations, prefix);

  const retried = await f.native.execution.run(f.request, handlers);
  equal(retried.status, "waiting");
  equal(f.effects(), 1, "settled replay must not repeat the effect");
  const [recovered] = await f.native.checkpoints();
  equal(recovered.nativeObservations.length, 5);
  deepStrictEqual(recovered.nativeObservations.slice(0, 2), prefix);
  // The failed node's callback is awaited again on replay; the checkpointed
  // start commit does not re-deliver, and observations are not duplicated.
  equal(delivered.filter((item) => item === "edge:start-effect").length, 1);
  equal(delivered.filter((item) => item === "action:effect").length, 2);
});

Deno.test("R4b journaled graph retains an inherited historical trace unchanged", async () => {
  const f = fixture(false);
  const saver = new MemorySaver();
  const config = {
    configurable: { thread_id: "r4b-inherited", checkpoint_ns: "" },
  };
  const handler = () => Promise.resolve({});
  const legacy = compileNativeOperatorGraph(f.request.model, handler, {
    scope: f.request.identity.scope,
    operatorId: f.request.identity.operatorId,
    flow: f.request.flow,
    maxSteps: f.request.maxSteps,
    checkpointer: saver,
    assertBoundary: () => Promise.resolve(),
    onEvent: () => Promise.resolve(),
  });
  for await (
    const _saved of await legacy.graph.stream(
      legacy.initialState(),
      { ...config, streamMode: "checkpoints", durability: "sync" },
    )
  ) { /* drain to the wait */ }
  const waiting = await legacy.graph.getState(config);
  const inherited = structuredClone(waiting.values.trace) as NativeTrace[];
  equal(inherited.length, 5);

  const emissions: NativeObservationEmission[] = [];
  const journaled = compileNativeOperatorGraph(f.request.model, handler, {
    scope: f.request.identity.scope,
    operatorId: f.request.identity.operatorId,
    flow: f.request.flow,
    maxSteps: f.request.maxSteps,
    checkpointer: saver,
    assertBoundary: () => Promise.resolve(),
    onObservation: (emission) => {
      emissions.push(structuredClone(emission));
      return Promise.resolve();
    },
  });
  for await (
    const _saved of await journaled.graph.stream(
      new Command({ resume: { contributionId: "input-two" } }),
      { ...config, streamMode: "checkpoints", durability: "sync" },
    )
  ) { /* drain to the next wait */ }
  const resumed = await journaled.graph.getState(config);
  deepStrictEqual(resumed.values.trace, inherited);
  ok(emissions.length > 0);
  ok(emissions.every((emission) => emission.emissionStep > 3));
  // No synthetic observations for inherited entries or ancestor emissions.
  deepStrictEqual(
    emissions.map((emission) =>
      emission.event.actionId ?? emission.event.edgeId
    ),
    ["wait", "wait-effect", "effect", "effect-wait", "wait", "wait"],
  );
});

Deno.test("memory native pending contributions require the exact production execution pin at the same source version", async () => {
  const f = fixture(true);
  await rejects(
    () => f.native.execution.run(f.request, f.handlers),
    /Interrupted after the fixture effect/,
  );
  const changes: Array<(request: NativeExecutionRequest) => void> = [
    (request) => {
      request.model.identity.catalogId = "different-catalog";
    },
    (request) => {
      request.flow.rootNativeId = "different-root";
    },
    (request) => {
      request.flow.rootOccurrenceId = "different-occurrence";
    },
    (request) => {
      delete request.flow.executionProfile;
    },
    (request) => {
      request.maxSteps = 15;
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(f.request);
    change(changed);
    deepStrictEqual(changed.model.version, f.request.model.version);
    await rejects(
      () => f.native.execution.run(changed, f.handlers),
      /Test pin transition requires an exact receipt/,
    );
    equal(f.effects(), 1);
  }
  const movedSourceExcerpt = structuredClone(f.request);
  movedSourceExcerpt.flow.source.quote = "Different source excerpt metadata";
  // Source excerpts are not added to the immutable ledger pin. The same run
  // still reaches its existing started-effect refusal, never another effect.
  await rejects(
    () => f.native.execution.run(movedSourceExcerpt, f.handlers),
    /Native effect was already started under this invocation/,
  );
  equal(f.effects(), 1);
  equal(f.acceptances(), 0);
});

async function mandateContinuationFixture(reviewer = false, promotion = false) {
  const seed = immutableConsultationFixture();
  const flow = fixture(false).request.flow;
  seed.model.flows.conversation = structuredClone(flow);
  if (promotion) seed.model.flows.promotion = structuredClone(flow);
  seed.state.executionModel = structuredClone(seed.model);
  seed.state.configuration = structuredClone(seed.model.configuration);
  let saved = structuredClone(seed.state);
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state) => {
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  await native.store.save(saved, null);
  let effects = 0;
  const handlers: NativeExecutionHandlers = {
    assertBoundary: () => Promise.resolve(),
    onEvent: () => Promise.resolve(),
    readAdoptedModel: () =>
      Promise.resolve(structuredClone(saved.executionModel!)),
    handle(node) {
      if (node.mechanism === "await_input") return Promise.resolve({});
      equal(node.mechanism, "fixture_effect");
      effects++;
      return Promise.resolve({});
    },
  };
  const source: NativeExecutionRequest = {
    ...seed.request,
    model: seed.model,
    flow,
    businessRevision: runtimeRevisionReference(saved),
    maxSteps: flow.maxSteps,
    identity: {
      ...seed.request.identity,
      purpose: promotion ? "promotion" : "conversation",
    },
  };
  const waiting = await native.execution.run(source, handlers);
  equal(waiting.waits[0].mechanism, "await_input");
  const published = structuredClone(seed.model);
  published.version.digest = "d".repeat(64);
  published.version.repositoryVersion = "c".repeat(40);
  published.configuration.revision++;
  if (!reviewer) {
    published.configuration.network = { allowedHosts: ["approved.example"] };
    published.mandate.network = { allowedHosts: ["approved.example"] };
  }
  if (reviewer) {
    published.identity.reviewerId = "exact-reviewer-native";
    published.configuration.reviewer = {
      id: "exact-mandate",
      name: "Exact reviewer",
      mandateRevision: 1,
    };
    published.configuration.builder.mandateRevision++;
    published.configuration.builder.admissionAuthority = "reviewer";
    published.flows.promotion = compileNativeFixtureFlows(
      published.flows.promotion.maxSteps,
      published.identity.reviewerId,
    ).promotion;
  }
  const change: PendingChange = {
    id: "exact-mandate",
    kind: reviewer ? "reviewer-creation" : "mandate-change",
    ...(reviewer
      ? {
        role: "reviewer" as const,
        name: "Exact reviewer",
        mandate: {
          mayReviewExactCandidate: true as const,
          mayAdmitReviewedCandidates: true as const,
        },
        authority: "human" as const,
        authorityExercise: exerciseOwnerAuthority(seed.model, "mandate-change"),
      }
      : {}),
    status: "approved" as const,
    requestedBy: "owner",
    designerScopeId: source.identity.scope.scopeId,
    baseRevision: seed.model.configuration.revision,
    baseModelDigest: seed.model.version.digest,
    reason: reviewer
      ? "Create the exact reviewer"
      : "Grant the exact network host",
    requestedAt: "2026-10-29T00:00:00Z",
    decidedAt: "2026-10-29T00:01:00Z",
    publishedCommit: published.version.repositoryVersion,
    diff: {
      title: "Exact network change",
      author: "owner",
      base: {
        repositoryVersion: seed.model.version.repositoryVersion!,
        modelDigest: seed.model.version.digest,
        sourceDigest: "old-source",
      },
      sourceDigest: "new-source",
      files: [],
      patch: "",
      additions: 0,
      deletions: 0,
    },
  };
  saved.executionModel = published;
  saved.configuration = {
    ...structuredClone(published.configuration),
    changes: [change],
  };
  saved.revision++;
  await native.store.save(saved, saved.revision - 1);
  const target: NativeExecutionRequest = {
    ...source,
    model: published,
    flow: published.flows.conversation,
    businessRevision: runtimeRevisionReference(saved),
    contribution: {
      id: `change-decision:${change.id}:${await valueDigest({
        status: change.status,
        decidedAt: change.decidedAt,
        publication: undefined,
      })}`,
      kind: "resume",
    },
  };
  return {
    native,
    handlers,
    target,
    waiting,
    effects: () => effects,
    disguiseAsReviewer: async () => {
      saved.configuration!.changes[0].kind = "reviewer-creation";
      saved.revision++;
      await native.store.save(saved, saved.revision - 1);
    },
    replaceDecision: async () => {
      saved.configuration!.changes[0].decidedAt = "2026-10-29T00:02:00Z";
      saved.revision++;
      await native.store.save(saved, saved.revision - 1);
    },
  };
}

Deno.test("memory mandate continuation resumes the genuine wait on the same thread under its exact approved decision", async () => {
  const f = await mandateContinuationFixture();
  const resumed = await f.native.execution.run(f.target, f.handlers);
  equal(resumed.status, "waiting");
  equal(resumed.threadId, f.waiting.threadId);
  notEqual(resumed.runId, f.waiting.runId);
  equal(resumed.modelDigest, f.target.model.version.digest);
  equal(resumed.contributionId, f.target.contribution.id);
  equal(f.effects(), 2);
  deepStrictEqual(await f.native.execution.run(f.target, f.handlers), resumed);
  equal(f.effects(), 2);
});

Deno.test("memory mandate continuation refuses a forged decision, a catalog disguise and a proof changed before selection", async () => {
  for (
    const variant of [
      "decision-digest",
      "catalog-disguise",
      "changed-after-open",
    ] as const
  ) {
    const f = await mandateContinuationFixture();
    const request = structuredClone(f.target);
    if (variant === "decision-digest") {
      request.contribution.id = "change-decision:exact-mandate:" +
        "0".repeat(64);
    }
    if (variant === "catalog-disguise") {
      request.contribution.id = "candidate-decision:foreign:" + "0".repeat(64);
    }
    await rejects(
      () =>
        f.native.execution.run(request, {
          ...f.handlers,
          readAdoptedModel: async () => {
            if (variant === "changed-after-open") await f.replaceDecision();
            return f.target.model;
          },
        }),
      variant === "catalog-disguise"
        ? /owned native execution contract/
        : /exact approved change receipt/,
    );
    equal(f.effects(), 1);
    const [retained] = await f.native.execution.inspect(
      request.identity.operatorId,
    );
    equal(retained.threadId, f.waiting.threadId);
    equal(retained.checkpointId, f.waiting.checkpointId);
    equal(retained.modelDigest, f.waiting.modelDigest);
    deepStrictEqual(retained.unsettledEffects, []);
  }
});

Deno.test("memory reviewer continuation migrates only its retained conversation and rejects altered target or a reviewer disguise", async () => {
  const valid = await mandateContinuationFixture(true);
  const resumed = await valid.native.execution.run(
    valid.target,
    valid.handlers,
  );
  equal(resumed.threadId, valid.waiting.threadId);
  notEqual(resumed.runId, valid.waiting.runId);
  equal(resumed.modelDigest, valid.target.model.version.digest);
  equal(valid.effects(), 2);
  deepStrictEqual(
    await valid.native.execution.run(valid.target, valid.handlers),
    resumed,
  );
  equal(valid.effects(), 2);
  for (
    const variant of [
      "target-promotion-drift",
      "fake-reviewer-kind",
      "old-promotion",
    ] as const
  ) {
    const f = await mandateContinuationFixture(
      variant !== "fake-reviewer-kind",
      variant === "old-promotion",
    );
    const target = structuredClone(f.target);
    if (variant === "target-promotion-drift") {
      target.model.flows.promotion.nodes[0].name = "Unapproved target drift";
    }
    if (variant === "fake-reviewer-kind") await f.disguiseAsReviewer();
    const expectedMessage = variant === "target-promotion-drift"
      ? "Test pin transition requires an exact receipt"
      : variant === "fake-reviewer-kind"
      ? "The reviewer continuation lacks its exact approved publication and prior authority"
      : "Catalog continuation requires exact native source pins";
    await rejects(() => f.native.execution.run(target, f.handlers), {
      message: expectedMessage,
    });
    equal(
      f.effects(),
      1,
      "Refused lineage cannot execute the next source effect",
    );
    const [retained] = await f.native.execution.inspect(
      target.identity.operatorId,
    );
    equal(retained.threadId, f.waiting.threadId);
    equal(retained.checkpointId, f.waiting.checkpointId);
    equal(retained.modelDigest, f.waiting.modelDigest);
    deepStrictEqual(retained.unsettledEffects, []);
  }
});

Deno.test("memory dispatch reports only terminal exact accepted jobs", async () => {
  const native = createTestNativeExecution({
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const model = nativeCaseFixtureModel("terminal-dispatch-fixture");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  native.bind({
    snapshot: {
      executionModel: model,
    } as import("../../src/domain/work/dialogue.ts").SystemRuntimeState,
    async processAcceptedContribution() {
      entered();
      await gate;
      throw new Error("fixture failure");
    },
    idle: () => Promise.resolve(),
  });
  const delivery:
    import("../../src/application/work/operators/execution.ts").OperatorExecutionDelivery =
      {
        id: "terminal-fixture",
        kind: "command",
        modelPin: { modelDigest: model.version.digest },
        identity: {
          operatorId: model.identity.builderId,
          invocationKey: "designer:terminal-fixture",
          purpose: "conversation",
          subjectId: "terminal-fixture",
          scope: {
            kind: "designer",
            scopeId: "terminal-fixture",
            ownerId: model.identity.builderId,
          },
        },
      };
  await native.dispatch.enqueue(delivery);
  await started;
  equal(
    await native.dispatch.inspectTerminalAccepted!(
      model.identity.builderId,
      delivery.id,
    ),
    null,
  );
  release();
  await rejects(() => native.idle(), /fixture failure/);
  const terminal = await native.dispatch.inspectTerminalAccepted!(
    model.identity.builderId,
    delivery.id,
  );
  equal(terminal?.terminal, "failed");
  deepStrictEqual(terminal?.delivery, delivery);
  equal(
    await native.dispatch.inspectTerminalAccepted!(
      model.identity.builderId,
      "other",
    ),
    null,
  );
});

Deno.test("two owner adoptions retire a terminal input without a phantom run and preserve the next real running owner", async () => {
  const { SystemRuntime } = await import("./system-runtime.ts");
  const { unexpectedModelAuthoring } = await import("./model-authoring.ts");
  const { evolutionCheckpoint } = await import(
    "../../src/application/work/runtime/evolution.ts"
  );
  const initial = nativeCaseFixtureModel("adoption-owner", {
    primary: true,
    repositoryVersion: "source:0",
  });
  const versions = new Map([["source:0", structuredClone(initial)]]);
  let current = structuredClone(initial);
  let saved:
    | import("../../src/domain/work/dialogue.ts").SystemRuntimeState
    | null = null;
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save(state, expected) {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  let providerCalls = 0, nativeEffects = 0;
  native.effectBoundary((boundary) => {
    if (boundary.phase === "before-operation") nativeEffects++;
  });
  let providerEntered!: () => void, releaseProvider!: () => void;
  const entered = new Promise<void>((resolve) => {
    providerEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const runtime = new SystemRuntime({
    store: native.store,
    execution: native.execution,
    stateHistory: native.stateHistory,
    dispatch: native.dispatch,
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(initial.identity),
      readExecutableModel: (_identity, version) => {
        const model = versions.get(
          version ?? current.version.repositoryVersion!,
        );
        ok(model);
        return Promise.resolve(structuredClone(model));
      },
      applyApprovedChange: () => {
        throw new Error("No source mandate publication expected");
      },
      activateCandidate: () => {
        throw new Error("No candidate activation expected");
      },
      graph: () => Promise.resolve({}),
    },
    agents: {
      label: "controlled terminal reply",
      async decide() {
        providerCalls++;
        if (providerCalls === 2) {
          providerEntered();
          await release;
        }
        return { kind: "reply", text: `Actual reply ${providerCalls}` };
      },
      review: () => {
        throw new Error("No review expected");
      },
    },
    runner: {
      test: () => {
        throw new Error("No tool test expected");
      },
      run: () => {
        throw new Error("No tool execution expected");
      },
    },
  });
  await runtime.initialize();
  native.bind(runtime);
  await runtime.submit("Finish this input");
  await native.idle();
  equal(providerCalls, 1);
  const [old] = await native.execution.inspect(initial.identity.builderId);
  equal(old.status, "waiting");
  const [frame] = await native.checkpoints();
  ok(frame.checkpointId);
  const effectsBeforeAdoption = nativeEffects;
  for (const index of [1, 2]) {
    current = structuredClone(initial);
    current.version.digest = `adopted:${index}`;
    current.version.repositoryVersion = `source:${index}`;
    versions.set(current.version.repositoryVersion, structuredClone(current));
    await runtime.adoptModelVersion({
      expectedDigest: current.version.digest,
      expectedVersion: current.version.repositoryVersion,
    });
    deepStrictEqual(runtime.snapshot.executionModel!.version, current.version);
    deepStrictEqual(
      await native.execution.inspect(initial.identity.builderId),
      [],
      "A binding without a selected run is not a running owner",
    );
    deepStrictEqual(
      await native.checkpoints(),
      [],
      "Retirement cannot fabricate a saver checkpoint or a source run",
    );
    equal(providerCalls, 1);
    equal(nativeEffects, effectsBeforeAdoption);
    if (index === 1) {
      // Use the real previous request. A refused opening cannot consume the
      // empty successor marker and expose a fabricated running contribution.
      await rejects(() =>
        native.execution.run(frame.request, {
          assertBoundary: () =>
            Promise.reject(new Error("No predecessor may execute")),
          onEvent: () =>
            Promise.reject(new Error("No predecessor event expected")),
          handle: () =>
            Promise.reject(new Error("No predecessor effect expected")),
        }), { message: "Test pin transition requires an exact receipt" });
      deepStrictEqual(
        await native.execution.inspect(initial.identity.builderId),
        [],
      );
      deepStrictEqual(await native.checkpoints(), []);
    }
  }
  const retirements = runtime.snapshot.events.filter((event) =>
    event.kind === "evolution-empty-await-retired"
  ).map((event) => JSON.parse(event.label)).filter((receipt) =>
    receipt.threadId === old.threadId
  );
  equal(retirements.length, 1);
  equal(retirements[0].checkpointId, old.checkpointId);
  try {
    await runtime.submit("Start a genuinely new input");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() =>
            reject(
              new Error(
                "The new native run did not reach its provider within 10s",
              ),
            ), 10_000);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    const [running] = await native.execution.inspect(
      initial.identity.builderId,
    );
    ok(running);
    equal(running.status, "running");
    equal(
      running.checkpointId,
      undefined,
      "The unfinished projection has no completed native snapshot checkpoint",
    );
    equal(running.modelDigest, "adopted:2");
    notEqual(running.threadId, old.threadId);
    const checkpoint = evolutionCheckpoint(
      { ...runtime.snapshot, busy: false },
      [running],
    );
    equal(checkpoint.safe, false);
    ok(
      checkpoint.blockers.some((blocker) =>
        blocker.code === "EVOLUTION_NATIVE_EXECUTION_UNSETTLED"
      ),
    );
  } finally {
    releaseProvider();
    await native.idle();
  }
  const [next] = await native.execution.inspect(initial.identity.builderId);
  equal(next.status, "waiting");
  equal(next.modelDigest, "adopted:2");
  ok(next.checkpointId);
  equal(
    providerCalls,
    2,
    "Only the new input executes after the two adoptions",
  );
});

Deno.test("native launcher hydrates only consumed inputs and guard references across resume", async () => {
  const f = fixture(false);
  const flow = f.request.flow;
  const effect = flow.nodes.find((node) => node.id === "effect")!;
  const wait = flow.nodes.find((node) => node.id === "wait")!;
  effect.inputs = ["record"];
  wait.inputs = ["record"];
  flow.edges.find((edge) => edge.id === "effect-wait")!.guard =
    "gate.allowed == true";
  const ref = (id: string) => ({ __assemblyRuntimeRevision: { id } });
  const calls: string[] = [];
  const graph = compileNativeOperatorGraph(
    f.request.model,
    (node, inputs, values) => {
      equal((inputs.record as { allowed: boolean }).allowed, true);
      deepStrictEqual(values.unrelated, ref("unrelated"));
      calls.push(node.id);
      return Promise.resolve({});
    },
    {
      scope: f.request.identity.scope,
      operatorId: f.request.identity.operatorId,
      flow,
      maxSteps: 16,
      checkpointer: new MemorySaver(),
      assertBoundary: () => Promise.resolve(),
      onEvent: () => Promise.resolve(),
      resolveValues: (values) => {
        const resolve = (value: unknown): unknown => {
          if (!value || typeof value !== "object") return value;
          if ("__assemblyRuntimeRevision" in value) {
            const id = (value as { __assemblyRuntimeRevision: { id: string } })
              .__assemblyRuntimeRevision.id;
            if (id === "unrelated") {
              throw new Error("unrelated reference loaded");
            }
            return { allowed: id !== "deny" };
          }
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, resolve(item)]),
          );
        };
        return Promise.resolve(resolve(values) as Record<string, unknown>);
      },
    },
  );
  const config = {
    configurable: { thread_id: "selective-hydration", checkpoint_ns: "" },
  };
  const initial = {
    effect: { record: ref("input") },
    wait: { record: ref("resume") },
    gate: ref("guard"),
    unrelated: ref("unrelated"),
  };
  for await (
    const _ of await graph.graph.stream(graph.initialState(initial), {
      ...config,
      streamMode: "checkpoints",
      durability: "sync",
    })
  ) { /* drain */ }
  deepStrictEqual((await graph.graph.getState(config)).values.values, initial);
  for await (
    const _ of await graph.graph.stream(
      new Command({ resume: { contributionId: "next" } }),
      { ...config, streamMode: "checkpoints", durability: "sync" },
    )
  ) { /* drain */ }
  deepStrictEqual(calls, ["effect", "wait", "effect"]);
  await rejects(async () => {
    for await (
      const _ of await graph.graph.stream(
        graph.initialState({ ...initial, gate: ref("deny") }),
        {
          configurable: { thread_id: "selective-refusal", checkpoint_ns: "" },
          streamMode: "checkpoints",
          durability: "sync",
        },
      )
    ) { /* drain */ }
  }, /No native control branch matches/);
});

Deno.test("native recovery projects only selected durable observations after completed replay without effects or selection fences", async () => {
  const f = fixture(false);
  // Simulate process loss before the business projection: ordinary callbacks
  // deliberately retain nothing while the mandatory journal commits the trace.
  await f.native.execution.run(f.request, f.handlers);
  const next = {
    ...f.request,
    contribution: {
      id: "input-two",
      kind: "resume" as const,
      inputMessageId: "input-one",
    },
  };
  const completed = await f.native.execution.run(next, f.handlers);
  const [selected] = await f.native.checkpoints();
  const expected = selected.nativeObservations.map((
    { event, firstRecordedAt },
  ) => ({ event, firstRecordedAt }));
  ok(expected.length > 0);
  ok(
    expected.every(({ event }) => event.step > 3),
    "ancestor observations are excluded",
  );
  const recovered: unknown[] = [];
  const handlers = {
    ...f.handlers,
    recoverEvents: (events: readonly unknown[]) => {
      recovered.push(structuredClone(events));
      return Promise.resolve();
    },
    onEvent: () =>
      Promise.reject(new Error("ordinary callbacks must not replay")),
    handle: () => Promise.reject(new Error("effects must not replay")),
  };
  deepStrictEqual(await f.native.execution.run(next, handlers), completed);
  deepStrictEqual(recovered, [expected]);
  equal(f.effects(), 2);

  // Production completed sessions reject withSelectionFence when no budget
  // selection exists. Recovery is a historical projection, not a new effect.
  const session = {
    alreadyCompleted: completed,
    nativeObservations: {
      read: () => Promise.resolve(selected.nativeObservations),
    },
    withSelectionFence: () =>
      Promise.reject(new Error("Completed execution has no budget selection")),
  };
  const execution = new NativeGraphExecution(undefined, {
    open: () => Promise.resolve(session),
  } as unknown as NativeExecutionLedger);
  recovered.length = 0;
  deepStrictEqual(await execution.run(next, handlers), completed);
  deepStrictEqual(recovered, [expected]);
  equal(f.effects(), 2);
});
