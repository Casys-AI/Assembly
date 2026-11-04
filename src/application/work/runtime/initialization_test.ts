import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import { WorkBudgetService } from "../budget/service.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "../native-execution/contract.ts";
import {
  adoptBudgetCeiling,
  type BudgetCeilingAdoptionHost,
} from "./budget-transition.ts";
import {
  initialize,
  type RuntimeInitializationHost,
} from "./initialization.ts";

/** Real application intent/policy CAS and real initialization, with in-memory
 * technical stores. This is not a native checkpoint or PostgreSQL witness. */
async function interruptedPolicy(phase: "authorized-intent" | "budget-policy") {
  const previous = artifactModel("owner");
  previous.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    limit: 0,
    unit: "agent-invocation",
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "native-budget",
    sourceIds: ["native-budget"],
  };
  const target = structuredClone(previous);
  target.workBudgetPolicy!.revision = 2;
  target.workBudgetPolicy!.limit = 2;
  target.version.digest = "raised-budget-model";
  target.version.repositoryVersion = "commit:raised-budget";
  const choose = previous.flows.conversation.nodes.find((node) =>
    node.mechanism === "choose_move"
  )!;
  let stored: SystemRuntimeState = {
    id: "runtime",
    revision: 1,
    catalogRevision: 0,
    executionModel: previous,
    model: previous.identity,
    configuration: { ...previous.configuration, changes: [] },
    provider: "fixture",
    phase: "waiting",
    busy: false,
    candidates: [],
    events: [],
    cases: [],
    designer: {
      scopeId: "designer",
      budget: { budgetId: "budget", scopeId: "designer" },
    },
    caseInvocation: { kind: "designer", scopeId: "designer" },
    activeInputMessageId: "original",
    messages: [{
      id: "original",
      role: "user",
      text: "Work",
      at: "now",
      designerScopeId: "designer",
    }],
    workBudgetBinding: { budgetId: "budget", scopeId: "designer" },
    budgetSuspension: {
      nodeId: choose.id,
      operation: "decide",
      recipient: "local-control",
      reason: "exhausted",
      diagnostic: "Original exact refusal",
      attemptId: "never-dispatched",
      dispatchStarted: false,
    },
  };
  let record: WorkBudgetRecord | null = null;
  const budget = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(record)),
    save(next, expected) {
      assert.equal(expected, record?.revision ?? null);
      record = structuredClone(next);
      return Promise.resolve();
    },
  });
  await budget.adopt({
    scopeId: "designer",
    ownerId: "owner",
    policy: previous.workBudgetPolicy,
    previousPolicy: undefined,
    modelVersion: previous.version,
  });
  await assert.rejects(
    () =>
      budget.reserve({
        scopeId: "designer",
        ownerId: "owner",
        policy: previous.workBudgetPolicy,
        attemptId: "never-dispatched",
        operation: "decide",
        modelVersion: previous.version,
      }),
    /exhausted/,
  );
  const store = {
    load: () => Promise.resolve(structuredClone(stored)),
    save(next: SystemRuntimeState, expected: number | null) {
      assert.equal(expected, stored.revision);
      stored = structuredClone(next);
      return Promise.resolve();
    },
  };
  const model = {
    initialize: () => {
      throw new Error("Existing admission must not initialize source");
    },
    readExecutableModel: (
      _identity: typeof previous.identity,
      version?: string,
    ) => {
      const selected = version === previous.version.repositoryVersion
        ? previous
        : version === undefined || version === target.version.repositoryVersion
        ? target
        : undefined;
      if (!selected) throw new Error("Exact source absent");
      return Promise.resolve(structuredClone(selected));
    },
    findCandidate: () => {
      throw new Error("A frozen restart must not reconcile candidates");
    },
    activateCandidate: () => {
      throw new Error("A frozen restart must not activate");
    },
  };
  const snapshot: NativeExecutionSnapshot = {
    identity: nativeExecutionIdentity(stored, "conversation", "original"),
    contributionId: "original",
    threadId: "thread",
    runId: "run",
    checkpointId: "checkpoint",
    checkpointNamespace: "namespace",
    modelDigest: previous.version.digest,
    repositoryVersion: previous.version.repositoryVersion,
    flowRootId: previous.flows.conversation.rootNativeId,
    status: "waiting",
    waits: [{ nodeId: choose.id, mechanism: "choose_move", kind: "budget" }],
    unsettledEffects: [],
    pendingContributions: [],
    budgetContinuationSource: {
      sourceKind: "settled-budget-wait",
      occurrenceId: choose.id,
      preparedNodeId: "prepared-choose",
      settledEffectKey: "budget-refusal",
    },
  };
  const policyCAS = budget.advanceCeiling.bind(budget);
  budget.advanceCeiling = async (input) => {
    const result = await policyCAS(input);
    if (phase === "authorized-intent") {
      throw new Error("Interrupted after policy CAS");
    }
    return result;
  };
  const adoption: BudgetCeilingAdoptionHost = {
    get state() {
      return stored;
    },
    ports: {
      model,
      workBudget: budget,
      clock: { now: () => "now" },
      execution: {
        inspect: () => Promise.resolve([structuredClone(snapshot)]),
        run: () => {
          throw new Error("Adoption cannot execute");
        },
        closeScope: () => {
          throw new Error("No closure");
        },
        retireAndAdvance: () => {
          throw new Error("No retirement");
        },
      },
    },
    async update(change) {
      const next = structuredClone(stored);
      change(next);
      next.revision++;
      await store.save(next, stored.revision);
      if (
        phase === "budget-policy" &&
        next.budgetCeilingTransition?.phase === "budget-policy"
      ) {
        throw new Error("Interrupted after canonical policy receipt");
      }
    },
  };
  await assert.rejects(
    () => adoptBudgetCeiling(adoption, target),
    /Interrupted after/,
  );
  assert.equal(stored.budgetCeilingTransition!.phase, phase);
  assert.equal(record!.events.at(-1)!.kind, "policy");
  budget.advanceCeiling = policyCAS;
  const host: RuntimeInitializationHost = {
    state: structuredClone(stored),
    runtimeRecorded: false,
    stage: () => {
      throw new Error("No stage transition during frozen initialization");
    },
    ports: {
      store,
      model,
      workBudget: budget,
      agents: { label: "reopened-fixture" },
      clock: { now: () => "now" },
      caseNumbers: {
        allocate: () => {
          throw new Error("No new Case");
        },
      },
    },
    async update(change) {
      const next = structuredClone(this.state);
      change(next);
      next.revision++;
      await store.save(next, this.state.revision);
      this.state = next;
    },
  };
  return {
    host,
    previous,
    target,
    record: () => structuredClone(record!),
    stored: () => structuredClone(stored),
    mutateRecord(change: (value: WorkBudgetRecord) => void) {
      change(record!);
    },
  };
}

for (const phase of ["authorized-intent", "budget-policy"] as const) {
  Deno.test(`initialize preserves the exact ceiling suspension after linked policy CAS (${phase})`, async () => {
    const f = await interruptedPolicy(phase);
    const before = f.stored();
    const ledger = f.record();
    await initialize.call(f.host);
    const after = f.stored();
    assert.deepEqual(after.budgetSuspension, before.budgetSuspension);
    assert.deepEqual(
      after.budgetCeilingTransition,
      before.budgetCeilingTransition,
    );
    assert.deepEqual(
      after.executionModel,
      f.previous,
      "The target is not implicitly adopted",
    );
    assert.deepEqual(after.activeInputMessageId, before.activeInputMessageId);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(
      f.record(),
      ledger,
      "Initialization cannot append policy or attempt events",
    );
    assert.equal(after.workBudget!.limit, f.target.workBudgetPolicy!.limit);
    assert.equal(after.phase, "Budget : contrôle local attendu");
    assert.equal(f.host.runtimeRecorded, true);
  });
}

Deno.test("initialize refuses foreign policy events or altered ledger origins without rewriting the frozen suspension", async () => {
  for (const mutation of ["policy-event", "origin"] as const) {
    const f = await interruptedPolicy("authorized-intent");
    f.mutateRecord((record) => {
      if (mutation === "policy-event") {
        const event = record.events.at(-1)!;
        assert.equal(event.kind, "policy");
        if (event.kind === "policy") {
          event.ceilingTransitionId = "foreign-intention";
        }
      } else {
        const refusal = record.events.find((event) =>
          event.kind === "refused"
        )!;
        if (refusal.kind === "refused") refusal.attemptId = "foreign-attempt";
      }
    });
    const before = f.stored();
    await assert.rejects(
      () => initialize.call(f.host),
      /BUDGET_CEILING_CONTINUATION_REFUSED/,
    );
    assert.deepEqual(f.stored(), before);
    assert.deepEqual(f.host.state.budgetSuspension, before.budgetSuspension);
    assert.equal(f.host.runtimeRecorded, false);
  }
});
