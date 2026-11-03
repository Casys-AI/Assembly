import type { PrismaClient } from "../../../../prisma/generated/client.ts";

const configuredSchemas = new WeakMap<PrismaClient, string>();

/** Factory-only metadata registration; no environment lookup or public fallback. */
export function registerPostgresClientSchema(
  client: PrismaClient,
  schema: string,
): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("Invalid PostgreSQL schema identifier");
  }
  configuredSchemas.set(client, schema);
}

export function postgresClientSchema(client: PrismaClient): string {
  const schema = configuredSchemas.get(client);
  if (!schema) throw new Error("Unregistered PostgreSQL client");
  return schema;
}

export function postgresQualifiedTableIdentifier(
  client: PrismaClient,
  table: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
    throw new Error("Invalid PostgreSQL table identifier");
  }
  return `"${postgresClientSchema(client)}"."${table}"`;
}
