/** The production PostgreSQL budget packet used by scoped software adoption.
 * These witnesses do not stand in for native execution or full D2 adoption. */
import assert from "node:assert/strict";
import { PostgresWorkBudgetStore } from "../../src/adapters/out/postgres/budget-store.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  budgetState,
  type WorkBudgetPolicy,
} from "../../src/domain/work/policies/budget.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const scope = {
  projectId: "scoped-budget-project",
  systemId: "scoped-budget-system",
  executionSpaceId: "request-budget-space",
  operatorId: "owner",
};
const oldPolicy: WorkBudgetPolicy = {
  id: "retained-budget",
  revision: 1,
  unit: "agent-invocation",
  limit: 3,
  onExhausted: "wait",
  exhaustionRecipient: "local-control",
};
const nextPolicy: WorkBudgetPolicy = { ...oldPolicy, revision: 2, limit: 4 };
const oldModel = {
  digest: "old-model",
  repositoryVersion: "commit:" + "1".repeat(40),
};
const newModel = {
  digest: "new-model",
  repositoryVersion: "commit:" + "2".repeat(40),
};
const input = {
  scopeId: "case-budget",
  ownerId: scope.operatorId,
  previousPolicy: oldPolicy,
  policy: nextPolicy,
  modelVersion: newModel,
};

Deno.test({
  name:
    "postgres scoped budget packet commits atomically and rejects stale or unsafe ledgers",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = new PostgresWorkBudgetStore(client, scope),
        service = new WorkBudgetService(store);
      await service.adopt({
        ...input,
        previousPolicy: undefined,
        policy: oldPolicy,
        modelVersion: oldModel,
      });
      await service.reserve({
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        policy: oldPolicy,
        attemptId: "one",
        operation: "decide",
        modelVersion: oldModel,
      });
      await assert.rejects(
        () => store.prepareEvolutionBatch([input.scopeId], [input]),
        /reservation/i,
      );
      await service.settle({
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        attemptId: "one",
        outcome: "returned",
      });
      const before = await service.readRecord(input.scopeId, input.ownerId);
      await assert.rejects(
        () =>
          store.prepareEvolutionBatch([input.scopeId], [{
            ...input,
            policy: { ...nextPolicy, limit: 0 },
          }]),
        /budget/i,
      );
      assert.deepEqual(
        await service.readRecord(input.scopeId, input.ownerId),
        before,
      );

      const rollback = await store.prepareEvolutionBatch([input.scopeId], [
        input,
      ]);
      await assert.rejects(() =>
        client.$transaction(async (tx) => {
          const token = await store.lockEvolutionBatchInTransaction(
            tx,
            rollback.packet,
          );
          await store.saveEvolutionBatchLocked(tx, rollback.packet, token);
          throw new Error("abort after budget mutation");
        }), /abort after budget mutation/);
      assert.deepEqual(
        await service.readRecord(input.scopeId, input.ownerId),
        before,
      );

      const stale = await store.prepareEvolutionBatch([input.scopeId], [input]);
      await service.reserve({
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        policy: oldPolicy,
        attemptId: "two",
        operation: "review",
        modelVersion: oldModel,
      });
      await service.settle({
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        attemptId: "two",
        outcome: "returned",
      });
      const settled = await service.readRecord(input.scopeId, input.ownerId);
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            store.lockEvolutionBatchInTransaction(tx, stale.packet)
          ),
        /budget changed/i,
      );
      assert.deepEqual(
        await service.readRecord(input.scopeId, input.ownerId),
        settled,
      );

      const fresh = await store.prepareEvolutionBatch([input.scopeId], [input]);
      const projected = await fresh.projected.snapshot(
        input.scopeId,
        input.ownerId,
        nextPolicy,
      );
      await client.$transaction(async (tx) => {
        const token = await store.lockEvolutionBatchInTransaction(
          tx,
          fresh.packet,
        );
        await store.saveEvolutionBatchLocked(tx, fresh.packet, token);
      });
      const after = await service.readRecord(input.scopeId, input.ownerId);
      assert.deepEqual(after.events.slice(0, -1), settled.events);
      assert.equal(after.revision, settled.revision + 1);
      assert.deepEqual(budgetState(after).view, projected);
      assert.equal(budgetState(after).view.consumed, 2);
      assert.equal(budgetState(after).view.reserved, 0);
      assert.equal(after.events.at(-1)?.kind, "policy");
    });
  },
});
