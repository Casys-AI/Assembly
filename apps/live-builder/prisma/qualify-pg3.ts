import { qualifyLocalPostgres } from "./qualify-local.ts";

/** Explicit PG-3 process/Git qualification; ordinary PG-1/PG-2 launchers keep
 * their existing narrower test permissions. All scratch stays in DEV. */
if (import.meta.main) {
  const binaries = Deno.env.get("ASSEMBLY_POSTGRES_BIN_DIR");
  const temporary = Deno.env.get("TMPDIR");
  if (!binaries || !temporary) {
    throw new Error(
      "PG-3 qualification requires host-selected PostgreSQL and DEV scratch",
    );
  }
  await qualifyLocalPostgres(binaries, [
    "test/integration/postgres-write-queue_test.ts",
  ], {
    allowRun: [Deno.execPath(), "git"],
    allowWrite: [temporary],
  });
}
