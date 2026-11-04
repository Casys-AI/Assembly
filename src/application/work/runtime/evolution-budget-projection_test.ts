import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import { WorkBudgetService } from "../budget/service.ts";
import { evolutionCheckpoint } from "./evolution.ts";
import {
  createRequestCase,
  selectDesignerInvocation,
} from "../cases/runtime.ts";
import { projectEvolutionBudgets } from "./evolution-budget-projection.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "../native-execution/contract.ts";

async function fixture() {
  const model = artifactModel("owner");
  model.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 8,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "budget",
    sourceIds: [],
  };
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (scope) =>
      Promise.resolve(structuredClone(records.get(scope) ?? null)),
    save: (record, expected) => {
      assert.equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  for (const scopeId of ["designer", "request"]) {
    await budget.adopt({
      scopeId,
      ownerId: "owner",
      policy: model.workBudgetPolicy,
      previousPolicy: undefined,
      modelVersion: model.version,
    });
  }
  const designer =
    (await budget.snapshot("designer", "owner", model.workBudgetPolicy))!;
  const request =
    (await budget.snapshot("request", "owner", model.workBudgetPolicy))!;
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 1,
    catalogRevision: 0,
    provider: "test",
    phase: "ready",
    busy: false,
    executionModel: model,
    configuration: { ...model.configuration, changes: [] },
    candidates: [],
    events: [],
    messages: [],
    designer: {
      scopeId: "designer",
      budget: { scopeId: "designer", budgetId: "budget" },
    },
    caseInvocation: { kind: "designer", scopeId: "designer" },
    workBudget: designer,
    workBudgetBinding: { scopeId: "designer", budgetId: "budget" },
    cases: [{
      id: "request",
      number: 1,
      owner: "owner",
      openedBy: "owner",
      type: "request",
      objective: "test",
      modelPin: { digest: model.version.digest },
      status: "open",
      createdAt: "now",
      openedFrom: { conversationId: "runtime" },
      budget: { scopeId: "request", budgetId: "budget" },
    }],
    invocationContinuations: {
      parked: {
        invocation: { kind: "local", caseId: "request" },
        workBudget: request,
        workBudgetBinding: { scopeId: "request", budgetId: "budget" },
      },
    },
  };
  const reserve = (scopeId: string, attemptId: string) =>
    budget.reserve({
      scopeId,
      ownerId: "owner",
      policy: model.workBudgetPolicy,
      operation: "decide",
      attemptId,
      modelVersion: model.version,
    });
  return { state, model, budget, records, reserve };
}

Deno.test("evolution projects every real ledger and preserves all non-budget barriers", async () => {
  const f = await fixture();
  await f.reserve("designer", "first");
  f.state.workBudget =
    (await f.budget.snapshot("designer", "owner", f.model.workBudgetPolicy))!;
  await f.budget.settle({
    scopeId: "designer",
    ownerId: "owner",
    attemptId: "first",
    outcome: "returned",
  });
  await f.reserve("request", "second");
  const before = structuredClone(f.state);
  const projected = await projectEvolutionBudgets(f.state, f.budget);
  assert.equal(projected.state.workBudget!.reserved, 0);
  assert.equal(
    projected.state.invocationContinuations!.parked.workBudget!.reserved,
    1,
  );
  assert.deepEqual(projected.reserved.map((scope) => scope.scopeId), [
    "request",
  ]);
  assert.deepEqual(f.state, before, "projection never mutates canonical state");
  await f.budget.settle({
    scopeId: "request",
    ownerId: "owner",
    attemptId: "second",
    outcome: "returned",
  });
  const settled = await projectEvolutionBudgets(f.state, f.budget);
  assert.equal(settled.reserved.length, 0);
  assert.equal(
    settled.state.invocationContinuations!.parked.workBudget!.reserved,
    0,
  );
  settled.state.budgetSuspension = {
    nodeId: "budget",
    operation: "decide",
    recipient: "local-control",
    reason: "exhausted",
    diagnostic: "retained",
    dispatchStarted: false,
  };
  const execution: NativeExecutionSnapshot = {
    identity: {
      operatorId: "owner",
      invocationKey: "designer",
      scope: { kind: "designer", scopeId: "designer", ownerId: "owner" },
      purpose: "conversation",
    },
    contributionId: "input",
    threadId: "thread",
    modelDigest: f.model.version.digest,
    flowRootId: "flow",
    status: "uncertain",
    waits: [],
    unsettledEffects: ["unknown"],
    pendingContributions: [],
  };
  const blockers = evolutionCheckpoint(settled.state, [execution]).blockers.map(
    (item) => item.code,
  );
  assert(blockers.includes("EVOLUTION_BUDGET_UNSETTLED"));
  assert(blockers.includes("EVOLUTION_NATIVE_EXECUTION_UNSETTLED"));
  const foreign = structuredClone(f.records.get("request")!);
  foreign.ownerId = "other-owner";
  f.records.set("request", foreign);
  await assert.rejects(
    () => projectEvolutionBudgets(f.state, f.budget),
    /owner|unavailable/i,
  );
  f.records.set("request", { ...foreign, ownerId: "owner" });
  const wrongPolicy = structuredClone(f.state);
  wrongPolicy.executionModel!.workBudgetPolicy!.id = "other-budget";
  await assert.rejects(
    () => projectEvolutionBudgets(wrongPolicy, f.budget),
    /policy|unproven/i,
  );
  f.records.delete("request");
  await assert.rejects(
    () => projectEvolutionBudgets(f.state, f.budget),
    /missing|unavailable/i,
  );
});

Deno.test("the reserved runtime boundary CAS saves the actual budget projection", async () => {
  const f = await fixture();
  const { SystemRuntime } = await import(
    "../../../../test/support/system-runtime.ts"
  );
  const { unexpectedModelAuthoring } = await import(
    "../../../../test/support/model-authoring.ts"
  );
  let saved: SystemRuntimeState | null = structuredClone(f.state);
  delete saved.invocationContinuations;
  const writes: Array<{ expected: number | null; revision: number }> = [];
  const runtime = new SystemRuntime({
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save: (state, expected) => {
        assert.equal(saved?.revision ?? null, expected);
        writes.push({ expected, revision: state.revision });
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(f.model.identity),
      readExecutableModel: () => Promise.resolve(structuredClone(f.model)),
      graph: () => Promise.resolve({}),
      applyApprovedChange: () => {
        throw new Error("Unexpected mutation");
      },
      activateCandidate: () => {
        throw new Error("Unexpected activation");
      },
    },
    workBudget: f.budget,
    agents: {
      label: "budget-boundary",
      decide: () => {
        throw new Error("Unexpected provider");
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
        throw new Error("Unexpected tool");
      },
    },
  });
  await runtime.initialize();
  assert.equal(runtime.snapshot.workBudget!.reserved, 0);
  await f.reserve("designer", "boundary-attempt");
  const first = await runtime.withEvolutionReservation(
    "dossier",
    () => runtime.evolutionBoundary("dossier"),
  );
  assert.equal(first.safe, false);
  assert(
    first.blockers.some((item) => item.code === "EVOLUTION_BUDGET_UNSETTLED"),
  );
  assert.equal(runtime.snapshot.workBudget!.reserved, 1);
  await f.budget.settle({
    scopeId: "designer",
    ownerId: "owner",
    attemptId: "boundary-attempt",
    outcome: "returned",
  });
  const priorRevision = runtime.snapshot.revision;
  const second = await runtime.withEvolutionReservation(
    "dossier",
    () => runtime.evolutionBoundary("dossier"),
  );
  assert.equal(second.safe, true, JSON.stringify(second.blockers));
  assert.equal(runtime.snapshot.workBudget!.reserved, 0);
  assert.equal(saved!.workBudget!.reserved, 0);
  assert.deepEqual(writes.at(-1), {
    expected: priorRevision,
    revision: priorRevision + 1,
  });
});

Deno.test("an explicitly unbudgeted delegated scope requires no invented ledger", async () => {
  const f = await fixture();
  const common = {
    correlationId: "correlation",
    callerId: "caller",
    invocationId: "invocation",
    behaviorId: "behavior",
    targetNativeId: "target",
    modelVersion: {
      digest: "caller-pin",
      repositoryVersion: "commit:caller-pin",
    },
    fingerprint: "fingerprint",
    priorCandidateIds: [],
  };
  f.state.invocationContinuations!.delegated = {
    invocation: {
      kind: "delegated",
      work: {
        ...common,
        caseContext: {
          caseId: "external-request",
          modelPin: { digest: "caller-pin" },
        },
      },
    },
  };
  f.state.invocationContinuations!.delegatedDesigner = {
    invocation: {
      kind: "delegated-designer",
      work: {
        ...common,
        designerContext: {
          scopeId: "external-designer",
          ownerId: "external-owner",
        },
      },
    },
  };
  const observed: string[] = [];
  const policyFor = (scope: { scopeId: string }) => {
    observed.push(scope.scopeId);
    return [f.model.workBudgetPolicy!];
  };
  const projected = await projectEvolutionBudgets(f.state, f.budget, policyFor);
  assert.equal(projected.reserved.length, 0);
  assert(!observed.includes("external-request"));
  assert(!observed.includes("external-designer"));
  assert.deepEqual(
    projected.state.invocationContinuations!.delegated.invocation,
    f.state.invocationContinuations!.delegated.invocation,
  );
  const bound = structuredClone(f.state);
  bound.invocationContinuations!.delegated.workBudgetBinding = {
    scopeId: "external-request",
    budgetId: "budget",
  };
  await assert.rejects(
    () => projectEvolutionBudgets(bound, f.budget, policyFor),
    /unavailable|missing/i,
  );
  const policyCaptured = structuredClone(f.state);
  const invocation =
    policyCaptured.invocationContinuations!.delegatedDesigner.invocation;
  assert.equal(invocation.kind, "delegated-designer");
  if (invocation.kind !== "delegated-designer") {
    throw new Error("Expected delegated designer");
  }
  invocation.work.designerContext.policy = f.model.workBudgetPolicy;
  await assert.rejects(
    () => projectEvolutionBudgets(policyCaptured, f.budget, policyFor),
    /unavailable|missing/i,
  );
});

Deno.test("evolution permits only the exact pending local scope without creating its initial ledger", async () => {
  for (const kind of ["request", "designer"] as const) {
    const f = await fixture();
    if (kind === "request") {
      createRequestCase(
        f.state,
        {
          id: "pending-request",
          objective: "A declared read refused before the first agent call",
        },
        { now: () => "2026-10-29T00:00:00.000Z" },
        2,
      );
    } else {
      delete f.state.designer;
      delete f.state.caseInvocation;
      delete f.state.workBudget;
      delete f.state.workBudgetBinding;
      selectDesignerInvocation(f.state);
    }
    const scopeId = f.state.workBudgetBinding!.scopeId;
    assert.equal(f.state.caseBudgetPending, true);
    assert.equal(f.state.workBudget, undefined);
    assert.equal(f.records.has(scopeId), false);
    const before = structuredClone(f.state);
    const records = structuredClone([...f.records]);
    const projected = await projectEvolutionBudgets(f.state, f.budget);
    assert.equal(projected.reserved.length, 0);
    assert.equal(projected.state.caseBudgetPending, true);
    assert.equal(projected.state.workBudget, undefined);
    assert.deepEqual(
      projected.state.workBudgetBinding,
      before.workBudgetBinding,
    );
    assert.deepEqual(f.state, before);
    assert.deepEqual(
      [...f.records],
      records,
      "projection never adopts a ledger",
    );
    const unknown: NativeExecutionSnapshot = {
      identity: nativeExecutionIdentity(
        projected.state,
        "conversation",
        "input",
      ),
      contributionId: "input",
      threadId: "unknown",
      modelDigest: f.model.version.digest,
      flowRootId: f.model.flows.conversation.rootNativeId,
      status: "uncertain",
      waits: [],
      unsettledEffects: ["unknown"],
      pendingContributions: [],
    };
    assert(
      evolutionCheckpoint(projected.state, [unknown]).blockers.some((blocker) =>
        blocker.code === "EVOLUTION_NATIVE_EXECUTION_UNSETTLED"
      ),
    );

    const invalid = [
      (state: SystemRuntimeState) => {
        delete state.caseBudgetPending;
      },
      (state: SystemRuntimeState) => {
        state.workBudgetBinding!.budgetId = "foreign-budget";
      },
      (state: SystemRuntimeState) => {
        state.caseInvocation = { kind: "local", caseId: "request" };
      },
      (state: SystemRuntimeState) => {
        state.invocationContinuations!.started = {
          invocation: structuredClone(state.caseInvocation!),
          workBudgetBinding: structuredClone(state.workBudgetBinding!),
        };
      },
      (state: SystemRuntimeState) => {
        state.workBudget = {
          ...f.state.invocationContinuations!.parked.workBudget!,
          scopeId,
        };
      },
    ];
    for (const change of invalid) {
      const unproven = structuredClone(before);
      change(unproven);
      await assert.rejects(
        () => projectEvolutionBudgets(unproven, f.budget),
        /unavailable|unproven/i,
      );
    }
    // readRecord uses the same missing-state code for a foreign owner. Its
    // policy snapshot must distinguish that conflict from an absent row.
    await f.budget.adopt({
      scopeId,
      ownerId: "foreign-owner",
      policy: f.model.workBudgetPolicy,
      previousPolicy: undefined,
      modelVersion: f.model.version,
    });
    await assert.rejects(
      () => projectEvolutionBudgets(before, f.budget),
      /owner differs/i,
    );
  }
});

Deno.test("a pending marker cannot hide an existing reserved ledger or a retained suspension", async () => {
  const f = await fixture();
  createRequestCase(
    f.state,
    {
      id: "pending-request",
      objective: "Interrupted after the initial ledger adoption",
    },
    { now: () => "2026-10-29T00:00:00.000Z" },
    2,
  );
  await f.budget.adopt({
    scopeId: "pending-request",
    ownerId: "owner",
    policy: f.model.workBudgetPolicy,
    previousPolicy: undefined,
    modelVersion: f.model.version,
  });
  await f.reserve("pending-request", "pending-reserved");
  f.state.budgetSuspension = {
    nodeId: "retained",
    operation: "decide",
    recipient: "local-control",
    reason: "unavailable",
    diagnostic: "Must remain a blocker",
    dispatchStarted: true,
  };
  const records = structuredClone([...f.records]);
  const projected = await projectEvolutionBudgets(f.state, f.budget);
  assert.equal(projected.state.workBudget!.reserved, 1);
  assert.deepEqual(projected.reserved.map((scope) => scope.scopeId), [
    "pending-request",
  ]);
  assert.deepEqual(projected.state.budgetSuspension, f.state.budgetSuspension);
  assert.deepEqual([...f.records], records);
  assert(
    evolutionCheckpoint(projected.state).blockers.some((blocker) =>
      blocker.code === "EVOLUTION_BUDGET_UNSETTLED"
    ),
  );
});

Deno.test("an old pinned flow pre-provider refusal permits exact source-read adoption before the initial Case budget starts", async () => {
  const { SystemRuntime } = await import(
    "../../../../test/support/system-runtime.ts"
  );
  const { createTestNativeExecution } = await import(
    "../../../../test/support/native-execution.ts"
  );
  const { enableCommandFixtureProfile } = await import(
    "../../../../test/support/execution-fixture.ts"
  );
  const { unexpectedModelAuthoring } = await import(
    "../../../../test/support/model-authoring.ts"
  );
  const model = artifactModel("future-owner");
  enableCommandFixtureProfile(model, { legacyDeclaredConsultation: true });
  model.policy.mayProposeSysmlRevision = false;
  model.workBudgetPolicy = {
    id: "initial-case-budget",
    elementId: "initial-case-budget",
    sourceIds: [],
    revision: 1,
    unit: "agent-invocation",
    limit: 4,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  let saved: SystemRuntimeState | null = null;
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (scope) =>
      Promise.resolve(structuredClone(records.get(scope) ?? null)),
    save: (record, expected) => {
      assert.equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state, expected) => {
      assert.equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  }, budget);
  let observed = structuredClone(model);
  let providerCalls = 0;
  const forbidden = () => {
    throw new Error("Unexpected external effect");
  };
  const runtime = new SystemRuntime({
    store: native.store,
    execution: native.execution,
    stateHistory: native.stateHistory,
    dispatch: native.dispatch,
    workBudget: budget,
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(model.identity),
      readExecutableModel: (_identity, version) =>
        Promise.resolve(
          structuredClone(
            version === model.version.repositoryVersion ? model : observed,
          ),
        ),
      applyApprovedChange: forbidden,
      activateCandidate: forbidden,
      graph: () => Promise.resolve({}),
    },
    information: {
      read: () => Promise.resolve({ memoryGuidance: [] }),
      consultAdmittedModelSource: forbidden,
    },
    agents: {
      label: "pre-provider-refusal",
      decide: () => {
        providerCalls++;
        return forbidden();
      },
      review: forbidden,
    },
    runner: { test: forbidden, run: forbidden },
  });
  await runtime.initialize();
  native.bind(runtime);
  const requestId = await runtime.submit(
    "Read the declared source",
    undefined,
    undefined,
    true,
  );
  await native.idle();
  assert(requestId);
  const before = runtime.snapshot;
  assert.equal(before.caseInvocation?.kind, "local");
  assert.equal(before.caseBudgetPending, true);
  assert.equal(before.workBudgetBinding?.scopeId, requestId);
  assert.equal(before.workBudget, undefined);
  assert.equal(records.size, 0);
  assert.equal(providerCalls, 0);
  const [refused] = await native.execution.inspect(model.identity.builderId);
  assert.equal(refused.status, "waiting");
  assert.deepEqual(refused.unsettledEffects, []);
  assert.equal(
    (refused.localState?.declaredConsultationRefusal as { code?: string })
      ?.code,
    "MODEL_CONSULTATION_REFUSED",
  );
  const [checkpoint] = await native.checkpoints();
  assert(checkpoint.checkpointId);
  assert.equal(checkpoint.checkpointId, refused.checkpointId);
  assert.equal(checkpoint.runId, refused.runId);
  assert.deepEqual(checkpoint.request.model.version, model.version);
  observed = structuredClone(model);
  observed.policy.mayProposeSysmlRevision = true;
  observed.version.digest = "source-read-separately-granted";
  observed.version.repositoryVersion = "commit:source-read-separately-granted";
  await runtime.adoptModelVersion({
    expectedDigest: observed.version.digest,
    expectedVersion: observed.version.repositoryVersion,
  });
  assert.equal(
    runtime.snapshot.executionModel!.version.digest,
    observed.version.digest,
  );
  assert.equal(runtime.snapshot.caseBudgetPending, undefined);
  assert.equal(providerCalls, 0, "adoption never dispatches a provider call");
  assert.deepEqual(runtime.snapshot.messages, before.messages);
  assert.equal(records.size, 1);
  const record = await budget.readRecord(requestId, model.identity.builderId);
  assert.equal(record.events.length, 1);
  assert.equal(record.events[0].kind, "policy");
  assert.equal(runtime.snapshot.workBudget!.consumed, 0);
  assert.equal(runtime.snapshot.workBudget!.reserved, 0);
  const retirements = runtime.snapshot.events.filter((event) =>
    event.kind === "evolution-empty-await-retired"
  ).map((event) => JSON.parse(event.label));
  assert.deepEqual(retirements, [{
    dossierId:
      `owner-adoption:${observed.version.digest}:${observed.version.repositoryVersion}`,
    threadId: refused.threadId,
    checkpointId: checkpoint.checkpointId,
    contributionId: refused.contributionId,
    inputMessageId: refused.identity.subjectId,
    repositoryVersion: model.version.repositoryVersion,
    invocation: refused.identity.invocationKey,
    scope: refused.identity.scope,
    modelDigest: model.version.digest,
    flow: refused.flowRootId,
  }]);
  // Adoption selects an empty binding; a later accepted input owns its run.
  assert.deepEqual(
    await native.execution.inspect(model.identity.builderId),
    [],
  );
  assert.deepEqual(await native.checkpoints(), []);
});
