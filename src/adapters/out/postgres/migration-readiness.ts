import { StartupRefusalError } from "../../../infrastructure/startup-refusal.ts";
import { publicPostgresFailure } from "./errors.ts";
import { postgresClientSchema } from "./client-schema.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";

export interface MigrationRecord {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export class PostgresMigrationsPendingError extends StartupRefusalError {
  readonly code = "POSTGRES_MIGRATIONS_PENDING";
  readonly recovery = "deno task db:migrate";
  constructor(readonly context: { pending: string[]; unresolved: string[] }) {
    super("PostgreSQL migrations must be applied before startup");
    this.name = "PostgresMigrationsPendingError";
  }
}

/** A rolled-back attempt is neither an applied migration nor an unresolved one. */
export function assertPostgresMigrationsReady(
  expected: string[],
  records: MigrationRecord[],
): void {
  const successful = new Set(
    records.filter((row) =>
      row.finished_at !== null && row.rolled_back_at === null
    ).map((row) => row.migration_name),
  );
  const pending = expected.filter((name) => !successful.has(name)).sort();
  const unresolved = [
    ...new Set(
      records.filter((row) =>
        row.finished_at === null && row.rolled_back_at === null
      ).map((row) => row.migration_name),
    ),
  ].sort();
  if (pending.length || unresolved.length) {
    throw new PostgresMigrationsPendingError({ pending, unresolved });
  }
}

/** Read-only startup gate against the registry in this client's configured schema. */
export async function requirePostgresMigrations(
  client: PrismaClient,
): Promise<void> {
  const expected: string[] = [];
  for await (
    const entry of Deno.readDir(
      new URL("../../../../prisma/migrations/", import.meta.url),
    )
  ) {
    if (entry.isDirectory) expected.push(entry.name);
  }
  let records: MigrationRecord[];
  try {
    const registry = `"${postgresClientSchema(client)}"."_prisma_migrations"`;
    const [presence] = await client.$queryRaw<Array<{ present: boolean }>>(
      Prisma.sql`SELECT to_regclass(${registry}) IS NOT NULL AS present`,
    );
    records = presence.present
      ? await client.$queryRaw<MigrationRecord[]>(Prisma.sql`
        SELECT migration_name, finished_at, rolled_back_at
        FROM ${postgresQualifiedTable(client, "_prisma_migrations")}
      `)
      : [];
  } catch (error) {
    // Reuse the storage boundary sanitizer; unexpected programming failures
    // retain their identity rather than becoming a migration diagnosis.
    throw publicPostgresFailure(error) ?? error;
  }
  assertPostgresMigrationsReady(expected, records);
}
