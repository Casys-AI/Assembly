import { deepStrictEqual, equal } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  toolkitSubprocessPermissions,
  toolkitSubprocessStagingDirectory,
} from "./toolkit-subprocess-permissions.ts";

Deno.test("trusted Toolkit fixture capabilities cover only output, app staging and selected native package", () => {
  const staging = fileURLToPath(
    new URL("../../.data/toolchains/", import.meta.url),
  );
  const nodeModules = fileURLToPath(
    new URL("../../node_modules/", import.meta.url),
  );
  equal(toolkitSubprocessStagingDirectory, staging);
  deepStrictEqual(
    toolkitSubprocessPermissions({
      outputPath: "/fixture/artifact.json",
      packageDir: "/selected/native-package",
      executable: "/qualified/deno",
    }),
    [
      `--allow-write=/fixture/artifact.json,${staging}`,
      "--allow-run=/qualified/deno",
      `--allow-ffi=${nodeModules},/selected/native-package,${staging}`,
    ],
  );
});
