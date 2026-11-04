import type {
  BuildArtifactPayload,
  BuildMaterializer,
} from "../../../../application/model/builds/ports/out/build-materializer.port.ts";
import { ModelBuildServiceError } from "../../../../application/model/builds/service.ts";
import type { BuildDescriptor } from "../../../../domain/model/value-objects/build.ts";
import {
  IR_VERSION,
  materialize,
} from "../../../../domain/model/value-objects/artifact.ts";
import { NORMALIZER_VERSION } from "./normalizer.ts";

/** The semantic projection reader shares the historical materializer's exact
 * compatibility guard without allocating an unused CompiledModel. */
export function assertStoredBuildCompatible(
  artifact: BuildArtifactPayload,
  descriptor: BuildDescriptor,
): void {
  if (
    descriptor.recipe.irVersion !== IR_VERSION ||
    descriptor.recipe.artifactSchema !== 1 ||
    descriptor.recipe.format !== "ase-toolkit-normalized-json-v1" ||
    ![1, NORMALIZER_VERSION].includes(descriptor.recipe.normalizerVersion) ||
    artifact.provider?.format !== descriptor.recipe.format
  ) {
    throw new ModelBuildServiceError(
      "BUILD_MATERIALIZATION_INCOMPATIBLE",
      { artifactDigest: descriptor.artifactDigest },
      "Unsupported stored artifact format/IR",
    );
  }
}

/** Reader compatibility is independent of whether a historical recipe can run. */
export const storedBuildMaterializer: BuildMaterializer = {
  async materialize({ artifact, sources, descriptor }) {
    assertStoredBuildCompatible(artifact, descriptor);
    return await materialize(
      artifact.elements,
      sources,
      artifact.engineVersion,
      artifact.provider,
    );
  },
};
