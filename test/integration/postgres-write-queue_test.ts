import { fileURLToPath } from "node:url";
import { isScopedSoftwareWriteDossier } from "../../src/application/model/publication/write-command-v2.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  queueTestCompiler,
  queueTestRecipe,
  unusedPublication,
} from "../support/postgres-write-queue.ts";
import {
  buildAcceptProposalCommand,
  ModelWriteWorker,
} from "../../src/application/model/publication/write-queue.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  withPostgresDatabase as withDatabase,
} from "../support/postgres.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { Client } from "pg";
import {
  PostgresModelWriteQueue,
} from "../../src/adapters/out/postgres/model-write-queue.ts";
import { buildApprovedChangeCommand } from "../../src/application/model/publication/write-queue.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { changePublication } from "../../src/domain/model/publication/change.ts";
import type { HostEdit } from "../../src/domain/model/editing/host-edit.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import { parseModelRevisionRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { buildOperationJournal } from "../../src/domain/model/editing/operation-journal.ts";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";

function postgresTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !postgresTestEnabled, fn });
}

interface QueueDatabase extends PostgresTestDatabase {
  writerLock: (repositoryId: string) => ReturnType<typeof repositoryWriterLock>;
}
async function withPostgresDatabase(
  run: (database: QueueDatabase) => Promise<void>,
) {
  await withDatabase(async (database) => {
    const lockRoot = await Deno.makeTempDir({ prefix: "pg3-lock-" });
    try {
      await run({
        ...database,
        writerLock: async (id) => {
          const dir = `${lockRoot}/${encodeURIComponent(id)}`;
          await Deno.mkdir(dir, { recursive: true });
          return await repositoryWriterLock(dir);
        },
      });
    } finally {
      await Deno.remove(lockRoot, { recursive: true });
    }
  });
}

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const hex = (char: string) => char.repeat(64);
const scope = { projectId: "pg3-project", systemId: "pg3-system" };
const repositoryId = "44444444-4444-4444-8444-444444444444";
const baseVersion = "commit:" + "1".repeat(40);
const edit: HostEdit = {
  op: "setFeatureValue",
  target: {
    id: "el-1",
    qualifiedName: "Sys::a",
    metaclass: "PartUsage",
    preimage: hex("a"),
  },
  value: "x",
  format: 1,
};

// Mirrors test/integration/model-write-queue_test.ts approvedChange().
function approvedChange(id: string, reason = "Exact extension") {
  const pin = {
    digest: "base-execution-digest",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id,
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason,
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  return { change, pin, approval: changePublication(change, pin) };
}

async function dossierFor(id: string, reason?: string) {
  const { change, pin } = approvedChange(id, reason);
  return await buildApprovedChangeCommand({
    repositoryId,
    change,
    pin,
    journal: buildOperationJournal({
      base: parseModelRevisionRef({ repositoryId, version: baseVersion }),
      baseSourceDigest: hex("a"),
      edits: [edit],
    }),
    recipeDigest: hex("b"),
  });
}

async function seedRepository(
  client: PrismaClient,
  id = repositoryId,
  targetScope = scope,
): Promise<void> {
  await client.project.upsert({
    where: { projectId: targetScope.projectId },
    create: { projectId: targetScope.projectId },
    update: {},
  });
  await client.assemblySystem.upsert({
    where: { projectId_systemId: targetScope },
    create: targetScope,
    update: {},
  });
  await client.sourceRepository.upsert({
    where: {
      projectId_systemId_repositoryId: { ...targetScope, repositoryId: id },
    },
    create: {
      ...targetScope,
      repositoryId: id,
      sourceScopeId:
        `pg3-${targetScope.projectId}-${targetScope.systemId}-${id}`,
    },
    update: {},
  });
}

postgresTest(
  "postgres queue: duplicate is idempotent, conflicting dossier rejected",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
      });
      const id = "11111111-1111-4111-8111-111111111111";
      const dossier = await dossierFor(id);
      equal((await queue.enqueue(dossier)).status, "queued");
      equal((await queue.enqueue(dossier)).status, "duplicate");
      deepStrictEqual(await queue.getDossier(repositoryId, id), dossier);
      const returnedDossier = await queue.getDossier(repositoryId, id);
      if (
        returnedDossier && !isScopedSoftwareWriteDossier(returnedDossier) &&
        returnedDossier.decision.kind === "approved-change"
      ) {
        returnedDossier.decision.change.reason = "caller-local mutation";
      }
      deepStrictEqual(await queue.getDossier(repositoryId, id), dossier);
      // Valid domain dossier with identical command bytes but distinct envelope
      // bytes: command digest alone must not treat this as a duplicate.
      const changedEnvelope = { ...dossier, transportNote: "changed" };
      await rejects(() => queue.enqueue(changedEnvelope), {
        code: "WRITE_QUEUE_CONFLICT",
      });
      await rejects(async () => queue.enqueue(await dossierFor(id, "Forged")), {
        code: "WRITE_QUEUE_CONFLICT",
      });
    });
  },
);

postgresTest(
  "postgres queue: pending bound and FIFO order across two clients",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      const first = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
        maxPendingPerRepository: 2,
      });
      const second = new PostgresModelWriteQueue({
        client: database.createClient(),
        scope,
        writerLock: database.writerLock,
        maxPendingPerRepository: 2,
      });
      const id1 = "11111111-1111-4111-8111-111111111111";
      const id2 = "22222222-2222-4222-8222-222222222222";
      const id3 = "33333333-3333-4333-8333-333333333333";
      await first.enqueue(await dossierFor(id1));
      await second.enqueue(await dossierFor(id2));
      await rejects(async () => first.enqueue(await dossierFor(id3)), {
        code: "WRITE_QUEUE_FULL",
      });
      const acquired = await second.acquire(repositoryId, "owner-b", 60_000);
      assert(acquired);
      equal(acquired.lease.commandId, id1, "oldest seq is the FIFO head");
      equal(
        await first.acquire(repositoryId, "owner-a", 60_000),
        null,
        "single active owner per repository across clients",
      );
      deepStrictEqual(
        (await first.list(repositoryId)).map((e) => e.command.commandId),
        [id1, id2],
      );
    });
  },
);

postgresTest(
  "postgres queue: expired lease recovers head with fresh fence; stale owner refused",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      let now = Date.parse("2026-10-25T12:00:00.000Z");
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
        now: () => new Date(now),
      });
      const id = "11111111-1111-4111-8111-111111111111";
      await queue.enqueue(await dossierFor(id));
      const acquired = await queue.acquire(repositoryId, "owner-a", 1_000);
      assert(acquired);
      now += 2_000;
      equal(await queue.recoverExpired(), 1);
      const reacquired = await queue.acquire(repositoryId, "owner-b", 60_000);
      assert(reacquired);
      assert(reacquired.lease.fence > acquired.lease.fence);
      await rejects(
        () =>
          queue.settle(acquired.lease, { status: "published", version: "x" }),
        { code: "WRITE_FENCE_LOST" },
      );
      await rejects(() => queue.heartbeat(acquired.lease, 60_000), {
        code: "WRITE_FENCE_LOST",
      });
      let staleEffectRan = false;
      await rejects(
        () =>
          database.writerLock(repositoryId).then((lock) =>
            lock.runExclusive(() =>
              queue.guardPublication(acquired.lease, 1_000, () => {
                staleEffectRan = true;
                return Promise.resolve();
              })
            )
          ),
        { code: "WRITE_FENCE_LOST" },
      );
      equal(staleEffectRan, false);
      await queue.transition(reacquired.lease, "prepared");
      await queue.transition(reacquired.lease, "publishing");
      await queue.settle(reacquired.lease, {
        status: "published",
        version: "commit:" + "3".repeat(40),
      });
      equal((await queue.get(repositoryId, id))?.state, "published");
    });
  },
);

postgresTest(
  "postgres queue: guard refuses outside Git lock and renews after slow CAS",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      let now = Date.now();
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
        now: () => new Date(now),
      });
      const id = "11111111-1111-4111-8111-111111111111";
      await queue.enqueue(await dossierFor(id));
      const acquired = await queue.acquire(repositoryId, "slow-owner", 1000);
      assert(acquired);
      // Accept-proposal follows preparing -> publishing directly.
      await queue.transition(acquired.lease, "publishing");
      let effects = 0;
      await rejects(() =>
        queue.guardPublication(acquired.lease, 1000, () => {
          effects++;
          return Promise.resolve("bad");
        }), { code: "WRITE_QUEUE_UNAVAILABLE" });
      equal(effects, 0);
      const lock = await database.writerLock(repositoryId);
      const callbackError = Object.assign(new Error("Git source conflict"), {
        code: "SOURCE_CONFLICT",
      });
      await rejects(
        () =>
          lock.runExclusive(() =>
            queue.guardPublication(
              acquired.lease,
              1000,
              () => Promise.reject(callbackError),
            )
          ),
        (error) => error === callbackError,
      );
      let pendingHeartbeat: Promise<void> | undefined;
      equal(
        await lock.runExclusive(() =>
          queue.guardPublication(acquired.lease, 1000, () => {
            effects++;
            // Its timestamp is captured before it waits for the guarded command row.
            pendingHeartbeat = queue.heartbeat(acquired.lease, 1000);
            now += 2000;
            return Promise.resolve("published");
          })
        ),
        "published",
      );
      equal(effects, 1);
      await pendingHeartbeat;
      await queue.settle(acquired.lease, {
        status: "published",
        version: baseVersion,
      });
      equal((await queue.get(repositoryId, id))?.state, "published");
    });
  },
);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => release = resolve);
  return { promise, release };
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

postgresTest(
  "postgres queue: disconnect during live effect blocks claim and recovery until effect ends",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      let now = Date.now();
      const options = {
        scope,
        writerLock: database.writerLock,
        now: () => new Date(now),
      };
      const queue = new PostgresModelWriteQueue({
        ...options,
        client: database.client,
      });
      const peer = new PostgresModelWriteQueue({
        ...options,
        client: database.createClient(),
      });
      const id = "11111111-1111-4111-8111-111111111111";
      await queue.enqueue(await dossierFor(id));
      const acquired = await queue.acquire(
        repositoryId,
        "disconnected-owner",
        1000,
      );
      assert(acquired);
      await queue.transition(acquired.lease, "publishing");
      const entered = latch(), finish = latch();
      let effects = 0;
      const lock = await database.writerLock(repositoryId);
      const guard = lock.runExclusive(() =>
        queue.guardPublication(acquired.lease, 1000, async () => {
          effects++;
          entered.release();
          await finish.promise;
        })
      );
      const guardFailure = rejects(guard, { code: "WRITE_QUEUE_UNAVAILABLE" });
      await entered.promise;
      const admin = new Client({ connectionString: database.connectionString });
      await admin.connect();
      try {
        // Exact unique-schema filter finds the live production transaction.
        const active = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE $1",
          [`%${database.schema}%`],
        );
        equal(active.rows.length, 1);
        equal(
          (await admin.query("SELECT pg_terminate_backend($1) AS stopped", [
            active.rows[0].pid,
          ])).rows[0].stopped,
          true,
        );
        now += 2000;
        let claimed = false, recovered = false;
        const pendingClaim = peer.acquire(repositoryId, "next-owner", 30_000)
          .then((value) => {
            claimed = true;
            return value;
          });
        const pendingRecovery = peer.recoverExpired().then((value) => {
          recovered = true;
          return value;
        });
        await tick();
        equal(
          claimed,
          false,
          "dead SQL connection cannot free the OS effect exclusion",
        );
        equal(
          recovered,
          false,
          "recovery cannot clear ownership during the live effect",
        );
        finish.release();
        await guardFailure;
        const next = await pendingClaim;
        await pendingRecovery;
        assert(next);
        assert(next.lease.fence > acquired.lease.fence);
        equal(effects, 1);
        await rejects(
          () =>
            queue.settle(acquired.lease, {
              status: "published",
              version: baseVersion,
            }),
          { code: "WRITE_FENCE_LOST" },
        );
      } finally {
        finish.release();
        await guardFailure;
        await admin.end();
      }
    });
  },
);

async function gitQueueFixture(
  database: QueueDatabase,
  beforeEffect?: () => Promise<void>,
) {
  const projectDir = await Deno.makeTempDir({ prefix: "pg3-git-" });
  let queue!: PostgresModelWriteQueue;
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: queueTestCompiler,
      writeFence: {
        assertCurrent: (fence) => queue.heartbeat(fence, 30_000),
        guard: (fence, operation) =>
          queue.guardPublication(fence, 30_000, async () => {
            await beforeEffect?.();
            return await operation();
          }),
      },
    });
    const base = await repository.initialize({
      "model.sysml": "package Initial;\n",
    });
    const proposal = await repository.propose({
      baseVersion: base.version,
      sources: { "model.sysml": "package Proposed;\n" },
      author: "pg3-fixture",
      reason: "Queue publication recovery",
    });
    await seedRepository(database.client, repository.repositoryId);
    let now = Date.now();
    queue = new PostgresModelWriteQueue({
      client: database.client,
      scope,
      writerLock: () => repositoryWriterLock(repository.stateDir),
      now: () => new Date(now),
    });
    const dossier = await buildAcceptProposalCommand({
      repositoryId: repository.repositoryId,
      proposal,
      expectedVersion: base.version,
      author: "pg3-reviewer",
      baseSourceDigest: base.sourceDigest,
      recipeDigest: queueTestRecipe,
    });
    await queue.enqueue(dossier);
    return {
      projectDir,
      repository,
      queue,
      dossier,
      expire: () => now = Date.now() + 600_000,
      worker: () =>
        new ModelWriteWorker({
          queue,
          repository,
          publication: unusedPublication,
          owner: "recovery-owner",
          leaseMs: 30_000,
          recipeDigest: () => Promise.resolve(queueTestRecipe),
        }),
      close: () => Deno.remove(projectDir, { recursive: true }),
    };
  } catch (error) {
    await Deno.remove(projectDir, { recursive: true });
    throw error;
  }
}

function childWorker(
  database: QueueDatabase,
  fixture: Awaited<ReturnType<typeof gitQueueFixture>>,
  mode: string,
  marker: string,
) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--frozen",
      "--allow-all",
      fileURLToPath(
        new URL("../support/postgres-write-queue.ts", import.meta.url),
      ),
      mode,
      database.schema,
      fixture.projectDir,
      fixture.repository.repositoryId,
      marker,
    ],
    env: { ASSEMBLY_POSTGRES_TEST_URL: database.connectionString },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}
async function waitMarker(path: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Child did not reach its durable publication marker");
}

postgresTest(
  "postgres queue: real accept-proposal worker uses preparing to publishing and exact digest anchor",
  async () => {
    await withPostgresDatabase(async (database) => {
      const fixture = await gitQueueFixture(database);
      try {
        const result = await fixture.worker().runOnce(
          fixture.repository.repositoryId,
        );
        assert(result.status === "published");
        equal(result.already, false);
        const anchor = await fixture.repository.findPublicationByCommand(
          fixture.dossier.command.commandId,
        );
        assert(anchor);
        equal(
          anchor.commandDigest,
          (await fixture.queue.get(
            fixture.repository.repositoryId,
            fixture.dossier.command.commandId,
          ))?.commandDigest,
        );
        equal(anchor.revision.version, result.version);
        equal(
          (await fixture.queue.get(
            fixture.repository.repositoryId,
            fixture.dossier.command.commandId,
          ))?.state,
          "published",
        );
        equal(
          (await fixture.worker().runOnce(fixture.repository.repositoryId))
            .status,
          "idle",
        );
      } finally {
        await fixture.close();
      }
    });
  },
);

postgresTest(
  "postgres queue: concurrent real processes acquire only one repository owner",
  async () => {
    await withPostgresDatabase(async (database) => {
      const fixture = await gitQueueFixture(database);
      const markers = ["claim-a", "claim-b"].map((name) =>
        `${fixture.projectDir}/${name}`
      );
      try {
        const children = markers.map((marker) =>
          childWorker(database, fixture, "claim", marker)
        );
        const outputs = await Promise.all(
          children.map((child) => child.output()),
        );
        for (const output of outputs) {
          assert(output.success, new TextDecoder().decode(output.stderr));
        }
        const claims = await Promise.all(
          markers.map(async (path) =>
            JSON.parse(await Deno.readTextFile(path))
          ),
        );
        equal(claims.filter(Boolean).length, 1);
        equal(
          claims.find(Boolean).commandId,
          fixture.dossier.command.commandId,
        );
      } finally {
        await fixture.close();
      }
    });
  },
);

postgresTest(
  "postgres queue: SIGKILL after actual Git CAS before SQL settlement recovers exact anchor once",
  async () => {
    await withPostgresDatabase(async (database) => {
      const fixture = await gitQueueFixture(database);
      const marker = `${fixture.projectDir}/published-before-settle`;
      const child = childWorker(database, fixture, "crash", marker);
      const output = child.output();
      let killed = false;
      try {
        const version = await Promise.race([
          waitMarker(marker),
          output.then((result) => {
            throw new Error(
              `Child exited before crash marker: ${
                new TextDecoder().decode(result.stderr)
              }`,
            );
          }),
        ]);
        const commandId = fixture.dossier.command.commandId;
        const before = await fixture.queue.get(
          fixture.repository.repositoryId,
          commandId,
        );
        equal(before?.state, "publishing");
        const anchor = await fixture.repository.findPublicationByCommand(
          commandId,
        );
        assert(anchor);
        equal(anchor.revision.version, version);
        equal(anchor.commandDigest, before?.commandDigest);
        child.kill("SIGKILL");
        killed = true;
        equal((await output).success, false);
        fixture.expire();
        const recovered = await fixture.worker().runOnce(
          fixture.repository.repositoryId,
        );
        assert(recovered.status === "published");
        equal(
          recovered.already,
          true,
          "unchanged worker uses exact command anchor before attempting acceptance",
        );
        equal(recovered.version, version);
        equal(await fixture.repository.headVersion(), version);
        equal(
          (await fixture.queue.get(fixture.repository.repositoryId, commandId))
            ?.state,
          "published",
        );
        equal(
          (await fixture.worker().runOnce(fixture.repository.repositoryId))
            .status,
          "idle",
        );
      } finally {
        if (!killed) {
          try {
            child.kill("SIGKILL");
          } catch { /* Process already exited. */ }
        }
        await output;
        await fixture.close();
      }
    });
  },
);

postgresTest(
  "postgres queue: equal repository and command IDs in sibling projects and systems stay isolated",
  async () => {
    await withPostgresDatabase(async (database) => {
      const scopes = [scope, { ...scope, projectId: "other-project" }, {
        ...scope,
        systemId: "other-system",
      }];
      const queues: PostgresModelWriteQueue[] = [];
      for (const target of scopes) {
        await seedRepository(database.client, repositoryId, target);
        queues.push(
          new PostgresModelWriteQueue({
            client: database.client,
            scope: target,
            writerLock: database.writerLock,
          }),
        );
      }
      const id = "11111111-1111-4111-8111-111111111111";
      for (const queue of queues) {
        equal((await queue.enqueue(await dossierFor(id))).status, "queued");
      }
      const leases = await Promise.all(
        queues.map((queue, index) =>
          queue.acquire(repositoryId, `owner-${index}`, 30_000)
        ),
      );
      for (const lease of leases) assert(lease);
      await rejects(
        () =>
          queues[1].settle(leases[0]!.lease, {
            status: "published",
            version: baseVersion,
          }),
        { code: "WRITE_FENCE_LOST" },
      );
      await queues[0].settle(leases[0]!.lease, {
        status: "published",
        version: baseVersion,
      });
      equal((await queues[0].get(repositoryId, id))?.state, "published");
      equal((await queues[1].get(repositoryId, id))?.state, "preparing");
      equal((await queues[2].get(repositoryId, id))?.state, "preparing");
    });
  },
);

postgresTest(
  "postgres queue: expired active head is reclaimed before queued followers without a recovery sweep",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      let now = Date.now();
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
        now: () => new Date(now),
      });
      const ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ];
      for (const id of ids) await queue.enqueue(await dossierFor(id));
      const first = await queue.acquire(repositoryId, "first", 1000);
      assert(first);
      await queue.transition(first.lease, "publishing");
      now += 2000;
      const recovered = await queue.acquire(repositoryId, "recovered", 30_000);
      assert(recovered);
      equal(recovered.lease.commandId, ids[0]);
      assert(recovered.lease.fence > first.lease.fence);
      const lock = await database.writerLock(repositoryId);
      let effects = 0;
      await rejects(
        () =>
          lock.runExclusive(() =>
            queue.guardPublication(first.lease, 1000, () => {
              effects++;
              return Promise.resolve();
            })
          ),
        { code: "WRITE_FENCE_LOST" },
      );
      equal(effects, 0);
      await queue.settle(recovered.lease, {
        status: "published",
        version: baseVersion,
      });
      equal(
        (await queue.acquire(repositoryId, "next", 30_000))?.lease.commandId,
        ids[1],
      );
    });
  },
);

postgresTest(
  "postgres queue: lost SQL connection during real Git acceptance leaves one anchored result for recovery",
  async () => {
    await withPostgresDatabase(async (database) => {
      const entered = latch(), finish = latch();
      const fixture = await gitQueueFixture(database, async () => {
        entered.release();
        await finish.promise;
      });
      const admin = new Client({ connectionString: database.connectionString });
      await admin.connect();
      let running: Promise<unknown> | undefined;
      try {
        running = fixture.worker().runOnce(fixture.repository.repositoryId);
        const outcome = running.then((value) => value, (error) => error);
        await entered.promise;
        const active = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE $1",
          [`%${database.schema}%`],
        );
        equal(active.rows.length, 1);
        equal(
          (await admin.query("SELECT pg_terminate_backend($1) AS stopped", [
            active.rows[0].pid,
          ])).rows[0].stopped,
          true,
        );
        fixture.expire();
        const peer = new PostgresModelWriteQueue({
          client: database.createClient(),
          scope,
          writerLock: () => repositoryWriterLock(fixture.repository.stateDir),
          now: () => new Date(Date.now() + 600_000),
        });
        let acquired = false;
        const claim = peer.acquire(
          fixture.repository.repositoryId,
          "competing-owner",
          30_000,
        ).then((value) => {
          acquired = true;
          return value;
        });
        await tick();
        equal(
          acquired,
          false,
          "competing owner waits for the live Git writer despite lost SQL lock",
        );
        finish.release();
        await outcome;
        const claimed = await claim;
        assert(claimed);
        const anchor = await fixture.repository.findPublicationByCommand(
          fixture.dossier.command.commandId,
        );
        assert(anchor, "Git command anchor survives failed database renewal");
        equal(anchor.commandDigest, claimed.entry.commandDigest);
        equal(await fixture.repository.headVersion(), anchor.revision.version);
        // Return this test's fresh claim so the real unchanged worker can recover.
        await peer.settle(claimed.lease, {
          status: "retryable",
          error: {
            code: "TEST_RECOVERY",
            message: "Use existing worker recovery",
          },
        });
        const recovered = await fixture.worker().runOnce(
          fixture.repository.repositoryId,
        );
        assert(recovered.status === "published");
        equal(recovered.already, true);
        equal(recovered.version, anchor.revision.version);
      } finally {
        finish.release();
        await running?.catch(() => {});
        await admin.end();
        await fixture.close();
      }
    });
  },
);

postgresTest(
  "postgres queue: database refuses immutable dossier replacement and unsafe counters",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
      });
      const dossier = await dossierFor("11111111-1111-4111-8111-111111111111");
      await queue.enqueue(dossier);
      const table = postgresQualifiedTable(
        database.client,
        "ModelWriteCommand",
      );
      await rejects(() =>
        database.client.$executeRaw(Prisma.sql`UPDATE ${table}
      SET dossier_json = '{}'
      WHERE project_id = ${scope.projectId} AND system_id = ${scope.systemId}
        AND repository_id = ${repositoryId}`)
      );
      await rejects(() =>
        database.client.$executeRaw(Prisma.sql`UPDATE ${table}
      SET fence = 9007199254740992
      WHERE project_id = ${scope.projectId} AND system_id = ${scope.systemId}
        AND repository_id = ${repositoryId}`)
      );
      deepStrictEqual(
        await queue.getDossier(repositoryId, dossier.command.commandId),
        dossier,
      );
    });
  },
);

postgresTest(
  "postgres queue: real elapsed slow CAS remains exclusive past its initial lease",
  async () => {
    await withPostgresDatabase(async (database) => {
      await seedRepository(database.client);
      const queue = new PostgresModelWriteQueue({
        client: database.client,
        scope,
        writerLock: database.writerLock,
      });
      const peer = new PostgresModelWriteQueue({
        client: database.createClient(),
        scope,
        writerLock: database.writerLock,
      });
      const id = "11111111-1111-4111-8111-111111111111";
      await queue.enqueue(await dossierFor(id));
      const acquired = await queue.acquire(
        repositoryId,
        "slow-wall-clock-owner",
        500,
      );
      assert(acquired);
      await queue.transition(acquired.lease, "publishing");
      const entered = latch();
      let effects = 0, claimed = false;
      const lock = await database.writerLock(repositoryId);
      const started = Date.now();
      const publication = lock.runExclusive(() =>
        queue.guardPublication(acquired.lease, 5000, async () => {
          effects++;
          entered.release();
          await new Promise((resolve) => setTimeout(resolve, 750));
          return "one-effect";
        })
      );
      await entered.promise;
      const claim = peer.acquire(
        repositoryId,
        "competing-wall-clock-owner",
        5000,
      ).then((value) => {
        claimed = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      equal(
        claimed,
        false,
        "claim stays blocked after the real original lease deadline",
      );
      equal(await publication, "one-effect");
      assert(Date.now() - started >= 750);
      equal(
        await claim,
        null,
        "post-CAS renewal keeps the original owner current",
      );
      equal(effects, 1);
      await queue.settle(acquired.lease, {
        status: "published",
        version: baseVersion,
      });
    });
  },
);
