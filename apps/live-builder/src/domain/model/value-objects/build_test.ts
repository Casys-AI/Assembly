import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { modelSourceDigest } from "./sources.ts";
import {
  ARTIFACT_SCHEMA,
  artifactDigest,
  artifactPayload,
  type BuildDescriptor,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  ModelBuildError,
  parseBuildDescriptorStrict,
  recipeDigest,
} from "./build.ts";

const sources = {
  "model.sysml": "package Golden {\n  part p;\n}\n",
  "other.sysml": "package Other {\n  part q;\n}\n",
};
const recipe: BuildRecipeInputs = {
  toolkit: { version: "0.10.10", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 1,
  irVersion: "0.1",
  artifactSchema: ARTIFACT_SCHEMA,
  engineVersion: "0.10.10",
};
const elements = [
  { "@id": "b-element", "@type": "PartUsage", qualifiedName: "Golden::p" },
  { "@id": "a-element", "@type": "PartDefinition", qualifiedName: "Golden" },
];
const provider = {
  name: "sysml-toolkit",
  version: "0.10.10",
  format: "ase-toolkit-normalized-json-v1",
};

async function goldenDescriptor(): Promise<BuildDescriptor> {
  const sourceDigest = await modelSourceDigest(sources);
  const digest = await recipeDigest(recipe);
  const key = await buildKey(sourceDigest, digest);
  const artifact = await artifactDigest({
    provider,
    engineVersion: "0.10.10",
    elements,
  });
  return buildDescriptor({
    repositoryId: "golden-fixture",
    sourceDigest,
    recipe,
    recipeDigest: digest,
    buildKey: key,
    artifactDigest: artifact,
    bytes: new TextEncoder().encode(
      artifactPayload({ provider, engineVersion: "0.10.10", elements }),
    ).length,
  });
}

Deno.test("build identity golden pins S, R, K and A", async () => {
  const descriptor = await goldenDescriptor();
  // Any output change without a version bump must fail here first.
  equal(
    descriptor.sourceDigest,
    "5db80ae78893a80c675e2a43f005b2cbd8c91b3a732f3a97fcefb38eeb610ad2",
  );
  equal(
    descriptor.recipe.digest,
    "ba01408d43d470694b1d5a11404fd9f283b9915fb24d1faa7dc297d0821ed9ee",
  );
  equal(
    descriptor.buildKey,
    "31b91b8b0bc16abccb1303beef8ef81ea7b8a92170c948731daaf133e7587d52",
  );
  equal(
    descriptor.artifactDigest,
    "4c467b8ad12214dd8be4052c497f38d9b64128b56880c8f51cc4e910dc0cc3d1",
  );
  equal(descriptor.bytes, 282);
  deepStrictEqual(
    parseBuildDescriptorStrict(JSON.parse(JSON.stringify(descriptor))),
    descriptor,
  );
});

Deno.test("build key moves with source path, bundle byte and normalizer", async () => {
  const sourceDigest = await modelSourceDigest(sources);
  const digest = await recipeDigest(recipe);
  const key = await buildKey(sourceDigest, digest);
  const renamed = await modelSourceDigest({
    "renamed.sysml": sources["model.sysml"] as string,
    "other.sysml": sources["other.sysml"] as string,
  });
  if (renamed === sourceDigest) throw new Error("Renamed sources kept S");
  if (await buildKey(renamed, digest) === key) {
    throw new Error("Source path change kept K");
  }
  const drifted = await recipeDigest({
    ...recipe,
    toolkit: { ...recipe.toolkit, bundleDigest: `8${"9".repeat(63)}` },
  });
  if (drifted === digest) throw new Error("Bundle byte change kept R");
  if (await buildKey(sourceDigest, drifted) === key) {
    throw new Error("Bundle byte change kept K");
  }
  const renormalized = await recipeDigest({
    ...recipe,
    normalizerVersion: recipe.normalizerVersion + 1,
  });
  if (renormalized === digest) throw new Error("Normalizer bump kept R");
  if (await buildKey(sourceDigest, renormalized) === key) {
    throw new Error("Normalizer bump kept K");
  }
});

Deno.test("build descriptor parse is strict and closed", async () => {
  const descriptor = await goldenDescriptor();
  const valid = JSON.parse(JSON.stringify(descriptor)) as Record<
    string,
    unknown
  >;
  const check = (mutate: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    mutate(copy);
    throws(() => parseBuildDescriptorStrict(copy), ModelBuildError);
  };
  for (
    const mutate of [
      (copy: Record<string, unknown>) => {
        copy["extra"] = 1;
      },
      (copy: Record<string, unknown>) => {
        delete copy["bytes"];
      },
      (copy: Record<string, unknown>) => {
        copy["v"] = 2;
      },
      (copy: Record<string, unknown>) => {
        copy["kind"] = "ase-model-build-legacy";
      },
      (copy: Record<string, unknown>) => {
        copy["buildKey"] = "not-hex";
      },
      (copy: Record<string, unknown>) => {
        copy["artifactDigest"] = "A".repeat(64);
      },
      (copy: Record<string, unknown>) => {
        (copy["recipe"] as Record<string, unknown>)["digest"] = "0".repeat(63);
      },
      (copy: Record<string, unknown>) => {
        (copy["recipe"] as Record<string, unknown>)["extra"] = true;
      },
      (copy: Record<string, unknown>) => {
        ((copy["recipe"] as Record<string, unknown>)["toolkit"] as Record<
          string,
          unknown
        >)["bundleDigest"] = "0".repeat(64).slice(0, 63) + "g";
      },
      (copy: Record<string, unknown>) => {
        ((copy["recipe"] as Record<string, unknown>)["toolkit"] as Record<
          string,
          unknown
        >)["version"] = "";
      },
      (copy: Record<string, unknown>) => {
        (copy["recipe"] as Record<string, unknown>)["normalizerVersion"] = -1;
      },
      (copy: Record<string, unknown>) => {
        copy["bytes"] = 1.5;
      },
      (copy: Record<string, unknown>) => {
        copy["repositoryId"] = "";
      },
    ]
  ) check(mutate);
  for (const notObject of [null, 42, "descriptor", [], "0".repeat(64)]) {
    throws(() => parseBuildDescriptorStrict(notObject), ModelBuildError);
  }
  try {
    parseBuildDescriptorStrict({ ...valid, extra: 1 });
    throw new Error("Open descriptor keys accepted");
  } catch (error) {
    if (!(error instanceof ModelBuildError)) throw error;
    equal(error.code, "BUILD_DESCRIPTOR_INVALID");
    equal(error.message, "Invalid build descriptor");
    deepStrictEqual(error.context, { reason: "Unexpected field extra" });
    if (typeof error.recovery !== "string" || !error.recovery) {
      throw new Error("Descriptor error lacks recovery");
    }
  }
});
