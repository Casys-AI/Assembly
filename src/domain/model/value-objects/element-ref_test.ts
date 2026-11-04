import { deepStrictEqual, equal, notEqual, throws } from "node:assert/strict";
import {
  type BuildRef,
  buildRefFromDescriptor,
  buildRefKey,
  parseBuildRef,
  parseProjectionRef,
  sameBuildRef,
} from "./element-ref.ts";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};

Deno.test("build refs carry S/R/K/A and derive from the W2 descriptor", () => {
  equal(sameBuildRef(parseBuildRef({ ...build }), build), true);
  const fromDescriptor = buildRefFromDescriptor({
    v: 1,
    kind: "ase-model-build",
    repositoryId: "repo-one",
    sourceDigest: digest("1"),
    recipe: {
      toolkit: { version: "0.10.10", bundleDigest: digest("9") },
      format: "ase-toolkit-normalized-json-v1",
      normalizerVersion: 2,
      irVersion: "0.1",
      artifactSchema: 1,
      engineVersion: "0.10.10",
      digest: digest("2"),
    },
    buildKey: digest("3"),
    artifactDigest: digest("4"),
    bytes: 42,
  });
  deepStrictEqual({ ...fromDescriptor }, { ...build });
  // A alone is not a build identity: same A, other repository → other key.
  notEqual(
    buildRefKey(build),
    buildRefKey({ ...build, repositoryId: "repo-two" }),
  );
  throws(() => parseBuildRef({ ...build, artifactDigest: "state-digest" }));
  throws(() => parseBuildRef({ ...build, operatorId: "op-1" }));
});

Deno.test("projection refs keep the projection digest distinct from A", () => {
  const ref = parseProjectionRef({
    kind: "rdf-quads",
    projectorVersion: "ase-rdf-quads-v1",
    artifactDigest: digest("4"),
    projectionDigest: digest("5"),
  });
  notEqual(ref.projectionDigest, ref.artifactDigest);
  throws(() =>
    parseProjectionRef({
      kind: "RDF Quads",
      projectorVersion: "v1",
      artifactDigest: digest("4"),
      projectionDigest: digest("5"),
    })
  );
});
