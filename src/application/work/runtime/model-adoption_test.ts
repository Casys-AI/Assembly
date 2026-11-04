import assert from "node:assert/strict";
import {
  adopt,
  adoptModelVersion,
  isPrimaryOperator,
  type ModelAdoptionHost,
} from "./model-adoption.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "./state.ts";
import {
  WorkBudgetError,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { WorkBudgetService } from "../budget/service.ts";
import { agentCall, budgetView, type RuntimeBudgetHost } from "./budget.ts";
import {
  caseExecutionContext,
  createRequestCase,
  designerExecutionContext,
  selectDesignerInvocation,
} from "../cases/runtime.ts";

function hostWithoutRegistry(
  operator?: ExecutableModel["operator"],
): ModelAdoptionHost {
  const admitted = {
    identity: { builderId: "builder" },
    version: { digest: "admitted-digest" },
    ...(operator ? { operator } : {}),
  };
  return {
    state: { executionModel: admitted },
  } as unknown as ModelAdoptionHost;
}

function candidate(): ExecutableModel {
  return {
    identity: { builderId: "builder" },
    version: { digest: "admitted-digest" },
  } as unknown as ExecutableModel;
}

Deno.test("primary fallback without a bound registry follows the admitted endpoint", () => {
  const primary = {
    name: "Designer",
    instruction: "Design with the person.",
    primary: true,
    humanInput: true,
  };
  assert.equal(
    isPrimaryOperator.call(hostWithoutRegistry(primary), candidate()),
    true,
  );
  assert.equal(
    isPrimaryOperator.call(
      hostWithoutRegistry({ ...primary, primary: false }),
      candidate(),
    ),
    false,
  );
  assert.equal(
    isPrimaryOperator.call(hostWithoutRegistry(), candidate()),
    true,
  );
});

function budgetAdoptionFixture(kind: "request" | "designer") {
  const model = artifactModel("builder");
  model.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 2,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "budget-native",
    sourceIds: [],
  };
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: structuredClone(model),
    model: structuredClone(model.identity),
    messages: [],
    candidates: [],
    events: [],
    cases: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  const clock = { now: () => "2026-10-26T00:00:00.000Z" };
  if (kind === "request") {
    createRequestCase(state, { objective: "Fresh Request" }, clock, 1);
  } else selectDesignerInvocation(state);
  const scopeId = state.workBudgetBinding!.scopeId;
  const records = new Map<string, WorkBudgetRecord>();
  const service = new WorkBudgetService({
    load: (scopeId) =>
      Promise.resolve(structuredClone(records.get(scopeId) ?? null)),
    save(record, expectedRevision) {
      assert.equal(
        records.get(record.scopeId)?.revision ?? null,
        expectedRevision,
      );
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  const host: ModelAdoptionHost & RuntimeBudgetHost = {
    state,
    ports: {
      clock,
      caseNumbers: { allocate: () => Promise.resolve(2) },
      model: {
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
      },
      workBudget: service,
    },
    control: (action) => action(),
    update(change) {
      change(state);
      return Promise.resolve();
    },
    inspectModelVersion: () => Promise.resolve(structuredClone(model)),
    isPrimaryOperator(native) {
      return isPrimaryOperator.call(this, native);
    },
    adopt(native, changes, event, onAdopt, origin) {
      return adopt.call(this, native, changes, event, onAdopt, origin);
    },
    budgetView(native) {
      return budgetView.call(this, native);
    },
  };
  const nextVersion = () => {
    model.version.digest = "next-digest";
    model.version.repositoryVersion = "next-source";
    model.workBudgetPolicy!.revision = 2;
    model.workBudgetPolicy!.limit = 4;
  };
  const admit = () =>
    adoptModelVersion.call(host, {
      expectedDigest: model.version.digest,
      expectedVersion: model.version.repositoryVersion,
    });
  return { state, model, scopeId, records, host, nextVersion, admit };
}

for (const kind of ["request", "designer"] as const) {
  Deno.test(`fresh ${kind} adopts its initial budget before any provider call without later reinitialization`, async () => {
    const f = budgetAdoptionFixture(kind);
    const binding = structuredClone(f.state.workBudgetBinding);
    const birthPin = structuredClone(f.state.cases?.[0]?.modelPin);
    assert.equal(f.state.caseBudgetPending, true);
    assert.equal(f.records.size, 0);
    f.nextVersion();
    await f.admit();
    const initial = structuredClone(f.records.get(f.scopeId)!);
    assert.equal(initial.ownerId, "builder");
    assert.equal(initial.scopeId, f.scopeId);
    assert.equal(initial.revision, 1);
    assert.deepEqual(initial.events, [{
      kind: "policy",
      policy: f.model.workBudgetPolicy,
      modelVersion: f.model.version,
    }]);
    assert.equal(f.state.caseBudgetPending, undefined);
    assert.deepEqual(f.state.workBudgetBinding, binding);
    assert.deepEqual(f.state.cases?.[0]?.modelPin, birthPin);
    if (kind === "request") {
      assert.deepEqual(f.state.cases![0].budget, binding);
      assert.equal(f.state.cases![0].owner, "builder");
    } else assert.deepEqual(f.state.designer!.budget, binding);
    await f.host.budgetView(f.state.executionModel!);
    assert.deepEqual(f.records.get(f.scopeId), initial);
    let calls = 0;
    await agentCall.call(f.host, f.state.executionModel!, "decide", () => {
      calls++;
      return Promise.resolve("done");
    });
    assert.equal(calls, 1);
    assert.equal(f.state.workBudget?.consumed, 1);
    assert.equal(f.state.workBudget?.remaining, 3);
    assert.equal(f.records.get(f.scopeId)!.revision, 3);
    assert.equal(f.records.size, 1);
  });

  Deno.test(`started ${kind} cannot adopt after its ledger is lost`, async () => {
    const f = budgetAdoptionFixture(kind);
    await agentCall.call(
      f.host,
      f.state.executionModel!,
      "decide",
      () => Promise.resolve("done"),
    );
    assert.equal(f.state.caseBudgetPending, undefined);
    const admitted = structuredClone(f.state.executionModel);
    const binding = structuredClone(f.state.workBudgetBinding);
    f.records.delete(f.scopeId);
    f.nextVersion();
    await assert.rejects(
      f.admit,
      (error) =>
        error instanceof WorkBudgetError && error.code === "missing-state",
    );
    assert.equal(f.records.size, 0);
    assert.deepEqual(f.state.executionModel, admitted);
    assert.deepEqual(f.state.workBudgetBinding, binding);
    assert.equal(f.state.workBudget?.consumed, 1);
  });

  Deno.test(`${kind} adoption preserves settled and outstanding reservations`, async () => {
    const f = budgetAdoptionFixture(kind);
    await agentCall.call(
      f.host,
      f.state.executionModel!,
      "decide",
      () => Promise.resolve("done"),
    );
    await f.host.ports.workBudget!.reserve({
      scopeId: f.scopeId,
      ownerId: "builder",
      policy: f.model.workBudgetPolicy,
      operation: "review",
      attemptId: "pending-review",
      modelVersion: f.model.version,
    });
    const before = structuredClone(f.records.get(f.scopeId)!);
    f.nextVersion();
    await f.admit();
    const after = f.records.get(f.scopeId)!;
    assert.deepEqual(after.events.slice(0, -1), before.events);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(f.state.workBudget?.consumed, 1);
    assert.equal(f.state.workBudget?.reserved, 1);
    assert.equal(f.state.workBudget?.remaining, 2);
    await f.host.budgetView(f.state.executionModel!);
    assert.deepEqual(f.records.get(f.scopeId), after);
  });

  Deno.test(`model adoption preserves delegated ${kind} budget authority`, async () => {
    const f = budgetAdoptionFixture(kind);
    const work = {
      callerId: "owner",
      correlationId: "correlation",
      invocationId: "invocation",
      behaviorId: "behavior",
      targetNativeId: "builder",
      modelVersion: {
        digest: f.model.version.digest,
        repositoryVersion: f.model.version.repositoryVersion!,
      },
      fingerprint: "fingerprint",
      priorCandidateIds: [],
    };
    f.state.caseInvocation = kind === "request"
      ? {
        kind: "delegated",
        work: { ...work, caseContext: caseExecutionContext(f.state)! },
      }
      : {
        kind: "delegated-designer",
        work: { ...work, designerContext: designerExecutionContext(f.state)! },
      };
    const invocation = structuredClone(f.state.caseInvocation);
    const binding = structuredClone(f.state.workBudgetBinding);
    f.nextVersion();
    await f.admit();
    assert.equal(f.records.size, 0);
    assert.deepEqual(f.state.caseInvocation, invocation);
    assert.deepEqual(f.state.workBudgetBinding, binding);
    assert.equal(f.state.caseBudgetPending, true);
  });
}

Deno.test("fresh budget initialization still requires the exact model pin", async () => {
  const f = budgetAdoptionFixture("request");
  f.nextVersion();
  await assert.rejects(
    () =>
      adoptModelVersion.call(f.host, {
        expectedDigest: f.model.version.digest,
        expectedVersion: "stale-source",
      }),
    /La version du modèle a changé/,
  );
  assert.equal(f.records.size, 0);
  assert.equal(f.state.caseBudgetPending, true);
});

Deno.test("model activation is persisted with its pin and independent of dialogue", async () => {
  const f = budgetAdoptionFixture("request");
  const caseId = f.state.cases![0].id;
  const original = structuredClone(f.state.executionModel!);
  const committed: SystemRuntimeState[] = [];
  f.host.update = (change) => {
    change(f.state);
    committed.push(structuredClone(f.state));
    return Promise.resolve();
  };
  f.nextVersion();
  await f.host.adopt(f.model);
  const event = f.state.events.find((event) => event.effectiveModelUpdate)!;
  assert.equal(event.kind, "effective-model-updated");
  assert.equal(event.effectiveModelUpdate!.caseId, caseId);
  assert.equal(event.effectiveModelUpdate!.designerScopeId, undefined);
  assert.equal(event.effectiveModelUpdate!.kind, "model");
  assert.equal(
    event.effectiveModelUpdate!.from.digest,
    original.version.digest,
  );
  assert.equal(event.effectiveModelUpdate!.to.digest, f.model.version.digest);
  assert.equal(
    event.effectiveModelUpdate!.activatedAt,
    f.host.ports.clock.now(),
  );
  assert.deepEqual(f.state.messages, []);
  const activationCommit = committed.find((state) =>
    state.events.some((entry) => entry.id === event.id)
  )!;
  assert.equal(
    activationCommit.executionModel!.version.digest,
    event.effectiveModelUpdate!.to.digest,
  );
  await f.admit();
  assert.equal(
    f.state.events.filter((event) => event.effectiveModelUpdate).length,
    1,
  );
});

Deno.test("failed admission creates no effective model update", async () => {
  const f = budgetAdoptionFixture("request");
  await agentCall.call(
    f.host,
    f.state.executionModel!,
    "decide",
    () => Promise.resolve("done"),
  );
  f.records.clear();
  f.nextVersion();
  await assert.rejects(f.admit, WorkBudgetError);
  assert.equal(
    f.state.events.some((event) => event.effectiveModelUpdate),
    false,
  );
});

Deno.test("delegated activation keeps its exact origin Case and local designer stays explicitly scoped", async () => {
  for (const kind of ["request", "designer"] as const) {
    const f = budgetAdoptionFixture(kind);
    const caseContext = caseExecutionContext(f.state);
    const designerContext = designerExecutionContext(f.state);
    const work = {
      callerId: "coordinator",
      correlationId: "correlation",
      invocationId: "invocation",
      behaviorId: "behavior",
      targetNativeId: "builder",
      modelVersion: {
        digest: f.model.version.digest,
        repositoryVersion: f.model.version.repositoryVersion!,
      },
      fingerprint: "fingerprint",
      priorCandidateIds: [],
    };
    f.state.caseInvocation = caseContext
      ? { kind: "delegated", work: { ...work, caseContext } }
      : {
        kind: "delegated-designer",
        work: { ...work, designerContext: designerContext! },
      };
    f.nextVersion();
    await f.host.adopt(f.model);
    const update = f.state.events.find((e) => e.effectiveModelUpdate)!
      .effectiveModelUpdate!;
    assert.equal(update.caseId, caseContext?.caseId);
    assert.equal(update.designerScopeId, designerContext?.scopeId);
  }
});

Deno.test("a later repeated A to B activation is retained while retries remain silent", async () => {
  const f = budgetAdoptionFixture("designer");
  const originalDigest = f.model.version.digest;
  for (const digest of ["new-digest", originalDigest, "new-digest"]) {
    f.model.version.digest = digest;
    await adopt.call(f.host, f.model);
    await adopt.call(f.host, f.model);
  }
  const updates = f.state.events.flatMap((event) =>
    event.effectiveModelUpdate ? [event.effectiveModelUpdate] : []
  );
  assert.equal(updates.length, 3);
  assert.equal(new Set(updates.map((update) => update.id)).size, 3);
  assert.deepEqual(
    updates.map((update) => [update.from.digest, update.to.digest]),
    [
      [originalDigest, "new-digest"],
      ["new-digest", originalDigest],
      [originalDigest, "new-digest"],
    ],
  );
});

Deno.test("trusted publication origin overrides an unrelated currently selected designer", async () => {
  const f = budgetAdoptionFixture("designer");
  f.nextVersion();
  await adopt.call(f.host, f.model, undefined, undefined, undefined, {
    caseId: "closed-origin-case",
    dossierId: "dossier",
    actorId: "coordinator",
  });
  const update = f.state.events.find((e) => e.effectiveModelUpdate)!
    .effectiveModelUpdate!;
  assert.equal(update.caseId, "closed-origin-case");
  assert.equal(update.designerScopeId, undefined);
  assert.equal(update.dossierId, "dossier");
  assert.equal(update.actorId, "coordinator");
});

Deno.test("an idle activation never infers a Case or designer from historical state", async () => {
  const f = budgetAdoptionFixture("request");
  f.state.cases![0].status = "closed-done";
  delete f.state.caseInvocation;
  f.state.designer = { scopeId: "historical-designer" };
  f.nextVersion();
  await f.admit();
  const update = f.state.events.find((e) => e.effectiveModelUpdate)!
    .effectiveModelUpdate!;
  assert.equal(update.caseId, undefined);
  assert.equal(update.designerScopeId, undefined);
});

Deno.test("owner Model API adoption stays unscoped despite a retained selected conversation", async () => {
  for (const kind of ["request", "designer"] as const) {
    const f = budgetAdoptionFixture(kind);
    const selected = structuredClone(f.state.caseInvocation);
    assert.ok(selected);
    f.nextVersion();
    await f.admit();
    const event = f.state.events.find((event) => event.effectiveModelUpdate)!;
    assert.equal(event.effectiveModelUpdate!.caseId, undefined);
    assert.equal(event.effectiveModelUpdate!.designerScopeId, undefined);
    assert.equal(event.caseId, undefined);
    assert.equal(event.effectiveModelUpdate!.to.digest, f.model.version.digest);
    assert.deepEqual(f.state.caseInvocation, selected);
  }
});

Deno.test("adoption supersedes stale pending proposals with a receipt and frees re-proposal", async () => {
  const { executableFixture } = await import(
    "../../../../test/support/execution-fixture.ts"
  );
  const { SystemGovernance } = await import(
    "../../../domain/governance/policies/governance.ts"
  );
  const admitted = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  admitted.version.repositoryVersion = "source-1";
  const governance = SystemGovernance.fromExecutable(admitted);
  const proposed = governance.propose(
    {
      kind: "propose_mandate_change",
      text: "Request one host.",
      reason: "Exact network extension",
      requestedRights: { addNetworkHosts: ["recovery.example"] },
    },
    "stale-change",
    "2026-10-28T00:00:00.000Z",
    { requestedBy: "builder", designerScopeId: "scope" },
  );
  const state = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: structuredClone(admitted),
    model: structuredClone(admitted.identity),
    configuration: {
      ...structuredClone(admitted.configuration),
      changes: [structuredClone(proposed)],
    },
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
    changeDecisionContinuations: { "stale-change": "pending" },
  } as unknown as SystemRuntimeState;
  const host = {
    state,
    ports: {
      clock: { now: () => "2026-10-28T00:00:00.000Z" },
      caseNumbers: { allocate: () => Promise.resolve(1) },
      model: { readExecutableModel: () => Promise.resolve(admitted) },
    },
    update: (change: (s: SystemRuntimeState) => void) => {
      change(state);
      return Promise.resolve();
    },
    isPrimaryOperator: () => true,
  } as unknown as ModelAdoptionHost;
  const native = structuredClone(admitted);
  native.version.digest = "advanced-digest";
  native.version.repositoryVersion = "source-2";
  native.configuration.revision++;
  await adopt.call(host, native);
  assert.equal(state.configuration!.changes[0].status, "superseded");
  const receipts = state.events.filter((event) =>
    event.kind === "configuration-change-superseded"
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].changeId, "stale-change");
  assert.equal(
    state.changeDecisionContinuations?.["stale-change"],
    undefined,
  );
  const reread = SystemGovernance.fromExecutable(
    state.executionModel!,
    state.configuration!.changes,
  );
  assert.equal(
    reread.propose(
      {
        kind: "propose_mandate_change",
        text: "Request one host.",
        reason: "Exact network extension",
        requestedRights: { addNetworkHosts: ["recovery.example"] },
      },
      "fresh-change",
      "2026-10-28T00:00:00.000Z",
      { requestedBy: "builder", designerScopeId: "scope" },
    ).status,
    "pending",
  );
});

Deno.test("ordinary adoption checks the durable pin gate inside serialized control before authority or source reads", async () => {
  let enteredControl = false, sourceReads = 0;
  const gate = new Error("EVOLUTION_BARRIER");
  const host = {
    state: { executionModel: candidate(), events: [] },
    control: async (action: () => Promise<void>) => {
      enteredControl = true;
      await action();
    },
    assertPinAdmission: () => {
      assert.equal(enteredControl, true);
      return Promise.reject(gate);
    },
    ports: {
      model: {
        readExecutableModel: () => {
          sourceReads++;
          return Promise.resolve(candidate());
        },
      },
    },
  } as unknown as ModelAdoptionHost;
  await assert.rejects(
    () =>
      adoptModelVersion.call(host, {
        expectedDigest: "candidate",
        expectedVersion: "published",
      }),
    (error: unknown) => error === gate,
  );
  assert.equal(sourceReads, 0);
});

Deno.test("foreign pin adoption preserves an actual parked promotion and permits the same transition only after settlement", async () => {
  const f = budgetAdoptionFixture("designer");
  const admitted = f.state.executionModel!;
  const promotion:
    import("../native-execution/contract.ts").NativeExecutionSnapshot = {
      identity: {
        operatorId: admitted.identity.builderId,
        invocationKey: "designer",
        scope: {
          kind: "designer",
          scopeId: f.state.designer!.scopeId,
          ownerId: admitted.identity.builderId,
        },
        purpose: "promotion",
        subjectId: "candidate",
      },
      threadId: "promotion-thread",
      contributionId: "input",
      modelDigest: admitted.version.digest,
      repositoryVersion: admitted.version.repositoryVersion,
      flowRootId: admitted.flows.promotion.rootNativeId,
      checkpointId: "retained-admission",
      status: "waiting",
      waits: [{
        nodeId: "admission",
        kind: "decision",
        mechanism: "decide_admission",
      }],
      unsettledEffects: [],
      pendingContributions: [],
    };
  f.host.ports.execution = {
    inspect: (operatorId) => {
      assert.equal(
        operatorId,
        admitted.identity.builderId,
        "The current owner must be inspected before a target can replace its identity",
      );
      return Promise.resolve([structuredClone(promotion)]);
    },
    run: () => Promise.reject(new Error("Adoption cannot run a promotion")),
    closeScope: () =>
      Promise.reject(new Error("Adoption cannot close the promotion")),
    retireAndAdvance: () =>
      Promise.reject(new Error("Adoption cannot migrate the promotion")),
  };
  const before = structuredClone(f.state), native = structuredClone(promotion);
  f.nextVersion();
  await assert.rejects(() => f.host.adopt(f.model), {
    message:
      "A native promotion checkpoint still depends on its previous admitted source pin",
  });
  assert.deepEqual(f.state, before);
  assert.deepEqual(promotion, native);
  assert.equal(
    f.records.size,
    0,
    "A refused adoption cannot mutate a budget ledger",
  );
  const ownerId = f.model.identity.builderId;
  f.model.identity.builderId = "foreign-target-owner";
  await assert.rejects(() => f.host.adopt(f.model), {
    message:
      "A native promotion checkpoint still depends on its previous admitted source pin",
  });
  assert.deepEqual(f.state, before);
  assert.deepEqual(promotion, native);
  assert.equal(f.records.size, 0);
  f.model.identity.builderId = ownerId;
  promotion.status = "completed";
  promotion.waits = [];
  await f.host.adopt(f.model);
  assert.equal(f.state.executionModel!.version.digest, f.model.version.digest);
  assert.equal(promotion.checkpointId, native.checkpointId);
});
