import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import { closeCase, openCase } from "../../src/domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { selectCaseInvocation } from "../../src/application/work/cases/runtime.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

import { executableFixture } from "../support/execution-fixture.ts";

const scope = {
  projectId: "cases",
  systemId: "system",
  executionSpaceId: "baseline",
  operatorId: "owner",
};

Deno.test({
  name:
    "Request execution checkpoints survive PostgreSQL reopen and recover only their own state",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      await seedPostgresRuntime(database.client, scope);
      let store = await PostgresSystemStateStore.open(
        database.createClient(),
        scope,
      );
      const model = executableFixture({
        projectId: "project",
        editingContextId: "context",
        rootId: "root",
        systemId: "system",
        catalogId: "catalog",
        builderId: "owner",
      });
      const record = (id: string, number: number) =>
        openCase({
          id,
          number,
          type: "request",
          objective: id,
          owner: "owner",
          openedBy: "owner",
          openedFrom: { conversationId: "session" },
          modelPin: { digest: "pin" },
          budget: { budgetId: "budget", scopeId: id },
          createdAt: "2026-10-27T00:00:00.000Z",
        });
      const state: SystemRuntimeState = {
        id: "session",
        revision: 0,
        catalogRevision: 0,
        cases: [record("A", 1), record("B", 2)],
        messages: [],
        candidates: [],
        events: [],
        busy: false,
        phase: "waiting",
        provider: "test",
        caseInvocation: { kind: "local", caseId: "A" },
        executionModel: model,
        conversationCursor: { nodeId: "A-suspended" },
        conversationContext: { effectReceipt: "A-confirmed" },
        conversationFlow: model.flows.conversation,
        workBudgetBinding: { budgetId: "budget", scopeId: "A" },
        budgetSuspension: {
          nodeId: "A-suspended",
          operation: "decide",
          recipient: "local-control",
          reason: "exhausted",
          diagnostic: "A exhausted",
          dispatchStarted: false,
        },
      };
      try {
        selectCaseInvocation(state, { kind: "local", caseId: "B" });
        state.conversationCursor = { nodeId: "B-suspended" };
        state.conversationContext = { effectReceipt: "B-confirmed" };
        await store.save(state, null);
        await store.close();
        store = await PostgresSystemStateStore.open(
          database.createClient(),
          scope,
        );
        const recovered = (await store.load())!;
        selectCaseInvocation(recovered, { kind: "local", caseId: "A" });
        deepStrictEqual(recovered.conversationCursor, {
          nodeId: "A-suspended",
        });
        deepStrictEqual(recovered.conversationContext, {
          effectReceipt: "A-confirmed",
        });
        equal(
          recovered.conversationFlow!.rootNativeId,
          model.flows.conversation.rootNativeId,
        );
        deepStrictEqual(recovered.workBudgetBinding, {
          budgetId: "budget",
          scopeId: "A",
        });
        equal(recovered.budgetSuspension?.diagnostic, "A exhausted");
        selectCaseInvocation(recovered, { kind: "local", caseId: "B" });
        deepStrictEqual(recovered.conversationContext, {
          effectReceipt: "B-confirmed",
        });
        equal(recovered.budgetSuspension, undefined);
        deepStrictEqual(recovered.workBudgetBinding, {
          budgetId: "budget",
          scopeId: "B",
        });
      } finally {
        await store.close();
      }
    });
  },
});

Deno.test({
  name:
    "Case state survives PostgreSQL reopen without rewriting pre-Case history",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      await seedPostgresRuntime(database.client, scope);
      let store = await PostgresSystemStateStore.open(
        database.createClient(),
        scope,
      );
      const legacy: SystemRuntimeState = {
        id: "conversation",
        revision: 0,
        catalogRevision: 0,
        messages: [{ id: "old", role: "user", text: "Travail", at: "legacy" }],
        events: [],
        candidates: [],
        busy: false,
        phase: "waiting",
        provider: "fixture",
        workBudgetBinding: { budgetId: "budget", scopeId: "conversation" },
      };
      try {
        await store.save(legacy, null);
        const opened = structuredClone(legacy);
        opened.revision++;
        const record = openCase({
          id: "conversation:case:1",
          number: 1,
          type: "request",
          objective: "Travail",
          owner: "central",
          openedBy: "central",
          openedFrom: { conversationId: legacy.id, messageId: "old" },
          modelPin: { digest: "admitted", repositoryVersion: "revision-1" },
          budget: legacy.workBudgetBinding,
          createdAt: "2026-10-24T00:00:00.000Z",
        });
        opened.cases = [record];
        opened.caseInvocation = { kind: "local", caseId: record.id };
        opened.messages.push({
          id: "new",
          role: "assistant",
          text: "Case #1 : résultat",
          at: "2026-10-24T00:00:00.000Z",
          caseId: record.id,
        });
        opened.events.push({
          id: "trace",
          kind: "flow-enter",
          label: "Conversation",
          at: "2026-10-24T00:00:00.000Z",
          caseId: record.id,
        });
        await store.save(opened, 0);
        const closed = structuredClone(opened);
        closed.revision++;
        closed.cases = [closeCase(record, "done", "2026-10-24T01:00:00.000Z")];
        delete closed.caseInvocation;
        await store.save(closed, 1);
        await store.close();
        store = await PostgresSystemStateStore.open(
          database.createClient(),
          scope,
        );
        deepStrictEqual(await store.load(), closed);
        deepStrictEqual(await store.loadRevision(0), legacy);
        deepStrictEqual(await store.loadRevision(1), opened);
        deepStrictEqual(
          (await store.load())!.workBudgetBinding,
          legacy.workBudgetBinding,
        );
        const copy = (await store.load())!;
        copy.cases![0].modelPin.digest = "mutated-copy";
        equal((await store.load())!.cases![0].modelPin.digest, "admitted");

        const corrupt = structuredClone(closed);
        corrupt.revision++;
        corrupt.caseInvocation = { kind: "local", caseId: record.id };
        await rejects(() => store.save(corrupt, 2), { code: "INVALID_CASE" });
        deepStrictEqual(await store.load(), closed);
        equal((await store.listRevisions()).length, 3);

        const designer = structuredClone(closed);
        designer.revision++;
        designer.designer = {
          scopeId: "conversation:designer",
          budget: {
            budgetId: "designer-budget",
            scopeId: "conversation:designer",
          },
        };
        designer.caseInvocation = {
          kind: "designer",
          scopeId: designer.designer.scopeId,
        };
        designer.workBudgetBinding = structuredClone(designer.designer.budget);
        designer.messages.push({
          id: "design",
          role: "user",
          text: "Concevoir",
          at: "2026-10-24T02:00:00.000Z",
          designerScopeId: designer.designer.scopeId,
        });
        await store.save(designer, 2);
        await store.close();
        store = await PostgresSystemStateStore.open(
          database.createClient(),
          scope,
        );
        deepStrictEqual(await store.load(), designer);
      } finally {
        await store.close();
      }
    });
  },
});
