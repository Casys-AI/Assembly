import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import legacy from "../fixtures/legacy-specialist-awaiting-admission.json" with {
  type: "json",
};
import { draftDigest, SystemRuntime } from "../support/system-runtime.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import {
  candidateCaseId,
  candidateCaseInvocation,
  recordedOperatorWork,
} from "../../src/application/work/operators/journal.ts";

/** Captured from the pre-Cases HEAD runtime, not a fabricated continuation.
 * The fixture records its source revision and contains the original journals,
 * candidate, native model and interpreter cursors/context without modification.
 */
function fixture() {
  const native = structuredClone(legacy.native) as unknown as ExecutableModel;
  let saved = structuredClone(legacy.state) as unknown as SystemRuntimeState;
  const contexts: ChatContext[] = [];
  let publications = 0;
  const forbidden = () => {
    throw new Error("The legacy continuation must not repeat its preparation");
  };
  const create = () =>
    new SystemRuntime({
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(native.identity)),
        readExecutableModel: () => Promise.resolve(structuredClone(native)),
        applyApprovedChange: forbidden,
        activateCandidate: (_identity, candidate) => {
          publications++;
          const entry = native.catalog.find((entry) =>
            entry.candidateId === candidate.id
          );
          ok(entry);
          entry.status = "active";
          return Promise.resolve({
            elementId: entry.nativeId,
            graphPath: candidate.binding?.graphPath ??
              `catalog/${candidate.id}`,
          });
        },
        graph: () => Promise.resolve({}),
      },
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (next, expected) => {
          equal(saved.revision, expected);
          saved = structuredClone(next);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      agents: {
        label: "legacy-regression",
        decide: (context) => {
          contexts.push(structuredClone(context));
          return Promise.resolve({
            kind: "reply",
            text: "Réponse finale du spécialiste.",
          });
        },
        review: forbidden,
      },
      runner: { test: forbidden, run: forbidden },
    });
  return {
    create,
    contexts,
    native,
    saved: () => saved,
    publications: () => publications,
  };
}

function result(state: SystemRuntimeState) {
  return recordedOperatorWork(
    state,
    "worker",
    "coordinator",
    "plan:task:legacy",
  )!.result;
}

Deno.test("legacy ownership migrates without inventing native admission, then a fresh Case runs independently", async () => {
  const f = fixture();
  const historical = structuredClone(f.saved());
  equal(historical.cases, undefined);
  equal(historical.caseInvocation, undefined);
  equal(historical.candidates[0].caseId, undefined);
  equal(historical.messages.some((message) => message.role === "user"), false);
  equal(result(historical).status, "waiting");
  const runtime = f.create();
  await runtime.initialize();
  const migrated = runtime.snapshot;
  const record = migrated.cases![0];
  const candidate = migrated.candidates[0];
  equal(record.number, 1);
  equal(record.migratedFrom, "legacy-dossier");
  equal(record.owner, "worker");
  equal(record.openedBy, "coordinator");
  equal(
    record.objective,
    historical.messages.find((message) => message.work)!.text,
  );
  equal(candidate.caseId, record.id);
  equal(candidate.digest, historical.candidates[0].digest);
  equal(await draftDigest(candidate), historical.candidates[0].digest);
  deepStrictEqual(migrated.messages, historical.messages);
  deepStrictEqual(
    migrated.events.slice(0, historical.events.length),
    historical.events,
  );
  deepStrictEqual(migrated.conversationCursor, historical.conversationCursor);
  equal(f.contexts.length, 0);
  equal(migrated.budgetSuspension, undefined);
  const catalog = structuredClone(f.native.catalog);

  await runtime.decideCandidate({
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Code et essais historiques examinés",
  });
  await rejects(
    () => runtime.idle(),
    /La décision humaine ne possède pas de continuation d’admission native/,
  );
  deepStrictEqual(runtime.snapshot.candidates[0], candidate);
  deepStrictEqual(f.native.catalog, catalog);
  deepStrictEqual(result(runtime.snapshot), result(migrated));
  equal(f.publications(), 0);
  equal(f.contexts.length, 0);
  await runtime.closeCase(record.id, "abandoned");
  equal(runtime.snapshot.candidates[0].stage, "failed");
  equal(runtime.cases.cases[0].status, "closed-abandoned");
  await runtime.submit(
    "Nouveau dossier indépendant",
    undefined,
    undefined,
    true,
  );
  await runtime.idle();
  const fresh = runtime.cases.cases[1];
  notEqual(fresh.id, record.id);
  equal(fresh.number, 2);
  equal(f.contexts.length, 1);
  equal(f.contexts[0].case?.id, fresh.id);
  equal(runtime.snapshot.messages.at(-1)?.caseId, fresh.id);
  equal(runtime.snapshot.candidates[0].caseId, record.id);
  equal(f.publications(), 0);
  deepStrictEqual(f.native.catalog, catalog);
  notEqual(result(runtime.snapshot).status, "completed");
  equal(
    result(runtime.snapshot).messages.some((message) =>
      message.text === "Réponse finale du spécialiste."
    ),
    false,
  );

  const reloaded = f.create();
  await reloaded.initialize();
  equal(reloaded.cases.cases.length, 2);
  equal(reloaded.snapshot.candidates[0].caseId, record.id);
  deepStrictEqual(result(reloaded.snapshot), result(runtime.snapshot));
  equal(f.contexts.length, 1);
});

Deno.test("abandoning a migrated Case terminates its historical candidate before a second Case can admit it", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  const first = runtime.cases.cases[0];
  const candidate = runtime.snapshot.candidates[0];
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.caseId, first.id);
  await runtime.closeCase(first.id, "abandoned");
  const abandoned = runtime.snapshot.candidates[0];
  equal(abandoned.stage, "failed");
  equal(abandoned.error, "Case abandoned");
  equal(abandoned.caseId, first.id);
  equal(abandoned.promotionCursor, undefined);
  equal(abandoned.promotionContext, undefined);
  equal(
    f.native.catalog.find((entry) => entry.candidateId === candidate.id)!
      .status,
    "awaiting-admission",
  );

  await runtime.submit(
    "Nouveau dossier indépendant",
    undefined,
    undefined,
    true,
  );
  await runtime.idle();
  const second = runtime.cases.cases[1];
  equal(second.number, 2);
  equal(f.contexts.length, 1);
  const beforeAdmission = runtime.snapshot;
  await rejects(async () => {
    await runtime.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Cette admission périmée doit être refusée",
    });
    await runtime.idle();
  }, { code: "CASE_CLOSED" });
  deepStrictEqual(runtime.snapshot, beforeAdmission);
  equal(runtime.snapshot.candidates[0].stage, "failed");
  equal(f.contexts.length, 1);
  ok(
    runtime.snapshot.events.filter((event) =>
      event.candidateId === candidate.id
    )
      .every((event) =>
        event.caseId === undefined || event.caseId === first.id
      ),
  );
  equal(
    runtime.snapshot.events.some((event) =>
      event.candidateId === candidate.id && event.caseId === second.id
    ),
    false,
  );
});

Deno.test("a saved pending continuation with an empty Case set fails during initialize before budget handling", async () => {
  const f = fixture();
  f.saved().cases = [];
  const runtime = f.create();
  await rejects(() => runtime.initialize(), (error: unknown) => {
    ok(error instanceof Error);
    const coded = error as Error & {
      code?: string;
      context?: unknown;
      recovery?: unknown;
    };
    equal(coded.code, "CASE_SCOPE_MISSING");
    ok(coded.context);
    ok(coded.recovery);
    return true;
  });
  equal(f.contexts.length, 0);
  equal(f.saved().budgetSuspension, undefined);
});

Deno.test("a candidate without persisted ownership cannot borrow an event or the current open Case", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  const state = runtime.snapshot;
  const candidate = state.candidates[0];
  const record = state.cases![0];
  deepStrictEqual(state.caseInvocation, { kind: "local", caseId: record.id });
  // Even an event naming the same active Case is insufficient ownership.
  state.events.find((event) => event.candidateId === candidate.id)!.caseId =
    record.id;
  delete candidate.caseId;
  equal(candidateCaseId(state, candidate.id), undefined);
  const before = structuredClone(state);
  throws(() => candidateCaseInvocation(state, candidate), {
    code: "CASE_SCOPE_MISSING",
    context: { conversationId: state.id, candidateId: candidate.id },
    recovery:
      "Reload the original pre-Cases dossier through initialize() to migrate it before deciding this candidate.",
  });
  deepStrictEqual(state, before);
});

Deno.test("initialize refuses missing candidate ownership even when its migrated Case is still open", async () => {
  const f = fixture();
  await f.create().initialize();
  const saved = f.saved();
  const candidate = saved.candidates[0];
  const record = saved.cases![0];
  equal(record.status, "waiting");
  equal(record.migratedFrom, "legacy-dossier");
  deepStrictEqual(saved.caseInvocation, { kind: "local", caseId: record.id });
  saved.events.find((event) => event.candidateId === candidate.id)!.caseId =
    record.id;
  delete candidate.caseId;
  const before = structuredClone(saved);
  await rejects(() => f.create().initialize(), {
    code: "CASE_SCOPE_MISSING",
    context: { conversationId: saved.id, candidateId: candidate.id },
    recovery:
      "Reload the original pre-Cases dossier through initialize() to migrate it before deciding this candidate.",
  });
  deepStrictEqual(f.saved(), before);
  equal(f.contexts.length, 0);
  equal(f.saved().budgetSuspension, undefined);
});

Deno.test("abandoning a migrated candidate keeps its stage event on its owner after another delegated Case runs", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  const owner = runtime.cases.cases[0];
  const candidate = runtime.snapshot.candidates[0];
  await runtime.submitWork({
    text: "Contribution indépendante au Case central",
    correlationId: "other-central-work",
    proof: {
      callerId: "coordinator",
      invocationId: "another-invocation",
      modelVersion: {
        digest: "central-pin",
        repositoryVersion: "central-source",
      },
      caseId: "central:case:12",
      caseContext: {
        caseId: "central:case:12",
        number: 12,
        modelPin: {
          digest: "central-pin",
          repositoryVersion: "central-source",
        },
      },
      behavior: {
        id: "access-worker",
        name: "Dispatch",
        description: "Admitted inbox",
        callerNativeId: "coordinator",
        targetNativeId: "inbox-worker",
        targetTypeId: "inbox-type",
        inputTypeId: "work-input",
        inputSchema: { type: "object" },
        sourceIds: [],
      },
    },
  });
  await runtime.idle();
  equal(runtime.snapshot.caseInvocation?.kind, "delegated");
  await runtime.closeCase(owner.id, "abandoned");
  const failed = runtime.snapshot.events.findLast((event) =>
    event.kind === "tool-failed" && event.candidateId === candidate.id
  );
  ok(failed);
  equal(failed.caseId, owner.id);
  equal(runtime.snapshot.candidates[0].caseId, owner.id);
});
