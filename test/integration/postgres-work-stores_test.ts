import {
  type ExecutionSql,
  withPostgresExecutionTransaction,
} from "../../src/adapters/out/postgres/execution-transaction.ts";
import assert from "node:assert/strict";
import { PostgresWorkPlanStore } from "../../src/adapters/out/postgres/plan-store.ts";
import { PostgresWorkBudgetStore } from "../../src/adapters/out/postgres/budget-store.ts";
import { PostgresCaseNumberAllocator } from "../../src/adapters/out/postgres/case-number-allocator.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  budgetState,
  WorkBudgetError,
  type WorkBudgetPolicy,
} from "../../src/domain/work/policies/budget.ts";
import type { WorkPlanRecord } from "../../src/domain/work/entities/plans.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const scope = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "space",
  operatorId: "operator",
};
function record(id = "plan-one"): WorkPlanRecord {
  const modelVersion = {
    digest: "model-digest",
    repositoryVersion: "branch:source",
  };
  return {
    id,
    callerId: "coordinator",
    modelVersion,
    origin: {
      behaviorId: "plan-exposure",
      targetNativeId: "plan-target",
      invocationId: id,
    },
    requestDigest: "request-digest",
    revision: 0,
    status: "admitted",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    tasks: [{
      id: "one",
      resourceId: "worker",
      inputDigest: "input-digest",
      dependsOn: [],
      state: "pending",
      invocation: {
        invocationId: `${id}:task:one`,
        callerId: "coordinator",
        modelVersion,
        behavior: {
          id: "native-exposure",
          name: "Inbox",
          description: "Modeled entry",
          targetNativeId: "worker-inbox",
          targetTypeId: "inbox-type",
          inputTypeId: "work-input",
          callerNativeId: "coordinator",
          sourceIds: ["native-exposure"],
          inputSchema: { type: "object" },
        },
        input: { text: "A scoped request" },
      },
    }],
  };
}

function verifiedRecord(): WorkPlanRecord {
  const original = record("verified-plan");
  const task = original.tasks[0]!;
  task.resultContract = {
    id: "result",
    callerNativeId: original.callerId,
    workBehaviorId: task.invocation.behavior.id,
    observationBehaviorId: "inspect",
    schemaVersion: "verified-effect-closure/v2",
    expected: {
      typeId: "expected",
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      values: { status: "published" },
    },
    observed: {
      typeId: "observed",
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
    condition: {
      nativeId: "condition",
      expression: {
        kind: "binary",
        op: "==",
        left: { kind: "path", root: "observed", path: ["status"] },
        right: { kind: "path", root: "expected", path: ["status"] },
      },
      sourceIds: ["condition"],
    },
    maxObservations: 2,
    sourceIds: ["source"],
  };
  task.observationInvocation = {
    ...structuredClone(task.invocation),
    invocationId: "read",
    behavior: { ...task.invocation.behavior, id: "inspect" },
  };
  task.observationInputDigest = "read-digest";
  task.resultVerification = {
    status: "pending",
    attempts: 0,
    observations: [],
  };
  return original;
}

const policy: WorkBudgetPolicy = {
  id: "budget",
  revision: 1,
  unit: "agent-invocation",
  limit: 1,
  onExhausted: "wait",
  exhaustionRecipient: "local-control",
};
const budgetInput = (attemptId: string) => ({
  scopeId: "case",
  ownerId: "builder",
  policy,
  attemptId,
  operation: "decide" as const,
  modelVersion: { digest: "model" },
});
const hasCode = (code: string) => (error: unknown): boolean =>
  error instanceof WorkBudgetError && error.code === code;

Deno.test({
  name:
    "PG-2 work plans isolate every scope axis, preserve exact history across reopen, and elect one CAS/create winner",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      const scopes = [
        scope,
        { ...scope, projectId: "other-project" },
        { ...scope, systemId: "other-system" },
        { ...scope, executionSpaceId: "sibling" },
        { ...scope, operatorId: "colleague" },
      ];
      for (const s of scopes) await seedPostgresRuntime(client, s);
      const otherClient = reopen();
      const store = new PostgresWorkPlanStore(client, scope);
      const contender = new PostgresWorkPlanStore(otherClient, scope);
      const original = record();
      const creation = await Promise.allSettled([
        store.save(original, null),
        contender.save(original, null),
      ]);
      assert.equal(creation.filter((r) => r.status === "fulfilled").length, 1);
      for (const s of scopes.slice(1)) {
        const isolated = new PostgresWorkPlanStore(client, s);
        assert.equal(await isolated.load(original.id), null);
        const local = record();
        local.requestDigest = s.projectId + s.systemId + s.executionSpaceId +
          s.operatorId;
        await isolated.save(local, null);
        assert.deepEqual(await isolated.load(local.id), local);
      }
      const running = {
        ...structuredClone(original),
        revision: 1,
        status: "running" as const,
      };
      running.tasks[0]!.state = "running";
      running.tasks[0]!.attempts = [{
        startedAt: "recorded",
        state: "running",
      }];
      const waiting = {
        ...structuredClone(original),
        revision: 1,
        status: "waiting" as const,
      };
      const updates = await Promise.allSettled([
        store.save(running, 0),
        contender.save(waiting, 0),
      ]);
      assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
      const winner = updates[0].status === "fulfilled" ? running : waiting;
      await assert.rejects(
        () =>
          store.save({ ...winner, revision: 2, requestDigest: "forged" }, 1),
        /identity changed/,
      );
      await store.close();
      await store.close();
      await assert.rejects(() => store.load(original.id), /closed/);
      // Closing one adapter must leave the shared host pool usable.
      assert.deepEqual(await contender.load(original.id), winner);
      await client.$disconnect();
      const afterRestart = new PostgresWorkPlanStore(reopen(), scope);
      assert.deepEqual(await afterRestart.load(original.id), winner);
    });
  },
});

Deno.test({
  name:
    "PG-2 work plans retain verification admission and observations and reject malformed stored envelopes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresWorkPlanStore(client, scope);
      const original = verifiedRecord();
      await assert.rejects(
        () => store.save({ ...original, revision: 1 }, null),
        /expected work-plan revision/,
      );
      assert.equal(await store.load(original.id), null);
      const writing = store.save(original, null);
      original.tasks[0]!.invocation.input.text = "caller mutated after save";
      await writing;
      assert.equal(
        (await store.load(original.id))!.tasks[0]!.invocation.input.text,
        "A scoped request",
      );
      const reserved = (await store.load(original.id))!;
      reserved.revision = 1;
      reserved.tasks[0]!.resultVerification!.attempts = 1;
      await store.save(reserved, 0);
      reserved.revision = 2;
      reserved.tasks[0]!.resultVerification!.status = "unknown";
      reserved.tasks[0]!.resultVerification!.observations.push({
        at: "2026-10-27T00:00:00.000Z",
        status: "unknown",
        error: "source unavailable",
      });
      await store.save(reserved, 1);
      const changed = structuredClone(reserved);
      changed.revision = 3;
      changed.tasks[0]!.resultContract!.expected.values.status = "different";
      await assert.rejects(() => store.save(changed, 2), /identity changed/);
      const reset = structuredClone(reserved);
      reset.revision = 3;
      reset.tasks[0]!.resultVerification!.attempts = 0;
      await assert.rejects(() => store.save(reset, 2), /verification/);
      const rewritten = structuredClone(reserved);
      rewritten.revision = 3;
      rewritten.tasks[0]!.resultVerification!.observations[0]!.error =
        "rewritten";
      await assert.rejects(
        () => store.save(rewritten, 2),
        /verification transition/,
      );
      const forged = structuredClone(reserved);
      forged.revision = 3;
      forged.tasks[0]!.resultVerification!.status = "verified";
      await assert.rejects(() => store.save(forged, 2), /verification/);
      await client.$disconnect();
      const fresh = reopen();
      assert.deepEqual(
        await new PostgresWorkPlanStore(fresh, scope).load(original.id),
        reserved,
      );
      await fresh.workPlan.updateMany({
        where: scope,
        data: { revision: 42n },
      });
      await assert.rejects(
        () => new PostgresWorkPlanStore(fresh, scope).load(original.id),
        /Corrupt work-plan identity or revision/,
      );
      await fresh.workPlan.updateMany({
        where: scope,
        data: { revision: BigInt(reserved.revision) },
      });
      await fresh.workPlan.updateMany({
        where: scope,
        data: { payload: "{}" },
      });
      await assert.rejects(
        () => new PostgresWorkPlanStore(fresh, scope).load(original.id),
        /Invalid stored work plan/,
      );
      const corrupt = record("wrong-identity");
      await fresh.workPlan.updateMany({
        where: scope,
        data: { payload: JSON.stringify(corrupt) },
      });
      await assert.rejects(
        () => new PostgresWorkPlanStore(fresh, scope).load(original.id),
        /Corrupt work-plan identity or revision/,
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 budgets atomically reserve the last credit, survive restart, and settle idempotently across connections",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const a = new WorkBudgetService(
        new PostgresWorkBudgetStore(client, scope),
      );
      const b = new WorkBudgetService(
        new PostgresWorkBudgetStore(reopen(), scope),
      );
      const adoption = {
        scopeId: "case",
        ownerId: "builder",
        previousPolicy: undefined,
        policy,
        modelVersion: { digest: "model" },
      };
      await Promise.all([a.adopt(adoption), b.adopt(adoption)]);
      const reservations = await Promise.allSettled([
        a.reserve(budgetInput("a")),
        b.reserve(budgetInput("b")),
      ]);
      assert.equal(
        reservations.filter((r) => r.status === "fulfilled").length,
        1,
      );
      const winner = reservations[0].status === "fulfilled" ? "a" : "b";
      const rejected = reservations.find((r) =>
        r.status === "rejected"
      ) as PromiseRejectedResult;
      assert.ok(hasCode("exhausted")(rejected.reason));
      await client.$disconnect();
      const fresh = reopen();
      const store = new PostgresWorkBudgetStore(fresh, scope);
      const c = new WorkBudgetService(store);
      assert.deepEqual(
        (await c.snapshot("case", "builder", policy))?.reserved,
        1,
      );
      await assert.rejects(
        () => c.reserve(budgetInput(winner)),
        hasCode("conflict"),
      );
      const settlement = {
        scopeId: "case",
        ownerId: "builder",
        attemptId: winner,
        outcome: "failed" as const,
      };
      await Promise.all([c.settle(settlement), b.settle(settlement)]);
      const ledger = (await store.load("case"))!;
      assert.equal(budgetState(ledger).view.consumed, 1);
      assert.equal(ledger.events.filter((e) => e.kind === "settle").length, 1);
      await assert.rejects(
        () => c.settle({ ...settlement, outcome: "returned" }),
        hasCode("conflict"),
      );
      await assert.rejects(
        () => c.snapshot("case", "builder", undefined),
        hasCode("missing-policy"),
      );
      const raised = { ...policy, revision: 2, limit: 2 };
      const increase = {
        ...adoption,
        previousPolicy: policy,
        policy: raised,
        modelVersion: { digest: "v2" },
      };
      await c.adopt(increase);
      await c.adopt(increase);
      await assert.rejects(
        () => c.reserve(budgetInput("stale")),
        hasCode("conflict"),
      );
      await assert.rejects(
        () => c.snapshot("case", "builder", policy),
        hasCode("conflict"),
      );
      await assert.rejects(
        () =>
          c.adopt({
            ...increase,
            previousPolicy: raised,
            policy: { ...raised, revision: 3, limit: 0 },
          }),
        hasCode("invalid"),
      );
      await assert.rejects(
        () =>
          c.adopt({
            ...increase,
            previousPolicy: raised,
            policy: { ...raised, id: "reset" },
          }),
        hasCode("conflict"),
      );
      await c.reserve({ ...budgetInput("second"), policy: raised });
      await c.settle({
        ...settlement,
        attemptId: "second",
        outcome: "returned",
      });
      assert.equal((await c.snapshot("case", "builder", raised))?.consumed, 2);
      const afterIncrease = (await store.load("case"))!;
      const forged = structuredClone(afterIncrease);
      forged.revision++;
      forged.ownerId = "impostor";
      forged.events.push({
        kind: "policy",
        policy: raised,
        modelVersion: { digest: "next" },
      });
      await assert.rejects(
        () => store.save(forged, afterIncrease.revision),
        hasCode("conflict"),
      );
      assert.deepEqual(await store.load("case"), afterIncrease);
      const isolatedScopes = [
        { ...scope, projectId: "other-project" },
        { ...scope, systemId: "other-system" },
        { ...scope, executionSpaceId: "sibling" },
        { ...scope, operatorId: "colleague" },
      ];
      for (const isolatedScope of isolatedScopes) {
        await seedPostgresRuntime(fresh, isolatedScope);
        const isolated = new PostgresWorkBudgetStore(fresh, isolatedScope);
        assert.equal(await isolated.load("case"), null);
        await new WorkBudgetService(isolated).adopt(adoption);
        assert.equal(
          budgetState((await isolated.load("case"))!).view.remaining,
          1,
        );
      }
      await fresh.workBudget.updateMany({
        where: scope,
        data: { payload: "{}" },
      });
      await assert.rejects(() => store.load("case"), hasCode("invalid"));
      await store.close();
      assert.equal(await fresh.workBudget.count(), 5);
      await assert.rejects(() => store.load("case"), hasCode("invalid"));
    });
  },
});

Deno.test({
  name:
    "PG-2 Case numbers are committed once across operators and spaces, independent per system, and exhaust safely",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const sibling = {
        ...scope,
        executionSpaceId: "sibling",
        operatorId: "colleague",
      };
      await seedPostgresRuntime(client, sibling);
      const a = new PostgresCaseNumberAllocator(client, scope);
      const b = new PostgresCaseNumberAllocator(reopen(), sibling);
      const allocations = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).allocate()),
      );
      assert.deepEqual(
        allocations.sort((x, y) => x - y),
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      await a.close();
      await assert.rejects(() => a.allocate(), /closed/);
      assert.equal(await b.allocate(), 21);
      await client.$disconnect();
      const fresh = reopen();
      const restarted = new PostgresCaseNumberAllocator(fresh, scope);
      assert.equal(await restarted.allocate(), 22);
      const other = { ...scope, systemId: "another-system" };
      await seedPostgresRuntime(fresh, other);
      assert.equal(
        await new PostgresCaseNumberAllocator(fresh, other).allocate(),
        1,
      );
      const otherProject = { ...scope, projectId: "another-project" };
      await seedPostgresRuntime(fresh, otherProject);
      assert.equal(
        await new PostgresCaseNumberAllocator(fresh, otherProject).allocate(),
        1,
      );
      await fresh.caseSequence.updateMany({
        where: { projectId: scope.projectId, systemId: scope.systemId },
        data: { lastNumber: BigInt(Number.MAX_SAFE_INTEGER - 1) },
      });
      assert.equal(await restarted.allocate(), Number.MAX_SAFE_INTEGER);
      await assert.rejects(() => restarted.allocate(), /exhausted or invalid/);
      assert.equal(
        (await fresh.caseSequence.findUniqueOrThrow({
          where: {
            projectId_systemId: {
              projectId: scope.projectId,
              systemId: scope.systemId,
            },
          },
        })).lastNumber,
        BigInt(Number.MAX_SAFE_INTEGER),
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 lost execution fence rolls back plan, budget reservation and Case number before commit",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      const plans = new PostgresWorkPlanStore(client, scope);
      const original = record();
      await plans.save(original, null);
      const budgetStore = new PostgresWorkBudgetStore(client, scope);
      const budgets = new WorkBudgetService(budgetStore);
      await budgets.adopt({
        scopeId: "case",
        ownerId: "builder",
        previousPolicy: undefined,
        policy,
        modelVersion: { digest: "model" },
      });
      const ledger = (await budgetStore.load("case"))!;
      const numbers = new PostgresCaseNumberAllocator(client, scope);
      assert.equal(await numbers.allocate(), 1);

      async function loseFenceAfterWrite(
        action: () => Promise<unknown>,
        inspect: (query: ExecutionSql) => Promise<void>,
      ): Promise<void> {
        let checks = 0;
        await assert.rejects(() =>
          withPostgresExecutionTransaction({
            client,
            fence: async (query) => {
              checks++;
              if (checks === 2) {
                // The post-write check sees this transaction's uncommitted bytes.
                await inspect(query);
                throw new Error("Worker claim lost before commit");
              }
            },
          }, action), /Worker claim lost before commit/);
        assert.equal(checks, 2);
      }

      const running = {
        ...structuredClone(original),
        revision: 1,
        status: "running" as const,
      };
      await loseFenceAfterWrite(() => plans.save(running, 0), async (query) => {
        const { rows } = await query(
          `SELECT "payload" FROM "${schema}"."WorkPlan"`,
        );
        assert.deepEqual(JSON.parse(rows[0].payload as string), running);
      });
      assert.deepEqual(await plans.load(original.id), original);

      await loseFenceAfterWrite(
        () => budgets.reserve(budgetInput("stale-attempt")),
        async (query) => {
          const { rows } = await query(
            `SELECT "payload" FROM "${schema}"."WorkBudget"`,
          );
          const uncommitted = JSON.parse(rows[0].payload as string);
          assert.equal(
            budgetState(uncommitted).attempts.has("stale-attempt"),
            true,
          );
        },
      );
      assert.deepEqual(await budgetStore.load("case"), ledger);
      assert.equal(
        budgetState((await budgetStore.load("case"))!).attempts.size,
        0,
      );

      await loseFenceAfterWrite(() => numbers.allocate(), async (query) => {
        const { rows } = await query(
          `SELECT "lastNumber" FROM "${schema}"."CaseSequence"`,
        );
        assert.equal(String(rows[0].lastNumber), "2");
      });
      assert.equal(
        (await client.caseSequence.findUniqueOrThrow({
          where: {
            projectId_systemId: {
              projectId: scope.projectId,
              systemId: scope.systemId,
            },
          },
        })).lastNumber,
        1n,
      );
      assert.equal(await numbers.allocate(), 2);
    });
  },
});

Deno.test({
  name:
    "PG-5 admitted plan identity and invocation inputs stay immutable across status updates",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresWorkPlanStore(client, scope);

      const original = record();
      await store.save(original, null);
      for (
        const mutate of [
          (plan: WorkPlanRecord) => plan.callerId = "other-operator",
          (plan: WorkPlanRecord) => plan.requestDigest = "other-request",
          (plan: WorkPlanRecord) => plan.origin!.behaviorId = "other-exposure",
          (plan: WorkPlanRecord) =>
            plan.origin!.targetNativeId = "other-target",
          (plan: WorkPlanRecord) => {
            delete plan.origin;
          },
          (plan: WorkPlanRecord) =>
            plan.tasks[0]!.invocation.input.text = "Changed effect",
        ]
      ) {
        const changed = structuredClone(original);
        changed.revision = 1;
        mutate(changed);
        await assert.rejects(() => store.save(changed, 0), /identity changed/);
        assert.deepEqual(await store.load(original.id), original);
      }
      const valid = {
        ...structuredClone(original),
        revision: 1,
        status: "completed" as const,
      };
      await store.save(valid, 0);
      assert.equal((await store.load(original.id))!.revision, 1);
    });
  },
});

Deno.test({
  name:
    "PG-5 legacy plans remain readable but cannot acquire a planning origin after admission",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresWorkPlanStore(client, scope);

      const legacy = record();
      delete legacy.origin;
      await store.save(legacy, null);
      assert.deepEqual(await store.load(legacy.id), legacy);
      const forged = { ...legacy, origin: record().origin, revision: 1 };
      await assert.rejects(() => store.save(forged, 0), /identity changed/);
      await assert.rejects(
        () =>
          store.save({
            ...record("invalid"),
            origin: { ...record().origin!, invocationId: "other-plan" },
          }, null),
        /Invalid stored work-plan origin/,
      );
      assert.deepEqual(await store.load(legacy.id), legacy);
    });
  },
});

Deno.test({
  name:
    "PG-5 plan IDs, SQL-looking strings and prototype-looking JSON keys remain ordinary bound data",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresWorkPlanStore(client, scope);

      const original = record(
        "plan'); DROP TABLE operator_work_plans; -- / ../ other",
      );
      original.tasks[0]!.invocation.input = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"note":"data"},"sql":"DROP TABLE operator_work_plans;\\n--"}',
      );
      await store.save(original, null);
      assert.deepEqual(await store.load(original.id), original);
      await store.save(record("unrelated"), null);
      assert.equal((await store.load("unrelated"))!.id, "unrelated");
      assert.equal(
        Object.hasOwn(
          (await store.load(original.id))!.tasks[0]!.invocation.input,
          "__proto__",
        ),
        true,
      );
      assert.equal(
        (Object.prototype as Record<string, unknown>).polluted,
        undefined,
      );
    });
  },
});
