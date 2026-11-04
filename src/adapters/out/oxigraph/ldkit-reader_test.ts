import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { buildElementRefFromIri } from "./iri.ts";
import { type BuildRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  type ModelSemanticIndex,
  SemanticIndexError,
} from "../../../application/model/semantic/index-service.ts";
import type {
  RdfTermDto,
  SemanticQueryRequest,
} from "../../../application/model/semantic/queries/inputs.ts";
import { semanticNeighborEvidence } from "./backend.ts";
import { ASE_VOCAB, propPredicate } from "./rdf.ts";
import {
  BoundModelReader,
  modelElementSchema,
  modelReaderContext,
  PackageSchema,
  SemanticIndexQueryEngine,
  SimpleBindings,
  termFromDto,
} from "./ldkit-reader.ts";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};
const iri = (value: string): RdfTermDto => ({ kind: "iri", value });
const lit = (value: string): RdfTermDto => ({
  kind: "literal",
  value,
  datatype: "http://www.w3.org/2001/XMLSchema#string",
});
const pkgIri = "urn:ase:model:repo-one:pkg";
const partIri = "urn:ase:model:repo-one:part";

function identityResponse(request: SemanticQueryRequest) {
  const values = /VALUES \?other \{([^}]+)\}/.exec(request.sparql);
  if (!values) return undefined;
  return {
    form: "solutions" as const,
    variables: ["other", "neighborNativeId"],
    truncated: false,
    rows: [...values[1]!.matchAll(/<([^>]+)>/g)].map((match) => ({
      other: iri(match[1]!),
      neighborNativeId: lit(
        buildElementRefFromIri(build, match[1]!).ref.nativeId,
      ),
    })),
  };
}

function fakeIndex() {
  const requests: SemanticQueryRequest[] = [];
  const index: ModelSemanticIndex = {
    ensureProjection(ensured) {
      return Promise.resolve({ build: ensured, state: "ready" as const });
    },
    release() {
      return Promise.resolve();
    },
    status(queried) {
      return Promise.resolve({ build: queried, state: "ready" as const });
    },
    queryReadOnly(request) {
      requests.push(request);
      const identities = identityResponse(request);
      if (identities) return Promise.resolve(identities);
      const sparql = request.sparql;
      if (sparql.startsWith("ASK")) {
        return Promise.resolve({ form: "boolean" as const, value: true });
      }
      if (sparql.includes("?s ?p ?o")) {
        return Promise.resolve({
          form: "solutions" as const,
          variables: ["s", "p", "o"],
          truncated: false,
          rows: [{ o: lit("part") }],
        });
      }
      if (sparql.includes("SELECT ?value")) {
        return Promise.resolve({
          form: "solutions" as const,
          variables: ["value"],
          truncated: false,
          rows: [
            { value: iri(partIri) },
            { value: iri("urn:ase:model:repo-one:attr") },
            { value: iri(partIri) },
          ],
        });
      }
      if (sparql.includes("ownedMember+")) {
        return Promise.resolve({
          form: "solutions" as const,
          variables: ["element", "nativeId", "metaclass"],
          truncated: false,
          rows: [{
            element: iri(partIri),
            nativeId: lit("part"),
            metaclass: lit("PartUsage"),
            name: lit("p"),
          }],
        });
      }
      if (sparql.includes("?other ?p <") || sparql.includes("?p ?other")) {
        return Promise.resolve({
          form: "solutions" as const,
          variables: ["p", "other"],
          truncated: false,
          rows: [
            {
              p: iri(propPredicate("owner")),
              other: iri(pkgIri),
              neighborNativeId: lit("pkg"),
            },
          ],
        });
      }
      if (sparql.includes("ase:nativeId ?nativeId")) {
        return Promise.resolve({
          form: "solutions" as const,
          variables: ["element", "nativeId"],
          truncated: false,
          rows: [{
            element: iri(partIri),
            nativeId: lit("part"),
            name: lit("p"),
            qualifiedName: lit("Golden::p"),
          }],
        });
      }
      return Promise.resolve({
        form: "solutions" as const,
        variables: ["metaclass", "name", "qualifiedName"],
        truncated: false,
        rows: [{
          metaclass: lit("PartUsage"),
          name: lit("p"),
          qualifiedName: lit("Golden::p"),
        }],
      });
    },
  };
  return { index, requests };
}

Deno.test("lookups pin the build and convert $id through the verified codec", async () => {
  const { index, requests } = fakeIndex();
  const reader = new BoundModelReader(index, build);
  const view = await reader.getElement("part");
  equal(view?.$id, partIri);
  equal(view?.metaclass, "PartUsage");
  equal(view?.qualifiedName, "Golden::p");
  deepStrictEqual({ ...view?.ref.build }, { ...build });
  equal(requests[0]?.build.artifactDigest, build.artifactDigest);
  equal((await reader.getByIri(partIri))?.nativeId, "part");
  // A foreign repository $id is refused before any query runs.
  const before = requests.length;
  throws(() => reader.refFromIri("urn:ase:model:repo-two:part"));
  equal(requests.length, before);
  equal(reader.refFromIri("urn:ase:library:lib-1").scope, "library");
});

Deno.test("metaclass listing, neighborhood and transversal walks map rows", async () => {
  const { index, requests } = fakeIndex();
  const reader = new BoundModelReader(index, build);
  const parts = await reader.elementsByMetaclass("PartUsage", 50);
  equal(parts.length, 1);
  equal(parts[0]?.name, "p");
  equal(requests.at(-1)?.limits?.maxResults, 50);
  equal(
    requests.at(-1)?.sparql.includes(
      "<https://www.omg.org/spec/SysML#PartUsage>",
    ),
    true,
  );

  const neighbors = await reader.neighbors(
    { build, nativeId: "part" },
    { direction: "out" },
  );
  // Non-property predicates (rdf:type) are not neighborhood edges.
  equal(neighbors.length, 1);
  equal(neighbors[0]?.property, "owner");
  equal(neighbors[0]?.other?.ref.nativeId, "pkg");

  const members = await reader.orderedMembers(
    { build, nativeId: "pkg" },
    "ownedMember",
  );
  deepStrictEqual([...members], [
    partIri,
    "urn:ase:model:repo-one:attr",
    partIri,
  ]);
  equal(requests.at(-1)?.sparql.endsWith("ORDER BY ?index"), true);

  const descendants = await reader.descendantsOf({ build, nativeId: "pkg" });
  equal(descendants[0]?.metaclass, "PartUsage");
  equal(requests.at(-1)?.sparql.includes("prop:ownedMember+"), true);
});

Deno.test("the engine yields RDFJS terms/bindings and refuses updates", async () => {
  const { index } = fakeIndex();
  const engine = new SemanticIndexQueryEngine(index);
  const context = modelReaderContext(build);
  const bindings: SimpleBindings[] = [];
  for await (
    const binding of await engine.queryBindings(
      "SELECT * WHERE { ?element ase:nativeId ?nativeId }",
      context,
    )
  ) {
    bindings.push(binding);
  }
  equal(bindings.length, 1);
  equal(bindings[0]?.get("element")?.termType, "NamedNode");
  equal(bindings[0]?.get("nativeId")?.value, "part");
  equal(await engine.queryBoolean("ASK {}", context), true);
  await rejects(
    () => engine.queryVoid(),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_QUERY_REFUSED",
  );
  const literal = termFromDto({
    kind: "literal",
    value: "3",
    datatype: "http://www.w3.org/2001/XMLSchema#integer",
  });
  equal(literal.termType, "Literal");
  equal(
    literal.termType === "Literal" ? literal.datatype.value : "",
    "http://www.w3.org/2001/XMLSchema#integer",
  );
});

Deno.test("quad-pattern source translates patterns to bounded SELECTs", async () => {
  const { index, requests } = fakeIndex();
  const engine = new SemanticIndexQueryEngine(
    index,
    modelReaderContext(build),
  );
  const quads: unknown[] = [];
  for await (
    const quad of engine.match(
      { termType: "NamedNode", value: partIri, equals: () => false } as never,
      {
        termType: "NamedNode",
        value: ASE_VOCAB.nativeId,
        equals: () => false,
      } as never,
      undefined,
    )
  ) {
    quads.push(quad);
  }
  equal(quads.length, 1);
  const patternRequest = requests.find((request) =>
    request.sparql.includes("?s ?p ?o")
  );
  equal(patternRequest?.build.artifactDigest, build.artifactDigest);
  equal(
    patternRequest?.sparql.includes(`<${partIri}> <${ASE_VOCAB.nativeId}> ?o`),
    true,
  );
  equal(typeof engine.countQuads, "function");
  // Without a bound context, quad-pattern access is refused.
  const unbound = new SemanticIndexQueryEngine(index);
  await rejects(() => unbound.countQuads());
});

Deno.test("schemas keep canonical predicates; the surface is read-only", () => {
  equal(PackageSchema["@type"], "https://www.omg.org/spec/SysML#Package");
  const schema = modelElementSchema("PartUsage");
  equal(schema.ownedMember["@id"], propPredicate("ownedMember"));
  equal(schema.nativeId["@id"], ASE_VOCAB.nativeId);
  for (
    const proto of [
      BoundModelReader.prototype,
      SemanticIndexQueryEngine.prototype,
    ]
  ) {
    const names = Object.getOwnPropertyNames(proto);
    deepStrictEqual(
      names.filter((name) =>
        /^(update|insert|delete|save|edit|create|remove)/i.test(name)
      ),
      [],
    );
  }
});

Deno.test("typed query engine refuses truncated results and preserves its bound build", async () => {
  const { index, requests } = fakeIndex();
  const original = index.queryReadOnly.bind(index);
  index.queryReadOnly = async (request) => {
    const result = await original(request);
    return result.form === "solutions"
      ? { ...result, truncated: true }
      : result;
  };
  const engine = new SemanticIndexQueryEngine(index, modelReaderContext(build));
  await rejects(
    () =>
      engine.queryBindings(
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        modelReaderContext({ ...build, repositoryId: "foreign" }),
      ),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_QUERY_LIMIT",
  );
  equal(requests[0]?.build.repositoryId, build.repositoryId);
  index.queryReadOnly = () =>
    Promise.resolve({ form: "graph", quads: [], truncated: true });
  await rejects(
    () => engine.queryQuads("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_QUERY_LIMIT",
  );
});

Deno.test("all target-ref readers refuse foreign builds before querying", async () => {
  const { index, requests } = fakeIndex();
  const reader = new BoundModelReader(index, build);
  const foreign = {
    build: { ...build, artifactDigest: digest("f") },
    nativeId: "part",
  };
  throws(() => reader.iriOf(foreign));
  await rejects(() => reader.getElement(foreign));
  await rejects(() => reader.neighbors(foreign));
  await rejects(() => reader.neighborsPage(foreign));
  await rejects(() => reader.referencesToPage(foreign));
  await rejects(() => reader.orderedMembers(foreign, "ownedMember"));
  await rejects(() => reader.descendantsOf(foreign));
  await rejects(() => reader.referencesTo(foreign));
  equal(requests.length, 0);
});

Deno.test("listing refs verify repository and nativeId against each element IRI", async () => {
  const { index } = fakeIndex();
  const reader = new BoundModelReader(index, build);
  for (
    const [element, nativeId] of [["urn:ase:model:foreign:part", "part"], [
      partIri,
      "wrong",
    ]]
  ) {
    index.queryReadOnly = () =>
      Promise.resolve({
        form: "solutions",
        variables: ["element", "nativeId"],
        rows: [{ element: iri(element), nativeId: lit(nativeId) }],
        truncated: false,
      });
    await rejects(() => reader.elementsByMetaclass("PartUsage"));
    await rejects(() => reader.descendantsOf({ build, nativeId: "pkg" }));
  }
});

Deno.test("named neighborhoods preserve occurrence duplicates and reject null markers", async () => {
  const { index, requests } = fakeIndex();
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) return Promise.resolve(identities);
    requests.push(request);
    return Promise.resolve({
      form: "solutions",
      variables: ["p", "other"],
      rows: [partIri, ASE_VOCAB.nullValue, partIri].filter((value) =>
        value !== ASE_VOCAB.nullValue
      ).map((value) => ({
        p: iri(propPredicate("ownedMember")),
        other: iri(value),
        neighborNativeId: lit(value.slice(value.lastIndexOf(":") + 1)),
      })),
      truncated: false,
    });
  };
  const reader = new BoundModelReader(index, build);
  const result = await reader.neighbors({ build, nativeId: "pkg" }, {
    property: "ownedMember",
  });
  deepStrictEqual(result.map((edge) => edge.other?.ref.nativeId), [
    "part",
    "part",
  ]);
  equal(requests[0]?.sparql.includes("ase:occurrence"), true);
  equal(requests[0]?.sparql.includes("FILTER NOT EXISTS"), true);
  equal(
    /ORDER BY \?direction \?p \?index \?other \?occurrence OFFSET 0 LIMIT 201$/
      .test(requests[0]!.sparql),
    true,
  );
  await reader.neighbors({ build, nativeId: "pkg" }, {
    property: "ownedMember",
    direction: "in",
  });
  equal(
    requests[1]?.sparql.includes(
      "?other <urn:ase:vocab:list:ownedMember> ?list",
    ),
    true,
  );
});

Deno.test("neighbor discovery accepts SysML properties and sysx annotations", async () => {
  const { index, requests } = fakeIndex();
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) return Promise.resolve(identities);
    requests.push(request);
    return Promise.resolve({
      form: "solutions",
      variables: ["p", "other", "direction"],
      truncated: false,
      rows: ["ownedMember", "sysx:sourceDocument"].map((property) => ({
        p: iri(propPredicate(property)),
        other: iri(partIri),
        direction: lit("out"),
      })),
    });
  };
  const reader = new BoundModelReader(index, build);
  const result = await reader.neighborsPage({ build, nativeId: "pkg" }, {
    direction: "both",
  });
  deepStrictEqual(result.items.map((edge) => edge.property), [
    "ownedMember",
    "sysx:sourceDocument",
  ]);
  const query = requests[0]!.sparql;
  for (
    const fragment of [
      'STRSTARTS(STR(?p), "https://www.omg.org/spec/SysML#")',
      'STRSTARTS(STR(?p), "urn:ase:vocab:prop:")',
      'STRSTARTS(?propertySuffix, "sysx%3A")',
      'STRAFTER(STR(?p), "https://www.omg.org/spec/SysML#")',
      'STRAFTER(STR(?p), "urn:ase:vocab:prop:")',
    ]
  ) equal(query.includes(fragment), true);
});

Deno.test("neighbor discovery pages filter noise before 20/50 row budgets", async () => {
  for (const count of [20, 50]) {
    const { index } = fakeIndex();
    const candidates = [
      {
        p: iri(ASE_VOCAB.rdfType),
        other: iri("https://www.omg.org/spec/SysML#Package"),
      },
      {
        p: iri(propPredicate("external")),
        other: iri("https://external.example/item"),
      },
      { p: iri(propPredicate("empty")), other: iri(ASE_VOCAB.nullValue) },
      ...Array.from(
        { length: count },
        (_, i) => ({
          p: iri(propPredicate("ownedMember")),
          other: iri(`urn:ase:model:repo-one:member-${i}`),
          neighborNativeId: lit(`member-${i}`),
        }),
      ),
    ];
    index.queryReadOnly = (request) => {
      const identities = identityResponse(request);
      if (identities) return Promise.resolve(identities);
      let rows = candidates;
      if (
        request.sparql.includes(
          'STRSTARTS(STR(?p), "https://www.omg.org/spec/SysML#")',
        )
      ) {
        rows = rows.filter((row) =>
          row.p.value.startsWith("https://www.omg.org/spec/SysML#")
        );
      }
      if (request.sparql.includes("?other ase:nativeId ?neighborNativeId")) {
        rows = rows.filter((row) => "neighborNativeId" in row);
      }
      const sqlLimit = /LIMIT (\d+)\s*$/.exec(request.sparql);
      if (sqlLimit) rows = rows.slice(0, Number(sqlLimit[1]));
      const budget = request.limits?.maxResults ?? 1000;
      return Promise.resolve({
        form: "solutions",
        variables: ["p", "other"],
        rows: rows.slice(0, budget),
        truncated: rows.length > budget,
      });
    };
    const reader = new BoundModelReader(index, build);
    const target = { build, nativeId: "pkg" };
    for (const limit of [count, 7]) {
      const page = await reader.neighborsPage(target, { limit });
      equal(page.items.length, limit);
      equal(page.limit, limit);
      equal(page.complete, limit === count); // Lookahead proves an exactly full last page.
      equal(page.items.every((edge) => !!edge.other), true);
      const incoming = await reader.referencesToPage(target, { limit });
      equal(incoming.items.length, limit);
      equal(incoming.complete, limit === count);
    }
    const exhausted = await reader.neighborsPage(target, { limit: count + 1 });
    equal(exhausted.items.length, count);
    equal(exhausted.complete, true);
  }
});

Deno.test("native truncation yields a partial discovery page but still fails strict element reads", async () => {
  const { index } = fakeIndex();
  index.queryReadOnly = (request) =>
    Promise.resolve(
      identityResponse(request) ?? {
        form: "solutions",
        variables: ["p", "other"],
        rows: [{
          p: iri(propPredicate("ownedMember")),
          other: iri(partIri),
          neighborNativeId: lit("part"),
        }],
        truncated: true,
      },
    );
  const reader = new BoundModelReader(index, build);
  const page = await reader.neighborsPage({ build, nativeId: "pkg" }, {
    limit: 20,
  });
  equal(page.items.length, 1);
  equal(page.complete, false);
  await rejects(
    () => reader.getElement("pkg"),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_QUERY_LIMIT",
  );
});

Deno.test("named occurrence discovery pages retain the duplicate sequence at lower limits", async () => {
  const { index } = fakeIndex();
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) return Promise.resolve(identities);
    equal(request.sparql.includes("ase:occurrence"), true);
    equal(
      /ORDER BY \?direction \?p \?index \?other \?occurrence OFFSET 0 LIMIT (?:3|5)$/
        .test(request.sparql),
      true,
    );
    const limit = Number(/LIMIT (\d+)\s*$/.exec(request.sparql)?.[1]);
    const rows = [partIri, "urn:ase:model:repo-one:attr", partIri].slice(
      0,
      limit,
    ).map((value) => ({
      p: iri(propPredicate("ownedMember")),
      other: iri(value),
      neighborNativeId: lit(value.slice(value.lastIndexOf(":") + 1)),
    }));
    return Promise.resolve({
      form: "solutions",
      variables: ["p", "other"],
      rows,
      truncated: false,
    });
  };
  const reader = new BoundModelReader(index, build);
  const page = await reader.neighborsPage({ build, nativeId: "pkg" }, {
    property: "ownedMember",
    limit: 2,
  });
  deepStrictEqual(page.items.map((edge) => edge.other?.ref.nativeId), [
    "part",
    "attr",
  ]);
  equal(page.complete, false);
  const full = await reader.neighborsPage({ build, nativeId: "pkg" }, {
    property: "ownedMember",
    limit: 4,
  });
  deepStrictEqual(full.items.map((edge) => edge.other?.ref.nativeId), [
    "part",
    "attr",
    "part",
  ]);
  equal(full.complete, true);
});

Deno.test("bounded VALUES verification refuses an IRI/nativeId mismatch without expanding discovery", async () => {
  const { index } = fakeIndex();
  let identityQueries = 0;
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) {
      identityQueries++;
      return Promise.resolve({
        ...identities,
        rows: [{ other: iri(pkgIri), neighborNativeId: lit("wrong-id") }],
      });
    }
    equal(
      request.sparql.includes(
        "FILTER EXISTS { ?other ase:nativeId ?neighborNativeId }",
      ),
      true,
    );
    equal(
      request.sparql.includes("SELECT ?direction ?p ?other ?index ?occurrence"),
      true,
    );
    return Promise.resolve({
      form: "solutions",
      variables: [],
      truncated: false,
      rows: [{ p: iri(propPredicate("owner")), other: iri(pkgIri) }],
    });
  };
  await rejects(
    () =>
      new BoundModelReader(index, build).neighborsPage({
        build,
        nativeId: "part",
      }),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_CORRUPT",
  );
  equal(identityQueries, 1);
});

Deno.test("array helpers preserve their 200-result default while agent evidence explicitly defaults to 20", async () => {
  const { index, requests } = fakeIndex();
  const reader = new BoundModelReader(index, build);
  const target = { build, nativeId: "part" };
  await reader.neighbors(target);
  equal(
    requests.findLast((r) => r.sparql.includes("ORDER BY ?direction"))?.limits
      ?.maxResults,
    201,
  );
  await reader.referencesTo(target);
  equal(
    requests.findLast((r) => r.sparql.includes("ORDER BY ?direction"))?.limits
      ?.maxResults,
    201,
  );
  await semanticNeighborEvidence(reader, target, "inspect", "user");
  equal(
    requests.findLast((r) => r.sparql.includes("ORDER BY ?direction"))?.limits
      ?.maxResults,
    21,
  );
});

Deno.test("exposed neighbor pages continue native truncation and suppress zero-row cursors", async () => {
  const { index } = fakeIndex();
  const rows = ["part", "attr", "part", "next", "attr"].map((id, position) => ({
    p: iri(propPredicate("ownedMember")),
    other: iri(`urn:ase:model:repo-one:${id}`),
    neighborNativeId: lit(id),
    index: lit(String(position)),
    occurrence: { kind: "blank" as const, value: `occ-${position}` },
  }));
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) return Promise.resolve(identities);
    const offset = Number(/OFFSET (\d+)/.exec(request.sparql)![1]);
    const available = rows.slice(
      offset,
      offset + Number(/LIMIT (\d+)$/.exec(request.sparql)![1]),
    );
    return Promise.resolve({
      form: "solutions",
      variables: [],
      rows: available.slice(0, 2),
      truncated: available.length > 2,
    });
  };
  const reader = new BoundModelReader(index, build);
  const pin = {
    version: `commit:${"a".repeat(40)}`,
    projection: {
      kind: "rdf-quads",
      projectorVersion: "v1",
      artifactDigest: build.artifactDigest,
      projectionDigest: "e".repeat(64),
    },
  };
  const found: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await semanticNeighborEvidence(
      reader,
      { build, nativeId: "pkg" },
      "inspect",
      "user",
      { limit: 3, cursor },
      pin,
    );
    found.push(...page.neighbors.map((n) => n.position!));
    equal(page.neighborPage.nativeTruncated, pages < 2);
    cursor = page.neighborPage.nextCursor;
    pages++;
    equal(pages <= 3, true);
  } while (cursor);
  deepStrictEqual(found, [0, 1, 2, 3, 4]);
  index.queryReadOnly = () =>
    Promise.resolve({
      form: "solutions",
      variables: [],
      rows: [],
      truncated: true,
    });
  const empty = await semanticNeighborEvidence(
    reader,
    { build, nativeId: "pkg" },
    "inspect",
    "user",
    {},
    pin,
  );
  deepStrictEqual(empty.neighbors, []);
  deepStrictEqual(empty.neighborPage, {
    limit: 20,
    complete: false,
    nativeTruncated: true,
  });
});

Deno.test("large low-level pages verify identities in row- and byte-bounded batches", async () => {
  const { index } = fakeIndex();
  const rows = Array.from(
    { length: 100 },
    (_, i) => ({
      p: iri(propPredicate("ownedMember")),
      other: iri(`urn:ase:model:repo-one:${i}-${"x".repeat(1990)}`),
    }),
  );
  let batches = 0, verified = 0;
  index.queryReadOnly = (request) => {
    const identities = identityResponse(request);
    if (identities) {
      batches++;
      verified += identities.rows.length;
      equal(identities.rows.length <= 50, true);
      equal(new TextEncoder().encode(request.sparql).length <= 65_536, true);
      return Promise.resolve(identities);
    }
    return Promise.resolve({
      form: "solutions",
      variables: [],
      truncated: false,
      rows,
    });
  };
  const page = await new BoundModelReader(index, build).neighborsPage({
    build,
    nativeId: "pkg",
  }, { limit: 10_000 });
  equal(page.items.length, 100);
  equal(verified, 100);
  equal(batches > 2, true);
});
