/** Explicit same-user local controls for an already initialized named profile.
 * Never prints secrets, starts a runtime/server or initializes/migrates data. */
import {
  readLocalCapabilityFile,
  readLocalControlProfile,
  reserveLocalCapabilityFile,
} from "../src/adapters/in/local/space-control-files.ts";
import { postgresClientConfiguration } from "../src/adapters/out/postgres/config.ts";
import { readAssemblyEnv } from "../src/infrastructure/environment.ts";
import { openLocalSpaceControls } from "../src/composition/local-space-controls.ts";
import {
  reportLocalControlCommand,
  runLocalControlCommand,
} from "../src/adapters/in/local/space-control-command.ts";

export async function main(argv: string[]) {
  const [action, path] = argv;
  if (
    (action !== "issue" && action !== "revoke") || !path || argv.length !== 2
  ) {
    throw new Error(
      "Usage: system control <name> issue <new-private-file> | revoke <private-file> [--env-file=.env]",
    );
  }
  const dataDir = readAssemblyEnv("ASSEMBLY_DEMO_DATA_DIR");
  const projectDir = readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR");
  const systemId = readAssemblyEnv("ASSEMBLY_SYSTEM_ID");
  const port = Deno.env.get("PORT");
  if (!dataDir || !projectDir || !systemId || !port || !/^\d+$/.test(port)) {
    throw new Error("An existing named local system profile is required.");
  }
  const profile = await readLocalControlProfile({
    dataDir,
    projectDir,
    systemId,
    origin: `http://127.0.0.1:${port}`,
  });
  // Read/reserve private files before connecting or creating any credential.
  const stored = action === "revoke"
    ? await readLocalCapabilityFile(path, profile)
    : undefined;
  const output = action === "issue"
    ? await reserveLocalCapabilityFile(path)
    : undefined;
  const open = () =>
    openLocalSpaceControls({
      database: postgresClientConfiguration(
        readAssemblyEnv("ASSEMBLY_DATABASE_URL"),
        1,
      ),
      scope: profile.scope,
      primaryOperatorId: profile.primaryOperatorId,
    });
  const result = await runLocalControlCommand(
    stored
      ? { action: "revoke", stored, open }
      : { action: "issue", profile, output: output!, open },
  );
  Deno.exitCode = reportLocalControlCommand(result, {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  });
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch {
    // Driver/JSON/filesystem errors may contain private values; never echo them.
    console.error(
      "Local control command failed; verify the existing named profile, private file and current modeled policy.",
    );
    Deno.exitCode = 1;
  }
}
