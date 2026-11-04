import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { PostgresWorkPlanStore } from "../../src/adapters/out/postgres/plan-store.ts";
import { openPostgresExecutionFixtureHost } from "../support/postgres-runtime-fixture.ts";
import {
  nativeCaseFixtureModel,
  nativeWorkPlanFixture,
} from "../support/native-execution.ts";
import { caseExecutionContext } from "../../src/application/work/cases/runtime.ts";
import type { WorkPlanExecution } from "../../src/application/work/plans/commands/inputs.ts";
import { WorkPlanExecutor } from "../../src/application/work/plans/executor.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  CaseExecutionContext,
} from "../../src/domain/work/execution/modeled-behavior.ts";
import type { WorkPlanRecord } from "../../src/domain/work/entities/plans.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const at = "2026-10-24T00:00:00.000Z";
const forbidden = () => {
  throw new Error("Unexpected model or tool effect");
};

// Real PostgreSQL host, opt-in like postgres-production-runtime_test.ts: the
// suite is ignored without the URL and runs for real in PostgreSQL campaigns.

function operatorModel(id: string): ExecutableModel {
  // Unified Case/WorkPlan fixture composition (PostgreSQL host): the same
  // builder feeds the MemorySaver host in operator-case-continuations_test.ts.
  return nativeCaseFixtureModel(id, {
    identity: {
      projectId: "legacy-plans-project",
      rootId: "legacy-plans-root",
      editingContextId: "legacy-plans-context",
      systemId: `system-${id}`,
      catalogId: `catalog-${id}`,
    },
    repositoryVersion: "legacy-plans-source",
    instruction: id,
    primary: id === "first",
  });
}

/** Copy the context emitted by the initialized runtime, never reconstruct it. */
function correlate<T extends WorkPlanExecution | WorkPlanRecord>(
  original: T,
  context: CaseExecutionContext,
): T {
  const result = structuredClone(original);
  result.caseId = context.caseId;
  for (const task of result.tasks) {
    task.caseId = context.caseId;
    task.invocation.caseId = context.caseId;
    task.invocation.caseContext = structuredClone(context);
  }
  return result;
}

Deno.test({
  name:
    "a second migrated operator resumes its legacy plan once under its own Case, with durable immutable correlation",
  ignore: !postgresTestEnabled,
  async fn() {
    const postgres = await openPostgresExecutionFixtureHost({
      scope: { projectId: "legacy-plans-project", systemId: "legacy-plans" },
    });
    const runtimes: SystemRuntime[] = [];
    let store: PostgresWorkPlanStore | undefined;
    try {
      const secondStorage = await postgres.storage.operator("second");
      store = secondStorage.plans;
      const requests: BehaviorInvocationRequest[] = [];
      let waiting = true;
      const executor = () =>
        new WorkPlanExecutor({
          now: () => "2026-11-03T00:00:00.000Z",
          store: store!,
          invokeTarget(request) {
            requests.push(structuredClone(request));
            return Promise.resolve({
              invocationId: request.invocationId,
              behaviorId: request.behavior.id,
              targetNativeId: request.behavior.targetNativeId,
              modelVersion: request.modelVersion,
              result: waiting ? "waiting" : "completed",
            });
          },
          completion: (receipt) =>
            receipt.result === "waiting" ? "waiting" : "completed",
        });
      const secondModel = operatorModel("second");
      const version = {
        digest: secondModel.version.digest,
        repositoryVersion: secondModel.version.repositoryVersion!,
      };
      const request = await nativeWorkPlanFixture(
        "legacy-plan",
        "second",
        version,
      );
      const untouchedRequest = await nativeWorkPlanFixture(
        "other-legacy-plan",
        "second",
        version,
      );
      const legacy = await executor().execute(request);
      const untouched = await executor().execute(untouchedRequest);
      equal(legacy.status, "waiting");
      equal(legacy.caseId, undefined);
      equal(requests.length, 2);

      for (const model of [operatorModel("first"), secondModel]) {
        const id = model.identity.builderId;
        const runtimePorts = await postgres.runtimePortsFor(id);
        const stateStore = runtimePorts.store;
        // This historical state has no Case fields. initialize() performs the
        // real migration, using the system allocator shared by both operators.
        await stateStore.save({
          id: `conversation-${id}`,
          revision: 0,
          catalogRevision: 0,
          model: model.identity,
          executionModel: model,
          messages: [{
            id: `request-${id}`,
            role: "user",
            at,
            text: `Pending dossier for ${id}`,
          }],
          conversationCursor: {
            nodeId: model.flows.conversation.nodes.find((node) =>
              node.mechanism === "choose_move"
            )!.id,
          },
          candidates: [],
          events: [],
          busy: false,
          phase: "Continuation pending",
          provider: "legacy",
        }, null);
        const runtime = new SystemRuntime({
          ...runtimePorts,
          agents: {
            label: "legacy-plan-cases",
            decide: () =>
              Promise.resolve({
                kind: "reply" as const,
                text: "New objective",
              }),
            review: forbidden,
          },
          model: {
            ...unexpectedModelAuthoring,
            initialize: () => Promise.resolve(model.identity),
            readExecutableModel: () => Promise.resolve(structuredClone(model)),
            activateCandidate: forbidden,
            applyApprovedChange: forbidden,
            graph: () => Promise.resolve({}),
          },
          runner: { test: forbidden, run: forbidden },
        });
        runtimes.push(runtime);
        await runtime.initialize();
      }
      await postgres.start(async (delivery) => {
        const runtime = runtimes.find((entry) =>
          entry.snapshot.executionModel?.identity.builderId ===
            delivery.identity.operatorId
        );
        ok(runtime, "Delivery must resolve its admitted operator");
        await runtime.processAcceptedContribution(delivery);
      });
      const first = caseExecutionContext(runtimes[0].snapshot)!;
      const second = caseExecutionContext(runtimes[1].snapshot)!;
      equal(first.number, 1);
      equal(second.number, 2);
      equal(first.record?.migratedFrom, "legacy-dossier");
      equal(second.record?.migratedFrom, "legacy-dossier");
      equal(second.record?.owner, request.callerId);

      await rejects(
        () => executor().execute(correlate(request, first)),
        /legacy/i,
      );
      const wrongOwner = correlate(legacy, first);
      wrongOwner.revision++;
      await rejects(() => store!.save(wrongOwner, legacy.revision), /legacy/i);
      deepStrictEqual(await store.load(request.id), legacy);
      equal(requests.length, 2);

      waiting = false;
      const resumed = await executor().execute(correlate(request, second), {
        resume: true,
      });
      equal(resumed.status, "completed");
      equal(resumed.requestDigest, legacy.requestDigest);
      equal(resumed.caseId, second.caseId);
      equal(resumed.tasks[0].invocation.caseId, second.caseId);
      equal(resumed.tasks[0].attempts?.length, 2);
      equal(resumed.tasks[0].attempts?.[0].receipt?.caseId, undefined);
      equal(resumed.tasks[0].attempts?.[1].receipt?.caseId, second.caseId);
      equal(requests.length, 3);
      equal(requests[2].caseId, second.caseId);
      deepStrictEqual(requests[2].caseContext, second);
      await store.close();
      store = new PostgresWorkPlanStore(
        postgres.database.createClient(),
        secondStorage.scope,
      );
      deepStrictEqual(await store.load(request.id), resumed);
      // Replaying a completed bound plan does not call the target again.
      await executor().execute(correlate(request, second), { resume: true });
      equal(requests.length, 3);

      await runtimes[1].closeCase(second.caseId, "done", ACCEPTED_CASE_CLOSURE);
      await runtimes[1].submit(
        "A new objective after the historical dossier",
        undefined,
        undefined,
        true,
      );
      await postgres.idle(runtimes[1]);
      const fresh = caseExecutionContext(runtimes[1].snapshot)!;
      ok(fresh);
      equal(fresh.number, 3);
      equal(fresh.record?.migratedFrom, undefined);
      equal(fresh.record?.owner, request.callerId);
      await rejects(
        () => executor().execute(correlate(untouchedRequest, fresh)),
        /legacy/i,
      );
      const nonMigrated = correlate(untouched, fresh);
      nonMigrated.revision++;
      await rejects(
        () => store!.save(nonMigrated, untouched.revision),
        /legacy/i,
      );
      deepStrictEqual(await store.load(untouchedRequest.id), untouched);
      await rejects(
        () => executor().execute(correlate(request, fresh)),
        /different content/,
      );
      const reassigned = correlate(resumed, fresh);
      reassigned.revision++;
      await rejects(
        () => store!.save(reassigned, resumed.revision),
        /case changed/,
      );
      deepStrictEqual(await store.load(request.id), resumed);
      equal(requests.length, 3);
    } finally {
      try {
        await postgres.idle();
      } finally {
        await store?.close();
        await postgres.close();
      }
    }
  },
});
