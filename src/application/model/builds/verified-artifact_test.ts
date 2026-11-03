import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  ARTIFACT_SCHEMA,
  artifactPayload,
  type BuildDescriptor,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  MAX_ARTIFACT_BYTES,
  ModelBuildServiceError,
  type ModelBuildServiceErrorCode,
  sha256HexOfBytes,
  validateBuildArtifact,
  validateBuildDescriptor,
} from "./service.ts";

const encoder = new TextEncoder();
const repositoryId = "verified-artifact-tests";
const recipe: BuildRecipeInputs = {
  toolkit: { version: "native-fixture", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 2,
  irVersion: "0.1",
  artifactSchema: ARTIFACT_SCHEMA,
  engineVersion: "native-fixture",
};
const payload = {
  provider: {
    name: "sysml-toolkit",
    version: "native-fixture",
    format: recipe.format,
  },
  engineVersion: recipe.engineVersion,
  elements: [{
    "@id": "library-part",
    "@type": "PartDefinition",
    isLibraryElement: true,
    ownedRelationship: [],
  }],
};

async function fixture(
  inputs: BuildRecipeInputs = recipe,
): Promise<{ descriptor: BuildDescriptor; bytes: Uint8Array }> {
  const bytes = encoder.encode(artifactPayload(payload));
  const sourceDigest = await modelSourceDigest({
    "part.sysml": "package Fixture { part def Part; }",
  });
  const digest = await recipeDigest(inputs);
  return {
    bytes,
    descriptor: buildDescriptor({
      repositoryId,
      sourceDigest,
      recipe: inputs,
      recipeDigest: digest,
      buildKey: await buildKey(sourceDigest, digest),
      artifactDigest: await sha256HexOfBytes(bytes),
      bytes: bytes.byteLength,
    }),
  };
}

function failure(code: ModelBuildServiceErrorCode, reason?: string) {
  return (error: unknown): boolean => {
    ok(error instanceof ModelBuildServiceError);
    equal(error.code, code);
    if (reason !== undefined) equal(error.context.reason, reason);
    ok(error.recovery.length > 0);
    return true;
  };
}

async function withBytes(
  descriptor: BuildDescriptor,
  bytes: Uint8Array,
): Promise<BuildDescriptor> {
  return {
    ...descriptor,
    bytes: bytes.byteLength,
    artifactDigest: await sha256HexOfBytes(bytes),
  };
}

Deno.test("narrow build validation retains verified library rows and empty lists", async () => {
  const { descriptor, bytes } = await fixture();
  const strict = await validateBuildDescriptor(
    descriptor,
    repositoryId,
    descriptor.sourceDigest,
  );
  deepStrictEqual(strict, descriptor);
  ok(Object.isFrozen(strict));
  ok(Object.isFrozen(strict.recipe));
  ok(Object.isFrozen(strict.recipe.toolkit));
  const artifact = await validateBuildArtifact(bytes, strict);
  deepStrictEqual(artifact, { v: ARTIFACT_SCHEMA, ...payload });
});

Deno.test("narrow descriptor validation refuses repository and independent source mismatches", async () => {
  const { descriptor } = await fixture();
  await rejects(
    () =>
      validateBuildDescriptor(
        descriptor,
        "another-repository",
        descriptor.sourceDigest,
      ),
    failure("BUILD_DESCRIPTOR_MISMATCH", "repositoryId differs"),
  );
  await rejects(
    () => validateBuildDescriptor(descriptor, repositoryId, "1".repeat(64)),
    failure("BUILD_SOURCE_MISMATCH"),
  );
});

Deno.test("narrow descriptor validation refuses a changed recipe or build key", async () => {
  const { descriptor } = await fixture();
  await rejects(
    () =>
      validateBuildDescriptor(
        {
          ...descriptor,
          recipe: { ...descriptor.recipe, normalizerVersion: 17 },
        },
        repositoryId,
        descriptor.sourceDigest,
      ),
    failure("BUILD_DESCRIPTOR_MISMATCH", "recipe digest R differs"),
  );
  await rejects(
    () =>
      validateBuildDescriptor(
        {
          ...descriptor,
          buildKey: "2".repeat(64),
        },
        repositoryId,
        descriptor.sourceDigest,
      ),
    failure("BUILD_DESCRIPTOR_MISMATCH", "build key K differs"),
  );
});

Deno.test("narrow descriptor validation retains strict shape and size bounds", async () => {
  const { descriptor } = await fixture();
  const extraField = { ...descriptor, untrustedPath: "/tmp/other-cache" };
  await rejects(
    () =>
      validateBuildDescriptor(
        extraField,
        repositoryId,
        descriptor.sourceDigest,
      ),
    failure("BUILD_DESCRIPTOR_MISMATCH"),
  );
  await rejects(
    () =>
      validateBuildDescriptor(
        {
          ...descriptor,
          bytes: MAX_ARTIFACT_BYTES + 1,
        },
        repositoryId,
        descriptor.sourceDigest,
      ),
    failure("ARTIFACT_TOO_LARGE"),
  );
  await rejects(
    () =>
      validateBuildDescriptor(
        descriptor,
        repositoryId,
        descriptor.sourceDigest,
        descriptor.bytes - 1,
      ),
    failure("ARTIFACT_TOO_LARGE"),
  );
});

Deno.test("narrow descriptor validation refuses a well-hashed unsupported schema", async () => {
  const { descriptor } = await fixture({ ...recipe, artifactSchema: 2 });
  await rejects(
    () =>
      validateBuildDescriptor(
        descriptor,
        repositoryId,
        descriptor.sourceDigest,
      ),
    failure("BUILD_MATERIALIZATION_INCOMPATIBLE"),
  );
});

Deno.test("narrow artifact validation refuses wrong length and same-length corruption", async () => {
  const { descriptor, bytes } = await fixture();
  await rejects(
    () => validateBuildArtifact(bytes.subarray(1), descriptor),
    failure("BUILD_CORRUPT", "artifact byte length differs from descriptor"),
  );
  const changed = bytes.slice();
  changed[changed.length - 2] ^= 1;
  await rejects(
    () => validateBuildArtifact(changed, descriptor),
    failure("BUILD_CORRUPT", "artifact sha256 differs from descriptor A"),
  );
});

Deno.test("narrow artifact validation refuses noncanonical bytes even with matching size and SHA", async () => {
  const { descriptor, bytes } = await fixture();
  const pretty = encoder.encode(JSON.stringify(
    JSON.parse(
      new TextDecoder().decode(bytes),
    ),
    null,
    2,
  ));
  await rejects(
    () =>
      withBytes(descriptor, pretty).then((pinned) =>
        validateBuildArtifact(pretty, pinned)
      ),
    failure("BUILD_CORRUPT", "artifact bytes are not the canonical payload"),
  );
});

Deno.test("narrow artifact validation refuses malformed payload shapes and UTF-8", async () => {
  const { descriptor } = await fixture();
  const cases = [
    {
      bytes: new Uint8Array([0xff]),
      reason: "bytes are not valid UTF-8",
    },
    {
      bytes: encoder.encode("{"),
      reason: "bytes are not valid JSON",
    },
    {
      bytes: encoder.encode(canonical({
        v: ARTIFACT_SCHEMA,
        ...payload,
        provider: { ...payload.provider, authority: "untrusted" },
      })),
      reason: "provider keys are not exactly name/version/format",
    },
  ];
  for (const entry of cases) {
    const pinned = await withBytes(descriptor, entry.bytes);
    await rejects(
      () => validateBuildArtifact(entry.bytes, pinned),
      failure("BUILD_CORRUPT", entry.reason),
    );
  }
});

Deno.test("narrow artifact validation distinguishes unknown schema from corrupt engine binding", async () => {
  const { descriptor, bytes } = await fixture();
  const unknownSchema = encoder.encode(canonical({ ...payload, v: 2 }));
  const unknownDescriptor = await withBytes(descriptor, unknownSchema);
  await rejects(
    () => validateBuildArtifact(unknownSchema, unknownDescriptor),
    failure("BUILD_MATERIALIZATION_INCOMPATIBLE"),
  );
  await rejects(
    () =>
      validateBuildArtifact(bytes, {
        ...descriptor,
        recipe: { ...descriptor.recipe, engineVersion: "another-engine" },
      }),
    failure(
      "BUILD_CORRUPT",
      "artifact engineVersion differs from descriptor recipe",
    ),
  );
});
