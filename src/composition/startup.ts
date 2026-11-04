import { requireToolkitPackage, toolkitPackageDir } from "./model-backend.ts";
import { assembleAssembly, type AssemblyOptions } from "./root.ts";

/** The composition seam keeps startup prerequisite tests free of live adapters. */
interface StartupDependencies {
  requireToolkit: () => Promise<void>;
  assemble: typeof assembleAssembly;
}

export async function startAssembly(
  options: AssemblyOptions,
  dependencies: StartupDependencies = {
    requireToolkit: () => requireToolkitPackage(toolkitPackageDir()),
    assemble: assembleAssembly,
  },
) {
  await dependencies.requireToolkit();
  return await dependencies.assemble(options);
}
