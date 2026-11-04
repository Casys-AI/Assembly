import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import assert from "node:assert/strict";
import { OperatorCases } from "../../src/application/work/cases/operators.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresExecutionFixtureHost } from "../support/postgres-runtime-fixture.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
} from "../support/postgres.ts";

const forbidden = () => {
  throw new Error("Unexpected external effect");
};

async function openSystem(database?: PostgresTestDatabase) {
  const postgres = await openPostgresExecutionFixtureHost({
    database,
    scope: { projectId: "project", systemId: "case-numbering" },
  });
  const runtimes = new Map<string, SystemRuntime>();
  const units = [];
  for (const id of ["central", "specialist"]) {
    const model = executableFixture({
      projectId: "project",
      rootId: "root",
      editingContextId: "context",
      systemId: `system-${id}`,
      catalogId: `catalog-${id}`,
      builderId: id,
    });
    model.version.repositoryVersion = "source";
    model.operator = {
      name: id,
      instruction: id,
      humanInput: true,
      primary: id === "central",
    };
    const runtime = new SystemRuntime({
      ...await postgres.runtimePortsFor(id),
      agents: {
        label: "case-numbering",
        decide: () =>
          Promise.resolve({ kind: "reply" as const, text: "Réponse" }),
        review: forbidden,
      },
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(model.identity),
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        applyApprovedChange: forbidden,
        activateCandidate: forbidden,
        graph: () => Promise.resolve({}),
      },
      runner: { test: forbidden, run: forbidden },
    });
    await runtime.initialize();
    runtimes.set(id, runtime);
    units.push({ systemQualifiedName: `System::${id}`, model });
  }
  const primary = runtimes.get("central")!;
  const conversations = new OperatorConversations({
    primary,
    factory: {
      open: (unit) =>
        Promise.resolve(runtimes.get(unit.model.identity.builderId)!),
    },
  });
  for (const runtime of runtimes.values()) {
    runtime.bindOperatorRegistry(conversations);
  }
  await conversations.initialize({ repositoryVersion: "source", units });
  await postgres.start(async (delivery) => {
    const runtime = runtimes.get(delivery.identity.operatorId);
    assert(runtime, "Delivery must resolve its admitted operator");
    await runtime.processAcceptedContribution(delivery);
  });
  return {
    database: postgres.database,
    idle: () => postgres.idle(),
    conversations,
    cases: new OperatorCases({
      systemId: () => primary.snapshot.id,
      runtimes: () => [...runtimes.values()],
      onChange: (listener) => conversations.onChange(listener),
    }),
    async close() {
      try {
        await postgres.idle();
        await conversations.dispose();
      } finally {
        await postgres.close({ retainDatabase: true });
      }
    },
  };
}

Deno.test({
  name:
    "Case numbers are unique across operator runtimes and durable after restart",
  ignore: !postgresTestEnabled,
  async fn() {
    let database: PostgresTestDatabase | undefined;
    let system: Awaited<ReturnType<typeof openSystem>> | undefined;
    try {
      system = await openSystem(database);
      database = system.database;
      await Promise.all(
        system.conversations.snapshot.conversations.map((entry) =>
          system!.conversations.submitHuman({
            agentId: entry.agentId,
            expectedRevision: entry.revision,
            text: `Première demande ${entry.agentId}`,
            newConversation: true,
          })
        ),
      );
      await system.idle();
      const snapshot = system.cases.cases;
      assert.equal(snapshot.cases.length, 2);
      assert.deepEqual(
        snapshot.cases.map((entry) => entry.number).sort((a, b) => a - b),
        [1, 2],
      );
      assert.equal(new Set(snapshot.cases.map((entry) => entry.id)).size, 2);
      for (const record of snapshot.cases) {
        await system.cases.closeCase(record.id, "done", ACCEPTED_CASE_CLOSURE);
      }
      await system.close();
      system = await openSystem(database);
      database = system.database;
      assert.equal(system.cases.cases.systemId, snapshot.systemId);
      for (const entry of system.conversations.snapshot.conversations) {
        await system.conversations.submitHuman({
          agentId: entry.agentId,
          expectedRevision: entry.revision,
          text: `Demande après redémarrage ${entry.agentId}`,
          newConversation: true,
        });
      }
      await system.idle();
      assert.deepEqual(
        system.cases.cases.cases.map((entry) => entry.number).sort((a, b) =>
          a - b
        ),
        [1, 2, 3, 4],
      );
    } finally {
      try {
        await system?.close();
      } finally {
        await database?.close();
      }
    }
  },
});
