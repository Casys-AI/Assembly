import assert from "node:assert/strict";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";

const system = { projectId: "git:source-project", systemId: "host-system" };
const initial = (text: string): SystemRuntimeState => ({
  id: "equal-local-runtime-id",
  revision: 0,
  catalogRevision: 0,
  busy: false,
  phase: "ready",
  provider: "fixture",
  messages: [{
    id: "equal-message-id",
    role: "user",
    text,
    at: "2026-10-27T00:00:00.000Z",
  }],
  candidates: [],
  events: [],
});

Deno.test({
  name:
    "PG-4 host composition creates real parent scopes and preserves operator isolation across reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const configuration = postgresClientConfiguration(
        database.connectionString,
        2,
        database.schema,
      );
      let host = new PostgresHostStorage(configuration);
      try {
        await host.registerSystem(system);
        await host.registerRepository("repository", host.sourceScopeId);
        await host.registerRepository("repository", host.sourceScopeId);
        await assert.rejects(
          host.registerRepository("repository", "changed-scope"),
          /scope changed/,
        );
        const [first, second] = await Promise.all([
          host.operator("operator-one"),
          host.operator("operator-two"),
        ]);
        assert.equal(await host.operator("operator-one"), first);
        assert.equal(first.scope.systemId, "host-system");
        assert.equal(first.scope.executionSpaceId, "main");
        await Promise.all([
          first.state.save(initial("one"), null),
          second.state.save(initial("two"), null),
        ]);
        const numbers = host.caseNumbers();
        assert.equal(await numbers.allocate(), 1);
        await host.close();
        await assert.rejects(numbers.allocate(), /closed/);
        host = new PostgresHostStorage(configuration);
        await host.registerSystem(system);
        const reopened = await host.operator("operator-one");
        assert.equal((await reopened.state.load())?.messages[0].text, "one");
        assert.equal(
          (await (await host.operator("operator-two")).state.loadRevision(0))
            ?.messages[0].text,
          "two",
        );
        assert.equal((await reopened.state.listRevisions()).length, 1);
        assert.equal(await host.caseNumbers().allocate(), 2);
        assert.equal(await database.client.operatorRuntime.count(), 2);
        await host.close();
        assert.equal(await database.client.project.count(), 1);
      } finally {
        await host.close();
      }
    });
  },
});

Deno.test({
  name:
    "Case space views share one host client and isolate identical operator storage",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const host = new PostgresHostStorage(
        postgresClientConfiguration(
          database.connectionString,
          2,
          database.schema,
        ),
      );
      try {
        await host.registerSystem(system);
        const client = host.client;
        for (
          const [caseId, number, executionSpaceId] of [
            ["case-a", 1, "space-a"],
            ["case-b", 2, "space-b"],
          ] as const
        ) {
          await client.caseIdentity.create({
            data: { ...system, caseId, number: BigInt(number) },
          });
          await client.executionSpace.create({
            data: {
              ...system,
              executionSpaceId,
              caseId,
              parentExecutionSpaceId: "main",
            },
          });
        }
        await client.project.create({ data: { projectId: "foreign" } });
        await client.assemblySystem.create({
          data: { projectId: "foreign", systemId: system.systemId },
        });
        await client.caseIdentity.create({
          data: {
            projectId: "foreign",
            systemId: system.systemId,
            caseId: "foreign-case",
            number: 1n,
          },
        });
        await client.executionSpace.create({
          data: {
            projectId: "foreign",
            systemId: system.systemId,
            executionSpaceId: "foreign-space",
            caseId: "foreign-case",
          },
        });
        const [a, b] = await Promise.all([
          host.caseSpace("space-a", "case-a"),
          host.caseSpace("space-b", "case-b"),
        ]);
        const [main, first, second] = await Promise.all([
          host.operator("same-operator"),
          a.operator("same-operator"),
          b.operator("same-operator"),
        ]);
        assert.equal(host.client, client);
        assert.notEqual(first, second);
        assert.equal(await a.operator("same-operator"), first);
        assert.equal(
          await (await host.caseSpace("space-a", "case-a")).operator(
            "same-operator",
          ),
          first,
        );
        assert.deepEqual([
          main.scope.executionSpaceId,
          first.scope.executionSpaceId,
          second.scope.executionSpaceId,
        ], ["main", "space-a", "space-b"]);
        await Promise.all([
          main.state.save(initial("main"), null),
          first.state.save(initial("a"), null),
          second.state.save(initial("b"), null),
        ]);
        assert.deepEqual(
          (await Promise.all([
            main.state.load(),
            first.state.load(),
            second.state.load(),
          ])).map((state) => state?.messages[0].text),
          ["main", "a", "b"],
        );
        await assert.rejects(
          host.caseSpace("missing", "case-a"),
          /unavailable/,
        );
        await assert.rejects(
          host.caseSpace("foreign-space", "foreign-case"),
          /unavailable/,
        );
        await assert.rejects(
          host.caseSpace("space-a", "case-b"),
          /unavailable/,
        );
        await assert.rejects(host.caseSpace("main", "case-a"), /Invalid Case/);
        await client.executionSpace.update({
          where: {
            projectId_systemId_executionSpaceId: {
              ...system,
              executionSpaceId: "space-a",
            },
          },
          data: { lifecycle: "closed", closedAt: new Date() },
        });
        await assert.rejects(
          host.caseSpace("space-a", "case-a"),
          /unavailable/,
        );
        await assert.rejects(a.operator("same-operator"), /unavailable/);
        assert.equal(await client.operatorRuntime.count({ where: system }), 3);
        await host.close();
        await assert.rejects(b.operator("same-operator"), /closing/);
        // Closing the host does not own or close the fixture's independent client.
        assert.equal(await database.client.project.count(), 2);
      } finally {
        await host.close();
      }
    });
  },
});
