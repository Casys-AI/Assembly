import { Client } from "pg";
import { createPostgresClient } from "../../src/adapters/out/postgres/client.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "../../src/adapters/out/postgres/scope.ts";
import { sourcePublicationError } from "./request-source-publication-diagnostics.ts";

/** Real PostgreSQL tests run only when the runner passes the dedicated test
 * URL; a stage without that environment permission reads as disabled. */
export const postgresTestEnabled = Deno.permissions.querySync({
      name: "env",
      variable: "ASSEMBLY_POSTGRES_TEST_URL",
    }).state === "granted" &&
  Boolean(Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL"));

/** A unique schema inside a dedicated local test database, never a demo DB. */
export interface PostgresTestDatabase {
  readonly client: PrismaClient;
  readonly schema: string;
  /** Test-host-only connection material. Never log or return it to a provider. */
  readonly connectionString: string;
  createClient(): PrismaClient;
  /** Only for explicit migration-upgrade fixtures, never product runtime use. */
  migrateToLatest(): Promise<void>;
  /** Stop owned resources/drop their explicit namespaces, once in LIFO order,
   * before the tracked Prisma clients and this helper's own schema are closed. */
  registerCleanup(cleanup: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export interface PostgresTestOptions {
  readonly throughMigration?: string;
}

/** Explicit ownership for fixtures whose setup and teardown span callbacks.
 * Other framework namespaces are never discovered or automatically dropped;
 * their owner must register an exact cleanup callback. */
export async function openPostgresDatabase(
  options: PostgresTestOptions = {},
): Promise<PostgresTestDatabase> {
  const configuration = postgresClientConfiguration(
    Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL"),
    2,
  );
  const url = new URL(configuration.connectionString);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/assembly_pg1_test"
  ) {
    throw new Error(
      "PostgreSQL qualification requires the dedicated local assembly_pg1_test database",
    );
  }
  const schema = `pg1_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: configuration.connectionString,
    connectionTimeoutMillis: 5_000,
  });
  const clients: PrismaClient[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  let connected = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let pendingMigration: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw new Error("PostgreSQL fixture is closing or closed");
  };
  const open = () => {
    assertOpen();
    const client = createPostgresClient(
      postgresClientConfiguration(configuration.connectionString, 2, schema),
    );
    clients.push(client);
    return client;
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const errors: unknown[] = [];
      await pendingMigration?.catch(() => {});
      for (const cleanup of cleanups.toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      const disconnected = await Promise.allSettled(
        clients.map((client) => client.$disconnect()),
      );
      for (const result of disconnected) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (connected) {
        try {
          await admin.query("ROLLBACK");
        } catch (error) {
          errors.push(error);
        }
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await admin.end();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const diagnosis = sourcePublicationError(new AggregateError(errors));
        throw new AggregateError(
          errors,
          `PostgreSQL fixture cleanup failed: ${JSON.stringify(diagnosis)}`,
        );
      }
    })();
    return closePromise;
  };
  try {
    const migrationDirectory = new URL(
      "../../prisma/migrations/",
      import.meta.url,
    );
    const migrationNames: string[] = [];
    for await (const entry of Deno.readDir(migrationDirectory)) {
      if (!entry.isDirectory) continue;
      if (!/^[0-9]{14}_[a-z0-9_]+$/.test(entry.name)) {
        throw new Error("Invalid PostgreSQL migration directory");
      }
      migrationNames.push(entry.name);
    }
    migrationNames.sort();
    if (
      options.throughMigration !== undefined &&
      !migrationNames.includes(options.throughMigration)
    ) {
      throw new Error("Unknown PostgreSQL migration cutoff");
    }
    const applied = new Set<string>();
    const migrate = (throughMigration?: string): Promise<void> => {
      assertOpen();
      const operation = async () => {
        const pending = migrationNames.filter((name) =>
          !applied.has(name) &&
          (throughMigration === undefined || name <= throughMigration)
        );
        if (!pending.length) return;
        // A migration may own an explicit BEGIN/COMMIT. Use a session-scoped
        // search_path on this fixture's dedicated connection so its COMMIT
        // cannot reset the schema before a following migration. Mirror deploy:
        // record each successful file independently, including on retry.
        await admin.query(`SET search_path TO "${schema}"`);
        try {
          for (const name of pending) {
            const migration = await Deno.readTextFile(
              new URL(`${name}/migration.sql`, migrationDirectory),
            );
            const ownsTransaction = /^\s*(?:--[^\n]*(?:\n|$)\s*)*BEGIN\s*;/i
              .test(migration);
            if (ownsTransaction && !/\bCOMMIT\s*;\s*$/i.test(migration)) {
              throw new Error(`Unclosed migration transaction: ${name}`);
            }
            if (!ownsTransaction) await admin.query("BEGIN");
            try {
              await admin.query(migration);
              if (!ownsTransaction) await admin.query("COMMIT");
            } catch (error) {
              await admin.query("ROLLBACK").catch(() => {});
              throw error;
            }
            applied.add(name);
          }
        } catch (error) {
          await admin.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          await admin.query("RESET search_path");
        }
      };
      // A later explicit retry may run after its caller handled a failed
      // migration; each original caller still observes its own rejection.
      pendingMigration =
        (pendingMigration?.catch(() => {}) ?? Promise.resolve()).then(
          operation,
        );
      return pendingMigration;
    };
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrate(options.throughMigration);
    return {
      client: open(),
      schema,
      connectionString: configuration.connectionString,
      createClient: open,
      migrateToLatest: () => migrate(),
      registerCleanup(cleanup) {
        assertOpen();
        cleanups.push(cleanup);
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PostgreSQL fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

export async function withPostgresDatabase<T>(
  run: (database: PostgresTestDatabase) => Promise<T>,
  options: PostgresTestOptions = {},
): Promise<T> {
  const database = await openPostgresDatabase(options);
  let result: T;
  try {
    result = await run(database);
  } catch (error) {
    try {
      await database.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PostgreSQL fixture scenario and cleanup failed",
      );
    }
    throw error;
  }
  await database.close();
  return result;
}

export async function seedPostgresRuntime(
  client: PrismaClient,
  scope: PostgresRuntimeScope,
): Promise<void> {
  assertPostgresRuntimeScope(scope);
  const { projectId, systemId, executionSpaceId } = scope;
  await client.project.upsert({
    where: { projectId },
    create: { projectId },
    update: {},
  });
  await client.assemblySystem.upsert({
    where: { projectId_systemId: { projectId, systemId } },
    create: { projectId, systemId },
    update: {},
  });
  await client.executionSpace.upsert({
    where: {
      projectId_systemId_executionSpaceId: {
        projectId,
        systemId,
        executionSpaceId: "baseline",
      },
    },
    create: { projectId, systemId, executionSpaceId: "baseline" },
    update: {},
  });
  if (executionSpaceId !== "baseline") {
    await client.executionSpace.upsert({
      where: {
        projectId_systemId_executionSpaceId: {
          projectId,
          systemId,
          executionSpaceId,
        },
      },
      create: {
        projectId,
        systemId,
        executionSpaceId,
        parentExecutionSpaceId: "baseline",
      },
      update: {},
    });
  }
  await client.operatorRuntime.upsert({
    where: { projectId_systemId_executionSpaceId_operatorId: scope },
    create: scope,
    update: {},
  });
}
