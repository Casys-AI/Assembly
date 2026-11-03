import assert from "node:assert/strict";
import { Client } from "pg";
import {
  createPostgresClient,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

Deno.test({
  name:
    "Prisma sockets retain UTC instants with a non-UTC PostgreSQL session and after reconnect",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const url = new URL(database.connectionString);
      url.searchParams.set(
        "options",
        "-c TimeZone=Asia/Taipei -c statement_timeout=5000",
      );
      const config = postgresClientConfiguration(
        url.toString(),
        2,
        database.schema,
      );
      const raw = new Client({ connectionString: database.connectionString });
      await raw.connect();
      let client = createPostgresClient(config);
      try {
        await raw.query("SET TIME ZONE 'Asia/Taipei'");
        assert.equal(
          (await raw.query("SHOW TimeZone")).rows[0].TimeZone,
          "Asia/Taipei",
        );
        const scope = {
          projectId: "timezone-project",
          systemId: "timezone-system",
          executionSpaceId: "main",
        };
        await seedPostgresRuntime(client, { ...scope, operatorId: "operator" });
        // Independent pg connection uses a non-UTC session and reads numeric
        // epoch, avoiding the Prisma timestamptz conversion under examination.
        const sql =
          `SELECT extract(epoch from "createdAt")::double precision AS epoch FROM "${database.schema}"."ExecutionSpace" WHERE "projectId" = $1 AND "systemId" = $2 AND "executionSpaceId" = $3`;
        const epoch = Number(
          (await raw.query(sql, [
            scope.projectId,
            scope.systemId,
            scope.executionSpaceId,
          ])).rows[0].epoch,
        );
        const key = { projectId_systemId_executionSpaceId: scope };
        const stored = await client.executionSpace.findUniqueOrThrow({
          where: key,
        });
        assert.equal(stored.createdAt.getTime(), Math.round(epoch * 1000));

        const intended = new Date("2026-10-28T22:53:30.470Z");
        const timestampTable = Prisma.raw(
          `"${database.schema}"."TimezoneWitness"`,
        );
        await client.$executeRaw(
          Prisma
            .sql`CREATE TABLE ${timestampTable} (value timestamptz NOT NULL)`,
        );
        const [inserted] = await client.$queryRaw<Array<{ value: Date }>>(
          Prisma
            .sql`INSERT INTO ${timestampTable} (value) VALUES (${intended}) RETURNING value`,
        );
        assert.equal(inserted.value.toISOString(), intended.toISOString());
        const written = Number(
          (await raw.query(
            `SELECT extract(epoch from value)::double precision AS epoch FROM "${database.schema}"."TimezoneWitness"`,
          )).rows[0].epoch,
        );
        assert.equal(Math.round(written * 1000), intended.getTime());
        let arrived = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const inspectSocket = () =>
          client.$transaction(async (tx) => {
            const [row] = await tx.$queryRaw<
              Array<
                { pid: number; timezone: string; observed: Date; epoch: number }
              >
            >(Prisma.sql`
            SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS timezone,
              ${intended}::timestamptz AS observed,
              extract(epoch from ${intended}::timestamptz)::double precision AS epoch
          `);
            if (++arrived === 2) release();
            await barrier;
            return row;
          });
        const executions = [inspectSocket(), inspectSocket()];
        let rows: Awaited<ReturnType<typeof inspectSocket>>[];
        try {
          rows = await Promise.all(executions);
        } finally {
          release();
          await Promise.allSettled(executions);
        }
        assert.notEqual(rows[0].pid, rows[1].pid);
        for (const row of rows) {
          assert.equal(row.timezone, "UTC");
          assert.equal(row.observed.toISOString(), intended.toISOString());
          assert.equal(Math.round(row.epoch * 1000), intended.getTime());
        }
        await client.$disconnect();
        client = createPostgresClient(config);
        const afterRestart = await client.executionSpace.findUniqueOrThrow({
          where: key,
        });
        assert.equal(
          afterRestart.createdAt.getTime(),
          Math.round(epoch * 1000),
        );
        const [retained] = await client.$queryRaw<Array<{ value: Date }>>(
          Prisma.sql`SELECT value FROM ${timestampTable}`,
        );
        assert.equal(retained.value.toISOString(), intended.toISOString());
      } finally {
        await client.$disconnect();
        await raw.end();
      }
    });
  },
});
