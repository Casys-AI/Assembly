import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { isOpenCase } from "../../src/domain/work/entities/cases.ts";
import { invocationKey } from "../../src/application/work/operators/journal.ts";
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
} from "../../src/application/work/runtime/ports.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../src/domain/work/policies/budget.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";

/** Only external ports are scripted: promotion, runtime and budget accounting
 * below are the production components. */
async function fixture(
  options: {
    budget?: boolean;
    budgetLimit?: number;
    reviewFails?: boolean;
    humanAdmission?: boolean;
    replyToRequests?: boolean;
  } = {},
) {
  const identity = {
    projectId: "initialization-project",
    rootId: "initialization-root",
    editingContextId: "initialization-context",
    systemId: "initialization-system",
    catalogId: "initialization-catalog",
    builderId: "builder",
    reviewerId: options.humanAdmission ? undefined : "reviewer",
  };
  const native = executableFixture(
    identity,
    options.humanAdmission
      ? SystemGovernance.fresh("human-initialization").snapshot
      : SystemGovernance.importLegacy("reviewed-initialization", "reviewer")
        .snapshot,
  );
  native.version.repositoryVersion = "initialization-source";
  native.initialTools = [{
    id: "initial-reader",
    nativeId: "initial-reader-selection",
    sourceIds: ["initial-reader-selection"],
    draft: {
      name: "initial-reader",
      description: "Selected reader that follows the ordinary promotion flow",
      kind: "read_web_page",
      code: "export default ({html}) => ({title:'Page',text:html})",
    },
  }];
  if (options.budget) {
    native.workBudgetPolicy = {
      id: "initialization-budget",
      revision: 1,
      unit: "agent-invocation",
      limit: options.budgetLimit ?? 3,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
      elementId: "initialization-budget-native",
      sourceIds: [],
    };
  }
  let persisted: SystemRuntimeState | null = null;
  let duringReview: SystemRuntimeState | undefined;
  let duringActivation: SystemRuntimeState | undefined;
  let duringAllocation: SystemRuntimeState | undefined;
  let reviewCalls = 0;
  let activationFails = false;
  let activationAttempts = 0;
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (scopeId) =>
      Promise.resolve(structuredClone(records.get(scopeId) ?? null)),
    save(record, expected) {
      equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(persisted)),
    save(next, expected) {
      equal(persisted?.revision ?? null, expected);
      persisted = structuredClone(next);
      if (
        !duringAllocation &&
        Object.keys(next.initialToolsPreparations ?? {}).length
      ) {
        duringAllocation = structuredClone(next);
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const forbidden = () => {
    throw new Error("Unexpected action during initial preparation");
  };
  const model: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(native)),
    applyApprovedChange: forbidden,
    activateCandidate(_identity, candidate) {
      activationAttempts++;
      duringActivation = structuredClone(persisted!);
      if (activationFails) {
        throw new Error("Transient native activation failure");
      }
      const binding = {
        elementId: `native-${candidate.id}`,
        graphPath: `catalog/${candidate.id}`,
      };
      native.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: `contract-${candidate.kind}`,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      return Promise.resolve(binding);
    },
    graph: () => Promise.resolve({}),
  };
  const agents: AgentPort = {
    label: "reviewed initialization",
    decide: options.replyToRequests
      ? () => Promise.resolve({ kind: "reply", text: "ok" })
      : forbidden,
    review(candidate) {
      reviewCalls++;
      duringReview = structuredClone(persisted!);
      if (options.reviewFails) throw new Error("Reviewer unavailable");
      return Promise.resolve({
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Exact selected candidate reviewed",
      });
    },
  };
  const retained = createTestNativeExecution(store);
  const open = async () => {
    const runtime = new SystemRuntime({
      model,
      agents,
      store: retained.store,
      execution: retained.execution,
      dispatch: retained.dispatch,
      stateHistory: retained.stateHistory,
      artifactSources: retained.artifactSources,
      workBudget: budget,
      runner: {
        test: () =>
          Promise.resolve({
            passed: true,
            checks: [{
              name: "reader",
              passed: true,
              detail: "Selected bytes tested",
            }],
          }),
        run: forbidden,
      },
    });
    await runtime.initialize();
    const controlIdle = runtime.idle.bind(runtime);
    const native = retained;
    native.bind(runtime);
    runtime.idle = async () => {
      await controlIdle();
      await native.idle();
      await controlIdle();
    };
    return runtime;
  };
  return {
    native,
    records,
    retained,
    open,
    runtime: await open(),
    get duringReview() {
      return duringReview;
    },
    get duringActivation() {
      return duringActivation;
    },
    get duringAllocation() {
      return duringAllocation;
    },
    setActivationFailure(value: boolean) {
      activationFails = value;
    },
    get activationAttempts() {
      return activationAttempts;
    },
    get reviewCalls() {
      return reviewCalls;
    },
  };
}

Deno.test("initial tools without a budget execute the reviewer inside a system-opened Request", async () => {
  const f = await fixture();
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  equal(f.reviewCalls, 1);
  equal(f.runtime.snapshot.candidates[0].stage, "active");
  equal(f.runtime.snapshot.budgetSuspension, undefined);
  const cases = f.runtime.cases.cases;
  equal(cases.length, 1);
  const initial = cases[0];
  equal(initial.type, "request");
  equal(initial.openedBy, f.native.identity.systemId);
  equal(initial.objective, "Prepare the initial tools");
  deepStrictEqual(initial.openedFrom, {
    conversationId: f.runtime.snapshot.id,
    origin: "initialization",
  });
  equal(initial.status, "closed-done");
  ok(initial.closedAt);
  equal(
    f.duringReview!.cases?.find((entry) => entry.id === initial.id)?.status,
    "open",
  );
  equal(f.records.size, 0);
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const restarted = await f.open();
  await restarted.prepareInitialTools();
  await restarted.idle();
  deepStrictEqual(restarted.cases.cases, cases);
  equal(f.reviewCalls, 1);
});

Deno.test("initial review consumes its own Case budget through the real budget service", async () => {
  const f = await fixture({ budget: true });
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  if (f.reviewCalls !== 1) {
    const state = f.runtime.snapshot;
    const intent = Object.values(state.initialToolsPreparations ?? {})[0];
    const accepted = intent && await f.retained.dispatch.inspectAccepted!(
      "builder",
      intent.key,
    );
    equal(
      f.reviewCalls,
      1,
      JSON.stringify({
        suspension: state.budgetSuspension,
        binding: state.workBudgetBinding,
        initialAdoptionPending: state.caseBudgetPending,
        invocation: state.caseInvocation,
        case: state.cases?.find((record) => record.id === intent?.caseId),
        preparation: intent,
        receipt: accepted?.receipt,
        budgets: [...f.records.values()].map((record) => ({
          scopeId: record.scopeId,
          revision: record.revision,
          events: record.events.map((event) => event.kind),
          view: budgetState(record).view,
        })),
        native: (await f.retained.execution.inspect("builder")).map((
          execution,
        ) => ({
          identity: execution.identity,
          status: execution.status,
          checkpointId: execution.checkpointId,
          waits: execution.waits,
          unsettledEffects: execution.unsettledEffects,
        })),
      }),
    );
  }
  equal(f.runtime.snapshot.candidates[0].stage, "active");
  const initial = f.runtime.cases.cases[0];
  equal(initial.status, "closed-done");
  equal(initial.budget?.scopeId, initial.id);
  notEqual(initial.budget?.scopeId, f.runtime.snapshot.id);
  equal(f.records.size, 1);
  const record = f.records.get(initial.id)!;
  ok(record);
  deepStrictEqual(
    record.events.filter((event) => event.kind === "reserve").map((event) =>
      event.operation
    ),
    ["review"],
  );
  equal(budgetState(record).view.consumed, 1);
  equal(budgetState(record).view.reserved, 0);
  const paid = structuredClone(record);
  const intent = Object.values(f.runtime.snapshot.initialToolsPreparations!)[0];
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const reopened = await f.open();
  await reopened.prepareInitialTools();
  await reopened.idle();
  deepStrictEqual(f.records.get(initial.id), paid);
  deepStrictEqual(
    await f.retained.dispatch.inspectAccepted!("builder", intent.key),
    accepted,
  );
  equal(f.reviewCalls, 1);
  equal(f.activationAttempts, 1);
  equal(reopened.snapshot.candidates[0].stage, "active");
  equal(reopened.snapshot.caseBudgetPending, undefined);
});

Deno.test("initial budget adoption is parked for its newborn Case while another Request remains selected", async () => {
  const f = await fixture({ budget: true, replyToRequests: true });
  await f.runtime.submit(
    "Keep this Request selected",
    undefined,
    undefined,
    true,
  );
  await f.runtime.idle();
  const selected = f.runtime.snapshot;
  const request = f.runtime.cases.cases[0];
  equal(selected.caseInvocation?.kind, "local");
  equal(selected.caseBudgetPending, undefined);
  const requestBudget = structuredClone(f.records.get(request.id)!);
  ok(requestBudget);
  equal(budgetState(requestBudget).view.consumed, 1);
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const allocation = f.duringAllocation!;
  ok(allocation);
  const intent = Object.values(allocation.initialToolsPreparations!)[0];
  const initial = allocation.cases!.find((record) =>
    record.id === intent.caseId
  )!;
  deepStrictEqual(allocation.caseInvocation, selected.caseInvocation);
  deepStrictEqual(allocation.workBudgetBinding, selected.workBudgetBinding);
  equal(
    allocation.caseBudgetPending,
    undefined,
    "A's birth never authorizes initial adoption for selected B",
  );
  const parked = allocation
    .invocationContinuations![
      invocationKey({ kind: "local", caseId: initial.id })
    ];
  deepStrictEqual(parked.invocation, { kind: "local", caseId: initial.id });
  equal(parked.caseBudgetPending, true);
  deepStrictEqual(parked.workBudgetBinding, initial.budget);
  notEqual(initial.id, request.id);
  const review = f.duringReview!;
  deepStrictEqual(review.caseInvocation, parked.invocation);
  equal(
    review.caseBudgetPending,
    undefined,
    "the actual budget service consumed A's birth marker before review",
  );
  equal(review.workBudgetBinding?.scopeId, initial.id);
  equal(f.reviewCalls, 1);
  equal(f.activationAttempts, 1);
  deepStrictEqual(f.runtime.snapshot.caseInvocation, selected.caseInvocation);
  deepStrictEqual(
    f.runtime.snapshot.workBudgetBinding,
    selected.workBudgetBinding,
  );
  equal(f.runtime.snapshot.caseBudgetPending, undefined);
  deepStrictEqual(f.records.get(request.id), requestBudget);
  const initialBudget = structuredClone(f.records.get(initial.id)!);
  equal(budgetState(initialBudget).view.consumed, 1);
  equal(budgetState(initialBudget).view.reserved, 0);
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const reopened = await f.open();
  await reopened.prepareInitialTools();
  await reopened.idle();
  deepStrictEqual(f.records.get(request.id), requestBudget);
  deepStrictEqual(f.records.get(initial.id), initialBudget);
  equal(f.reviewCalls, 1);
  equal(f.activationAttempts, 1);
  equal(f.records.size, 2);
});

Deno.test("initial reviewer failure closes the initialization Case as abandoned", async () => {
  const f = await fixture({ reviewFails: true });
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  equal(f.reviewCalls, 1);
  equal(f.runtime.snapshot.candidates[0].stage, "failed");
  equal(f.runtime.cases.cases[0].status, "closed-abandoned");
  ok(f.runtime.cases.cases[0].closedAt);
});

Deno.test("restart retains the terminal preparation receipt without replaying a failed reviewer", async () => {
  const f = await fixture({ reviewFails: true });
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const intent = Object.values(f.runtime.snapshot.initialToolsPreparations!)[0];
  equal(intent.phase, "terminal");
  equal(intent.terminal?.outcome, "abandoned");
  const closed = f.runtime.cases.cases[0];
  equal(closed.status, "closed-abandoned");
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  equal(accepted.receipt.status, "completed");
  const frames = await f.retained.checkpoints();
  const restarted = await f.open();
  await restarted.prepareInitialTools();
  await restarted.idle();
  deepStrictEqual(restarted.cases.cases, [closed]);
  deepStrictEqual(
    restarted.snapshot.initialToolsPreparations![intent.key],
    intent,
  );
  equal(restarted.snapshot.candidates[0].stage, "failed");
  deepStrictEqual(
    await f.retained.dispatch.inspectAccepted!("builder", intent.key),
    accepted,
  );
  deepStrictEqual(await f.retained.checkpoints(), frames);
  equal(f.reviewCalls, 1);
  equal(f.activationAttempts, 0);
  equal(f.native.catalog.length, 0);
});

Deno.test("an unknown initial activation preserves its open Case, admission and native command across restart", async () => {
  const f = await fixture();
  f.setActivationFailure(true);
  await f.runtime.prepareInitialTools();
  await rejects(() => f.runtime.idle(), /Transient native activation failure/);
  const admitted = f.runtime.snapshot.candidates[0]!;
  const intent = Object.values(f.runtime.snapshot.initialToolsPreparations!)[0];
  const initial = f.runtime.cases.cases[0]!;
  equal(initial.id, intent.caseId);
  ok(isOpenCase(initial));
  equal(initial.closedAt, undefined);
  equal(initial.openedBy, f.native.identity.systemId);
  equal(initial.openedFrom.origin, "initialization");
  equal(intent.phase, "pending");
  equal(admitted.caseId, initial.id);
  equal(admitted.stage, "activating");
  equal(admitted.activationModelDigest, f.native.version.digest);
  equal(admitted.admission?.candidateId, admitted.id);
  equal(admitted.admission?.candidateDigest, admitted.digest);
  equal(admitted.admission?.authority, "reviewer");
  equal(admitted.tests?.passed, true);
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  equal(accepted.receipt.status, "failed");
  const frames = await f.retained.checkpoints();
  const executions = await f.retained.execution.inspect("builder");
  ok(
    executions.some((execution) =>
      execution.status === "uncertain" && execution.unsettledEffects.length
    ),
  );
  f.setActivationFailure(false);
  const restarted = await f.open();
  await restarted.prepareInitialTools();
  await restarted.idle();
  deepStrictEqual(restarted.cases.cases, [initial]);
  deepStrictEqual(
    restarted.snapshot.initialToolsPreparations![intent.key],
    intent,
  );
  deepStrictEqual(
    restarted.snapshot.candidates[0]!.admission,
    admitted.admission,
  );
  equal(
    restarted.snapshot.candidates[0]!.activationModelDigest,
    admitted.activationModelDigest,
  );
  equal(restarted.snapshot.candidates[0]!.activationAttempts, 1);
  equal(restarted.snapshot.candidates[0]!.stage, "activating");
  equal(restarted.snapshot.catalogRevision, 0);
  equal(f.native.catalog.length, 0);
  equal(f.reviewCalls, 1);
  equal(f.activationAttempts, 1);
  deepStrictEqual(
    await f.retained.dispatch.inspectAccepted!("builder", intent.key),
    accepted,
  );
  deepStrictEqual(await f.retained.checkpoints(), frames);
  deepStrictEqual(await f.retained.execution.inspect("builder"), executions);
});

Deno.test("a retained activation receipt completes the same initial preparation after a lost worker acknowledgement", async () => {
  const f = await fixture();
  let interrupted = false;
  f.retained.effectBoundary((boundary) => {
    if (
      !interrupted && boundary.phase === "after-receipt" &&
      boundary.node.mechanism === "activate_candidate"
    ) {
      interrupted = true;
      throw new Error("Interrupted after the native activation receipt");
    }
  });
  await f.runtime.prepareInitialTools();
  await rejects(() => f.runtime.idle(), /after the native activation receipt/);
  equal(interrupted, true);
  const active = f.runtime.snapshot.candidates[0]!;
  equal(active.stage, "active");
  equal(active.admission?.authority, "reviewer");
  const intent = Object.values(f.runtime.snapshot.initialToolsPreparations!)[0];
  equal(intent.phase, "pending");
  ok(isOpenCase(f.runtime.cases.cases[0]));
  equal(f.runtime.cases.cases[0].closedAt, undefined);
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  equal(accepted.receipt.status, "failed");
  const frames = await f.retained.checkpoints();
  const promotion = frames.find((frame) =>
    frame.request.identity.purpose === "promotion"
  )!;
  ok(
    promotion.effects.some((effect) =>
      effect.node.mechanism === "activate_candidate" && effect.settled
    ),
  );
  deepStrictEqual(promotion.effects.filter((effect) => !effect.settled), []);
  const restarted = await f.open();
  await f.retained.retryFailed();
  await restarted.idle();
  const completed = restarted.snapshot.initialToolsPreparations![intent.key];
  equal(completed.caseId, intent.caseId);
  equal(completed.key, intent.key);
  equal(completed.revision, intent.revision);
  equal(completed.phase, "terminal");
  equal(completed.terminal?.outcome, "done");
  equal(restarted.cases.cases.length, 1);
  equal(restarted.cases.cases[0].status, "closed-done");
  deepStrictEqual(
    restarted.snapshot.candidates[0]!.admission,
    active.admission,
  );
  equal(
    restarted.snapshot.candidates[0]!.binding?.elementId,
    active.binding?.elementId,
  );
  const acknowledged = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(acknowledged);
  equal(acknowledged.receipt.jobId, accepted.receipt.jobId);
  equal(acknowledged.receipt.status, "completed");
  equal(f.activationAttempts, 1);
  equal(f.reviewCalls, 1);
  equal(f.native.catalog.length, 1);
  equal(restarted.snapshot.catalogRevision, 1);
});

Deno.test("the operator registry admits an exact initial candidate after its preparation Case closed", async () => {
  const f = await fixture({ humanAdmission: true });
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const candidate = f.runtime.snapshot.candidates[0];
  equal(candidate.stage, "awaiting-admission");
  const preparation = f.runtime.cases.cases[0];
  equal(preparation.status, "closed-done");
  const registry = new OperatorConversations({
    primary: f.runtime,
    factory: { open: () => Promise.resolve(f.runtime) },
  });
  f.runtime.bindOperatorRegistry(registry);
  await registry.initialize({
    repositoryVersion: f.native.version.repositoryVersion!,
    units: [{ systemQualifiedName: "System::builder", model: f.native }],
  });
  try {
    await registry.decideCandidate({
      agentId: f.native.identity.builderId,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      expectedRevision: f.runtime.snapshot.revision,
      verdict: "approve",
      reason: "Admit the tested selected bytes explicitly",
    });
    await f.runtime.idle();
    equal(f.runtime.snapshot.candidates[0].stage, "active");
    equal(f.runtime.snapshot.candidates[0].admission?.authority, "human");
    equal(f.runtime.cases.cases.length, 2);
    equal(f.runtime.cases.cases[1].status, "closed-done");
    notEqual(f.runtime.cases.cases[1].id, preparation.id);
    deepStrictEqual(f.runtime.cases.cases[0], preparation);
    equal(f.reviewCalls, 0);
  } finally {
    await registry.dispose();
  }
});

Deno.test("restart preserves a budget-suspended initial review in its exact open Case", async () => {
  const f = await fixture({ budget: true, budgetLimit: 0 });
  await f.runtime.prepareInitialTools();
  await f.runtime.idle();
  const waiting = f.runtime.snapshot;
  const candidate = waiting.candidates[0];
  const initial = f.runtime.cases.cases[0];
  const intent = Object.values(waiting.initialToolsPreparations!)[0];
  ok(isOpenCase(initial));
  equal(initial.closedAt, undefined);
  equal(candidate.caseId, initial.id);
  equal(candidate.stage, "reviewing");
  equal(candidate.admission, undefined);
  equal(candidate.binding, undefined);
  ok(candidate.promotionExecution);
  equal(waiting.budgetSuspension?.candidateId, candidate.id);
  equal(waiting.budgetPromotionCandidateId, candidate.id);
  equal(waiting.caseInvocation?.kind, "local");
  equal(intent.caseId, initial.id);
  equal(intent.phase, "pending");
  equal(initial.budget?.scopeId, initial.id);
  notEqual(initial.budget?.scopeId, waiting.id);
  const budget = structuredClone(f.records.get(initial.id)!);
  ok(budget);
  equal(budgetState(budget).view.consumed, 0);
  equal(budgetState(budget).view.reserved, 0);
  const frames = await f.retained.checkpoints();
  const executions = await f.retained.execution.inspect("builder");
  const promotion = executions.find((execution) =>
    execution.identity.purpose === "promotion" &&
    execution.identity.subjectId === candidate.promotionExecution!.subjectId
  )!;
  equal(promotion.status, "waiting");
  ok(promotion.checkpointId);
  ok(promotion.waits.some((wait) => wait.kind === "budget"));
  deepStrictEqual(promotion.unsettledEffects, []);
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  equal(accepted.receipt.status, "completed");
  const restarted = await f.open();
  await restarted.prepareInitialTools();
  await restarted.idle();
  equal(restarted.cases.cases[0].status, initial.status);
  ok(isOpenCase(restarted.cases.cases[0]));
  equal(restarted.cases.cases[0].closedAt, undefined);
  equal(restarted.cases.cases[0].id, initial.id);
  deepStrictEqual(
    restarted.snapshot.initialToolsPreparations![intent.key],
    intent,
  );
  deepStrictEqual(restarted.snapshot.candidates[0], candidate);
  deepStrictEqual(
    restarted.snapshot.budgetSuspension,
    waiting.budgetSuspension,
  );
  equal(restarted.snapshot.budgetPromotionCandidateId, candidate.id);
  deepStrictEqual(f.records.get(initial.id), budget);
  deepStrictEqual(
    await f.retained.dispatch.inspectAccepted!("builder", intent.key),
    accepted,
  );
  deepStrictEqual(await f.retained.checkpoints(), frames);
  deepStrictEqual(await f.retained.execution.inspect("builder"), executions);
  equal(f.native.catalog.length, 0);
  equal(f.reviewCalls, 0);
  equal(f.activationAttempts, 0);
});
