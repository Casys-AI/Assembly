import assert from "node:assert/strict";
import { withPostgresExecutionTransaction } from "../../src/adapters/out/postgres/execution-transaction.ts";
import { Client } from "pg";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import type { PostgresSystemScope } from "../../src/adapters/out/postgres/scope.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { EvolutionAuthorityExercise } from "../../src/domain/model/evolution/policy.ts";
import type {
  EvolutionDossier,
  EvolutionStatus,
  EvolutionStorePort,
} from "../../src/application/model/evolution/ports.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const scope: PostgresSystemScope = { projectId: "project", systemId: "system" };

async function seedRepository(
  client: PrismaClient,
  namespace = scope,
  repositoryId = "repository",
) {
  await seedPostgresRuntime(client, {
    ...namespace,
    executionSpaceId: "main",
    operatorId: "main",
  });
  await client.sourceRepository.upsert({
    where: { projectId_systemId_repositoryId: { ...namespace, repositoryId } },
    create: { ...namespace, repositoryId, sourceScopeId: "registered-source" },
    update: {},
  });
}

function dossier(id: string, targets: string[]): EvolutionDossier {
  const proposal = {
    id: `proposal-${id}`,
    version: "candidate",
    baseVersion: "base",
    sourceDigest: "sources",
    recipeDigest: "recipe",
    digest: `exact-${id}`,
    targets: targets.map((operatorId) => ({
      operatorId,
      previousDigest: "old",
      candidateDigest: "new",
    })),
    categories: ["flow" as const],
  };
  const preparation: EvolutionAuthorityExercise = {
    act: "prepare",
    operatorNativeId: "author",
    systemQualifiedName: "System",
    authorityDigest: "prior",
    policyId: "policy",
    policyRevision: 1,
    mandateNativeId: "mandate-native",
    mandateId: "mandate",
    mandateRevision: 1,
    targets,
    categories: ["flow"],
    proposalDigest: proposal.digest,
  };
  return {
    v: 1,
    id,
    repositoryId: "repository",
    revision: 0,
    status: "prepared",
    origin: { operatorId: "author", requestId: "closed" },
    finalizerActorId: "finalizer",
    accounting: { id: `evolution:repository:${id}`, agentInvocations: 0 },
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    proposal,
    preparation,
    adoptions: [],
    blockers: [],
  };
}
function next(d: EvolutionDossier, status: EvolutionStatus): EvolutionDossier {
  return { ...d, revision: d.revision + 1, status };
}
async function accepted(
  store: EvolutionStorePort,
  d: EvolutionDossier,
): Promise<EvolutionDossier> {
  await store.create(d);
  return await store.compareAndSwap(d.id, 0, {
    ...next(d, "accepted"),
    acceptance: {
      ...d.preparation,
      act: "accept",
      operatorNativeId: "decider",
    },
  });
}
function armed(d: EvolutionDossier): EvolutionDossier {
  return {
    ...next(d, "armed"),
    adoptionAuthorization: {
      ...d.preparation,
      act: "adopt",
      operatorNativeId: "finalizer",
    },
  };
}

Deno.test({
  name:
    "PG-2 evolution loses a claim after arming and rolls back every target without notification",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      await seedRepository(client);
      const store = new PostgresEvolutionStore(client, scope);
      const before = await accepted(
        store,
        dossier("lost-claim", ["one", "two"]),
      );
      const arming = armed(before);
      let notifications = 0, checks = 0;
      store.onChange(() => {
        notifications++;
      });
      await assert.rejects(
        () =>
          withPostgresExecutionTransaction({
            client,
            fence: async (query) => {
              checks++;
              if (checks !== 2) return;
              const stored = await query(
                `SELECT payload FROM "${schema}"."EvolutionDossier" WHERE id = $1`,
                [before.id],
              );
              assert.equal(stored.rows[0]!.payload, canonical(arming));
              const targets = await query(
                `SELECT "operatorId", "dossierId" FROM "${schema}"."EvolutionTargetBarrier" ORDER BY "operatorId"`,
              );
              assert.deepEqual(targets.rows, [
                { operatorId: "one", dossierId: before.id },
                { operatorId: "two", dossierId: before.id },
              ]);
              throw new Error("Worker claim lost before evolution commit");
            },
          }, () => store.compareAndSwap(before.id, before.revision, arming)),
        /Worker claim lost before evolution commit/,
      );
      assert.equal(checks, 2);
      assert.equal(notifications, 0);
      assert.deepEqual(await store.get(before.id), before);
      assert.equal(await store.targetOwner("repository", "one"), null);
      assert.equal(await store.targetOwner("repository", "two"), null);
      await store.compareAndSwap(before.id, before.revision, arming);
      assert.equal(notifications, 1);
      assert.equal(await store.targetOwner("repository", "one"), before.id);
      assert.equal(await store.targetOwner("repository", "two"), before.id);
    });
  },
});

Deno.test({
  name:
    "PG-2 evolution preserves canonical dossiers and isolates equal identities by project and system",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      const namespaces = [scope, { ...scope, projectId: "other-project" }, {
        ...scope,
        systemId: "other-system",
      }];
      const saved: EvolutionDossier[] = [];
      for (const namespace of namespaces) {
        await seedRepository(client, namespace);
        const mutableScope = { ...namespace };
        const store = new PostgresEvolutionStore(client, mutableScope);
        const input = dossier("equal-id", ["member"]);
        input.proposal.sourceDigest =
          `${namespace.projectId}/${namespace.systemId}`;
        const snapshot = structuredClone(input);
        const pending = store.create(input);
        input.proposal.sourceDigest = "caller mutation";
        mutableScope.projectId = "caller mutation";
        await pending;
        const row = await client.evolutionDossier.findUniqueOrThrow({
          where: { projectId_systemId_id: { ...namespace, id: snapshot.id } },
        });
        assert.equal(row.payload, canonical(snapshot));
        const read = (await store.get(snapshot.id))!;
        read.origin.requestId = "reader mutation";
        assert.deepEqual(await store.get(snapshot.id), snapshot);
        saved.push(snapshot);
        await store.close();
      }
      await client.$disconnect();
      const reopened = createClient();
      for (const [index, namespace] of namespaces.entries()) {
        assert.deepEqual(
          await new PostgresEvolutionStore(reopened, namespace).get("equal-id"),
          saved[index],
        );
      }
      const unregistered = dossier("missing-repository", ["member"]);
      unregistered.repositoryId = "unregistered";
      unregistered.accounting.id = `evolution:unregistered:${unregistered.id}`;
      await assert.rejects(
        new PostgresEvolutionStore(reopened, scope).create(unregistered),
        { code: "EVOLUTION_INVALID" },
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 evolution has one CAS winner and atomic complete target claims across two PostgreSQL clients",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedRepository(client);
      const writers = [
        new PostgresEvolutionStore(client, scope),
        new PostgresEvolutionStore(createClient(), scope),
      ];
      const original = dossier("one-create", ["member"]);
      const creates = await Promise.allSettled(
        writers.map((writer) => writer.create(original)),
      );
      assert.equal(
        creates.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const revisions = await Promise.allSettled(
        writers.map((writer) =>
          writer.compareAndSwap(original.id, 0, {
            ...next(original, "accepted"),
            acceptance: {
              ...original.preparation,
              act: "accept",
              operatorNativeId: "decider",
            },
          })
        ),
      );
      assert.equal(
        revisions.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const conflict = revisions.find((result) => result.status === "rejected");
      if (conflict?.status === "rejected") {
        assert.equal(conflict.reason.code, "EVOLUTION_CONFLICT");
      }
      const first = await accepted(
        writers[0]!,
        dossier("first", ["first-only", "shared"]),
      );
      const second = await accepted(
        writers[1]!,
        dossier("second", ["second-only", "shared"]),
      );
      const claims = await Promise.allSettled([
        writers[0]!.compareAndSwap(first.id, first.revision, armed(first)),
        writers[1]!.compareAndSwap(second.id, second.revision, armed(second)),
      ]);
      assert.equal(
        claims.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failed = claims.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        assert.equal(failed.reason.code, "EVOLUTION_TARGET_RESERVED");
      }
      const winnerIndex = claims.findIndex((result) =>
        result.status === "fulfilled"
      );
      const loserIndex = 1 - winnerIndex;
      const candidates = [first, second];
      const winner =
        (await writers[winnerIndex]!.get(candidates[winnerIndex]!.id))!;
      const loser = candidates[loserIndex]!;
      assert.equal(
        await writers[0]!.targetOwner("repository", "shared"),
        winner.id,
      );
      assert.equal(
        await writers[0]!.targetOwner(
          "repository",
          loserIndex === 0 ? "first-only" : "second-only",
        ),
        null,
      );
      assert.equal((await writers[0]!.get(loser.id))!.status, "accepted");
      await assert.rejects(
        writers[0]!.compareAndSwap(
          winner.id,
          winner.revision - 1,
          next(winner, "publishing"),
        ),
        { code: "EVOLUTION_CONFLICT" },
      );
      await writers[0]!.compareAndSwap(winner.id, winner.revision, {
        ...next(winner, "cancelled"),
        cancellation: winner.acceptance,
      });
      assert.equal(await writers[1]!.targetOwner("repository", "shared"), null);
      const subsequent = await writers[1]!.compareAndSwap(
        loser.id,
        loser.revision,
        armed(loser),
      );
      assert.equal(
        await writers[0]!.targetOwner("repository", "shared"),
        subsequent.id,
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 evolution observers see commits and never announce rolled-back barrier claims",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(
      async ({ client, createClient, schema, connectionString }) => {
        await seedRepository(client);
        const store = new PostgresEvolutionStore(client, scope);
        const reader = createClient();
        const observed: Array<Promise<bigint>> = [];
        let notifications = 0;
        const unsubscribe = store.onChange(() => {
          notifications++;
          observed.push(
            reader.evolutionDossier.findUniqueOrThrow({
              where: { projectId_systemId_id: { ...scope, id: "observed" } },
            }).then((row) => row.revision),
          );
        });
        store.onChange(() => {
          throw new Error("observer failure cannot undo commit");
        });
        const initial = dossier("observed", ["one", "two"]);
        await store.create(initial);
        assert.deepEqual(await Promise.all(observed), [0n]);
        const d = await store.compareAndSwap(initial.id, 0, {
          ...next(initial, "accepted"),
          acceptance: {
            ...initial.preparation,
            act: "accept",
            operatorNativeId: "decider",
          },
        });
        assert.equal(notifications, 2);
        assert.deepEqual(await Promise.all(observed), [0n, 1n]);
        const admin = new Client({ connectionString });
        await admin.connect();
        try {
          await admin.query(
            `ALTER TABLE "${schema}"."EvolutionDossier" ADD CONSTRAINT pg2_controlled_arming_failure CHECK (status <> 'armed')`,
          );
          await assert.rejects(
            store.compareAndSwap(d.id, d.revision, armed(d)),
          );
          assert.equal(notifications, 2);
          assert.equal(await store.targetOwner("repository", "one"), null);
          assert.equal(await store.targetOwner("repository", "two"), null);
          assert.deepEqual(await store.get(d.id), d);
          await admin.query(
            `ALTER TABLE "${schema}"."EvolutionDossier" DROP CONSTRAINT pg2_controlled_arming_failure`,
          );
          const committed = await store.compareAndSwap(
            d.id,
            d.revision,
            armed(d),
          );
          assert.equal(notifications, 3);
          assert.equal(
            await store.targetOwner("repository", "two"),
            committed.id,
          );
          unsubscribe();
          await store.compareAndSwap(
            committed.id,
            committed.revision,
            next(committed, "publishing"),
          );
          assert.equal(notifications, 3);
          await Promise.all(observed);
        } finally {
          await admin.end();
        }
        await store.close();
        assert.equal(await reader.evolutionDossier.count({ where: scope }), 1);
      },
    );
  },
});

Deno.test({
  name:
    "PG-2 evolution retains published barriers across restart and releases them only on valid adoption",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedRepository(client);
      let store = new PostgresEvolutionStore(client, scope);
      let d = await accepted(store, dossier("published", ["member"]));
      d = await store.compareAndSwap(d.id, d.revision, armed(d));
      d = await store.compareAndSwap(d.id, d.revision, next(d, "publishing"));
      d = await store.compareAndSwap(d.id, d.revision, {
        ...next(d, "published-awaiting-adoption"),
        publication: {
          commandId: d.proposal.id,
          commandDigest: "exact-command",
          version: "published",
          sourceDigest: d.proposal.sourceDigest,
          proposalDigest: d.proposal.digest,
        },
      });
      await store.close();
      await client.$disconnect();
      store = new PostgresEvolutionStore(createClient(), scope);
      assert.deepEqual(await store.get(d.id), d);
      assert.equal(await store.targetOwner("repository", "member"), d.id);
      assert.equal(await store.targetOwner("repository", "unrelated"), null);
      await assert.rejects(
        store.compareAndSwap(d.id, d.revision, {
          ...next(d, "cancelled"),
          cancellation: d.acceptance,
        }),
        { code: "EVOLUTION_INVALID" },
      );
      assert.equal(await store.targetOwner("repository", "member"), d.id);
      const receipt = {
        ...d.proposal.targets[0]!,
        proposalDigest: d.proposal.digest,
        version: "published",
        effectiveAt: "2026-10-27T00:01:00Z",
      };
      d = await store.compareAndSwap(d.id, d.revision, {
        ...next(d, "adopted"),
        adoptions: [receipt],
        updatedAt: "2026-10-27T00:01:00Z",
      });
      assert.equal(await store.targetOwner("repository", "member"), null);
      assert.deepEqual(await store.listPending("repository"), []);
      assert.deepEqual(await store.listRecent("repository", 1), [d]);
      assert.equal(d.accounting.agentInvocations, 0);
      await assert.rejects(store.listRecent("repository", 257), {
        code: "EVOLUTION_INVALID",
      });
    });
  },
});

Deno.test({
  name:
    "PG-2 evolution rejects malformed stored representations and immutable dossier mutations without notices",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedRepository(client);
      const store = new PostgresEvolutionStore(client, scope);
      const d = await accepted(store, dossier("corruptible", ["member"]));
      let notifications = 0;
      store.onChange(() => {
        notifications++;
      });
      const rewritten = armed(d);
      rewritten.origin.requestId = "changed-origin";
      await assert.rejects(store.compareAndSwap(d.id, d.revision, rewritten), {
        code: "EVOLUTION_INVALID",
      });
      for (
        const payload of [
          "{",
          JSON.stringify(d),
          canonical({ ...d, repositoryId: "other" }),
          "null",
        ]
      ) {
        await client.evolutionDossier.updateMany({
          where: { ...scope, id: d.id },
          data: { payload },
        });
        await assert.rejects(store.get(d.id), {
          code: "EVOLUTION_STORE_CORRUPT",
        });
        await assert.rejects(store.listPending("repository"), {
          code: "EVOLUTION_STORE_CORRUPT",
        });
        await assert.rejects(store.compareAndSwap(d.id, d.revision, armed(d)), {
          code: "EVOLUTION_STORE_CORRUPT",
        });
        assert.equal(await store.targetOwner("repository", "member"), null);
      }
      assert.equal(notifications, 0);
      await client.evolutionDossier.updateMany({
        where: { ...scope, id: d.id },
        data: { payload: canonical(d) },
      });
      assert.deepEqual(await store.get(d.id), d);
      const committed = await store.compareAndSwap(d.id, d.revision, armed(d));
      assert.equal(notifications, 1);
      assert.equal(
        await store.targetOwner("repository", "member"),
        committed.id,
      );
    });
  },
});

Deno.test({
  name:
    "PG-2 evolution enforces its repository pending bound under competing final-slot creates",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, createClient }) => {
      await seedRepository(client);
      const data = Array.from(
        { length: 255 },
        (_, index) => dossier(`seed-${index}`, ["member"]),
      ).map((d) => ({
        ...scope,
        id: d.id,
        repositoryId: d.repositoryId,
        revision: 0n,
        status: d.status,
        payload: canonical(d),
        updatedAt: d.updatedAt,
      }));
      await client.evolutionDossier.createMany({ data });
      const stores = [
        new PostgresEvolutionStore(client, scope),
        new PostgresEvolutionStore(createClient(), scope),
      ];
      const attempts = await Promise.allSettled(
        stores.map((store, index) =>
          store.create(dossier(`final-${index}`, ["member"]))
        ),
      );
      assert.equal(
        attempts.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = attempts.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        assert.equal(failure.reason.code, "EVOLUTION_STORE_FULL");
      }
      assert.equal((await stores[0]!.listPending("repository")).length, 256);
    });
  },
});
