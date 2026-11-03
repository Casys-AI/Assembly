import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";

/** Real Toolkit tests require an explicit opt-in, even when its path is inherited. */
export const toolkitIntegrationEnabled =
  readAssemblyEnv("ASSEMBLY_SEMANTIC_INTEGRATION") === "1" &&
  Deno.permissions.querySync({
      name: "env",
      variable: "SYSML_TOOLKIT_DIR",
    }).state === "granted" &&
  !!Deno.env.get("SYSML_TOOLKIT_DIR");
