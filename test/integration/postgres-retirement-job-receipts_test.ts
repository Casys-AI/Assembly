import assert from "node:assert/strict";
import { Pool } from "pg";
import { fromPrisma, PgBoss } from "pg-boss";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import {
  PostgresNativeExecutionLedger,
  type PostgresOperatorJob,
} from "../../src/adapters/out/native-execution/postgres-ledger.ts";
import { PostgresOperatorDispatch } from "../../src/adapters/out/native-execution/operator-dispatch.ts";
import { lockRetirementJobReceipts } from "../../src/adapters/out/native-execution/retirement-job-receipts.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { eventually } from "../support/eventually.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  database: PostgresTestDatabase,
  ownerStatus = "completed",
) {
  const { client } = database;
  const fixtureId = crypto.randomUUID().slice(0, 8);
  const scope = {
    projectId: "receipt-project",
    systemId: "receipt-system",
    executionSpaceId: "main",
  };
  const queueSchema = `${database.schema}_j${fixtureId}`,
    queueName = `receipt-${fixtureId}`;
  const boss = new PgBoss({
    connectionString: database.connectionString,
    schema: queueSchema,
    schedule: false,
    supervise: false,
  });
  const errors: unknown[] = [];
  boss.on("error", (error) => {
    errors.push(error);
  });
  database.registerCleanup(async () => {
    await boss.stop();
    // Only this fixture's explicitly owned framework namespace.
    await client.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`,
    );
  });
  await boss.start();
  const pool = new Pool({
    connectionString: database.connectionString,
    max: 2,
  });
  database.registerCleanup(() => pool.end());
  const lookup = (tx: Prisma.TransactionClient, id: string) =>
    boss.findJobs<PostgresOperatorJob>(queueName, {
      id,
      limit: 1,
      db: fromPrisma(tx),
    });
  const ledger = new PostgresNativeExecutionLedger({
    client,
    scope,
    queueSchema,
    queueName,
    checkpointPool: pool,
    checkpointSchema: database.schema,
    lookupRetirementJob: lookup,
  });
  const dispatch = new PostgresOperatorDispatch(ledger, boss);
  await dispatch.setup();
  const inputId = `original-input-${fixtureId}`;
  const delivery: PostgresOperatorJob["delivery"] = {
    id: inputId,
    kind: "contribution",
    identity: {
      operatorId: "owner",
      invocationKey: "local:case",
      purpose: "conversation",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
      subjectId: inputId,
    },
    modelPin: {
      modelDigest: "a".repeat(64),
      repositoryVersion: `commit:${"b".repeat(40)}`,
    },
    payload: { text: "A real queued delivery", inputMessageId: inputId },
  };
  const data: PostgresOperatorJob = {
    runtimeScope: scope,
    threadId: `owner-thread-${fixtureId}`,
    delivery,
  };
  const jobId = await boss.send(queueName, data, {
    singletonKey: await executionDigest({
      ...scope,
      operatorId: delivery.identity.operatorId,
    }),
  });
  assert(jobId);
  async function receipt(
    operatorId: string,
    threadId: string,
    contributionId: string,
    status: string,
  ) {
    await seedPostgresRuntime(client, { ...scope, operatorId });
    const identity = { ...delivery.identity, operatorId };
    await client.operatorExecution.create({
      data: {
        ...scope,
        operatorId,
        threadId,
        identityJson: canonical(identity),
        scopeKind: "request",
        scopeId: "case",
        rootRequestId: "case",
        purpose: "conversation",
        subjectId: delivery.identity.subjectId,
        status: "waiting",
        checkpointNamespace: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return await client.executionContribution.create({
      data: {
        ...scope,
        operatorId,
        threadId,
        contributionId,
        digest: await executionDigest(delivery),
        kind: "contribution",
        originJson: canonical({ delivery }),
        payloadJson: canonical(delivery),
        jobId,
        status,
        acceptedAt: new Date(),
      },
    });
  }
  await receipt("owner", data.threadId, delivery.id, ownerStatus);
  const ownerKey = {
    ...scope,
    operatorId: "owner",
    threadId: data.threadId,
    contributionId: delivery.id,
  };
  const where = {
    projectId_systemId_executionSpaceId_operatorId_threadId_contributionId:
      ownerKey,
  };
  const lock = (tx: Prisma.TransactionClient) =>
    lockRetirementJobReceipts({
      tx,
      client,
      scope,
      queueName,
      jobIds: [jobId],
      lookup,
    });
  return {
    client,
    scope,
    queueName,
    boss,
    errors,
    dispatch,
    data,
    jobId,
    receipt,
    where,
    lock,
  };
}

Deno.test({
  name:
    "retirement locks the owner receipt; an officially activated retry waits then returns without invoking its handler",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database);
      const locked = gate(), release = gate();
      let handlerCalls = 0;
      const retirement = f.client.$transaction(async (tx) => {
        await f.lock(tx);
        locked.release();
        await release.promise;
      }, { timeout: 20_000 });
      try {
        await Promise.race([locked.promise, retirement]);
        // This is the actual worker/claim/receipt path, not a replacement worker.
        await f.dispatch.start(async () => {
          handlerCalls++;
          return await Promise.resolve();
        });
        await eventually(
          async () =>
            (await f.boss.findJobs(f.queueName, { id: f.jobId, limit: 1 }))[0]
                ?.state === "active" || undefined,
          { timeoutMs: 15_000 },
        );
        assert.equal(handlerCalls, 0);
      } finally {
        release.release();
        await retirement;
      }
      await eventually(
        async () =>
          (await f.boss.findJobs(f.queueName, { id: f.jobId, limit: 1 }))[0]
              ?.state === "completed" || undefined,
        { timeoutMs: 15_000 },
      );
      assert.equal(handlerCalls, 0);
      assert.deepEqual(f.errors, []);
    });
  },
});

Deno.test({
  name:
    "retirement refuses a running owner despite completed nested native receipt, owner-lock races and malformed job evidence",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const f = await fixture(database, "queued");
      await f.receipt("nested", "nested-thread", "nested-input", "completed");
      for (const status of ["running", "failed", "uncertain", "queued"]) {
        const blocked = await fixture(database, status);
        if (status === "running") {
          await blocked.receipt(
            "nested",
            "nested-running-owner",
            "nested-completed-input",
            "completed",
          );
        }
        await assert.rejects(
          () => blocked.client.$transaction(blocked.lock),
          /completed retirement job owner/,
        );
      }
      const competitor = database.createClient(),
        locked = gate(),
        release = gate();
      const worker = competitor.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "contributionId" FROM ${
            postgresQualifiedTable(competitor, "ExecutionContribution")
          }
          WHERE "projectId"=${f.scope.projectId} AND "systemId"=${f.scope.systemId}
          AND "executionSpaceId"=${f.scope.executionSpaceId} AND "operatorId"='owner'
          AND "threadId"=${f.data.threadId} AND "contributionId"=${f.data.delivery.id} FOR UPDATE`,
        );
        await tx.executionContribution.update({
          where: f.where,
          data: { status: "running" },
        });
        locked.release();
        await release.promise;
      }, { timeout: 20_000 });
      try {
        await Promise.race([locked.promise, worker]);
        await assert.rejects(() => f.client.$transaction(f.lock));
      } finally {
        release.release();
        await worker;
      }
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /completed retirement job owner/,
      );
      await f.client.executionContribution.update({
        where: f.where,
        data: { status: "completed" },
      });
      await f.boss.update(f.queueName, {
        ...f.data,
        threadId: "nested-thread",
        delivery: {
          ...f.data.delivery,
          identity: { ...f.data.delivery.identity, operatorId: "nested" },
          id: "nested-input",
        },
      }, { id: f.jobId });
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /completed retirement job owner/,
      );
      await f.boss.update(f.queueName, {
        ...f.data,
        threadId: "missing-owner-thread",
      }, { id: f.jobId });
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /completed retirement job owner/,
      );
      await f.boss.update(f.queueName, {
        ...f.data,
        runtimeScope: { ...f.scope, executionSpaceId: "foreign" },
      }, { id: f.jobId });
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /job owner is unavailable/,
      );
      await f.boss.update(f.queueName, f.data, { id: f.jobId });
      const [attempt] = await f.boss.fetch(f.queueName, {
        includeMetadata: true,
      });
      assert(attempt);
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /Live or unknown native claim/,
      );
      await f.boss.complete(f.queueName, attempt);
      await f.client.$transaction(f.lock);
      await f.boss.deleteJob(f.queueName, f.jobId);
      await assert.rejects(
        () => f.client.$transaction(f.lock),
        /missing or foreign/,
      );
      assert.deepEqual(f.errors, []);
    });
  },
});
