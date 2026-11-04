import { deepStrictEqual, throws } from "node:assert/strict";
import {
  assertPostgresMigrationsReady,
  type MigrationRecord,
  PostgresMigrationsPendingError,
} from "./migration-readiness.ts";

const finished = new Date("2026-11-03T00:00:00Z");
const row = (
  name: string,
  finished_at: Date | null = finished,
  rolled_back_at: Date | null = null,
): MigrationRecord => ({ migration_name: name, finished_at, rolled_back_at });

Deno.test("migration readiness accepts applied local migrations and newer deployed ones", () => {
  assertPostgresMigrationsReady(["a", "b"], [row("a"), row("b"), row("newer")]);
  assertPostgresMigrationsReady(["a"], [row("a", null, finished), row("a")]);
});

Deno.test("missing registry and rolled-back migrations require deployment with safe recovery", () => {
  for (const records of [[], [row("a", null, finished)]]) {
    throws(() => assertPostgresMigrationsReady(["a"], records), (error) => {
      if (!(error instanceof PostgresMigrationsPendingError)) return false;
      deepStrictEqual(error.context, { pending: ["a"], unresolved: [] });
      deepStrictEqual(error.code, "POSTGRES_MIGRATIONS_PENDING");
      deepStrictEqual(error.recovery, "deno task db:migrate");
      return true;
    });
  }
});

Deno.test("an unresolved migration blocks startup even if the expected names succeeded", () => {
  throws(
    () => assertPostgresMigrationsReady(["a"], [row("a"), row("newer", null)]),
    (error) => {
      if (!(error instanceof PostgresMigrationsPendingError)) return false;
      deepStrictEqual(error.context, { pending: [], unresolved: ["newer"] });
      return true;
    },
  );
});
