import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import type { WorkBudgetRecord } from "../../src/domain/work/policies/budget.ts";
import { compileNativeFixtureFlows } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { artifactModel } from "../support/tool-artifact-fixture.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";

function fixture() {
  const model = artifactModel("builder");
  model.identity.reviewerId = "reviewer-native";
  model.configuration.reviewer = {
    id: "reviewer",
    name: "Reviewer",
    mandateRevision: 1,
  };
  model.configuration.builder.admissionAuthority = "reviewer";
  model.flows = compileNativeFixtureFlows(128, "reviewer-native");
  model.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 1,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
    elementId: "budget-native",
    sourceIds: [],
  };
  let saved: SystemRuntimeState | null = null;
  let calls = 0, reviews = 0, reviewFails = false;
  const records = new Map<string, WorkBudgetRecord>();
  const workBudget = new WorkBudgetService({
    load: (scopeId) =>
      Promise.resolve(structuredClone(records.get(scopeId) ?? null)),
    save: (next, expected) => {
      equal(records.get(next.scopeId)?.revision ?? null, expected);
      records.set(next.scopeId, structuredClone(next));
      return Promise.resolve();
    },
  });
  const forbidden = () => {
    throw new Error("Unexpected effect");
  };
  const versions = new Map([[
    model.version.repositoryVersion,
    structuredClone(model),
  ]]);
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: (_identity, version) => {
      versions.set(model.version.repositoryVersion, structuredClone(model));
      const retained = version === undefined ? model : versions.get(version);
      ok(retained, "The exact fixture source must be retained");
      return Promise.resolve(structuredClone(retained));
    },
    applyApprovedChange: forbidden,
    activateCandidate: (_identity, candidate) => {
      const binding = {
        elementId: `native-${candidate.id}`,
        graphPath: "fixture",
      };
      model.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: model.contracts[0]!.nativeId,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      return Promise.resolve(binding);
    },
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
  }, workBudget);
  const create = () => {
    const service = new SystemRuntime({
      model: native,
      workBudget,
      store: execution.store,
      execution: execution.execution,
      dispatch: execution.dispatch,
      stateHistory: execution.stateHistory,
      agents: {
        label: "test",
        decide: () => {
          calls++;
          return Promise.resolve(
            calls === 1
              ? {
                kind: "propose_tool" as const,
                text: "Prepare the reader",
                tool: {
                  name: "reader",
                  description: "Reader",
                  kind: "read_web_page" as const,
                  code: "export default ({html}) => ({title:'Page',text:html})",
                },
              }
              : { kind: "reply" as const, text: "New Case started" },
          );
        },
        review: (candidate) => {
          reviews++;
          if (reviewFails) throw new Error("Review failed after resumption");
          return Promise.resolve({
            candidateDigest: candidate.digest,
            verdict: "approve",
            reason: "reviewed",
          });
        },
      },
      runner: {
        run: forbidden,
        test: () => Promise.resolve({ passed: true, checks: [] }),
      },
    });
    const initialize = service.initialize.bind(service);
    const localIdle = service.idle.bind(service);
    service.initialize = async (...args) => {
      await initialize(...args);
      execution.bind(service);
      service.idle = async () => {
        await localIdle();
        await execution.idle();
        await localIdle();
      };
    };
    return service;
  };
  return {
    create,
    execution,
    model,
    counts: () => ({ calls, reviews }),
    failReview: () => {
      reviewFails = true;
    },
  };
}

async function turn(
  runtime: SystemRuntime,
  text = "Prepare a reader",
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

Deno.test("abandoning a budget-suspended review terminates its candidate and permits a fresh Case", async () => {
  const f = fixture();
  const initial = f.create();
  await initial.initialize();
  await turn(initial);
  const beforeRestart = await f.execution.execution.inspect("builder");
  const runtime = f.create();
  await runtime.initialize();
  deepStrictEqual(
    await f.execution.execution.inspect("builder"),
    beforeRestart,
  );
  const first = runtime.cases.cases[0]!;
  const candidate = runtime.snapshot.candidates[0]!;
  equal(candidate.caseId, first.id);
  equal(candidate.stage, "reviewing");
  const promotion = beforeRestart.find((snapshot) =>
    snapshot.identity.purpose === "promotion" &&
    snapshot.identity.subjectId === candidate.promotionExecution?.subjectId
  );
  ok(promotion?.checkpointId);
  equal(promotion.status, "waiting");
  deepStrictEqual(
    promotion.waits.map((wait) => ({
      kind: wait.kind,
      mechanism: wait.mechanism,
    })),
    [{ kind: "budget", mechanism: "review_candidate" }],
  );
  deepStrictEqual(promotion.unsettledEffects, []);
  const checkpoint = (await f.execution.checkpoints()).find((entry) =>
    entry.threadId === promotion.threadId
  );
  ok(checkpoint);
  equal(checkpoint.checkpointId, promotion.checkpointId);
  equal(checkpoint.runId, promotion.runId);
  equal(runtime.snapshot.budgetSuspension?.operation, "review");
  equal(runtime.snapshot.budgetSuspension?.candidateId, candidate.id);
  equal(f.counts().reviews, 0);
  await rejects(() => runtime.closeCase(first.id, "done"), {
    code: "CASE_BUSY",
  });
  equal(runtime.cases.cases[0]!.status, "waiting");

  await runtime.closeCase(first.id, "abandoned");
  const failed = runtime.snapshot.candidates[0]!;
  equal(failed.stage, "failed");
  equal(failed.error, "Case abandoned");
  equal(failed.promotionCursor, undefined);
  equal(failed.promotionContext, undefined);
  equal(runtime.snapshot.budgetSuspension, undefined);
  equal(runtime.snapshot.budgetPromotionCandidateId, undefined);
  equal(runtime.cases.cases[0]!.status, "closed-abandoned");
  equal(f.model.catalog.length, 0);
  equal(failed.binding, undefined);
  const closedPromotion = (await f.execution.execution.inspect("builder")).find(
    (snapshot) => snapshot.threadId === promotion.threadId,
  );
  ok(closedPromotion);
  equal(closedPromotion.status, "completed");
  equal(closedPromotion.checkpointId, promotion.checkpointId);
  equal(f.counts().reviews, 0);

  await turn(runtime, "Start another request");
  equal(f.counts().calls, 2);
  const second = runtime.cases.cases[1]!;
  notEqual(second.id, first.id);
  equal(second.number, 2);
  equal(runtime.snapshot.workBudget?.consumed, 1);
  equal(runtime.snapshot.workBudget?.scopeId, second.id);
  equal(runtime.snapshot.messages.at(-1)?.caseId, second.id);
  equal(runtime.snapshot.candidates[0]!.caseId, first.id);
});

Deno.test("a failed native review preserves its unknown receipt when the Case completes", async () => {
  const f = fixture();
  const runtime = f.create();
  await runtime.initialize();
  await turn(runtime);
  const first = runtime.cases.cases[0]!;
  const promotion = (await f.execution.execution.inspect("builder")).find((
    snapshot,
  ) => snapshot.identity.purpose === "promotion");
  ok(promotion?.checkpointId);
  equal(promotion.status, "waiting");
  f.failReview();
  f.model.workBudgetPolicy!.limit = 3;
  f.model.workBudgetPolicy!.revision = 2;
  f.model.version.digest = "budget-expanded";
  f.model.version.repositoryVersion = "commit:budget-expanded";
  await runtime.adoptModelVersion({ expectedDigest: "budget-expanded" });
  await rejects(
    () => turn(runtime, "Resume the review", first.id),
    /Review failed after resumption/,
  );
  equal(f.counts().reviews, 1);
  equal(runtime.cases.cases.length, 1);
  const failed = runtime.snapshot.candidates[0]!;
  equal(failed.caseId, first.id);
  equal(failed.stage, "failed");
  equal(failed.error, "Review failed after resumption");
  equal(failed.promotionCursor, undefined);
  equal(failed.promotionContext, undefined);
  const uncertain = (await f.execution.execution.inspect("builder")).find((
    snapshot,
  ) => snapshot.threadId === promotion.threadId);
  ok(uncertain);
  equal(uncertain.status, "uncertain");
  equal(uncertain.unsettledEffects.length, 1);
  equal(f.model.catalog.length, 0);
  await runtime.closeCase(first.id, "done");
  equal(runtime.cases.cases[0]!.status, "closed-done");
  deepStrictEqual(
    (await f.execution.execution.inspect("builder")).find((snapshot) =>
      snapshot.threadId === promotion.threadId
    ),
    uncertain,
  );
  equal(f.counts().reviews, 1);
});
