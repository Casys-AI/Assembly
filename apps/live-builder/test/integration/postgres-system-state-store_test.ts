import assert from "node:assert/strict";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { registerPostgresClientSchema } from "../../src/adapters/out/postgres/client-schema.ts";
import {
  type ExecutionSql,
  withPostgresExecutionTransaction,
} from "../../src/adapters/out/postgres/execution-transaction.ts";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import {
  decodeRuntimeSnapshotPayload,
  RUNTIME_SNAPSHOT_PREFIX,
} from "../../src/adapters/out/postgres/runtime-snapshot-codec.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const scope = {
  projectId: "project-a",
  systemId: "system",
  executionSpaceId: "space",
  operatorId: "operator",
};

function state(revision = 0): SystemRuntimeState {
  return {
    id: "local-runtime-id",
    revision,
    catalogRevision: 1,
    busy: false,
    phase: "ready",
    provider: "fixture",
    messages: [{ id: "m1", role: "user", text: "hello", at: "now" }],
    cases: [{
      id: "case",
      number: 1,
      type: "request",
      objective: "Preserve admitted source pin",
      owner: "owner",
      openedBy: "opener",
      openedFrom: { conversationId: "conversation" },
      modelPin: { digest: "f".repeat(64), repositoryVersion: "e".repeat(40) },
      status: "open",
      createdAt: "2026-10-27T00:00:00.000Z",
    }],
    candidates: [],
    events: [{ id: "e1", at: "now", kind: "activation", label: "accepted" }],
    model: {
      projectId: "source-project",
      editingContextId: "context",
      rootId: "root",
      systemId: "source-system",
      catalogId: "catalog",
      builderId: "builder",
    },
  };
}

Deno.test({
  name:
    "PG-2 state preserves bytes, pins, immutable history and projections across reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      let store = await PostgresSystemStateStore.open(client, scope);
      assert.equal(await store.load(), null);
      const original = state();
      original.messages[0].text = "請保留原文 😀 ".repeat(3_000);
      const exactJson = JSON.stringify(original);
      const saving = store.save(original, null);
      original.messages[0].text = "mutated after save call";
      await saving;
      const row = await client.runtimeState.findFirstOrThrow({ where: scope });
      assert.ok(row.payload.startsWith(RUNTIME_SNAPSHOT_PREFIX));
      assert.equal(decodeRuntimeSnapshotPayload(row.payload), exactJson);
      assert.equal(
        (await client.runtimeRevision.findFirstOrThrow({ where: scope }))
          .payload,
        row.payload,
      );
      const next = state(1);
      next.model!.catalogId = "catalog-v2";
      next.events.push({
        id: "e2",
        at: "later",
        kind: "review",
        label: "reviewed",
      });
      await store.save(next, 0);
      await store.recordProjection(
        0,
        { exact: "source graph" },
        "graph-digest",
      );
      await store.recordProjection(
        0,
        { exact: "source graph" },
        "graph-digest",
      );
      await assert.rejects(
        () =>
          store.recordProjection(0, { exact: "changed graph" }, "graph-digest"),
        /different content/,
      );
      await assert.rejects(
        () =>
          store.recordProjection(
            0,
            { exact: "source graph" },
            "conflicting-digest",
          ),
        /different content/,
      );
      await assert.rejects(
        () => store.recordProjection(2, {}, "missing"),
        /does not exist/,
      );
      const revisions = await store.listRevisions();
      assert.deepEqual(
        revisions.map((r) => [r.revision, r.hasProjection, r.eventCount]),
        [[0, true, 1], [1, false, 2]],
      );
      assert.deepEqual(await store.loadAt("2999-01-01T00:00:00Z"), next);
      assert.equal(await store.loadAt("2000-01-01T00:00:00Z"), null);
      assert.equal(await store.loadRevision(3), null);
      await store.close();
      await store.close();
      await assert.rejects(() => store.load(), /closed/);
      // Adapter close leaves the host pool usable; only the host disconnects it.
      assert.equal(await client.runtimeState.count({ where: scope }), 1);
      await client.$disconnect();
      const reopened = reopen();
      store = await PostgresSystemStateStore.open(reopened, scope);
      assert.equal(JSON.stringify(await store.loadRevision(0)), exactJson);
      assert.deepEqual(await store.loadRevision(1), next);
      assert.deepEqual(await store.load(), next);
      const loaded = (await store.load())!;
      loaded.messages[0].text = "external mutation";
      assert.deepEqual(await store.load(), next);
      const projection = (await store.loadProjection(0))!;
      assert.deepEqual(projection.graph, { exact: "source graph" });
      (projection.graph as { exact: string }).exact = "external mutation";
      assert.deepEqual((await store.loadProjection(0))!.graph, {
        exact: "source graph",
      });
      await assert.rejects(() =>
        reopened.runtimeRevision.updateMany({
          where: scope,
          data: { payload: "changed" },
        })
      );
      await assert.rejects(() =>
        reopened.runtimeProjection.deleteMany({ where: scope })
      );
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 independent clients choose one create-only and expected-revision winner",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient: reopen }) => {
      await seedPostgresRuntime(client, scope);
      const second = reopen();
      const [a, b] = await Promise.all([
        PostgresSystemStateStore.open(client, scope),
        PostgresSystemStateStore.open(second, scope),
      ]);
      await assert.rejects(() => a.save(state(1), null), /revision/);
      await assert.rejects(
        () => a.save({ ...state(), id: " " }, null),
        /Invalid/,
      );
      const creates = await Promise.allSettled([
        a.save(state(), null),
        b.save({ ...state(), phase: "other" }, null),
      ]);
      assert.equal(
        creates.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        creates.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.equal((await a.listRevisions()).length, 1);
      const updates = await Promise.allSettled([
        a.save({ ...state(1), phase: "winner-a" }, 0),
        b.save({ ...state(1), phase: "winner-b" }, 0),
      ]);
      assert.equal(
        updates.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const expectedPhase = updates[0].status === "fulfilled"
        ? "winner-a"
        : "winner-b";
      assert.equal((await a.load())!.phase, expectedPhase);
      assert.deepEqual(await a.loadRevision(1), await a.load());
      await assert.rejects(
        () => a.save({ ...state(2), id: "different-runtime" }, 1),
        /system ID changed/,
      );
      await assert.rejects(() => a.save(state(3), 1), /revision/);
      assert.equal((await a.load())!.revision, 1);
      assert.equal((await a.listRevisions()).length, 2);
      await Promise.all([a.close(), b.close()]);
    });
  },
});

Deno.test({
  name:
    "PG-2 failed history insertion atomically rolls back current state and preserves history",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = await PostgresSystemStateStore.open(client, scope);
      await store.save(state(), null);
      // A real conflicting immutable history row forces append failure after
      // the transaction has updated current state: the current update must roll back.
      const prior = await client.runtimeRevision.findFirstOrThrow({
        where: scope,
      });
      await client.runtimeRevision.create({ data: { ...prior, revision: 1n } });
      const compressed = state(1);
      compressed.messages[0].text = "État 漢字 🙂".repeat(4_000);
      await assert.rejects(() => store.save(compressed, 0));
      assert.deepEqual(await store.load(), state());
      assert.deepEqual(await store.loadRevision(0), state());
      assert.equal(await client.runtimeRevision.count({ where: scope }), 2);
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 full namespace isolates state, immutable projections and bounded evidence",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const scopes = [
        scope,
        { ...scope, projectId: "project-b" },
        { ...scope, systemId: "other-system" },
        { ...scope, executionSpaceId: "sibling" },
        { ...scope, operatorId: "sibling-operator" },
      ];
      const stores: PostgresSystemStateStore[] = [];
      for (const [i, scoped] of scopes.entries()) {
        await seedPostgresRuntime(client, scoped);
        const store = await PostgresSystemStateStore.open(client, scoped);
        stores.push(store);
        await store.save({ ...state(), phase: `scope-${i}` }, null);
        await store.recordProjection(0, { scoped: i }, `digest-${i}`);
      }
      const first = stores[0];
      await first.save(state(1), 0);
      await first.save(state(2), 1);
      for (const [i, store] of stores.entries()) {
        assert.equal((await store.loadRevision(0))!.phase, `scope-${i}`);
        assert.deepEqual((await store.loadProjection(0))!.graph, { scoped: i });
        const evidence = await store.readNetworkImpactEvidence({
          maxSnapshots: 5,
          maxPayloadBytes: 100_000,
          maxTotalBytes: 500_000,
        });
        assert.equal(evidence.complete, true);
        assert.equal(evidence.snapshots.length, i === 0 ? 3 : 1);
        assert.equal(
          JSON.parse(evidence.snapshots[0].payload).phase,
          `scope-${i}`,
        );
      }
      const limited = await first.readNetworkImpactEvidence({
        maxSnapshots: 1,
        maxPayloadBytes: 100_000,
        maxTotalBytes: 100_000,
      });
      assert.equal(limited.complete, false);
      assert.deepEqual(limited.snapshots.map((s) => s.revision), [2]);
      assert.deepEqual(limited.revisionBounds, { from: 0, to: 2 });
      assert.ok(
        limited.issues.some((issue) =>
          issue.code === "EVIDENCE_SNAPSHOT_LIMIT"
        ),
      );
      const tooSmall = await first.readNetworkImpactEvidence({
        maxSnapshots: 5,
        maxPayloadBytes: 1,
        maxTotalBytes: 100_000,
      });
      assert.equal(tooSmall.bytesRead, 0);
      assert.equal(tooSmall.snapshots.length, 0);
      assert.ok(
        tooSmall.issues.some((issue) =>
          issue.code === "EVIDENCE_PAYLOAD_LIMIT"
        ),
      );
      const controller = new AbortController();
      controller.abort();
      const aborted = await first.readNetworkImpactEvidence({
        maxSnapshots: 5,
        maxPayloadBytes: 100_000,
        maxTotalBytes: 100_000,
        signal: controller.signal,
      });
      assert.equal(aborted.snapshotsRead, 0);
      assert.ok(
        aborted.issues.some((issue) => issue.code === "EVIDENCE_ABORTED"),
      );
      await Promise.all(stores.map((store) => store.close()));
    });
  },
});

Deno.test({
  name:
    "PG-2 invalid stored state and mismatching compressed digest fail closed",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = await PostgresSystemStateStore.open(client, scope);
      await store.save(state(), null);
      await client.runtimeState.updateMany({
        where: scope,
        data: { payload: '{"revision":0}' },
      });
      await assert.rejects(() => store.load(), /Invalid/);
      await assert.rejects(
        () => PostgresSystemStateStore.open(client, scope),
        /Invalid/,
      );
      const large = state();
      large.messages[0].text = "compressible".repeat(8_000);
      // Restore exact current to permit the next valid accepted revision.
      await client.runtimeState.updateMany({
        where: scope,
        data: { payload: JSON.stringify(state()) },
      });
      large.revision = 1;
      await store.save(large, 0);
      const row = await client.runtimeState.findFirstOrThrow({ where: scope });
      const wrongDigest = row.payload.replace(
        /:([0-9a-f]{64}):/,
        `:${"0".repeat(64)}:`,
      );
      assert.notEqual(wrongDigest, row.payload);
      await client.runtimeState.updateMany({
        where: scope,
        data: { payload: wrongDigest },
      });
      await assert.rejects(
        () => store.load(),
        /corrupt runtime snapshot encoding/,
      );
      await assert.rejects(
        () => PostgresSystemStateStore.open(client, scope),
        /corrupt runtime snapshot encoding/,
      );
      // A corrupted immutable snapshot is rejected by both historical decode
      // and the bounded reader, with work charged before inflation is attempted.
      const history = await client.runtimeRevision.findFirstOrThrow({
        where: { ...scope, revision: 1n },
      });
      await client.runtimeRevision.createMany({
        data: [2n, 3n].map((revision) => ({
          ...history,
          revision,
          payload: wrongDigest,
        })),
      });
      await assert.rejects(
        () => store.loadRevision(2),
        /corrupt runtime snapshot encoding/,
      );
      const decodedBytes =
        new TextEncoder().encode(JSON.stringify(large)).length;
      const evidence = await store.readNetworkImpactEvidence({
        maxSnapshots: 2,
        maxPayloadBytes: decodedBytes,
        maxTotalBytes: decodedBytes,
      });
      assert.equal(evidence.snapshots.length, 0);
      assert.equal(evidence.bytesRead, decodedBytes);
      assert.equal(evidence.snapshotsRead, 2);
      assert.ok(
        evidence.issues.some((issue) => issue.code === "EVIDENCE_BYTE_LIMIT"),
      );
      assert.ok(
        evidence.issues.some((issue) =>
          issue.code === "EVIDENCE_PAYLOAD_INVALID"
        ),
      );
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 post-write execution fence failure rolls back state, history and projection before commit",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      const store = await PostgresSystemStateStore.open(client, scope);
      await store.save(state(), null);

      async function loseFenceAfterWrite(
        action: () => Promise<void>,
        inspect: (query: ExecutionSql) => Promise<void>,
      ): Promise<void> {
        let checks = 0;
        await assert.rejects(() =>
          withPostgresExecutionTransaction({
            client,
            fence: async (query) => {
              checks++;
              if (checks === 2) {
                // Inspect the uncommitted writes through this exact transaction.
                await inspect(query);
                throw new Error("Worker claim lost before commit");
              }
            },
          }, action), /Worker claim lost before commit/);
        assert.equal(checks, 2);
      }

      const next = state(1);
      await loseFenceAfterWrite(() => store.save(next, 0), async (query) => {
        const current = await query(
          `SELECT "revision", "payload" FROM "${schema}"."RuntimeState"`,
        );
        assert.equal(BigInt(current.rows[0].revision as string), 1n);
        assert.deepEqual(JSON.parse(current.rows[0].payload as string), next);
        const history = await query(
          `SELECT "payload" FROM "${schema}"."RuntimeRevision" WHERE "revision" = $1`,
          [1],
        );
        assert.deepEqual(JSON.parse(history.rows[0].payload as string), next);
      });
      assert.deepEqual(await store.load(), state());
      assert.equal(await store.loadRevision(1), null);
      assert.deepEqual(
        (await store.listRevisions()).map((row) => row.revision),
        [0],
      );

      const graph = { exact: "uncommitted projection" };
      await loseFenceAfterWrite(
        () => store.recordProjection(0, graph, "uncommitted-digest"),
        async (query) => {
          const projection = await query(
            `SELECT "digest", "payload" FROM "${schema}"."RuntimeProjection"`,
          );
          assert.equal(projection.rows[0].digest, "uncommitted-digest");
          assert.deepEqual(
            JSON.parse(projection.rows[0].payload as string),
            graph,
          );
        },
      );
      assert.equal(await store.loadProjection(0), null);
      assert.equal((await store.listRevisions())[0].hasProjection, false);
      assert.deepEqual(await store.load(), state());
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 candidate proposal and review stages survive reopen with exact temporal history",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      let store = await PostgresSystemStateStore.open(client, scope);
      const proposed = state();
      proposed.catalogRevision = 0;
      proposed.candidates = [{
        id: "c1",
        name: "Page reader",
        description: "Read a page",
        kind: "read_web_page",
        code: "export default () => ({title:'title',text:'body'})",
        digest: "digest",
        stage: "proposed",
        createdAt: "now",
        baseCatalogRevision: 0,
      }];
      proposed.events = [{
        id: "proposal",
        at: "now",
        kind: "proposal",
        label: "proposed",
        candidateId: "c1",
      }];
      await store.save(proposed, null);
      const first = (await store.listRevisions())[0];
      // Ensure two distinct wall-clock boundaries without rewriting immutable rows.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const reviewing = structuredClone(proposed);
      reviewing.revision = 1;
      reviewing.candidates[0].stage = "reviewing";
      reviewing.candidates[0].tests = { passed: true, checks: [] };
      reviewing.events.push({
        id: "review",
        at: "later",
        kind: "review",
        label: "reviewing",
        candidateId: "c1",
      });
      await store.save(reviewing, 0);
      const second = (await store.listRevisions())[1];
      assert.ok(Date.parse(first.recordedAt) < Date.parse(second.recordedAt));
      assert.equal(
        await store.loadAt(
          new Date(Date.parse(first.recordedAt) - 1).toISOString(),
        ),
        null,
      );
      assert.deepEqual(await store.loadAt(first.recordedAt), proposed);
      assert.deepEqual(
        await store.loadAt(
          new Date(Date.parse(second.recordedAt) - 1).toISOString(),
        ),
        proposed,
      );
      assert.deepEqual(await store.loadAt(second.recordedAt), reviewing);
      await assert.rejects(() => store.loadAt("not-a-timestamp"), /timestamp/);
      await assert.rejects(() => store.loadRevision(-1), /integer/);
      await store.close();
      await client.$disconnect();
      store = await PostgresSystemStateStore.open(createClient(), scope);
      assert.deepEqual(await store.loadRevision(0), proposed);
      assert.deepEqual(await store.load(), reviewing);
      assert.equal((await store.load())!.candidates[0].binding, undefined);
      assert.deepEqual(
        (await store.listRevisions()).map((r) => ({
          label: r.label,
          activeToolCount: r.activeToolCount,
          agentCount: r.agentCount,
          model: r.model,
          origin: r.origin,
        })),
        [proposed, reviewing].map((s) => ({
          label: s.events.at(-1)!.label,
          activeToolCount: 0,
          agentCount: 1,
          model: s.model,
          origin: "commit",
        })),
      );
      const activated = structuredClone(reviewing);
      activated.revision = 2;
      activated.catalogRevision = 1;
      activated.candidates[0].stage = "active";
      activated.candidates[0].review = {
        candidateDigest: "digest",
        verdict: "approve",
        reason: "ok",
      };
      activated.candidates[0].binding = {
        elementId: "element",
        graphPath: "graph",
      };
      await store.save(activated, 1);
      assert.deepEqual(await store.load(), activated);
      assert.equal((await store.listRevisions())[2].activeToolCount, 1);
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 invalid and oversized UTF-8 projections leave accepted history intact",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = await PostgresSystemStateStore.open(client, scope);
      await store.save(state(), null);
      await assert.rejects(
        () => store.recordProjection(-1, {}, "digest"),
        /integer/,
      );
      await assert.rejects(() => store.loadProjection(1.5), /integer/);
      await assert.rejects(() => store.recordProjection(0, {}, " "), /digest/);
      await assert.rejects(
        () => store.recordProjection(0, undefined, "digest"),
        /payload/,
      );
      await assert.rejects(
        () =>
          store.recordProjection(
            0,
            { label: "漢".repeat(4 * 1024 * 1024) },
            "digest",
          ),
        /exceeds 10 MiB/,
      );
      assert.equal(await store.loadProjection(0), null);
      assert.equal((await store.listRevisions()).length, 1);
      assert.deepEqual(await store.load(), state());
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 evidence keeps a stable recent window and charges exact aggregate bytes",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, scope);
      const store = await PostgresSystemStateStore.open(client, scope);
      const budget = {
        maxSnapshots: 3,
        maxPayloadBytes: 100_000,
        maxTotalBytes: 500_000,
      };
      const empty = await store.readNetworkImpactEvidence(budget);
      assert.equal(empty.complete, false);
      assert.deepEqual(empty.revisionBounds, { from: null, to: null });
      assert.equal(empty.issues[0].code, "EVIDENCE_SOURCE_EMPTY");
      for (let revision = 0; revision < 7; revision++) {
        await store.save(state(revision), revision === 0 ? null : revision - 1);
      }
      const pending = store.readNetworkImpactEvidence(budget);
      const writing = store.save(state(7), 6);
      const captured = await pending;
      await writing;
      assert.deepEqual(captured.revisionBounds, { from: 0, to: 6 });
      assert.deepEqual(captured.snapshots.map((s) => s.revision), [4, 5, 6]);
      assert.equal(captured.snapshotsRead, 3);
      assert.equal(
        captured.issues.filter((i) => i.code === "EVIDENCE_SNAPSHOT_LIMIT")
          .length,
        1,
      );
      assert.ok(
        captured.issues[0].message.includes("Older state history was omitted"),
      );
      const advanced = await store.readNetworkImpactEvidence(budget);
      assert.deepEqual(advanced.revisionBounds, { from: 0, to: 7 });
      assert.deepEqual(advanced.snapshots.map((s) => s.revision), [5, 6, 7]);
      assert.deepEqual(captured.snapshots.map((s) => s.revision), [4, 5, 6]);
      const size = new TextEncoder().encode(JSON.stringify(state())).length;
      const limited = await store.readNetworkImpactEvidence({
        ...budget,
        maxSnapshots: 8,
        maxTotalBytes: size,
      });
      assert.equal(limited.bytesRead, size);
      assert.deepEqual(limited.snapshots.map((s) => s.revision), [0]);
      assert.equal(limited.issues[0].code, "EVIDENCE_BYTE_LIMIT");
      const exact = await store.readNetworkImpactEvidence({
        ...budget,
        maxSnapshots: 8,
      });
      assert.equal(exact.complete, true);
      assert.equal(exact.snapshotsRead, 8);
      await assert.rejects(
        () => store.readNetworkImpactEvidence({ ...budget, maxSnapshots: 0 }),
        /budget/,
      );
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 compressed evidence rejects over-budget payloads before fetching and rejects dishonest headers",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      let payloadFetches = 0;
      const observed = client.$extends({
        query: {
          runtimeRevision: {
            findFirst({ args, query }) {
              if (args.select?.payload) payloadFetches++;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      registerPostgresClientSchema(observed, schema);
      const store = await PostgresSystemStateStore.open(observed, scope);
      const original = state();
      original.messages[0].text = "État 漢字 🙂".repeat(4_000);
      const json = JSON.stringify(original);
      const size = new TextEncoder().encode(json).length;
      await store.save(original, null);
      const budget = {
        maxSnapshots: 1,
        maxPayloadBytes: size,
        maxTotalBytes: size,
      };
      const payloadLimited = await store.readNetworkImpactEvidence({
        ...budget,
        maxPayloadBytes: size - 1,
      });
      assert.equal(payloadLimited.issues[0].code, "EVIDENCE_PAYLOAD_LIMIT");
      assert.equal(payloadFetches, 0);
      const totalLimited = await store.readNetworkImpactEvidence({
        ...budget,
        maxTotalBytes: size - 1,
      });
      assert.equal(totalLimited.issues[0].code, "EVIDENCE_BYTE_LIMIT");
      assert.equal(payloadFetches, 0);
      const exact = await store.readNetworkImpactEvidence(budget);
      assert.equal(exact.complete, true);
      assert.equal(exact.bytesRead, size);
      assert.equal(exact.snapshots[0].payload, json);
      assert.equal(payloadFetches, 1);
      const history = await client.runtimeRevision.findFirstOrThrow({
        where: scope,
      });
      const dishonest = history.payload.replace(
        /:gzip:[0-9]{10}:/,
        ":gzip:0000000008:",
      );
      assert.notEqual(dishonest, history.payload);
      await client.runtimeRevision.create({
        data: { ...history, revision: 1n, payload: dishonest },
      });
      const corrupt = await store.readNetworkImpactEvidence(budget);
      assert.equal(corrupt.snapshots.length, 0);
      assert.ok(
        corrupt.issues.some((i) => i.code === "EVIDENCE_PAYLOAD_INVALID"),
      );
      assert.equal(payloadFetches, 1);
      await store.close();
    });
  },
});

Deno.test({
  name:
    "PG-2 cancellation between evidence queries releases queued writes without cancelling the host pool",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedPostgresRuntime(client, scope);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const observed = client.$extends({
        query: {
          runtimeRevision: {
            async aggregate({ args, query }) {
              const result = await query(args);
              reached.resolve();
              await release.promise;
              return result;
            },
          },
        },
      }) as unknown as PrismaClient;
      registerPostgresClientSchema(observed, schema);
      const store = await PostgresSystemStateStore.open(observed, scope);
      try {
        await store.save(state(), null);
        const reading = store.readNetworkImpactEvidence({
          maxSnapshots: 3,
          maxPayloadBytes: 100_000,
          maxTotalBytes: 500_000,
          signal: controller.signal,
        });
        await reached.promise;
        const writing = store.save(state(1), 0);
        controller.abort();
        release.resolve();
        const aborted = await reading;
        assert.equal(aborted.complete, false);
        assert.equal(aborted.snapshotsRead, 0);
        assert.ok(aborted.issues.some((i) => i.code === "EVIDENCE_ABORTED"));
        await writing;
        await store.save(state(2), 1);
        assert.deepEqual(await store.load(), state(2));
        assert.equal(await client.runtimeState.count({ where: scope }), 1);
      } finally {
        release.resolve();
        await store.close();
      }
    });
  },
});

Deno.test({
  name:
    "PG-2 an existing plain snapshot gets one explicit baseline without inventing prior history",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedPostgresRuntime(client, scope);
      const prior = state(7);
      const json = ` \n${JSON.stringify(prior, null, 2)}\n`;
      await client.runtimeState.create({
        data: { ...scope, revision: 7n, payload: json },
      });
      let store = await PostgresSystemStateStore.open(client, scope);
      assert.deepEqual(await store.load(), prior);
      assert.deepEqual(await store.loadRevision(7), prior);
      assert.equal(await store.loadRevision(6), null);
      assert.equal(
        (await client.runtimeRevision.findFirstOrThrow({ where: scope }))
          .payload,
        json,
      );
      const baseline = await store.listRevisions();
      assert.equal(baseline.length, 1);
      assert.equal(baseline[0].origin, "legacy_backfill");
      assert.equal(
        await store.loadAt(
          new Date(Date.parse(baseline[0].recordedAt) - 1).toISOString(),
        ),
        null,
      );
      await store.close();
      await client.$disconnect();
      store = await PostgresSystemStateStore.open(createClient(), scope);
      assert.deepEqual(await store.listRevisions(), baseline);
      await store.save(state(8), 7);
      assert.deepEqual(
        (await store.listRevisions()).map(({ revision, origin }) => ({
          revision,
          origin,
        })),
        [
          { revision: 7, origin: "legacy_backfill" },
          { revision: 8, origin: "commit" },
        ],
      );
      const evidence = await store.readNetworkImpactEvidence({
        maxSnapshots: 2,
        maxPayloadBytes: 100_000,
        maxTotalBytes: 200_000,
      });
      assert.equal(evidence.complete, false);
      assert.deepEqual(evidence.revisionBounds, { from: 7, to: 8 });
      assert.equal(evidence.issues[0].code, "LEGACY_HISTORY_MISSING");
      assert.equal(evidence.snapshots[0].payload, json);
      await store.close();
    });
  },
});
