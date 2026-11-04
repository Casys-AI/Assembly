import { deepStrictEqual, equal, notEqual, throws } from "node:assert/strict";
import type { BuildRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  buildElementIri,
  buildElementRefFromIri,
  buildGraphIri,
  libraryElementIri,
  parseElementIri,
  userElementIri,
} from "./iri.ts";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};

Deno.test("IRI codec is reversible, repository-scoped and collision-free", () => {
  for (
    const [repositoryId, nativeId] of [
      ["repo-one", "el-1"],
      ["a:b", "c"],
      ["a", "b:c"],
      ["dépôt/%", "élément :: x/y"],
      ["r", "%3Aalready-encoded"],
    ] as const
  ) {
    const iri = userElementIri(repositoryId, nativeId);
    deepStrictEqual({ ...parseElementIri(iri) }, {
      scope: "user",
      repositoryId,
      nativeId,
    });
  }
  // Ambiguous concatenations stay distinct.
  notEqual(userElementIri("a:b", "c"), userElementIri("a", "b:c"));
  notEqual(
    userElementIri("repo-one", "el-1"),
    userElementIri("repo-two", "el-1"),
  );
  // Library elements live outside any repository scope.
  const library = libraryElementIri("el-1");
  deepStrictEqual({ ...parseElementIri(library) }, {
    scope: "library",
    nativeId: "el-1",
  });
  notEqual(library, userElementIri("repo-one", "el-1"));
  for (
    const bad of [
      "urn:ase:model:repo",
      "urn:ase:model:a:b:c",
      "urn:ase:model:re po:el",
      "urn:ase:model:repo:%zz",
      "urn:ase:model:repo:%2f",
      "https://example.invalid/el-1",
      "urn:ase:build:" + digest("4"),
    ]
  ) {
    throws(() => parseElementIri(bad));
  }
});

Deno.test("build graph IRI is urn:ase:build:<A>", () => {
  equal(buildGraphIri(build), `urn:ase:build:${digest("4")}`);
  throws(() => buildGraphIri("current"));
});

Deno.test("$id conversion verifies the repository of the bound build", () => {
  const ref = { build, nativeId: "el-7" };
  const { ref: roundtrip, scope } = buildElementRefFromIri(
    build,
    buildElementIri(ref),
  );
  equal(scope, "user");
  equal(roundtrip.nativeId, "el-7");
  throws(() =>
    buildElementRefFromIri(build, userElementIri("repo-two", "el-7"))
  );
  equal(
    buildElementRefFromIri(build, libraryElementIri("lib-1")).scope,
    "library",
  );
});
