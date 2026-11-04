import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";
import type {
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import { CaseError } from "../../src/domain/work/errors/case.ts";
import type { WorkBudgetRecord } from "../../src/domain/work/policies/budget.ts";

import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { recordedOperatorWork } from "../../src/application/work/operators/journal.ts";

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
function runtimeFixture(limit?: number, typed = false) {
  const model = modelFixture();
  if (limit !== undefined) {
    if (typed) {
      model.caseTypes = [{
        id: "request-type",
        name: "Request",
        type: "request",
        envelope: "conversational",
        behaviorId: model.flows.conversation.rootNativeId,
        ownerId: model.identity.builderId,
        maxInvocations: limit,
        sourceIds: [],
      }];
    } else {model.workBudgetPolicy = {
        id: "budget",
        revision: 1,
        unit: "agent-invocation",
        limit,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
        elementId: "budget",
        sourceIds: [],
      };}
  }
  let saved: SystemRuntimeState | null = null;
  let answer: ChatDecision = {
    kind: "reply",
    text: "Quel résultat souhaites-tu ?",
  };
  let tick = clock.now();
  const contexts: ChatContext[] = [];
  let diagnosticReads = 0;
  let beforeReply = () => Promise.resolve();
  const records = new Map<string, WorkBudgetRecord>();
  const budget = new WorkBudgetService({
    load: (id) => Promise.resolve(structuredClone(records.get(id) ?? null)),
    save: (record, expected) => {
      equal(records.get(record.scopeId)?.revision ?? null, expected);
      records.set(record.scopeId, structuredClone(record));
      return Promise.resolve();
    },
  });
  const forbidden = () => {
    throw new Error("Unexpected side effect");
  };
  const versions = new Map([[
    model.version.repositoryVersion,
    structuredClone(model),
  ]]);
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: (_identity, version) => {
      versions.set(model.version.repositoryVersion, structuredClone(model));
      const retained = version === undefined ? model : versions.get(version);
      ok(retained, "The exact fixture source must be retained");
      return Promise.resolve(structuredClone(retained));
    },
    applyApprovedChange: forbidden,
    activateCandidate: forbidden,
    graph: () => Promise.resolve({}),
  };
  const execution = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save: (next, expected) => {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  }, budget);
  const create = () => {
    const runtime = new SystemRuntime({
      clock: { now: () => tick },
      model: source,
      workBudget: budget,
      modelDiagnostics: {
        read: () => {
          diagnosticReads++;
          return Promise.resolve([
            {
              code: "DESIGN_WARNING",
              severity: "warning" as const,
              finding: "absent" as const,
              message: "Un avertissement",
              masked: false,
            },
            {
              code: "MASKED",
              severity: "error" as const,
              finding: "absent" as const,
              message: "Masqué",
              masked: true,
            },
          ]);
        },
      },
      store: execution.store,
      execution: execution.execution,
      dispatch: execution.dispatch,
      stateHistory: execution.stateHistory,
      agents: {
        label: "test",
        review: forbidden,
        decide: async (context) => {
          contexts.push(structuredClone(context));
          await beforeReply();
          return structuredClone(answer);
        },
      },
      runner: { test: forbidden, run: forbidden },
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
    contexts,
    records,
    budget,
    diagnosticReads: () => diagnosticReads,
    answer: (next: ChatDecision) => {
      answer = next;
    },
    clock: (at: string) => {
      tick = at;
    },
    saved: () => saved!,
    blockReply: () => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      beforeReply = () => {
        entered.resolve();
        return gate.promise;
      };
      return {
        entered: entered.promise,
        release: () => {
          beforeReply = () => Promise.resolve();
          gate.resolve();
        },
      };
    },
  };
}
async function turn(
  runtime: SystemRuntime,
  text = "Aide-moi",
  caseId?: string,
) {
  await runtime.submit(
    text,
    undefined,
    caseId,
    caseId === undefined ? true : undefined,
  );
  await runtime.idle();
}

Deno.test("perpetual designer has isolated history, durable budget and diagnostics without a Case", async () => {
  const f = runtimeFixture(4);
  let runtime = f.create();
  await runtime.initialize();
  f.answer({ kind: "reply", text: "Conception 1", caseClosure: "done" });
  equal(await runtime.submit("Concevons le système"), undefined);
  await runtime.idle();
  equal(runtime.snapshot.error, undefined);
  equal(runtime.cases.cases.length, 0);
  equal(runtime.snapshot.caseInvocation?.kind, "designer");
  const scopeId = runtime.snapshot.designer!.scopeId;
  equal(scopeId, `${runtime.snapshot.id}:designer`);
  equal(runtime.snapshot.workBudget?.scopeId, scopeId);
  equal(runtime.snapshot.workBudget?.consumed, 1);
  equal(f.contexts[0].case, undefined);
  equal(f.contexts[0].designer?.scopeId, scopeId);
  deepStrictEqual(f.contexts[0].modelDiagnostics?.map((entry) => entry.code), [
    "DESIGN_WARNING",
  ]);
  ok(
    runtime.snapshot.messages.every((message) => message.caseId === undefined),
  );
  equal(f.diagnosticReads(), 1);

  f.answer({ kind: "reply", text: "Réponse A" });
  const a = (await runtime.submit("Demande A", undefined, undefined, true))!;
  await runtime.idle();
  equal(runtime.cases.cases.length, 1);
  equal(runtime.cases.cases[0].number, 1);
  deepStrictEqual(f.contexts.at(-1)!.messages.map((message) => message.text), [
    "Demande A",
  ]);
  equal(f.contexts.at(-1)!.designer, undefined);
  equal(f.contexts.at(-1)!.modelDiagnostics, undefined);
  equal(f.diagnosticReads(), 1);
  f.answer({ kind: "reply", text: "Conception 2" });
  await runtime.submit("Évolution du système");
  await runtime.idle();
  equal(runtime.snapshot.messages.at(-1)?.caseId, undefined);
  equal(runtime.snapshot.workBudget?.scopeId, scopeId);
  equal(runtime.snapshot.workBudget?.consumed, 2);
  deepStrictEqual(f.contexts.at(-1)!.messages.map((message) => message.text), [
    "Concevons le système",
    "Conception 1",
    "Évolution du système",
  ]);
  equal(f.contexts.at(-1)!.modelDiagnostics?.length, 1);
  equal(
    f.records.get(a)?.events.filter((event) => event.kind === "reserve").length,
    1,
  );

  runtime = f.create();
  await runtime.initialize();
  equal(runtime.snapshot.caseInvocation?.kind, "designer");
  equal(runtime.snapshot.workBudget?.consumed, 2);
  f.answer({ kind: "reply", text: "Conception 3", caseClosure: "abandoned" });
  await runtime.submit("Suite après redémarrage");
  await runtime.idle();
  equal(runtime.snapshot.error, undefined);
  equal(runtime.snapshot.workBudget?.consumed, 3);
  equal(runtime.cases.cases.length, 1);
  equal(runtime.cases.cases[0].status, "waiting");
  f.answer({ kind: "reply", text: "Suite A" });
  await turn(runtime, "Continuation A", a);
  deepStrictEqual(f.contexts.at(-1)!.messages.map((message) => message.text), [
    "Demande A",
    "Réponse A",
    "Continuation A",
  ]);
  equal(runtime.snapshot.workBudget?.consumed, 2);
  equal(
    f.records.get(scopeId)?.events.filter((event) => event.kind === "reserve")
      .length,
    3,
  );
});

Deno.test("legacy history without pending work becomes designer history, never a Request", async () => {
  const f = runtimeFixture(3);
  let runtime = f.create();
  await runtime.initialize();
  await runtime.submit("Ancienne conception");
  await runtime.idle();
  const saved = f.saved();
  // A pre-Cases runtime used its session ID as the durable budget scope.
  const legacyBudget = structuredClone(f.records.get(saved.designer!.scopeId)!);
  legacyBudget.scopeId = saved.id;
  f.records.set(saved.id, legacyBudget);
  saved.workBudgetBinding = {
    budgetId: f.model.workBudgetPolicy!.id,
    scopeId: saved.id,
  };
  delete saved.cases;
  delete saved.caseInvocation;
  delete saved.designer;
  delete saved.conversationCursor;
  delete saved.conversationContext;
  delete saved.conversationFlow;
  delete saved.workBudget;
  for (const message of saved.messages) delete message.designerScopeId;
  const journal = structuredClone(saved.messages);
  runtime = f.create();
  await runtime.initialize();
  equal(runtime.cases.cases.length, 0);
  deepStrictEqual(runtime.snapshot.messages, journal);
  equal(runtime.snapshot.designer?.scopeId, saved.id);
  equal(runtime.snapshot.workBudget?.consumed, 1);
  await runtime.submit("Reprenons la conception");
  await runtime.idle();
  deepStrictEqual(f.contexts.at(-1)!.messages.map((message) => message.text), [
    ...journal.map((message) => message.text),
    "Reprenons la conception",
  ]);
  equal(runtime.cases.cases.length, 0);
  equal(runtime.snapshot.workBudget?.consumed, 2);
});

Deno.test("designer delegation shares only its budget and isolates the specialist's own designer history", async () => {
  const f = runtimeFixture(4);
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submit("Conception locale privée");
  await runtime.idle();
  const localScope = runtime.snapshot.designer!.scopeId;
  const policy = f.model.workBudgetPolicy!;
  const designerContext = {
    scopeId: "central:designer",
    ownerId: "central",
    policy,
  };
  await f.budget.adopt({
    ...designerContext,
    previousPolicy: undefined,
    modelVersion: f.model.version,
  });
  f.answer({
    kind: "reply",
    text: "Contribution de conception",
    caseClosure: "done",
  });
  const input = {
    text: "Concevoir la délégation",
    correlationId: "designer-work",
    proof: {
      designerContext,
      callerId: "central",
      invocationId: "designer-invocation",
      modelVersion: {
        digest: "central-pin",
        repositoryVersion: "central-source",
      },
      behavior: {
        id: "worker-inbox",
        name: "Dispatch",
        description: "Admitted inbox",
        targetNativeId: "worker",
        targetTypeId: "inbox-type",
        inputTypeId: "work-input",
        callerNativeId: "central",
        sourceIds: [],
        inputSchema: { type: "object" },
      },
    },
  };
  await runtime.submitWork(input);
  await runtime.idle();
  equal(runtime.snapshot.error, undefined);
  equal(runtime.cases.cases.length, 0);
  equal(runtime.snapshot.workBudget?.scopeId, designerContext.scopeId);
  equal(runtime.snapshot.workBudget?.consumed, 1);
  equal(f.contexts.at(-1)?.modelDiagnostics, undefined);
  deepStrictEqual(f.contexts.at(-1)?.messages.map((message) => message.text), [
    input.text,
  ]);
  await runtime.submitWork(input);
  await runtime.idle();
  equal(f.contexts.length, 2);
  await runtime.submit("Retour à la conception locale");
  await runtime.idle();
  equal(runtime.snapshot.workBudget?.scopeId, localScope);
  equal(runtime.snapshot.workBudget?.consumed, 2);
  ok(
    f.contexts.at(-1)!.messages.every((message) =>
      message.designerScopeId === localScope
    ),
  );
  equal(
    f.contexts.at(-1)!.messages.some((message) => message.text === input.text),
    false,
  );
});

Deno.test("a missing persisted designer budget binding cannot grant a fresh budget", async () => {
  const f = runtimeFixture(3);
  let runtime = f.create();
  await runtime.initialize();
  await runtime.submit("Concevoir");
  await runtime.idle();
  delete f.saved().designer!.budget;
  delete f.saved().workBudgetBinding;
  runtime = f.create();
  await runtime.initialize();
  equal(runtime.snapshot.budgetSuspension?.reason, "unavailable");
  await rejects(() => runtime.submit("Ne pas recréer le budget"), {
    code: "CASE_SCOPE_MISSING",
  });
  equal(f.contexts.length, 1);
  equal(runtime.cases.cases.length, 0);
});

Deno.test("runtime separates Cases from chat, tags questions and traces, closes and allocates fresh budget", async () => {
  const f = runtimeFixture(3);
  const runtime = f.create();
  await runtime.initialize();
  equal(runtime.cases.cases.length, 0);
  const sessionId = runtime.snapshot.id;
  await turn(runtime);
  const first = runtime.cases.cases[0];
  equal(first.number, 1);
  equal(first.status, "waiting");
  equal(first.budget!.scopeId, first.id);
  equal(
    runtime.snapshot.messages.at(-1)!.text,
    "Quel résultat souhaites-tu ?",
  );
  equal(runtime.snapshot.messages.at(-1)!.caseId, first.id);
  ok(
    runtime.snapshot.events.filter((e) => e.kind.startsWith("flow-")).every((
      e,
    ) => e.caseId === first.id),
  );
  equal(f.contexts[0].case?.id, first.id);
  f.answer({ kind: "reply", text: "Précise le format souhaité" });
  await turn(runtime, "Précision", first.id);
  equal(
    runtime.snapshot.messages.at(-1)!.text,
    "Précise le format souhaité",
  );
  equal(runtime.snapshot.workBudget!.consumed, 2);
  f.clock("2026-10-24T04:00:00.000Z");
  await runtime.closeCase(first.id, "done", ACCEPTED_CASE_CLOSURE);
  equal(runtime.cases.cases[0].closedAt, "2026-10-24T04:00:00.000Z");
  await turn(runtime, "Autre objectif");
  equal(runtime.snapshot.id, sessionId);
  equal(runtime.cases.cases[1].number, 2);
  equal(runtime.snapshot.workBudget!.consumed, 1);
  equal(runtime.snapshot.workBudget!.scopeId, runtime.cases.cases[1].id);
  equal(
    f.records.get(first.id)!.events.filter((e) => e.kind === "reserve").length,
    2,
  );
  await rejects(
    () => runtime.closeCase(first.id, "done", ACCEPTED_CASE_CLOSURE),
    {
      code: "CASE_CLOSED",
    },
  );
});

Deno.test("parallel Requests isolate history, objective, replies, budgets and closure across reload", async () => {
  const f = runtimeFixture(3);
  let runtime = f.create();
  await runtime.initialize();
  deepStrictEqual(runtime.snapshot.messages, []);
  f.answer({ kind: "reply", text: "Réponse A1" });
  const a = (await runtime.submit("Objectif A", undefined, undefined, true))!;
  await runtime.idle();
  f.answer({ kind: "reply", text: "Réponse B1" });
  const b = (await runtime.submit("Objectif B", undefined, undefined, true))!;
  await runtime.idle();
  equal(runtime.cases.cases.length, 2);
  deepStrictEqual(runtime.cases.cases.map((record) => record.status), [
    "waiting",
    "waiting",
  ]);
  const contextB = f.contexts.find((context) => context.case?.id === b);
  ok(contextB);
  deepStrictEqual(contextB.messages.map((message) => message.text), [
    "Objectif B",
  ]);
  runtime = f.create();
  await runtime.initialize();
  equal(runtime.cases.cases.length, 2);
  f.answer({ kind: "reply", text: "Réponse A2" });
  await turn(runtime, "Suite A", a);
  const context = f.contexts.at(-1)!;
  equal(context.case?.id, a);
  equal(context.case?.objective, "Objectif A");
  equal(context.workBudget?.scopeId, a);
  equal(context.workBudget?.consumed, 1);
  deepStrictEqual(context.messages.map((message) => message.text), [
    "Objectif A",
    "Réponse A1",
    "Suite A",
  ]);
  equal(runtime.snapshot.workBudget?.consumed, 2);
  f.answer({ kind: "reply", text: "Réponse B2" });
  await turn(runtime, "Suite B", b);
  deepStrictEqual(f.contexts.at(-1)!.messages.map((message) => message.text), [
    "Objectif B",
    "Réponse B1",
    "Suite B",
  ]);
  equal(runtime.snapshot.workBudget?.consumed, 2);
  f.answer({ kind: "reply", text: "Terminé A" });
  await turn(runtime, "Fin A", a);
  await runtime.closeCase(a, "done", ACCEPTED_CASE_CLOSURE);
  equal(
    runtime.cases.cases.find((record) => record.id === a)?.status,
    "closed-done",
  );
  equal(
    runtime.cases.cases.find((record) => record.id === b)?.status,
    "waiting",
  );
  equal(runtime.snapshot.messages.at(-1)?.caseId, a);
  for (const [id, count] of [[a, 3], [b, 2]] as const) {
    equal(
      f.records.get(id)?.events.filter((event) => event.kind === "reserve")
        .length,
      count,
    );
  }
  for (const context of f.contexts) {
    ok(context.case);
    ok(
      context.messages.every((message) => message.caseId === context.case!.id),
    );
  }
  const before = runtime.snapshot;
  await rejects(() => runtime.submit("Trop tard", undefined, a), {
    code: "CASE_CLOSED",
    context: { caseId: a, agentId: "operator" },
  });
  await rejects(() => runtime.submit("Inconnu", undefined, "unknown"), {
    code: "CASE_NOT_FOUND",
  });
  deepStrictEqual(runtime.snapshot, before);
});

Deno.test("a busy runtime refuses another Request and new conversations without queueing", async () => {
  const f = runtimeFixture();
  const runtime = f.create();
  await runtime.initialize();
  const a = (await runtime.submit("Objectif A", undefined, undefined, true))!;
  await runtime.idle();
  const gate = f.blockReply();
  try {
    await runtime.submit("Objectif B", undefined, undefined, true);
    await gate.entered;
    const before = runtime.snapshot;
    for (const caseId of [a, undefined]) {
      await rejects(
        () => runtime.submit("Ne pas mettre en attente", undefined, caseId),
        { code: "AGENT_BUSY", recovery: "retry after the current reply" },
      );
    }
    deepStrictEqual(runtime.snapshot, before);
  } finally {
    gate.release();
    await runtime.idle();
  }
  equal(f.contexts.length, 2);
  equal(runtime.cases.cases.length, 2);
  equal(
    runtime.snapshot.messages.some((message) =>
      message.text === "Ne pas mettre en attente"
    ),
    false,
  );
});

Deno.test("human closure preserves birth pin across a separate explicit model adoption", async () => {
  const f = runtimeFixture();
  const runtime = f.create();
  await runtime.initialize();
  await turn(runtime);
  const birth = runtime.cases.cases[0].modelPin;
  f.model.version.digest = "executable-2";
  f.model.version.repositoryVersion = "source-2";
  await rejects(
    () => turn(runtime, "Suite", runtime.cases.cases[0].id),
    /une admission explicite de sa version est requise/,
  );
  equal(f.contexts.length, 1);
  deepStrictEqual(runtime.cases.cases[0].modelPin, birth);
  await runtime.adoptModelVersion({
    expectedDigest: "executable-2",
    expectedVersion: "source-2",
  });
  deepStrictEqual(runtime.cases.cases[0].modelPin, birth);
  f.answer({ kind: "reply", text: "Terminé" });
  await turn(runtime, "Fin", runtime.cases.cases[0].id);
  await runtime.closeCase(
    runtime.cases.cases[0].id,
    "done",
    ACCEPTED_CASE_CLOSURE,
  );
  equal(runtime.cases.cases[0].status, "closed-done");
  f.answer({ kind: "reply", text: "Abandonné", caseClosure: "abandoned" });
  await turn(runtime);
  equal(runtime.cases.cases[1].status, "closed-abandoned");
  equal(runtime.cases.cases[1].modelPin.digest, "executable-2");
});

Deno.test("legacy settled history preserves its known budget without inventing a pending Request", async () => {
  const f = runtimeFixture(2);
  const first = f.create();
  await first.initialize();
  await turn(first);
  const saved = f.saved();
  delete saved.cases;
  delete saved.caseInvocation;
  for (const message of saved.messages) delete message.caseId;
  for (const event of saved.events) delete event.caseId;
  const messages = structuredClone(saved.messages);
  const budgetScope = saved.workBudgetBinding!.scopeId;
  const restarted = f.create();
  await restarted.initialize();
  equal(restarted.cases.cases.length, 0);
  equal(restarted.snapshot.caseInvocation?.kind, "designer");
  equal(restarted.snapshot.workBudgetBinding!.scopeId, budgetScope);
  equal(restarted.snapshot.workBudget!.consumed, 1);
  deepStrictEqual(restarted.snapshot.messages, messages);
  await restarted.submit("Suite");
  await restarted.idle();
  equal(restarted.snapshot.workBudget!.consumed, 2);
  await restarted.submit("Suite épuisée");
  await restarted.idle();
  equal(f.contexts.length, 2);
  equal(restarted.snapshot.budgetSuspension?.reason, "exhausted");
  equal(restarted.cases.cases.length, 0);
  equal(restarted.snapshot.workBudgetBinding!.scopeId, budgetScope);
});

Deno.test("CaseType maxInvocations alone reserves durably and enforces zero or exhaustion", async () => {
  for (const limit of [0, 1]) {
    const f = runtimeFixture(limit, true);
    const runtime = f.create();
    await runtime.initialize();
    await turn(runtime);
    if (limit === 0) {
      const before = runtime.snapshot;
      const ledger = structuredClone(f.records);
      await rejects(
        () => turn(runtime, "Suite", runtime.cases.cases[0].id),
        (error: unknown) => {
          ok(error instanceof CaseError);
          equal(error.code, "CASE_BUSY");
          equal(error.context?.reason, "BUDGET_WAIT_ACTIVE");
          return true;
        },
      );
      deepStrictEqual(runtime.snapshot, before);
      deepStrictEqual(f.records, ledger);
    } else await turn(runtime, "Suite", runtime.cases.cases[0].id);
    equal(f.contexts.length, limit);
    equal(runtime.snapshot.workBudget!.limit, limit);
    equal(runtime.snapshot.budgetSuspension?.reason, "exhausted");
    equal(runtime.cases.cases[0].budget!.budgetId, "request-type:invocations");
  }
});

Deno.test("adopting a smaller budget between Cases never rewrites the closed Case ledger", async () => {
  const f = runtimeFixture(3);
  const runtime = f.create();
  await runtime.initialize();
  await turn(runtime);
  await turn(runtime, "Suite", runtime.cases.cases[0].id);
  const first = runtime.cases.cases[0];
  await runtime.closeCase(first.id, "done", ACCEPTED_CASE_CLOSURE);
  const ledger = structuredClone(f.records.get(first.budget!.scopeId));
  f.model.workBudgetPolicy!.limit = 1;
  f.model.workBudgetPolicy!.revision = 2;
  f.model.version.digest = "smaller-budget";
  f.model.version.repositoryVersion = "source-smaller-budget";
  await runtime.adoptModelVersion({ expectedDigest: "smaller-budget" });
  deepStrictEqual(f.records.get(first.budget!.scopeId), ledger);
  const restarted = f.create();
  await restarted.initialize();
  equal(restarted.snapshot.budgetSuspension, undefined);
  await turn(restarted);
  equal(restarted.cases.cases[1].modelPin.digest, "smaller-budget");
  equal(restarted.snapshot.workBudget!.limit, 1);
  equal(restarted.snapshot.workBudget!.consumed, 1);
  deepStrictEqual(f.records.get(first.budget!.scopeId), ledger);
});

Deno.test("a specialist contributes to the central Case and spends its shared reservation without opening another Case", async () => {
  const f = runtimeFixture();
  const runtime = f.create();
  await runtime.initialize();
  const policy = {
    id: "central-budget",
    revision: 1,
    unit: "agent-invocation" as const,
    limit: 2,
    onExhausted: "wait" as const,
    exhaustionRecipient: "local-control" as const,
  };
  await f.budget.adopt({
    scopeId: "central-case",
    ownerId: "coordinator",
    policy,
    previousPolicy: undefined,
    modelVersion: { digest: "central-pin" },
  });
  const input = {
    text: "Contribue à cet objectif",
    correlationId: "task-one",
    proof: {
      caseId: "central-case",
      callerId: "coordinator",
      invocationId: "invocation-one",
      caseContext: {
        caseId: "central-case",
        number: 12,
        modelPin: { digest: "central-pin" },
        budget: { scopeId: "central-case", ownerId: "coordinator", policy },
      },
      modelVersion: {
        digest: "central-pin",
        repositoryVersion: "central-source",
      },
      behavior: {
        id: "access-worker",
        name: "Dispatch",
        description: "Admitted inbox",
        targetNativeId: "inbox-worker",
        targetTypeId: "inbox-type",
        inputTypeId: "work-input",
        callerNativeId: "coordinator",
        sourceIds: ["access-native"],
        inputSchema: { type: "object" },
      },
    },
  };
  await runtime.submitWork(input);
  await runtime.idle();
  equal(runtime.cases.cases.length, 0);
  equal(runtime.snapshot.workBudget!.consumed, 1);
  equal(runtime.snapshot.workBudget!.scopeId, "central-case");
  equal(
    runtime.snapshot.messages.at(-1)!.text,
    "Quel résultat souhaites-tu ?",
  );
  equal(runtime.snapshot.messages.at(-1)!.caseId, "central-case");
  await runtime.submitWork(input);
  await runtime.idle();
  equal(f.contexts.length, 1);
  await rejects(() =>
    runtime.submitWork({
      ...input,
      proof: { ...input.proof, caseId: "other-case" },
    }), /autre contenu/);
  f.answer({ kind: "reply", text: "Terminé", caseClosure: "done" });
  await runtime.submitWork({ ...input, correlationId: "task-two" });
  await runtime.idle();
  equal(runtime.snapshot.error, undefined);
  equal(runtime.snapshot.messages.at(-1)!.text, "Terminé");
  equal(runtime.snapshot.messages.at(-1)!.caseId, "central-case");
  equal(
    recordedOperatorWork(
      runtime.snapshot,
      "operator",
      "coordinator",
      "task-two",
    )!.result.status,
    "completed",
  );
  equal(runtime.cases.cases.length, 0);
});

Deno.test("runtime closure awaits the shared Case reservation and leaves the Case open when a specialist is busy", async () => {
  const f = runtimeFixture();
  const runtime = f.create();
  await runtime.initialize();
  await turn(runtime);
  const record = runtime.cases.cases[0];
  let specialistBusy = true;
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  runtime.bindOperatorRegistry({
    snapshot: {
      systemId: "system",
      defaultAgentId: "operator",
      version: "1",
      conversations: [],
    },
    async withCaseClosure<T>(
      caseId: string,
      action: () => Promise<T>,
    ): Promise<T> {
      equal(caseId, record.id);
      if (specialistBusy) {
        throw new CaseError("CASE_BUSY", "Specialist still running");
      }
      entered.resolve();
      await released.promise;
      return await action();
    },
  });
  await rejects(
    () => runtime.closeCase(record.id, "done", ACCEPTED_CASE_CLOSURE),
    {
      code: "CASE_BUSY",
    },
  );
  equal(runtime.cases.cases[0].status, "waiting");
  equal(runtime.cases.cases[0].closedAt, undefined);
  specialistBusy = false;
  const closure = runtime.closeCase(record.id, "done", ACCEPTED_CASE_CLOSURE);
  await entered.promise;
  equal(runtime.cases.cases[0].closedAt, undefined);
  released.resolve();
  await closure;
  equal(runtime.cases.cases[0].status, "closed-done");
  equal(runtime.cases.cases[0].closedAt, clock.now());
});
