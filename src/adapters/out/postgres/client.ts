import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../../../prisma/generated/client.ts";
import {
  type PostgresClientConfiguration,
  postgresPrismaUtcConnectionString,
} from "./config.ts";
import process from "node:process";

export { Prisma, PrismaClient };

import {
  postgresQualifiedTableIdentifier,
  registerPostgresClientSchema,
} from "./client-schema.ts";
export { postgresClientSchema } from "./client-schema.ts";

/** Host-selected SQL identifier only; values still use Prisma.sql parameters. */
export function postgresQualifiedTable(
  client: PrismaClient,
  table: string,
): Prisma.Sql {
  return Prisma.raw(postgresQualifiedTableIdentifier(client, table));
}

/** One host-owned pool shared by scoped adapters; close once at host shutdown. */
export function createPostgresClient(
  configuration: PostgresClientConfiguration,
): PrismaClient {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(configuration.schema)) {
    throw new Error("Invalid PostgreSQL schema identifier");
  }
  const adapter = new PrismaPg({
    connectionString: postgresPrismaUtcConnectionString(
      configuration.connectionString,
      process.env.PGOPTIONS,
    ),
    max: configuration.maxConnections,
    connectionTimeoutMillis: configuration.connectionTimeoutMillis,
    idleTimeoutMillis: configuration.idleTimeoutMillis,
  }, { schema: configuration.schema });
  const client = new PrismaClient({
    adapter,
    // Query logging can expose payloads and private binding metadata.
    log: [],
    transactionOptions: { maxWait: 5_000, timeout: 10_000 },
  });
  registerPostgresClientSchema(client, configuration.schema);
  return client;
}
