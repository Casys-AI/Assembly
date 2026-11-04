import type { RequestSourceOwnerAuthorityEnvelope } from "../../src/application/model/source-admission/request-source-owner.ts";
import { RequestSpaceError } from "../../src/domain/work/request-spaces.ts";
import { ModelWriteQueueError } from "../../src/application/model/publication/write-queue.ts";
import { isRequestSourceSettlementUnavailable } from "../../src/application/model/publication/request-source-context.ts";
import { buildModelWriteDossierV2 } from "../../src/application/model/publication/write-command-v2.ts";
/** Real queue SQL + OS fence, synthetic Git/authority/D2 participant evidence.
 * This proves transaction/dispatch ordering, not source publication authority. */
import assert from "node:assert/strict";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { requestPublicationFixture } from "../support/request-source-publication-fixture.ts";
import {
  PostgresModelWriteQueue,
  requestSqlUnavailable,
} from "../../src/adapters/out/postgres/model-write-queue.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { Prisma } from "../../src/adapters/out/postgres/client.ts";

Deno.test({
  name:
    "Request W3 guard keeps Git-pending SQL rollback recoverable without re-exercising revoked authority",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      const { dossier, context, revision } = await requestPublicationFixture();
      const scope = dossier.command.destination.host,
        repositoryId = dossier.command.repositoryId;
      await client.project.create({ data: { projectId: scope.projectId } });
      await client.assemblySystem.create({ data: scope });
      await client.sourceRepository.create({
        data: {
          ...scope,
          repositoryId,
          sourceScopeId: "request-fence-fixture",
        },
      });
      assert.match(schema, /^pg1_[a-f0-9]+$/);
      const marker = Prisma.raw(`"${schema}"."D3PublicationWitness"`);
      await client.$executeRaw(
        Prisma.sql`CREATE TABLE ${marker} (id integer PRIMARY KEY)`,
      );
      const dir = await Deno.makeTempDir({
        prefix: "request-publication-fence-",
      });
      try {
        const lock = await repositoryWriterLock(dir), events: string[] = [];
        let allowed = true, failAppend = true, effects = 0;
        const queue = new PostgresModelWriteQueue({
          client,
          scope,
          writerLock: () => Promise.resolve(lock),
          requestPublication: {
            assertNewLocked: () => {
              events.push("current-D1");
              return allowed
                ? Promise.resolve()
                : Promise.reject(new Error("revoked"));
            },
            assertExpiryLocked: () => {
              events.push("expiry");
              return Promise.resolve();
            },
            appendLocked: async (tx) => {
              events.push("append-D2");
              await tx.$executeRaw(
                Prisma.sql`INSERT INTO ${marker} (id) VALUES (1)`,
              );
              if (failAppend) throw new Error("after-Git SQL rollback");
            },
          },
        });
        await queue.enqueue(dossier);
        const otherDestination = {
          ...dossier.command.destination,
          caseId: "other-case",
        };
        const human = dossier.authority as RequestSourceOwnerAuthorityEnvelope;
        const otherAuthority = {
          ...human,
          proposal: {
            ...human.proposal,
            destination: otherDestination,
          },
          acceptance: {
            ...human.acceptance,
            destination: otherDestination,
          },
        };
        const conflicting = await buildModelWriteDossierV2({
          ...dossier.command,
          destination: otherDestination,
          authority: otherAuthority,
          operations: dossier.operations,
          decision: dossier.decision,
        });
        await assert.rejects(
          () => queue.enqueue(conflicting),
          (error: unknown) =>
            error instanceof Error && "code" in error &&
            error.code === "WRITE_QUEUE_CONFLICT",
        );
        const acquired = await queue.acquire(repositoryId, "worker", 60_000);
        assert(acquired);
        await queue.transition(acquired.lease, "publishing");
        const effect = () => {
          events.push("Git");
          effects++;
          return Promise.resolve(revision);
        };
        await assert.rejects(
          () =>
            lock.runExclusive(() =>
              queue.guardRequestPublication(
                acquired.lease,
                60_000,
                context,
                effect,
              )
            ),
          /SQL rollback/,
        );
        assert.equal(effects, 1, "Git cannot be rolled back with SQL");
        assert.deepEqual(
          await client.$queryRaw(Prisma.sql`SELECT * FROM ${marker}`),
          [],
        );
        assert.equal(
          (await queue.get(repositoryId, dossier.command.commandId))!.state,
          "publishing",
        );
        allowed = false;
        failAppend = false;
        await lock.runExclusive(() =>
          queue.reconcileRequestPublication(acquired.lease, 60_000, context)
        );
        await queue.settle(acquired.lease, {
          status: "published",
          version: revision.version,
        });
        assert.deepEqual(events, [
          "current-D1",
          "expiry",
          "Git",
          "append-D2",
          "append-D2",
        ]);
        assert.equal(
          (await queue.get(repositoryId, dossier.command.commandId))!
            .publishedVersion,
          revision.version,
        );
        assert.deepEqual(
          await client.$queryRaw(Prisma.sql`SELECT * FROM ${marker}`),
          [{ id: 1 }],
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});
Deno.test({
  name:
    "Request new publication fails closed without typed participant or after current authorization refusal",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      const { dossier, context, revision } = await requestPublicationFixture();
      const scope = dossier.command.destination.host,
        repositoryId = dossier.command.repositoryId;
      await client.project.create({ data: { projectId: scope.projectId } });
      await client.assemblySystem.create({ data: scope });
      await client.sourceRepository.create({
        data: {
          ...scope,
          repositoryId,
          sourceScopeId: "request-refused-fence-fixture",
        },
      });
      const dir = await Deno.makeTempDir({
        prefix: "request-publication-refused-",
      });
      try {
        const lock = await repositoryWriterLock(dir);
        let effects = 0;
        const options = {
          client,
          scope,
          writerLock: () => Promise.resolve(lock),
        };
        const queue = new PostgresModelWriteQueue(options);
        await queue.enqueue(dossier);
        const acquired = await queue.acquire(repositoryId, "worker", 60_000);
        assert(acquired);
        await queue.transition(acquired.lease, "publishing");
        const effect = () => {
          effects++;
          return Promise.resolve(revision);
        };
        await assert.rejects(
          () =>
            lock.runExclusive(() =>
              queue.guardRequestPublication(
                acquired.lease,
                60_000,
                context,
                effect,
              )
            ),
          /typed SQL participant/,
        );
        const refused = new PostgresModelWriteQueue({
          ...options,
          requestPublication: {
            assertNewLocked: () =>
              Promise.reject(new Error("current authority revoked")),
            assertExpiryLocked: () =>
              Promise.reject(new Error("must not continue")),
            appendLocked: () => Promise.reject(new Error("must not append")),
          },
        });
        await assert.rejects(
          () =>
            lock.runExclusive(() =>
              refused.guardRequestPublication(
                acquired.lease,
                60_000,
                context,
                effect,
              )
            ),
          /authority revoked/,
        );
        assert.equal(effects, 0);
        await queue.settle(acquired.lease, {
          status: "refused",
          error: { code: "REVOKED", message: "Fixture refused before Git" },
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});

Deno.test({
  name:
    "Request SQL serialization availability is distinct from immutable D2, fence and unknown SQL errors",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client, schema }) => {
      const { dossier, context } = await requestPublicationFixture();
      const scope = dossier.command.destination.host,
        repositoryId = dossier.command.repositoryId;
      await client.project.create({ data: { projectId: scope.projectId } });
      await client.assemblySystem.create({ data: scope });
      await client.sourceRepository.create({
        data: {
          ...scope,
          repositoryId,
          sourceScopeId: "request-sql-classification",
        },
      });
      assert.match(schema, /^pg1_[a-f0-9]+$/);
      const missing = Prisma.raw(`"${schema}"."D3NeverCreated"`);
      const dir = await Deno.makeTempDir({
        prefix: "request-sql-classification-",
      });
      try {
        const lock = await repositoryWriterLock(dir);
        let mode: "serialization" | "conflict" | "unknown" = "serialization";
        const conflict = new RequestSpaceError(
          "OPENING_CONFLICT",
          "The Request source admission changed.",
        );
        const options = {
          client,
          scope,
          writerLock: () => Promise.resolve(lock),
          requestPublication: {
            assertNewLocked: () =>
              Promise.reject(
                new Error(
                  "historical settlement cannot re-exercise current authority",
                ),
              ),
            assertExpiryLocked: () =>
              Promise.reject(
                new Error(
                  "historical settlement cannot re-exercise current authority",
                ),
              ),
            appendLocked: async (tx: Prisma.TransactionClient) => {
              if (mode === "conflict") throw conflict;
              if (mode === "unknown") {
                await tx.$queryRaw(Prisma.sql`SELECT * FROM ${missing}`);
                return;
              }
              await tx.$executeRaw(
                Prisma
                  .sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='controlled Request serialization interruption'; END; $$`,
              );
            },
          },
        };
        const queue = new PostgresModelWriteQueue(options);
        await queue.enqueue(dossier);
        const acquired = await queue.acquire(repositoryId, "worker", 60_000);
        assert(acquired);
        await queue.transition(acquired.lease, "publishing");
        const reconcile = () =>
          lock.runExclusive(() =>
            queue.reconcileRequestPublication(acquired.lease, 60_000, context)
          );
        await assert.rejects(
          reconcile,
          (error) =>
            error instanceof ModelWriteQueueError &&
            error.code === "WRITE_QUEUE_UNAVAILABLE",
        );
        mode = "conflict";
        await assert.rejects(
          reconcile,
          (error) =>
            error === conflict && !isRequestSourceSettlementUnavailable(error),
        );
        mode = "unknown";
        await assert.rejects(
          reconcile,
          (error) =>
            error instanceof Error &&
            !isRequestSourceSettlementUnavailable(error),
        );
        const expired = new PostgresModelWriteQueue({
          ...options,
          now: () => new Date(Date.now() + 120_000),
        });
        await assert.rejects(
          () =>
            lock.runExclusive(() =>
              expired.reconcileRequestPublication(
                acquired.lease,
                60_000,
                context,
              )
            ),
          (error) =>
            error instanceof ModelWriteQueueError &&
            error.code === "WRITE_FENCE_LOST" &&
            !isRequestSourceSettlementUnavailable(error),
        );
        await queue.settle(acquired.lease, {
          status: "refused",
          error: { code: "FIXTURE_END", message: "classification witnessed" },
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});

Deno.test("Request SQL classification recognizes only the observed nested adapter conflict shape", () => {
  const shape = (
    driverName: string,
    kind: string,
    originalCode: unknown,
    legacyCode?: string,
  ) =>
    Object.assign(new Error("Formatted message is not inspected"), {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
      meta: {
        ...(legacyCode === undefined ? {} : { code: legacyCode }),
        driverAdapterError: { name: driverName, cause: { kind, originalCode } },
      },
    });
  assert.equal(
    requestSqlUnavailable(
      shape("DriverAdapterError", "TransactionWriteConflict", "40001"),
    ),
    true,
  );
  assert.equal(
    requestSqlUnavailable(
      shape("DriverAdapterError", "TransactionWriteConflict", "23505"),
    ),
    false,
  );
  assert.equal(
    requestSqlUnavailable(shape("DriverAdapterError", "UnknownError", "40001")),
    false,
  );
  assert.equal(
    requestSqlUnavailable(
      shape("OtherAdapter", "TransactionWriteConflict", "40001"),
    ),
    false,
  );
  assert.equal(
    requestSqlUnavailable(
      shape("DriverAdapterError", "TransactionWriteConflict", 40001),
    ),
    false,
  );
  assert.equal(
    requestSqlUnavailable(
      shape("DriverAdapterError", "TransactionWriteConflict", "40001", "42P01"),
    ),
    false,
  );
  assert.equal(
    requestSqlUnavailable(
      shape("DriverAdapterError", "UnknownError", undefined, "40001"),
    ),
    true,
  );
});
