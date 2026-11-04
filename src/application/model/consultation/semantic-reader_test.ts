import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { SemanticModelContextReader } from "./semantic-reader.ts";
import type { ModelContextQueryResult } from "../../../domain/model/consultation/context.ts";
import type { ModelContextReader } from "./source-reader.ts";
import { SemanticIndexError } from "../semantic/index-service.ts";

const result: ModelContextQueryResult = {
  operation: "references",
  version: "commit:abc",
  sourceDigest: "a".repeat(64),
  offset: 0,
  limit: 20,
  total: 0,
  truncated: false,
  selected: { id: "native-1", metaclass: "PartUsage" },
  items: [],
  coverage: "stored-normalized-relations",
};
const base = {
  query: () => Promise.resolve(result),
  overview: () => Promise.resolve({ marker: true }),
} as unknown as Pick<ModelContextReader, "query" | "overview">;
Deno.test("semantic decorator refuses index failure instead of source-only success", async () => {
  let pin: unknown;
  const reader = new SemanticModelContextReader(base, {
    inspect: (...args) => {
      pin = args;
      throw new SemanticIndexError(
        "INDEX_PROJECTION_MISSING",
        {},
        "legacy recipe unknown",
      );
    },
  });
  await rejects(() =>
    reader.query({
      operation: "references",
      version: result.version,
      elementId: "native-1",
    }), (error: unknown) => {
    const failure =
      error as import("../../../domain/model/consultation/context.ts").ModelNavigationError;
    equal(failure.code, "INDEX_PROJECTION_MISSING");
    equal(failure.evidence.version, result.version);
    return true;
  });
  deepStrictEqual(pin, [
    result.version,
    result.sourceDigest,
    "native-1",
    "references",
    undefined,
  ]);
  deepStrictEqual(await reader.overview(), { marker: true });
});
Deno.test("source errors remain authoritative, semantic enrichment is never attempted", async () => {
  let attempted = false;
  const reader = new SemanticModelContextReader({
    ...base,
    query: () => Promise.reject(new Error("source refused")),
  }, {
    inspect: () => {
      attempted = true;
      throw new Error("unexpected");
    },
  });
  let message = "";
  try {
    await reader.query({
      operation: "inspect",
      version: result.version,
      elementId: "native-1",
    });
  } catch (error) {
    message = String(error);
  }
  equal(message, "Error: source refused");
  equal(attempted, false);
});

Deno.test("semantic decorator enriches successful reads without changing source evidence", async () => {
  const build = {
    repositoryId: "p",
    sourceDigest: result.sourceDigest,
    recipeDigest: "b".repeat(64),
    buildKey: "c".repeat(64),
    artifactDigest: "d".repeat(64),
  };
  const semantic = {
    state: "ready" as const,
    advisory: true as const,
    version: result.version,
    build,
    projection: {
      kind: "rdf-quads",
      projectorVersion: "v1",
      artifactDigest: build.artifactDigest,
      projectionDigest: "e".repeat(64),
    },
    iri: "urn:ase:user:p:native-1",
    scope: "user" as const,
    metaclass: "PartUsage",
    readerVersion: "qualified-test-lens",
    neighbors: [],
    neighborPage: { limit: 20, complete: true },
    coverage: "bounded-direct-neighbors" as const,
  };
  const reader = new SemanticModelContextReader(base, {
    inspect: () => Promise.resolve(semantic),
  });
  const enriched = await reader.query({
    operation: "references",
    version: result.version,
    elementId: "native-1",
  });
  deepStrictEqual(enriched, { ...result, semantic });
});

Deno.test("source search and read_source bypass the semantic backend", async () => {
  const search = { ...result, operation: "search" as const, items: [] };
  let attempted = false;
  const reader = new SemanticModelContextReader({
    ...base,
    query: () => Promise.resolve(search),
  }, {
    inspect: () => {
      attempted = true;
      throw new Error("unexpected");
    },
  });
  equal(
    await reader.query({ operation: "search", version: result.version }),
    search,
  );
  equal(attempted, false);
});

Deno.test("graph selectors stay independent and endpoint sources are verified or explicitly unavailable", async () => {
  const build = {
    repositoryId: "p",
    sourceDigest: result.sourceDigest,
    recipeDigest: "b".repeat(64),
    buildKey: "c".repeat(64),
    artifactDigest: "d".repeat(64),
  };
  const projection = {
    kind: "rdf-quads",
    projectorVersion: "v1",
    artifactDigest: build.artifactDigest,
    projectionDigest: "e".repeat(64),
  };
  const endpoint = (nativeId: string, scope: "user" | "library" = "user") => ({
    direction: "out" as const,
    property: "ownedMember",
    predicate: "https://www.omg.org/spec/SysML#ownedMember",
    iri: "urn:" + nativeId,
    ref: { build, nativeId },
    scope,
  });
  const graph = {
    direction: "out" as const,
    property: "ownedMember",
    limit: 5,
    cursor: "opaque-cursor",
  };
  const sourceCalls:
    import("../../../domain/model/consultation/context.ts").ModelContextQuery[] =
      [];
  const reader = new SemanticModelContextReader({
    ...base,
    query: (input) => {
      sourceCalls.push(input);
      if (input.elementId === "native-1") return Promise.resolve(result);
      if (input.elementId === "missing") {
        return Promise.reject(
          Object.assign(new Error("absent"), { code: "NOT_FOUND" }),
        );
      }
      return Promise.resolve({
        ...result,
        operation: "inspect",
        selected: {
          id: "mapped",
          metaclass: "PartUsage",
          source: { path: "m.sysml" },
        },
        items: [],
        coverage: "selected-owner-owned-and-direct-relations",
      });
    },
  }, {
    inspect: (_version, _digest, _id, _operation, options) => {
      deepStrictEqual(options, graph);
      return Promise.resolve({
        state: "ready",
        advisory: true,
        version: result.version,
        build,
        projection,
        iri: "urn:root",
        scope: "user",
        metaclass: "Package",
        readerVersion: "v1",
        neighbors: [
          ...["mapped", "mapped", "missing", "missing"].map((id, position) => ({
            ...endpoint(id),
            position,
            occurrence: `occ-${position}`,
          })),
          {
            ...endpoint("library-node", "library"),
            position: 4,
            occurrence: "occ-4",
          },
        ],
        neighborPage: { limit: 5, complete: true },
        coverage: "bounded-direct-neighbors",
      });
    },
  });
  const enriched = await reader.query({
    operation: "references",
    version: result.version,
    elementId: "native-1",
    limit: 1,
    offset: 7,
    graph,
  });
  if (enriched.operation !== "references") {
    throw new Error("expected references");
  }
  equal(enriched.limit, result.limit);
  if (enriched.semantic?.state !== "ready") throw new Error("expected ready");
  deepStrictEqual(enriched.semantic.neighbors[0]?.source, {
    version: result.version,
    sourceDigest: result.sourceDigest,
    elementId: "mapped",
    path: "m.sysml",
  });
  deepStrictEqual(
    enriched.semantic.neighbors[1]?.source,
    enriched.semantic.neighbors[0]?.source,
  );
  equal(enriched.semantic.neighbors[2]?.sourceUnavailable, "unmapped");
  equal(enriched.semantic.neighbors[3]?.sourceUnavailable, "unmapped");
  equal(enriched.semantic.neighbors[4]?.sourceUnavailable, "library");
  deepStrictEqual(
    enriched.semantic.neighbors.map((n) => [n.position, n.occurrence]),
    [0, 1, 2, 3, 4].map((i) => [i, `occ-${i}`]),
  );
  equal(sourceCalls.filter((input) => input.elementId === "mapped").length, 1);
  equal(sourceCalls.filter((input) => input.elementId === "missing").length, 1);
  equal(sourceCalls.some((input) => input.elementId === "library-node"), false);
  equal(sourceCalls[0]?.limit, 1);
  equal(sourceCalls[0]?.offset, 7);
});

Deno.test("unexpected endpoint source failures retain known semantic provenance and recovery", async () => {
  const build = {
    repositoryId: "p",
    sourceDigest: result.sourceDigest,
    recipeDigest: "b".repeat(64),
    buildKey: "c".repeat(64),
    artifactDigest: "d".repeat(64),
  };
  const projection = {
    kind: "rdf-quads",
    projectorVersion: "v1",
    artifactDigest: build.artifactDigest,
    projectionDigest: "e".repeat(64),
  };
  const reader = new SemanticModelContextReader({
    ...base,
    query: (input) =>
      input.elementId === "native-1" ? Promise.resolve(result) : Promise.reject(
        Object.assign(new Error("Source storage failed"), {
          code: "SOURCE_READ_FAILED",
          recovery: "Restore the pinned source snapshot",
        }),
      ),
  }, {
    inspect: () =>
      Promise.resolve({
        state: "ready",
        advisory: true,
        version: result.version,
        build,
        projection,
        iri: "urn:root",
        scope: "user",
        metaclass: "Package",
        readerVersion: "v1",
        coverage: "bounded-direct-neighbors",
        neighborPage: { limit: 20, complete: true },
        neighbors: [{
          direction: "out",
          property: "ownedMember",
          predicate: "urn:prop",
          iri: "urn:child",
          ref: { build, nativeId: "child" },
          scope: "user",
        }],
      }),
  });
  await rejects(
    () =>
      reader.query({
        operation: "references",
        version: result.version,
        elementId: "native-1",
      }),
    (error: unknown) => {
      const failure =
        error as import("../../../domain/model/consultation/context.ts").ModelNavigationError;
      deepStrictEqual(failure.evidence, {
        state: "unavailable",
        advisory: true,
        version: result.version,
        build,
        projection,
        code: "SOURCE_READ_FAILED",
        message: "Source storage failed",
        recovery: "Restore the pinned source snapshot",
      });
      return true;
    },
  );
});
