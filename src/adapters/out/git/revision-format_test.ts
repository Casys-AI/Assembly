import { deepStrictEqual, equal } from "node:assert/strict";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import {
  ARTIFACT_SCHEMA,
  artifactDigest,
  artifactPayload,
  type BuildDescriptor,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  classifyGitRevisionBuildPaths,
  decodeGitRevisionBuild,
  DESCRIPTOR_BUILD_PATH,
  encodeBuildRef,
  GitRevisionFormat,
  GitRevisionFormatError,
  LEGACY_BUILD_PATH,
  LEGACY_DESCRIPTOR_BUILD_PATH,
  parseBuildRefText,
  verifyLegacyBuildSnapshot,
} from "./revision-format.ts";

const sources = { "model.sysml": "package Golden { part p; }" };
const recipe: BuildRecipeInputs = {
  toolkit: { version: "native-1", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 1,
  irVersion: "0.1",
  artifactSchema: ARTIFACT_SCHEMA,
  engineVersion: "native-1",
};
const elements = [{ "@id": "e1", "@type": "PartUsage" }];

async function descriptorFixture(): Promise<BuildDescriptor> {
  const sourceDigest = await modelSourceDigest(sources);
  const digest = await recipeDigest(recipe);
  return buildDescriptor({
    repositoryId: "repo-1",
    sourceDigest,
    recipe,
    recipeDigest: digest,
    buildKey: await buildKey(sourceDigest, digest),
    artifactDigest: await artifactDigest({
      engineVersion: recipe.engineVersion,
      elements,
    }),
    bytes: new TextEncoder().encode(
      artifactPayload({ engineVersion: recipe.engineVersion, elements }),
    ).length,
  });
}

async function legacyTextFixture(): Promise<string> {
  const compiled = {
    sources,
    elements,
    documents: [],
    sourceDigest: await modelSourceDigest(sources),
    semanticDigest: "s",
    provenanceDigest: "p",
    sourceHashes: {},
    engineVersion: "old-wasm-1",
  };
  return canonical({
    repositoryId: "repo-1",
    compiled,
    digest: await sha256(canonical(compiled)),
  });
}

function formatCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GitRevisionFormatError) return error.code;
    throw error;
  }
  throw new Error("expected GitRevisionFormatError");
}

Deno.test("git format classifies legacy, descriptor, ambiguity and absence", () => {
  equal(
    classifyGitRevisionBuildPaths([LEGACY_BUILD_PATH, "sources/a.sysml"]),
    "legacy",
  );
  equal(classifyGitRevisionBuildPaths([DESCRIPTOR_BUILD_PATH]), "descriptor");
  equal(
    classifyGitRevisionBuildPaths([LEGACY_DESCRIPTOR_BUILD_PATH]),
    "descriptor",
  );
  for (
    const competing of [
      [LEGACY_BUILD_PATH, LEGACY_DESCRIPTOR_BUILD_PATH],
      [DESCRIPTOR_BUILD_PATH, LEGACY_DESCRIPTOR_BUILD_PATH],
      [LEGACY_BUILD_PATH, DESCRIPTOR_BUILD_PATH, LEGACY_DESCRIPTOR_BUILD_PATH],
    ]
  ) {
    equal(
      formatCode(() => classifyGitRevisionBuildPaths(competing)),
      "BUILD_FORMAT_AMBIGUOUS",
    );
  }
  equal(
    formatCode(() =>
      classifyGitRevisionBuildPaths([LEGACY_BUILD_PATH, DESCRIPTOR_BUILD_PATH])
    ),
    "BUILD_FORMAT_AMBIGUOUS",
  );
  equal(
    formatCode(() => classifyGitRevisionBuildPaths(["sources/a.sysml"])),
    "BUILD_FORMAT_MISSING",
  );
});

Deno.test("git format decodes both formats and refuses double presence", async () => {
  const descriptor = await descriptorFixture();
  const descriptorText = encodeBuildRef(descriptor).text;
  const legacyText = await legacyTextFixture();
  const decodedDescriptor = decodeGitRevisionBuild({ descriptorText });
  equal(decodedDescriptor.kind, "descriptor");
  if (decodedDescriptor.kind === "descriptor") {
    deepStrictEqual(decodedDescriptor.descriptor, descriptor);
  }
  deepStrictEqual(
    decodeGitRevisionBuild({ legacyDescriptorText: descriptorText }),
    decodedDescriptor,
  );
  for (
    const competing of [
      { legacyText: "not json", legacyDescriptorText: descriptorText },
      { descriptorText, legacyDescriptorText: "not json" },
    ]
  ) {
    equal(
      formatCode(() => decodeGitRevisionBuild(competing)),
      "BUILD_FORMAT_AMBIGUOUS",
    );
  }
  const decodedLegacy = decodeGitRevisionBuild({ legacyText });
  equal(decodedLegacy.kind, "legacy");
  if (decodedLegacy.kind === "legacy") {
    equal(await verifyLegacyBuildSnapshot(decodedLegacy.legacy), true);
    const tampered = {
      ...decodedLegacy.legacy,
      compiled: {
        ...decodedLegacy.legacy.compiled,
        engineVersion: "tampered",
      },
    };
    equal(await verifyLegacyBuildSnapshot(tampered), false);
  }
  // Ambiguity is decided before parsing either side.
  equal(
    formatCode(() =>
      decodeGitRevisionBuild({ legacyText: "not json", descriptorText })
    ),
    "BUILD_FORMAT_AMBIGUOUS",
  );
  equal(formatCode(() => decodeGitRevisionBuild({})), "BUILD_FORMAT_MISSING");
});

Deno.test("git format encodes only the descriptor entry for new commits", async () => {
  const descriptor = await descriptorFixture();
  const entry = encodeBuildRef(descriptor);
  equal(entry.path, ".assembly-build-ref.json");
  equal(entry.path, DESCRIPTOR_BUILD_PATH);
  deepStrictEqual(parseBuildRefText(entry.text), descriptor);
  deepStrictEqual(GitRevisionFormat.parseDescriptor(entry.text), descriptor);
  equal(
    formatCode(() => parseBuildRefText(canonical({ ...descriptor, extra: 1 }))),
    "BUILD_FORMAT_INVALID",
  );
  equal(
    formatCode(() => decodeGitRevisionBuild({ legacyText: "{}" })),
    "BUILD_FORMAT_INVALID",
  );
});
