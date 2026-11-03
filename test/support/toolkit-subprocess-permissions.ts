import { fileURLToPath } from "node:url";

/** Trusted fixture setup needs a private snapshot beneath the same app-local
 * staging root used by the native process client and direct SDK loader. */
export const toolkitSubprocessStagingDirectory = fileURLToPath(
  new URL("../../.data/toolchains/", import.meta.url),
);
const nodeModulesDirectory = fileURLToPath(
  new URL("../../node_modules/", import.meta.url),
);

/** Only output, native staging and native loading capabilities are added.
 * The caller keeps its existing read/env permissions and isolated process. */
export function toolkitSubprocessPermissions(options: {
  outputPath: string;
  packageDir: string;
  executable: string;
}): string[] {
  return [
    `--allow-write=${options.outputPath},${toolkitSubprocessStagingDirectory}`,
    `--allow-run=${options.executable}`,
    `--allow-ffi=${nodeModulesDirectory},${options.packageDir},${toolkitSubprocessStagingDirectory}`,
  ];
}
