import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import {
  createTestNativeExecution,
  nativeCaseFixtureModel,
} from "../support/native-execution.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../src/domain/work/policies/budget.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import {
  type OperatorCommandOrigin,
  OperatorCommandPending,
} from "../../src/application/work/operators/command-delivery.ts";
import { runtimeRevisionReference } from "../../src/application/work/runtime/execution.ts";
import {
  caseExecutionContext,
  delegatedCaseContext,
} from "../../src/application/work/cases/runtime.ts";
import {
  invocationInput,
  recordedOperatorWork,
  workReceipt,
} from "../../src/application/work/operators/journal.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";

/** Real execution, registry and reservation service; only external ports are doubles. */
async function fixture(
  limit: number | undefined,
  workerLimit?: number,
  secondWorker = false,
) {
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (scope) =>
      Promise.resolve(structuredClone(records.get(scope) ?? null)),
    save: (record, expected) => {
      equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  function operator(id: string, ceiling?: number) {
    // Unified Case/WorkPlan fixture composition (memory host): the same
    // builder feeds the PostgreSQL host in legacy-plan-cases_test.ts.
    const model = nativeCaseFixtureModel(id, {
      admissionAuthority: "human",
      primary: id === "central",
      budgetLimit: ceiling,
    });
    let saved: SystemRuntimeState | null = null;
    let answer: (context: ChatContext) => Promise<ChatDecision> = () =>
      Promise.resolve({ kind: "reply", text: "Précise le résultat" });
    const contexts: ChatContext[] = [];
    let tests = 0, publications = 0;
    const hooks: {
      failCatalog?: boolean;
      interruptActivation?: "before-publication" | "after-publication";
      readingCatalog?: () => Promise<void>;
    } = {};
    const forbidden = () => {
      throw new Error("Unexpected external effect");
    };
    const versions = new Map([[
      model.version.repositoryVersion,
      structuredClone(model),
    ]]);
    const execution = createTestNativeExecution({
      load: () => Promise.resolve(structuredClone(saved)),
      save: (state, expected) => {
        equal(saved?.revision ?? null, expected);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    }, budget);
    const create = () => {
      const runtime = new SystemRuntime({
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(structuredClone(model.identity)),
          readExecutableModel: async (_identity, version) => {
            await hooks.readingCatalog?.();
            if (hooks.failCatalog) throw new Error("Catalog unavailable");
            versions.set(
              model.version.repositoryVersion,
              structuredClone(model),
            );
            const retained = version === undefined
              ? model
              : versions.get(version);
            ok(retained, "The exact fixture source must be retained");
            return structuredClone(retained);
          },
          applyApprovedChange: forbidden,
          activateCandidate: (_identity, candidate) => {
            publications++;
            if (hooks.interruptActivation === "before-publication") {
              hooks.failCatalog = true;
              throw new Error("Publication interrupted");
            }
            const binding = {
              elementId: `native-${candidate.id}`,
              graphPath: "fixture",
            };
            model.catalog.push({
              nativeId: binding.elementId,
              candidateId: candidate.id,
              contractId: model.contracts[0].nativeId,
              name: candidate.name,
              kind: candidate.kind,
              digest: candidate.digest,
              status: "active",
            });
            if (hooks.interruptActivation === "after-publication") {
              hooks.failCatalog = true;
              throw new Error("Publication acknowledgement interrupted");
            }
            return Promise.resolve(binding);
          },
          graph: () => Promise.resolve({}),
        },
        workBudget: budget,
        store: execution.store,
        execution: execution.execution,
        dispatch: execution.dispatch,
        stateHistory: execution.stateHistory,
        agents: {
          label: "test",
          decide: (context) => {
            contexts.push(structuredClone(context));
            return answer(context);
          },
          review: forbidden,
        },
        runner: {
          run: forbidden,
          test: () => {
            tests++;
            return Promise.resolve({ passed: true, checks: [] });
          },
        },
      });
      const initialize = runtime.initialize.bind(runtime);
      const localIdle = runtime.idle.bind(runtime);
      runtime.initialize = async (...args) => {
        await initialize(...args);
        execution.bind(runtime);
        runtime.idle = async () => {
          await localIdle();
          await execution.idle();
          await localIdle();
        };
      };
      return runtime;
    };
    return {
      model,
      create,
      execution,
      contexts,
      hooks,
      tests: () => tests,
      publications: () => publications,
      answer: (next: ChatDecision | typeof answer) => {
        answer = typeof next === "function"
          ? next
          : () => Promise.resolve(next);
      },
    };
  }
  const central = operator("central", limit);
  const worker = operator("worker", workerLimit);
  const workerTwo = secondWorker
    ? operator("worker-two", workerLimit)
    : undefined;
  central.model.behaviors = [worker, ...(workerTwo ? [workerTwo] : [])].map((
    unit,
  ) => ({
    id: `${unit.model.identity.builderId}-access`,
    name: "Delegate",
    description: "Native worker inbox",
    callerNativeId: "central",
    targetNativeId: unit.model.flows.conversation.rootNativeId,
    targetTypeId: "inbox-type",
    inputTypeId: "work-input",
    inputSchema: { type: "object" },
    sourceIds: [],
  }));
  const owner = central.create();
  let specialist = worker.create();
  let specialistTwo = workerTwo?.create();
  await owner.initialize();
  await specialist.initialize();
  await specialistTwo?.initialize();
  const unit = (model: ExecutableModel) => ({
    systemQualifiedName: `System::${model.identity.builderId}`,
    model,
  });
  async function registry() {
    const manager = new OperatorConversations({
      primary: owner,
      factory: {
        open: (unit) =>
          Promise.resolve(
            unit.model.identity.builderId === "worker-two"
              ? specialistTwo!
              : specialist,
          ),
      },
    });
    await manager.initialize({
      repositoryVersion: owner.snapshot.executionModel!.version
        .repositoryVersion!,
      units: [
        unit(owner.snapshot.executionModel!),
        unit(specialist.snapshot.executionModel!),
        ...(specialistTwo
          ? [unit(specialistTwo.snapshot.executionModel!)]
          : []),
      ],
    });
    owner.bindOperatorRegistry(manager);
    specialist.bindOperatorRegistry(manager);
    specialistTwo?.bindOperatorRegistry(manager);
    return manager;
  }
  let manager = await registry();
  let sequence = 0;
  // Cross-operator wakeups cascade worker -> owner -> worker; one concurrent
  // manager.idle() can exit before a peer enqueues the next exact delivery.
  async function settle() {
    for (let pass = 0; pass < 10; pass++) {
      const before = [owner, specialist, specialistTwo].map((runtime) =>
        runtime?.snapshot.revision
      );
      await manager.idle();
      const after = [owner, specialist, specialistTwo].map((runtime) =>
        runtime?.snapshot.revision
      );
      if (before.every((value, index) => value === after[index])) return;
    }
    throw new Error("Fixture deliveries did not settle");
  }
  return {
    central,
    worker,
    workerTwo,
    owner,
    records,
    budget,
    get specialist() {
      return specialist;
    },
    get specialistTwo() {
      return specialistTwo;
    },
    get manager() {
      return manager;
    },
    async restartWorker() {
      await manager.dispose();
      specialist = worker.create();
      await specialist.initialize();
      // Resumed continuations are durable deliveries: let them re-park at
      // their exact wait before the successor accepts new work.
      await specialist.idle();
      specialistTwo = workerTwo?.create();
      await specialistTwo?.initialize();
      await specialistTwo?.idle();
      manager = await registry();
      // Registry refresh enqueues exact continuation wakeups on owners;
      // settle them before the successor observes budgets or pins.
      await settle();
    },
    settle,
    async delegate(text: string, agentId = "worker") {
      const model = owner.snapshot.executionModel!;
      const context = caseExecutionContext(owner.snapshot)!;
      const submitted = await manager.submitWork(
        agentId,
        text,
        `task-${++sequence}`,
        {
          callerId: "central",
          invocationId: `invoke-${sequence}`,
          behavior: model.behaviors!.find((behavior) =>
            behavior.id === `${agentId}-access`
          )!,
          modelVersion: {
            digest: model.version.digest,
            repositoryVersion: model.version.repositoryVersion!,
          },
          caseId: context.caseId,
          caseContext: context,
        },
      );
      // Durable dispatch accepts first and executes in the worker; settle the
      // exact contribution before reading candidate/Case state.
      await settle();
      return submitted;
    },
    async human(text: string, caseId?: string) {
      const submitted = await manager.submitHuman({
        agentId: "worker",
        expectedRevision: specialist.snapshot.revision,
        text,
        ...(caseId !== undefined ? { caseId } : { newConversation: true }),
      });
      await settle();
      return submitted;
    },
    async raise(ceiling: number) {
      central.model.workBudgetPolicy!.limit = ceiling;
      central.model.workBudgetPolicy!.revision++;
      central.model.version.digest = `central-budget-${ceiling}`;
      central.model.version.repositoryVersion =
        `source:central-budget-${ceiling}`;
      await owner.adoptModelVersion({
        expectedDigest: central.model.version.digest,
      });
    },
  };
}

async function turn(runtime: SystemRuntime, text: string, caseId?: string) {
  await runtime.submit(
    text,
    undefined,
    caseId,
    caseId === undefined ? true : undefined,
  );
  await runtime.idle();
}

function proposal(name: string): ChatDecision {
  return {
    kind: "propose_tool",
    text: `Prepare ${name}`,
    tool: {
      name,
      description: "Read supplied HTML",
      kind: "read_web_page",
      code: "export default ({html}) => ({title:'Page',text:html})",
    },
  };
}

Deno.test("abandonment settles exact durable contributions at two operators and preserves another Request and its admitted tool", async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    await turn(f.owner, "Request A");
    const requestA = f.owner.cases.cases[0];
    f.worker.answer(proposal("reader-a"));
    f.workerTwo!.answer(proposal("second-reader-a"));
    await f.delegate("Prepare A");
    await f.delegate("Also prepare A", "worker-two");
    const firstA = f.specialist.snapshot.candidates[0];
    const secondA = f.specialistTwo!.snapshot.candidates[0];
    equal(firstA.stage, "awaiting-admission");
    equal(secondA.stage, "awaiting-admission");
    await f.restartWorker();
    equal(f.specialist.snapshot.candidates[0].caseId, requestA.id);
    equal(f.specialistTwo!.snapshot.candidates[0].caseId, requestA.id);

    await turn(f.owner, "Request B");
    const requestB = f.owner.cases.cases[1];
    f.worker.answer(proposal("active-reader-b"));
    await f.delegate("Prepare B's admitted reader");
    const admitted = f.specialist.snapshot.candidates[1];
    f.worker.answer({ kind: "reply", text: "B's reader is ready" });
    await f.manager.decideCandidate({
      agentId: "worker",
      expectedRevision: f.specialist.snapshot.revision,
      candidateId: admitted.id,
      candidateDigest: admitted.digest,
      verdict: "approve",
      reason: "Reviewed exact reader for B",
    });
    await f.manager.idle();
    f.worker.answer(proposal("pending-reader-b"));
    await f.delegate("Prepare B's pending reader");
    const before = f.specialist.snapshot;
    const otherCandidates = before.candidates.filter((candidate) =>
      candidate.caseId === requestB.id
    );
    equal(otherCandidates[0].stage, "active");
    equal(otherCandidates[1].stage, "awaiting-admission");
    const calls = [f.worker.contexts.length, f.workerTwo!.contexts.length];
    const publications = f.worker.publications();
    const catalog = structuredClone(f.worker.model.catalog);
    const registered = f.manager.snapshot.conversations.map((entry) =>
      entry.agentId
    );

    await f.owner.closeCase(requestA.id, "abandoned");
    equal(f.owner.cases.cases[0].status, "closed-abandoned");
    equal(f.owner.cases.cases[1].status, requestB.status);
    for (const runtime of [f.specialist, f.specialistTwo!]) {
      const candidate = runtime.snapshot.candidates.find((entry) =>
        entry.caseId === requestA.id
      )!;
      equal(candidate.stage, "failed");
      equal(candidate.error, "Case abandoned");
      equal(candidate.promotionCursor, undefined);
      equal(candidate.promotionContext, undefined);
      equal(candidate.admissionContinuation, undefined);
    }
    deepStrictEqual(
      f.specialist.snapshot.candidates.filter((candidate) =>
        candidate.caseId === requestB.id
      ),
      otherCandidates,
    );
    deepStrictEqual(
      f.specialist.snapshot.caseInvocation,
      before.caseInvocation,
    );
    deepStrictEqual(
      f.specialist.snapshot.conversationCursor,
      before.conversationCursor,
    );
    deepStrictEqual(f.worker.model.catalog, catalog);
    deepStrictEqual(
      f.manager.snapshot.conversations.map((entry) => entry.agentId),
      registered,
    );
    await rejects(() => f.owner.closeCase(requestA.id, "abandoned"), {
      code: "CASE_CLOSED",
    });
    await f.restartWorker();
    await f.manager.resumeCandidateContinuations();
    await f.manager.idle();
    await f.manager.resumeCandidateContinuations();
    await f.manager.idle();
    equal(f.specialist.snapshot.candidates[0].stage, "failed");
    equal(f.specialistTwo!.snapshot.candidates[0].stage, "failed");
    deepStrictEqual(
      [f.worker.contexts.length, f.workerTwo!.contexts.length],
      calls,
    );
    equal(f.worker.publications(), publications);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a contributor busy on another Request refuses abandonment before settling any contributor", async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    await turn(f.owner, "Request A");
    const requestA = f.owner.cases.cases[0];
    f.worker.answer(proposal("reader-a"));
    f.workerTwo!.answer(proposal("second-reader-a"));
    await f.delegate("Prepare A");
    await f.delegate("Also prepare A", "worker-two");
    const before = [
      f.specialist.snapshot.candidates,
      f.specialistTwo!.snapshot.candidates,
    ];
    await turn(f.owner, "Request B");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.workerTwo!.answer(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "reply", text: "B complete" };
    });
    const work = f.delegate("Contribute to B", "worker-two");
    await entered.promise;
    try {
      await rejects(() => f.owner.closeCase(requestA.id, "abandoned"), {
        code: "AGENT_BUSY",
      });
      deepStrictEqual(
        [
          f.specialist.snapshot.candidates,
          f.specialistTwo!.snapshot.candidates,
        ],
        before,
      );
      equal(f.owner.cases.cases[0].status, requestA.status);
      equal(
        f.owner.snapshot.events.filter((event) =>
          event.kind === "case-closed" && event.caseId === requestA.id
        ).length,
        0,
      );
    } finally {
      release.resolve();
    }
    await work;
    await f.owner.closeCase(requestA.id, "abandoned");
    equal(f.owner.cases.cases[0].status, "closed-abandoned");
  } finally {
    await f.manager.dispose();
  }
});

for (
  const interruption of ["before-publication", "after-publication"] as const
) {
  Deno.test(`abandonment preserves ${interruption} outcome and never repeats an unknown publication`, async () => {
    const f = await fixture(undefined);
    try {
      await turn(f.owner, "Request A");
      const requestA = f.owner.cases.cases[0];
      f.worker.answer(proposal("reader-a"));
      await f.delegate("Prepare A");
      const candidate = f.specialist.snapshot.candidates[0];
      f.worker.answer({ kind: "reply", text: "Reader ready" });
      f.worker.hooks.interruptActivation = interruption;
      // Acceptance commits only the durable command; the worker-side
      // publication failure surfaces when the exact delivery is drained.
      await f.manager.decideCandidate({
        agentId: "worker",
        expectedRevision: f.specialist.snapshot.revision,
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Reviewed exact reader",
      });
      await rejects(() => f.manager.idle(), /Publication.*interrupted/);
      const interrupted = f.specialist.snapshot.candidates[0];
      const unknown = (await f.worker.execution.execution.inspect("worker"))
        .find((snapshot) =>
          snapshot.identity.purpose === "promotion" &&
          snapshot.identity.subjectId ===
            candidate.promotionExecution?.subjectId
        );
      ok(unknown?.checkpointId);
      equal(unknown.status, "uncertain");
      equal(unknown.unsettledEffects.length, 1);
      ok(f.specialist.snapshot.candidates[0].activationModelDigest);
      const calls = f.worker.contexts.length;
      const publications = f.worker.publications();
      await rejects(
        () => f.owner.closeCase(requestA.id, "abandoned"),
        /Catalog unavailable/,
      );
      equal(f.owner.cases.cases[0].status, requestA.status);
      ok(f.specialist.snapshot.candidates[0].activationModelDigest);
      equal(
        f.owner.snapshot.events.filter((event) =>
          event.kind === "case-closed" && event.caseId === requestA.id
        ).length,
        0,
      );

      f.worker.hooks.failCatalog = false;
      delete f.worker.hooks.interruptActivation;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.worker.hooks.readingCatalog = async () => {
        entered.resolve();
        await release.promise;
      };
      const closing = f.owner.closeCase(requestA.id, "abandoned");
      const closed = interruption === "before-publication"
        ? rejects(() => closing, /native activation effect is unresolved/)
        : closing;
      await entered.promise;
      try {
        await f.manager.resumeCandidateContinuations();
        await rejects(() => f.delegate("Do not resume during abandonment"), {
          code: "AGENT_BUSY",
        });
        await rejects(() =>
          f.specialist.settleDelegatedCandidateActivations({
            caseId: requestA.id,
            abandon: true,
          }), { code: "AGENT_BUSY" });
        equal(f.worker.publications(), publications);
        equal(f.worker.contexts.length, calls);
      } finally {
        release.resolve();
      }
      await closed;
      await f.manager.idle();
      delete f.worker.hooks.readingCatalog;
      const settled = f.specialist.snapshot.candidates[0];
      equal(
        settled.stage,
        interruption === "after-publication" ? "active" : "activating",
      );
      if (interruption === "after-publication") {
        equal(settled.activationModelDigest, undefined);
        equal(settled.admissionContinuation, undefined);
      } else {
        ok(settled.activationModelDigest);
        deepStrictEqual(
          settled.admissionContinuation,
          interrupted.admissionContinuation,
        );
      }
      deepStrictEqual(settled.admission?.candidateId, candidate.id);
      equal(
        f.owner.cases.cases[0].status,
        interruption === "after-publication"
          ? "closed-abandoned"
          : requestA.status,
      );
      await f.restartWorker();
      await f.manager.resumeCandidateContinuations();
      await f.manager.idle();
      await f.manager.resumeCandidateContinuations();
      await f.manager.idle();
      equal(f.specialist.snapshot.candidates[0].stage, settled.stage);
      equal(
        f.worker.model.catalog.length,
        interruption === "after-publication" ? 1 : 0,
      );
      equal(f.worker.publications(), publications);
      equal(f.worker.contexts.length, calls);
      deepStrictEqual(
        (await f.worker.execution.execution.inspect("worker")).find((
          snapshot,
        ) => snapshot.threadId === unknown.threadId),
        unknown,
      );
    } finally {
      await f.manager.dispose();
    }
  });
}

Deno.test("a fresh delegated Case discards the abandoned Case's suspended cursor and decision inputs", async () => {
  const f = await fixture(1);
  try {
    await turn(f.owner, "Case one");
    const first = f.owner.cases.cases[0];
    await f.delegate("Objective from Case one");
    equal(f.specialist.snapshot.budgetSuspension?.reason, "exhausted");
    // The suspended cursor now lives in the framework checkpoint, not in
    // canonical state; the durable budget suspension is its business trace.
    ok(f.specialist.snapshot.budgetSuspension);
    equal(f.worker.contexts.length, 0);
    await f.owner.closeCase(first.id, "abandoned");
    const closedLedger = structuredClone(f.records.get(first.budget!.scopeId));
    await f.raise(2);
    await turn(f.owner, "Case two");
    await f.delegate("Objective from Case two");
    equal(f.worker.contexts.length, 1);
    equal(
      f.worker.contexts[0].messages.at(-1)?.text,
      "Objective from Case two",
    );
    equal(
      delegatedCaseContext(f.specialist.snapshot)?.caseId,
      f.owner.cases.cases[1].id,
    );
    equal(
      f.specialist.snapshot.workBudget?.scopeId,
      f.owner.cases.cases[1].budget!.scopeId,
    );
    equal(f.specialist.snapshot.workBudget?.consumed, 2);
    deepStrictEqual(f.records.get(first.budget!.scopeId), closedLedger);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("an unbudgeted successor Case and its reload never read the closed session ledger", async () => {
  const f = await fixture(2);
  try {
    await turn(f.owner, "Budgeted Case");
    const first = f.owner.cases.cases[0];
    await f.owner.closeCase(first.id, "done");
    const ledger = structuredClone(f.records.get(first.budget!.scopeId));
    delete f.central.model.workBudgetPolicy;
    f.central.model.version.digest = "central-without-budget";
    f.central.model.version.repositoryVersion = "source:central-without-budget";
    await f.owner.adoptModelVersion({
      expectedDigest: "central-without-budget",
    });
    await turn(f.owner, "Unbudgeted Case");
    equal(f.central.contexts.length, 2);
    equal(f.owner.snapshot.budgetSuspension, undefined);
    equal(f.owner.cases.cases[1].budget, undefined);
    const reloaded = f.central.create();
    await reloaded.initialize();
    equal(reloaded.snapshot.budgetSuspension, undefined);
    await turn(reloaded, "Continue this Case", reloaded.cases.cases[1].id);
    equal(f.central.contexts.length, 3);
    deepStrictEqual(f.records.get(first.budget!.scopeId), ledger);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a delegated candidate admission uses the central Case's newly adopted budget policy", async () => {
  const f = await fixture(2, 20);
  try {
    await turn(f.owner, "Build a reader");
    f.worker.answer({
      kind: "propose_tool",
      text: "Propose reader",
      tool: {
        name: "reader",
        description: "Read supplied HTML",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Page',text:html})",
      },
    });
    await f.delegate("Build the reader");
    const candidate = f.specialist.snapshot.candidates[0];
    equal(candidate.stage, "awaiting-admission");
    equal(f.worker.tests(), 1);
    const originalContext = delegatedCaseContext(f.specialist.snapshot)!;
    const localLedger = structuredClone(
      f.records.get(f.specialist.snapshot.id),
    );
    await f.raise(3);
    f.worker.answer({ kind: "reply", text: "Reader ready" });
    await f.manager.decideCandidate({
      agentId: "worker",
      expectedRevision: f.specialist.snapshot.revision,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Reviewed exact candidate",
    });
    await f.manager.idle();
    equal(f.specialist.snapshot.candidates[0].stage, "active");
    equal(f.worker.tests(), 1);
    equal(f.worker.contexts.length, 2);
    equal(delegatedCaseContext(f.specialist.snapshot)!.budget!.policy.limit, 3);
    equal(
      delegatedCaseContext(f.specialist.snapshot)!.caseId,
      originalContext.caseId,
    );
    deepStrictEqual(
      delegatedCaseContext(f.specialist.snapshot)!.modelPin,
      originalContext.modelPin,
    );
    equal(f.specialist.snapshot.workBudget?.consumed, 3);
    deepStrictEqual(f.records.get(f.specialist.snapshot.id), localLedger);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("human messages open their own Request and cannot address a foreign central Case", async () => {
  const f = await fixture(1, 20);
  try {
    await turn(f.owner, "Central objective");
    const centralCase = f.owner.cases.cases[0];
    await f.delegate("Delegated objective");
    equal(f.specialist.snapshot.budgetSuspension?.reason, "exhausted");
    const centralLedger = structuredClone(
      f.records.get(centralCase.budget!.scopeId),
    );
    await f.human("Here is the requested precision");
    await f.specialist.idle();
    const local = f.specialist.cases.cases[0];
    equal(f.specialist.snapshot.budgetSuspension, undefined);
    equal(f.worker.contexts.length, 1);
    equal(f.specialist.cases.cases.length, 1);
    equal(f.specialist.snapshot.messages.at(-1)?.caseId, local.id);
    equal(delegatedCaseContext(f.specialist.snapshot), undefined);
    equal(f.specialist.snapshot.workBudget?.scopeId, local.budget!.scopeId);
    equal(
      workReceipt(
        f.specialist.snapshot.messages.findLast((message) =>
          message.role === "user"
        )!,
      ),
      undefined,
    );
    deepStrictEqual(f.records.get(centralCase.budget!.scopeId), centralLedger);
    const before = f.specialist.snapshot;
    await rejects(() => f.human("Foreign continuation", centralCase.id), {
      code: "CASE_NOT_OWNED",
    });
    deepStrictEqual(f.specialist.snapshot, before);
    await f.owner.closeCase(centralCase.id, "abandoned");
    await rejects(() => f.human("Try again", centralCase.id), {
      code: "CASE_NOT_OWNED",
    });
    await f.human("Continue my conversation", local.id);
    await f.specialist.idle();
    equal(f.worker.contexts.length, 2);
    equal(f.specialist.cases.cases.length, 1);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a native delegated continuation refreshes after reload and reserves its central Case until idle", async () => {
  // Limit 3: turn + delegated decision + exact parent wake decision settle
  // before the raise; a budget-suspended pin adoption stays barrier-blocked.
  const f = await fixture(3, 20);
  try {
    await turn(f.owner, "Central objective");
    await f.delegate("Delegated objective");
    const centralCase = f.owner.cases.cases[0];
    await f.restartWorker();
    equal(
      f.specialist.snapshot.workBudget?.scopeId,
      centralCase.budget!.scopeId,
    );
    await f.raise(4);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.worker.answer(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "reply", text: "Continuation complete" };
    });
    const work = f.delegate("Continue the central Case");
    await entered.promise;
    try {
      await rejects(() => f.owner.closeCase(centralCase.id, "done"), {
        code: "CASE_BUSY",
      });
      await rejects(() => f.owner.closeCase(centralCase.id, "abandoned"), {
        code: "CASE_BUSY",
      });
      equal(
        delegatedCaseContext(f.specialist.snapshot)!.budget!.policy.limit,
        4,
      );
      equal(f.specialist.snapshot.workBudget?.consumed, 3);
      equal(f.specialist.snapshot.workBudget?.reserved, 1);
      equal(f.specialist.cases.cases.length, 0);
    } finally {
      release.resolve();
    }
    await work;
    equal(f.specialist.snapshot.workBudget?.consumed, 4);
    await f.owner.closeCase(centralCase.id, "done");
    equal(f.owner.cases.cases[0].status, "closed-done");
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("native delegated work reserves its central Case until the contribution settles", async () => {
  const f = await fixture(2);
  try {
    await turn(f.owner, "Central objective");
    const centralCase = f.owner.cases.cases[0];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.worker.answer(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "reply", text: "Contribution complete" };
    });
    const work = f.delegate("Contribute to the central Case");
    await entered.promise;
    try {
      await rejects(() => f.owner.closeCase(centralCase.id, "done"), {
        code: "CASE_BUSY",
      });
      await rejects(() => f.owner.closeCase(centralCase.id, "abandoned"), {
        code: "CASE_BUSY",
      });
    } finally {
      release.resolve();
    }
    await work;
    await f.owner.closeCase(centralCase.id, "done");
    equal(f.owner.cases.cases[0].status, "closed-done");
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a delegated Case adopts its first central budget without changing its identity", async () => {
  const f = await fixture(undefined, 20);
  try {
    await turn(f.owner, "Central objective without budget");
    await f.delegate("Delegated objective without budget");
    const original = delegatedCaseContext(f.specialist.snapshot)!;
    equal(original.budget, undefined);
    const localLedger = structuredClone(
      f.records.get(f.specialist.snapshot.id),
    );
    f.central.model.workBudgetPolicy = {
      id: "central-first-budget",
      revision: 1,
      unit: "agent-invocation",
      limit: 1,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
      elementId: "central-first-budget",
      sourceIds: [],
    };
    f.central.model.version.digest = "central-first-budget-adopted";
    f.central.model.version.repositoryVersion =
      "source:central-first-budget-adopted";
    await f.owner.adoptModelVersion({
      expectedDigest: f.central.model.version.digest,
    });
    await f.delegate("Continue with the central budget");
    equal(f.worker.contexts.length, 2);
    equal(delegatedCaseContext(f.specialist.snapshot)!.caseId, original.caseId);
    deepStrictEqual(
      delegatedCaseContext(f.specialist.snapshot)!.modelPin,
      original.modelPin,
    );
    equal(f.specialist.snapshot.workBudget?.scopeId, original.caseId);
    equal(f.specialist.snapshot.workBudget?.consumed, 1);
    await f.delegate("The central budget is now exhausted");
    equal(f.worker.contexts.length, 2);
    equal(f.specialist.snapshot.budgetSuspension?.reason, "exhausted");
    deepStrictEqual(f.records.get(f.specialist.snapshot.id), localLedger);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a candidate from an abandoned Case cannot resume under the successor Case", async () => {
  const f = await fixture(3, 20);
  try {
    await turn(f.owner, "First objective");
    f.worker.answer({
      kind: "propose_tool",
      text: "Propose reader",
      tool: {
        name: "reader",
        description: "Read supplied HTML",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Page',text:html})",
      },
    });
    await f.delegate("First delegated objective");
    const candidate = f.specialist.snapshot.candidates[0];
    equal(candidate.stage, "awaiting-admission");
    await f.owner.closeCase(f.owner.cases.cases[0].id, "abandoned");
    const abandoned = f.specialist.snapshot.candidates[0];
    equal(abandoned.stage, "failed");
    await turn(f.owner, "Second objective");
    f.worker.answer({ kind: "reply", text: "Second objective received" });
    await f.delegate("Second delegated objective");
    const before = f.specialist.snapshot;
    const ledgers = structuredClone(f.records);
    await rejects(() =>
      f.manager.decideCandidate({
        agentId: "worker",
        expectedRevision: before.revision,
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Old candidate must not move to the new Case",
      }), { code: "WORK_CASE_INACTIVE" });
    deepStrictEqual(f.specialist.snapshot, before);
    deepStrictEqual(f.records, ledgers);
    // The runtime command is accepted durably; the worker rechecks Case
    // provenance and refuses the closed Case without applying the decision.
    await f.specialist.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "The runtime also checks existing Case provenance",
    });
    await rejects(() => f.specialist.idle(), { code: "CASE_CLOSED" });
    deepStrictEqual(f.specialist.snapshot.candidates[0], abandoned);
    deepStrictEqual(f.records, ledgers);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("delegation and human inputs select their own Case objective and budget when a local Request exists", async () => {
  for (const outcome of ["done", "abandoned"] as const) {
    const f = await fixture(3, 10);
    try {
      await f.human("Local Request L");
      await f.specialist.idle();
      const local = f.specialist.cases.cases[0];
      equal(f.worker.contexts.at(-1)?.case?.objective, "Local Request L");
      const localLedger = structuredClone(f.records.get(local.budget!.scopeId));
      await turn(f.owner, "Central Request C");
      const central = f.owner.cases.cases[0];
      await f.delegate("Contribute to central objective");
      const delegated = f.worker.contexts.at(-1)!;
      equal(delegated.case?.id, central.id);
      equal(delegated.case?.objective, "Central Request C");
      equal(delegated.workBudget?.scopeId, central.budget!.scopeId);
      // Central turn + delegated decision + exact parent wake decision.
      equal(
        budgetState(f.records.get(central.budget!.scopeId)!).view.consumed,
        3,
      );
      deepStrictEqual(f.records.get(local.budget!.scopeId), localLedger);
      await f.owner.closeCase(central.id, outcome);
      await f.human("Continue local Request L after C closes", local.id);
      await f.specialist.idle();
      const resumed = f.worker.contexts.at(-1)!;
      equal(resumed.case?.id, local.id);
      equal(resumed.case?.objective, "Local Request L");
      equal(resumed.workBudget?.scopeId, local.budget!.scopeId);
      equal(
        budgetState(f.records.get(local.budget!.scopeId)!).view.consumed,
        2,
      );
      equal(
        budgetState(f.records.get(central.budget!.scopeId)!).view.consumed,
        3,
      );
      await f.specialist.closeCase(local.id, outcome);
      equal(f.specialist.cases.cases[0].status, `closed-${outcome}`);
    } finally {
      await f.manager.dispose();
    }
  }
});

Deno.test("closing or abandoning a local Request is independent of the last delegated invocation", async () => {
  for (const outcome of ["done", "abandoned"] as const) {
    const f = await fixture(3, 10);
    try {
      await f.human("Local Request L");
      await f.specialist.idle();
      const local = f.specialist.cases.cases[0];
      await turn(f.owner, "Central Request C");
      const central = f.owner.cases.cases[0];
      await f.delegate("Contribute to central objective");
      await f.owner.closeCase(central.id, "done");
      await f.specialist.closeCase(local.id, outcome);
      equal(f.specialist.cases.cases[0].status, `closed-${outcome}`);
    } finally {
      await f.manager.dispose();
    }
  }
});

Deno.test("human input never inherits a delegated receipt and later native work records its own final answer", async () => {
  const f = await fixture(1, 20);
  try {
    await turn(f.owner, "Central objective");
    const central = f.owner.cases.cases[0];
    const waiting = await f.delegate("Produce the final result");
    equal(waiting.status, "waiting");
    equal(f.worker.contexts.length, 0);
    await f.human("Still waiting for a budget");
    await f.specialist.idle();
    const stillWaiting = recordedOperatorWork(
      f.specialist.snapshot,
      "worker",
      "central",
      waiting.correlationId,
    )!.result;
    equal(stillWaiting.status, "waiting");
    equal(stillWaiting.error, undefined);
    equal(
      stillWaiting.messages.some((message) =>
        message.text === "Still waiting for a budget"
      ),
      false,
    );
    await f.raise(2);
    f.worker.answer({ kind: "reply", text: "Final delegated answer" });
    const accepted = await f.delegate(
      "The increased budget is approved; finish the work",
    );
    // submitWork returns the durable waiting acceptance; the settled result
    // is read back from the exact canonical work journal.
    const completed = recordedOperatorWork(
      f.specialist.snapshot,
      "worker",
      "central",
      accepted.correlationId,
    )!.result;
    const humanResponse = f.specialist.snapshot.messages.findLast((message) =>
      message.role === "user"
    )!;
    equal(workReceipt(humanResponse), undefined);
    deepStrictEqual(
      recordedOperatorWork(
        f.specialist.snapshot,
        "worker",
        "central",
        waiting.correlationId,
      )!.result,
      stillWaiting,
    );
    equal(completed.status, "completed");
    equal(completed.caseId, central.id);
    equal(completed.error, undefined);
    ok(
      completed.messages.some((message) =>
        message.role === "assistant" &&
        message.text.includes("Final delegated answer")
      ),
    );
    equal(f.worker.contexts.length, 2);
    equal(f.specialist.snapshot.workBudget?.scopeId, central.budget!.scopeId);
    equal(f.specialist.snapshot.workBudget?.consumed, 2);
    await f.restartWorker();
    const reloaded = recordedOperatorWork(
      f.specialist.snapshot,
      "worker",
      "central",
      completed.correlationId,
    )!.result;
    deepStrictEqual(reloaded, completed);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("human candidate admission selects its open local Request after another delegated Case closes", async () => {
  const f = await fixture(4, 10);
  try {
    f.worker.answer({
      kind: "propose_tool",
      text: "Prepare a local reader",
      tool: {
        name: "local-reader",
        description: "Read supplied HTML",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Page',text:html})",
      },
    });
    await f.human("Local Request L needs a reader");
    await f.specialist.idle();
    const local = f.specialist.cases.cases[0];
    const candidate = f.specialist.snapshot.candidates[0];
    equal(candidate.stage, "awaiting-admission");
    await turn(f.owner, "Central Request C");
    const central = f.owner.cases.cases[0];
    f.worker.answer({ kind: "reply", text: "Central contribution finished" });
    await f.delegate("Contribute to C");
    await f.owner.closeCase(central.id, "done");
    const ledgers = structuredClone(f.records);
    const providerCalls = f.worker.contexts.length;
    const decision = () =>
      f.manager.decideCandidate({
        agentId: "worker",
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        expectedRevision: f.specialist.snapshot.revision,
        verdict: "approve",
        reason: "Decide the exact candidate belonging to L",
      });
    await decision();
    await f.manager.idle();
    equal(f.specialist.snapshot.candidates[0].stage, "active");
    equal(
      f.specialist.snapshot.candidates[0].admission?.authority,
      "human",
    );
    equal(caseExecutionContext(f.specialist.snapshot)?.caseId, local.id);
    equal(
      f.specialist.snapshot.workBudgetBinding?.scopeId,
      local.budget!.scopeId,
    );
    equal(
      f.specialist.snapshot.events.findLast((event) =>
        event.kind === "human-admission-decided"
      )?.caseId,
      local.id,
    );
    deepStrictEqual(f.records, ledgers);
    equal(f.worker.contexts.length, providerCalls);
    // The await-input cursor lives in the framework checkpoint; canonical
    // state only proves the operator settled back to an idle wait.
    equal(f.specialist.snapshot.busy, false);
    f.worker.answer({
      kind: "reply",
      text: "Local continuation explicitly requested",
    });
    await f.human("Continue local Request L after admission", local.id);
    await f.specialist.idle();
    equal(f.worker.contexts.length, providerCalls + 1);
    equal(
      budgetState(f.records.get(local.budget!.scopeId)!).view.consumed,
      budgetState(ledgers.get(local.budget!.scopeId)!).view.consumed + 1,
    );
    deepStrictEqual(
      f.records.get(central.budget!.scopeId),
      ledgers.get(central.budget!.scopeId),
    );
    await f.specialist.closeCase(local.id, "done");
    const closed = f.specialist.snapshot;
    await rejects(decision, { code: "WORK_CASE_INACTIVE" });
    deepStrictEqual(f.specialist.snapshot, closed);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("closing an idle local Request does not interrupt another Case's running delegated invocation", async () => {
  for (const outcome of ["done", "abandoned"] as const) {
    const f = await fixture(3, 10);
    const release = Promise.withResolvers<void>();
    try {
      await f.human("Local Request L");
      await f.specialist.idle();
      const local = f.specialist.cases.cases[0];
      await turn(f.owner, "Central Request C");
      const central = f.owner.cases.cases[0];
      const entered = Promise.withResolvers<void>();
      f.worker.answer(async () => {
        entered.resolve();
        await release.promise;
        return {
          kind: "reply",
          text: "Central work completed after local closure",
        };
      });
      const work = f.delegate("Execute the central contribution");
      await entered.promise;
      const before = f.specialist.snapshot;
      equal(before.busy, true);
      equal(before.workBudget?.scopeId, central.budget!.scopeId);
      equal(before.workBudget?.reserved, 1);
      try {
        await f.specialist.closeCase(local.id, outcome);
        const during = f.specialist.snapshot;
        equal(f.specialist.cases.cases[0].status, `closed-${outcome}`);
        equal(during.busy, true);
        equal(during.phase, before.phase);
        deepStrictEqual(during.caseInvocation, before.caseInvocation);
        deepStrictEqual(during.workBudget, before.workBudget);
        deepStrictEqual(during.messages, before.messages);
        equal(f.owner.cases.cases[0].status, "waiting");
      } finally {
        release.resolve();
      }
      const accepted = await work;
      const completed = recordedOperatorWork(
        f.specialist.snapshot,
        "worker",
        "central",
        accepted.correlationId,
      )!.result;
      equal(completed.status, "completed");
      equal(completed.caseId, central.id);
      ok(completed.messages.some((message) =>
        message.role === "assistant" &&
        message.text.includes("Central work completed after local closure")
      ));
      equal(f.specialist.snapshot.busy, false);
      equal(f.specialist.snapshot.workBudget?.scopeId, central.budget!.scopeId);
      equal(f.specialist.snapshot.workBudget?.consumed, 2);
      equal(f.specialist.snapshot.workBudget?.reserved, 0);
      await f.owner.closeCase(central.id, "done");
    } finally {
      release.resolve();
      await f.manager.dispose();
    }
  }
});

Deno.test("LEGACY-PROFILE: an admitted flow without operator-command-v1 refuses operator commands without executing them", async () => {
  const f = await fixture(undefined);
  try {
    await turn(f.owner, "Request A");
    const before = f.specialist.snapshot;
    f.worker.answer({
      kind: "open_request",
      text: "Open a follow-up Request",
      objective: "Follow-up objective",
      openingId: "legacy-profile-opening",
      source: { kind: "current-main" },
    });
    await rejects(
      () => f.delegate("Try an operator command on the legacy profile"),
      /no explicit operator-command action/,
    );
    // Refusal only: no Case opened and no command effect was executed.
    equal(f.specialist.cases.cases.length, before.cases?.length ?? 0);
    equal(f.owner.cases.cases.length, 1);
    ok(f.specialist.snapshot.error?.includes("operator-command"));
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a completed operator command replays as already-done while a queued receipt stays pending", async () => {
  const f = await fixture(undefined, 20);
  try {
    await turn(f.owner, "Central objective");
    const propose = (name: string): ChatDecision => ({
      kind: "propose_tool",
      text: `Prepare ${name}`,
      tool: {
        name,
        description: "Read supplied HTML",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Page',text:html})",
      },
    });
    f.worker.answer(propose("replay-reader-a"));
    await f.delegate("First replay objective");
    f.worker.answer(propose("replay-reader-b"));
    await f.delegate("Second replay objective");
    f.worker.answer(propose("replay-reader-c"));
    await f.delegate("Third replay objective");
    const [first, second, third] = f.specialist.snapshot.candidates;
    const park = async (
      candidate: { id: string; digest: string },
      effectKey: string,
      verdict: "approve" | "refuse" = "approve",
    ) => {
      const command = {
        kind: "decide-candidate" as const,
        input: {
          candidateId: candidate.id,
          candidateDigest: candidate.digest,
          verdict,
          reason: "Replay test decision",
        },
      };
      // The origin names the owner as the real command source with its
      // exact current input, so the worker's completion notify-back
      // resolves the parent input instead of refusing it.
      const ownerInput = invocationInput(f.owner.snapshot)?.id;
      ok(ownerInput);
      const origin: OperatorCommandOrigin = {
        businessRevision: runtimeRevisionReference(f.owner.snapshot),
        effectKey,
        inputMessageId: ownerInput,
      };
      try {
        await f.specialist.decideCandidate(command.input, undefined, origin);
        throw new Error("Expected the operator command to park");
      } catch (error) {
        ok(error instanceof OperatorCommandPending);
      }
      return { command, origin };
    };
    // Completed receipt with its canonical completion event replays as
    // already-done without re-executing the approved decision.
    const settled = await park(first, "replay-settled-effect");
    await f.specialist.idle();
    equal(
      f.specialist.snapshot.candidates.find((entry) => entry.id === first.id)
        ?.stage,
      "active",
    );
    ok(
      f.specialist.snapshot.events.some((event) =>
        event.id.startsWith("operator-command-completed:")
      ),
    );
    const calls = f.worker.contexts.length;
    const tests = f.worker.tests();
    const publications = f.worker.publications();
    const revision = f.specialist.snapshot.revision;
    equal(
      await f.specialist.resumeOperatorCommand(
        settled.command,
        settled.origin,
      ),
      true,
    );
    equal(f.specialist.snapshot.revision, revision);
    equal(f.worker.contexts.length, calls);
    equal(f.worker.tests(), tests);
    equal(f.worker.publications(), publications);
    // A receipt still queued behind a blocked worker raises pending again.
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.worker.hooks.readingCatalog = async () => {
      entered.resolve();
      await release.promise;
    };
    try {
      // Refusals publish nothing, so the queued refusal's candidate base
      // stays valid behind the blocked refusal ahead of it.
      await park(second, "replay-running-effect", "refuse");
      await entered.promise;
      const queued = await park(third, "replay-queued-effect", "refuse");
      try {
        await f.specialist.resumeOperatorCommand(
          queued.command,
          queued.origin,
        );
        throw new Error("Expected the queued command to stay pending");
      } catch (error) {
        ok(error instanceof OperatorCommandPending);
      }
    } finally {
      release.resolve();
    }
    delete f.worker.hooks.readingCatalog;
    await f.specialist.idle();
    for (const candidate of [second, third]) {
      equal(
        f.specialist.snapshot.candidates.find((entry) =>
          entry.id === candidate.id
        )?.stage,
        "refused",
      );
    }
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("continuation fingerprint tracks the waiting execution and diverges after a checkpoint advance", async (t) => {
  const { nativeExecutionIdentity } = await import(
    "../../src/application/work/runtime/execution.ts"
  );
  type Snapshot =
    import("../../src/application/work/runtime/execution.ts").NativeExecutionSnapshot;
  const model = nativeCaseFixtureModel("central", {
    admissionAuthority: "human",
    primary: true,
  });
  let waiting: Snapshot[] = [];
  const execution = {
    run: () => Promise.reject(new Error("No execution run is expected")),
    closeScope: () => Promise.resolve(),
    inspect: () => Promise.resolve(structuredClone(waiting)),
    retireAndAdvance: () => Promise.resolve(),
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
    configuration: { ...structuredClone(model.configuration), changes: [] },
    cases: [{
      id: "case-1",
      number: 1,
      owner: "central",
      openedBy: "Main",
      type: "request",
      objective: "Probe the continuation",
      modelPin: { digest: model.version.digest },
      status: "open",
      createdAt: "now",
      openedFrom: {
        conversationId: "main",
        openingId: "opening",
        designerScopeId: "designer",
      },
    }],
    caseInvocation: { kind: "local", caseId: "case-1" },
    activeInputMessageId: "input-1",
  };
  const runtime = new SystemRuntime({
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      findApprovedChange: () => Promise.resolve(null),
      applyApprovedChange: () =>
        Promise.reject(new Error("No mandate change belongs here")),
      activateCandidate: () =>
        Promise.reject(new Error("No activation belongs here")),
      graph: () => Promise.resolve({}),
    },
    execution,
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save: (state, expected) => {
        equal(saved?.revision ?? null, expected);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    agents: {
      label: "test",
      decide: () => Promise.resolve({ kind: "reply", text: "Idle." }),
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      test: () => Promise.reject(new Error("Unexpected test")),
      run: () => Promise.reject(new Error("Unexpected effect")),
    },
  });
  await runtime.initialize();
  const { continuationFingerprint } = await import(
    "../../src/application/work/operators/coordination.ts"
  );
  const ports = {
    model: {
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
    },
    clock: { now: () => "2026-10-24T00:00:00.000Z" },
    caseNumbers: { allocate: () => Promise.resolve(1) },
    execution,
  };
  const fingerprint = () =>
    continuationFingerprint.call({ state: runtime.snapshot, ports });
  const identity = nativeExecutionIdentity(
    runtime.snapshot,
    "conversation",
    "input-1",
  );
  equal(identity.operatorId, "central");
  function park(checkpointId: string, status: Snapshot["status"] = "waiting") {
    waiting = [{
      contributionId: "contrib-1",
      identity: structuredClone(identity),
      threadId: "thread-1",
      modelDigest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
      flowRootId: model.flows.conversation.rootNativeId,
      status,
      checkpointId,
      waits: [],
      unsettledEffects: [],
      pendingContributions: [],
    }];
  }
  const ownedInput = () => ({
    id: "input-1",
    role: "user" as const,
    text: "Probe the continuation",
    at: "2026-10-24T00:00:00.000Z",
    caseId: "case-1",
  });
  const ownedCandidate = (fingerprintValue: string) => ({
    name: "owned",
    description: "Interrupted admission.",
    kind: "read_web_page" as const,
    code: "export default () => ({})",
    id: "cand-owned",
    caseId: "case-1",
    digest: "d".repeat(64),
    stage: "refused" as const,
    createdAt: "now",
    baseCatalogRevision: 0,
    admissionDecision: {
      candidateDigest: "d".repeat(64),
      verdict: "refuse" as const,
      reason: "Reviewed before the restart",
    },
    admissionContinuation: {
      modelDigest: model.version.digest,
      fingerprint: fingerprintValue,
      inputMessageId: "input-1",
      messageStart: 0,
      priorCandidateIds: [],
    },
  });
  function restart(run?: () => Promise<never>) {
    return new SystemRuntime({
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(model.identity)),
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        findApprovedChange: () => Promise.resolve(null),
        applyApprovedChange: () =>
          Promise.reject(new Error("No mandate change belongs here")),
        activateCandidate: () =>
          Promise.reject(new Error("No activation belongs here")),
        graph: () => Promise.resolve({}),
      },
      execution: run ? { ...execution, run } : execution,
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (state, expected) => {
          equal(saved?.revision ?? null, expected);
          saved = structuredClone(state);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      agents: {
        label: "test",
        decide: () => Promise.resolve({ kind: "reply", text: "Idle." }),
        review: () => {
          throw new Error("Unexpected review");
        },
      },
      runner: {
        test: () => Promise.reject(new Error("Unexpected test")),
        run: () => Promise.reject(new Error("Unexpected effect")),
      },
    });
  }

  await t.step("fingerprint is defined for a waiting execution", async () => {
    park("checkpoint-1");
    const current = await fingerprint();
    ok(typeof current === "string" && current.length > 0);
  });

  await t.step("fingerprint changes after a checkpoint advance", async () => {
    park("checkpoint-1");
    const before = await fingerprint();
    park("checkpoint-2");
    const after = await fingerprint();
    ok(before && after);
    ok(
      before !== after,
      "A stale resume presenting the old fingerprint cannot match the advanced checkpoint",
    );
  });

  await t.step("no fingerprint without a waiting execution", async () => {
    park("checkpoint-2", "completed");
    equal(await fingerprint(), undefined);
    waiting = [];
    equal(await fingerprint(), undefined);
  });

  await t.step(
    "stale owned continuation is refused at the fingerprint comparison",
    async () => {
      park("checkpoint-1");
      const previous = await fingerprint();
      ok(previous);
      // Advance only the checkpoint: the same owned, eligible continuation now
      // presents a stale fingerprint while native work is still unfinished, so
      // the fingerprint comparison (not the ownership guard) must refuse it.
      park("checkpoint-2");
      waiting[0].unsettledEffects = ["effect-1"];
      const current = await fingerprint();
      ok(current && current !== previous);
      saved = {
        ...structuredClone(saved)!,
        messages: [ownedInput()],
        candidates: [ownedCandidate(previous)],
      };
      const successor = restart();
      await successor.initialize();
      equal(successor.snapshot.error, undefined);
      equal(
        successor.snapshot.candidates[0]?.admissionContinuation,
        undefined,
        "The stale owned continuation must be refused at the fingerprint comparison, never executed",
      );
    },
  );

  await t.step("matching owned continuation reaches execution", async () => {
    park("checkpoint-2");
    const current = await fingerprint();
    ok(current);
    saved = {
      ...structuredClone(saved)!,
      messages: [ownedInput()],
      candidates: [ownedCandidate(current)],
    };
    const successor = restart(() =>
      Promise.reject(new Error("CONTINUATION_EXECUTION_REACHED"))
    );
    try {
      await successor.initialize();
      throw new Error("Expected the matching continuation to reach execution");
    } catch (error) {
      equal((error as Error).message, "CONTINUATION_EXECUTION_REACHED");
    }
  });
});
