import { doesNotThrow, equal, ok, throws } from "node:assert/strict";
import type { BuildArtifactPayload } from "../../../../application/model/builds/ports/out/build-materializer.port.ts";
import { ModelBuildServiceError } from "../../../../application/model/builds/service.ts";
import {
  type BuildDescriptor,
  buildDescriptor,
} from "../../../../domain/model/value-objects/build.ts";
import { IR_VERSION } from "../../../../domain/model/value-objects/artifact.ts";
import { assertStoredBuildCompatible } from "./stored-materializer.ts";
import { NORMALIZER_VERSION } from "./normalizer.ts";

const descriptor = buildDescriptor({
  repositoryId: "compatibility-tests",
  sourceDigest: "1".repeat(64),
  recipe: {
    toolkit: { version: "historical-engine", bundleDigest: "2".repeat(64) },
    format: "ase-toolkit-normalized-json-v1",
    normalizerVersion: NORMALIZER_VERSION,
    irVersion: IR_VERSION,
    artifactSchema: 1,
    engineVersion: "historical-engine",
  },
  recipeDigest: "3".repeat(64),
  buildKey: "4".repeat(64),
  artifactDigest: "5".repeat(64),
  bytes: 100,
});
const artifact: BuildArtifactPayload = {
  v: 1,
  provider: {
    name: "sysml-toolkit",
    version: "historical-engine",
    format: descriptor.recipe.format,
  },
  engineVersion: "historical-engine",
  elements: [],
};

function incompatible(error: unknown): boolean {
  ok(error instanceof ModelBuildServiceError);
  equal(error.code, "BUILD_MATERIALIZATION_INCOMPATIBLE");
  equal(error.context.artifactDigest, descriptor.artifactDigest);
  return true;
}

Deno.test("stored artifact compatibility accepts supported historical and current normalizers", () => {
  for (const normalizerVersion of new Set([1, NORMALIZER_VERSION])) {
    doesNotThrow(() =>
      assertStoredBuildCompatible(artifact, {
        ...descriptor,
        recipe: { ...descriptor.recipe, normalizerVersion },
      })
    );
  }
});

Deno.test("stored artifact compatibility refuses unsupported IR, schema, format and normalizer", () => {
  const recipes: BuildDescriptor["recipe"][] = [
    { ...descriptor.recipe, irVersion: "unsupported-ir" },
    { ...descriptor.recipe, artifactSchema: 2 },
    { ...descriptor.recipe, format: "unsupported-format" },
    { ...descriptor.recipe, normalizerVersion: NORMALIZER_VERSION + 1 },
  ];
  for (const recipe of recipes) {
    throws(
      () => assertStoredBuildCompatible(artifact, { ...descriptor, recipe }),
      incompatible,
    );
  }
});

Deno.test("stored artifact compatibility refuses absent or mismatching provider format", () => {
  throws(
    () =>
      assertStoredBuildCompatible({
        ...artifact,
        provider: undefined,
      }, descriptor),
    incompatible,
  );
  throws(
    () =>
      assertStoredBuildCompatible({
        ...artifact,
        provider: {
          name: "sysml-toolkit",
          version: "historical-engine",
          format: "another-format",
        },
      }, descriptor),
    incompatible,
  );
});
