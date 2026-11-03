import { qualifyLocalPostgres } from "./qualify-local.ts";

/** Real application worker composition; fixture source/provider, no API calls. */
if (import.meta.main) {
  const binaries = Deno.env.get("ASSEMBLY_POSTGRES_BIN_DIR");
  const temporary = Deno.env.get("TMPDIR");
  if (!binaries || !temporary) throw new Error("Production runtime qualification requires selected PostgreSQL and DEV scratch");
  await qualifyLocalPostgres(binaries, [
    "test/integration/postgres-host-storage_test.ts",
    "test/integration/postgres-production-runtime_test.ts",
  ], {
    allowWrite: [temporary],
    allowSys: ["hostname", "systemMemoryInfo", "cpus"],
  });
}
