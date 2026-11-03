import { equal, rejects } from "node:assert/strict";
import { createModelSemanticBackend } from "./backend.ts";
import type { ModelSemanticBackendOptions } from "./backend.ts";
import {
  ARTIFACT_SCHEMA,
  buildDescriptor,
  buildKey,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";

const digest = "a".repeat(64);
const descriptor = buildDescriptor({
  repositoryId: "project",
  sourceDigest: digest,
  recipe: {
    toolkit: { version: "native-1", bundleDigest: "b".repeat(64) },
    format: "ase-toolkit-normalized-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: ARTIFACT_SCHEMA,
    engineVersion: "native-1",
  },
  recipeDigest: "c".repeat(64),
  buildKey: "d".repeat(64),
  artifactDigest: "e".repeat(64),
  bytes: 10,
});
function fixture() {
  let resolved = 0;
  const options: ModelSemanticBackendOptions = {
    repositoryId: "project",
    repository: {
      header: (version) =>
        Promise.resolve({
          version,
          sourceDigest: digest,
          sources: { "m.sysml": "package P;" },
        }),
      descriptorAt: () => Promise.resolve(descriptor),
    },
    buildService: {
      resolve: () => {
        resolved++;
        throw new Error("unexpected resolution");
      },
    },
    native: {
      load: () => Promise.resolve({ quadCount: 0 }),
      query: () => Promise.resolve({ form: "boolean", value: true }),
      release: () => Promise.resolve(),
      isLoaded: () => Promise.resolve(false),
    },
  };
  return { options, resolved: () => resolved };
}
Deno.test("semantic backend resolves exact persisted build with no compilation or artifact retention", async () => {
  const f = fixture();
  const backend = createModelSemanticBackend(f.options);
  const build = await backend.resolveBuild(`commit:${"a".repeat(40)}`, digest);
  equal(build.repositoryId, "project");
  equal(build.artifactDigest, descriptor.artifactDigest);
  equal(f.resolved(), 0);
  await backend.close();
  await rejects(
    () => backend.resolveBuild(`commit:${"a".repeat(40)}`),
    /closed/,
  );
});
Deno.test("legacy build recipe absence is explicit and does not synthesize identity", async () => {
  const f = fixture();
  f.options.repository.descriptorAt = () => Promise.resolve(null);
  await rejects(
    () =>
      createModelSemanticBackend(f.options).resolveBuild(
        `commit:${"a".repeat(40)}`,
      ),
    (e: unknown) => (e as { code: string }).code === "INDEX_PROJECTION_MISSING",
  );
  equal(f.resolved(), 0);
});
Deno.test("semantic backend refuses source and repository mismatches before native load", async () => {
  const f = fixture();
  const backend = createModelSemanticBackend(f.options);
  await rejects(
    () => backend.resolveBuild(`commit:${"a".repeat(40)}`, "f".repeat(64)),
    /Source pin/,
  );
  f.options.repositoryId = "other";
  await rejects(
    () => backend.resolveBuild(`commit:${"a".repeat(40)}`),
    /repository and source pin/,
  );
  equal(f.resolved(), 0);
});
Deno.test("semantic backend refuses mutable or incorrectly returned version pins", async () => {
  const f = fixture();
  f.options.repository.header = () =>
    Promise.resolve({
      version: `commit:${"b".repeat(40)}`,
      sourceDigest: digest,
      sources: {},
    });
  await rejects(
    () =>
      createModelSemanticBackend(f.options).resolveBuild(
        `commit:${"a".repeat(40)}`,
      ),
    /Source pin/,
  );
});

Deno.test("semantic backend refuses branch identities before any repository access", async () => {
  const f = fixture();
  await rejects(
    () => createModelSemanticBackend(f.options).resolveBuild("branch:main"),
    /immutable model commit/,
  );
});

async function referenceFixture() {
  const f = fixture();
  const sources = { "m.sysml": "package P;" };
  const sourceDigest = await modelSourceDigest(sources);
  const { digest: _digest, ...recipe } = descriptor.recipe;
  const recipeHash = await recipeDigest(recipe);
  const verified = {
    ...descriptor,
    sourceDigest,
    recipe: { ...recipe, digest: recipeHash },
    buildKey: await buildKey(sourceDigest, recipeHash),
  };
  f.options.repository.header = (version) =>
    Promise.resolve({ version, sourceDigest, sources });
  f.options.repository.descriptorAt = () => Promise.resolve(verified);
  const requests: unknown[] = [];
  const loads: unknown[] = [];
  const loaded = new Set<string>();
  f.options.projectionPreparer = {
    prepare(input) {
      requests.push(input);
      return Promise.resolve({
        projection: {
          kind: "rdf-quads",
          projectorVersion: "ase-rdf-quads-v2:verified-context",
          artifactDigest: input.build.artifactDigest,
          projectionDigest: "f".repeat(64),
        },
      });
    },
  };
  f.options.native.load = () => {
    throw new Error("Production preparation must not use parent RDF bytes");
  };
  f.options.native.loadReference = (input) => {
    loads.push(input);
    loaded.add(buildRefKey(input.build));
    return Promise.resolve({ quadCount: 5 });
  };
  f.options.native.isLoaded = (build) =>
    Promise.resolve(loaded.has(buildRefKey(build)));
  f.options.native.release = (build) => {
    loaded.delete(buildRefKey(build));
    return Promise.resolve();
  };
  return { ...f, requests, loads, sources, sourceDigest, verified };
}

Deno.test("production reference preparation binds header S/R/K and never resolves artifact elements in parent", async () => {
  const f = await referenceFixture();
  const backend = createModelSemanticBackend(f.options);
  const version = `commit:${"a".repeat(40)}`;
  try {
    const graph = await backend.readGraph(
      version,
      f.sourceDigest,
      (pin) => pin,
    );
    equal(graph.build.artifactDigest, f.verified.artifactDigest);
    equal(f.requests.length, 1);
    equal(f.loads.length, 1);
    equal(f.resolved(), 0);
    deepStrictEqual(Object.keys(f.requests[0]!).sort(), [
      "build",
      "descriptor",
    ]);
    deepStrictEqual(Object.keys(f.loads[0]!).sort(), ["build", "projection"]);
    const second = await backend.readGraph(
      version,
      f.sourceDigest,
      (pin) => pin,
    );
    deepStrictEqual(second.build, graph.build);
    equal(f.requests.length, 1);
  } finally {
    await backend.close();
  }
});

Deno.test("reference preparation refuses forged header contents and invalid descriptor recipe before dispatch", async () => {
  for (const corruption of ["sources", "recipe", "key"] as const) {
    const f = await referenceFixture();
    if (corruption === "sources") {
      f.sources["m.sysml"] = "package Other;";
    } else if (corruption === "recipe") {
      f.verified.recipe.digest = "0".repeat(64);
    } else {
      f.verified.buildKey = "0".repeat(64);
    }
    const backend = createModelSemanticBackend(f.options);
    try {
      await rejects(
        () =>
          backend.readGraph(
            `commit:${"a".repeat(40)}`,
            f.sourceDigest,
            () => {},
          ),
        (e: unknown) =>
          (e as { code?: string }).code ===
            (corruption === "sources"
              ? "BUILD_SOURCE_MISMATCH"
              : "BUILD_DESCRIPTOR_MISMATCH"),
      );
      equal(f.requests.length, 0);
      equal(f.loads.length, 0);
      equal(f.resolved(), 0);
    } finally {
      await backend.close();
    }
  }
});

import { deepStrictEqual } from "node:assert/strict";
import {
  MAX_QUEUED_SEMANTIC_READS,
  MAX_RESIDENT_SEMANTIC_GRAPHS,
  SCALAR_INSPECT_QUAD_BUDGET,
  scalarInspectionSchema,
} from "./backend.ts";
import type { ResolvedModelBuild } from "../../../application/model/builds/service.ts";
import { buildRefKey } from "../../../domain/model/value-objects/element-ref.ts";

function graphFixture() {
  const f = fixture();
  const loaded = new Set<string>();
  const released: string[] = [];
  let peak = 0;
  f.options.repository.descriptorAt = (version) => {
    const id = version.slice(-1).repeat(64);
    return Promise.resolve({ ...descriptor, artifactDigest: id, buildKey: id });
  };
  f.options.buildService.resolve = () =>
    Promise.resolve(
      { artifact: { elements: [] } } as unknown as ResolvedModelBuild,
    );
  f.options.native.load = ({ build }) => {
    loaded.add(buildRefKey(build));
    peak = Math.max(peak, loaded.size);
    if (loaded.size > 3) throw new Error("STORE_FULL");
    return Promise.resolve({ quadCount: 0 });
  };
  f.options.native.isLoaded = (build) =>
    Promise.resolve(loaded.has(buildRefKey(build)));
  f.options.native.release = (build) => {
    const key = buildRefKey(build);
    released.push(key);
    loaded.delete(key);
    return Promise.resolve();
  };
  return { ...f, loaded, released, peak: () => peak };
}
const graphVersion = (id: number) =>
  `commit:${id.toString(16).padStart(40, "0")}`;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
Deno.test("five sequential versions evict idle native graphs before loading, within native budget", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  for (let id = 1; id <= 5; id++) {
    await backend.readGraph(graphVersion(id), digest, ({ build }) => {
      equal(f.loaded.has(buildRefKey(build)), true);
    });
  }
  equal(f.peak(), MAX_RESIDENT_SEMANTIC_GRAPHS);
  equal(f.loaded.size, 3);
  equal(f.released.length, 2);
  await backend.close();
  equal(f.loaded.size, 0);
});
Deno.test("active read pins survive logical mapping churn and concurrent fifth version admission", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  const entered = [barrier(), barrier(), barrier()];
  const leave = [barrier(), barrier(), barrier()];
  const reads = entered.map((ready, i) =>
    backend.readGraph(graphVersion(i + 1), digest, async (graph) => {
      ready.resolve();
      await leave[i]!.promise;
      equal(f.loaded.has(buildRefKey(graph.build)), true);
    })
  );
  await Promise.all(entered.map((e) => e.promise));
  for (let id = 6; id <= 30; id++) await backend.resolveBuild(graphVersion(id));
  equal(f.released.length, 0);
  const pinnedKey = buildRefKey(await backend.resolveBuild(graphVersion(1)));
  const fourth = backend.readGraph(graphVersion(4), digest, async () => {});
  const fifth = backend.readGraph(graphVersion(5), digest, async () => {});
  await rejects(
    () => backend.release(graphVersion(1)),
    (e: unknown) => (e as { code: string }).code === "INDEX_BUSY",
  );
  equal(f.released.length, 0);
  leave[1]!.resolve();
  await Promise.all([reads[1], fourth, fifth]);
  equal(f.released.includes(pinnedKey), false);
  leave[0]!.resolve();
  leave[2]!.resolve();
  await Promise.all(reads);
  equal(f.peak(), 3);
  await backend.close();
});
Deno.test("graph waiter queue is bounded and shutdown rejects waiters then drains admitted reads", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  const entered = [barrier(), barrier(), barrier()];
  const leave = barrier();
  const reads = entered.map((ready, i) =>
    backend.readGraph(graphVersion(i + 1), digest, async () => {
      ready.resolve();
      await leave.promise;
    })
  );
  await Promise.all(entered.map((e) => e.promise));
  const queued = Array.from(
    { length: MAX_QUEUED_SEMANTIC_READS },
    () => backend.readGraph(graphVersion(4), digest, async () => {}),
  );
  // A normal event-loop turn lets the sixteen admission promises enqueue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rejects(
    () => backend.readGraph(graphVersion(5), digest, async () => {}),
    (e: unknown) => (e as { code: string }).code === "INDEX_BUSY",
  );
  const settled = Promise.allSettled(queued);
  const closing = backend.close();
  leave.resolve();
  await Promise.all(reads);
  await closing;
  equal((await settled).every((r) => r.status === "rejected"), true);
  equal(f.loaded.size, 0);
});
Deno.test("graph cleanup attempts every release even if one native release fails", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  for (let id = 1; id <= 3; id++) {
    await backend.readGraph(graphVersion(id), digest, async () => {});
  }
  const original = f.options.native.release;
  let calls = 0;
  f.options.native.release = (build) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("native release failed"));
    return original(build);
  };
  await rejects(() => backend.close(), AggregateError);
  equal(calls, 3);
  equal(f.loaded.size, 1);
});
Deno.test("scalar package inspection schema stays cardinality-independent above 100 owned members", () => {
  const pkg = {
    "@type": "Package",
    ownedMember: Array.from({ length: 150 }, (_, i) => ({ "@id": `p${i}` })),
  };
  const schema = scalarInspectionSchema(pkg["@type"]);
  deepStrictEqual(Object.keys(schema).sort(), [
    "@type",
    "declaredName",
    "metaclass",
    "name",
    "nativeId",
    "qualifiedName",
  ]);
  equal(
    Object.values(schema).some((value) =>
      typeof value === "object" && "@array" in value
    ),
    false,
  );
  equal(Object.keys(schema).length < SCALAR_INSPECT_QUAD_BUDGET, true);
});
Deno.test("fixed graph query capability expires after its callback", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  let saved!: (sparql: string) => Promise<unknown>;
  await backend.readGraph(graphVersion(1), digest, (graph) => {
    saved = graph.query;
  });
  await rejects(() => saved("ASK {}"), /lease has ended/);
  await backend.close();
});

Deno.test("graph operation pin drains a query even when callback did not await it", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  const queryStarted = barrier();
  const queryFinished = barrier();
  f.options.native.query = () => {
    queryStarted.resolve();
    return queryFinished.promise.then(() => ({ form: "boolean", value: true }));
  };
  const reading = backend.readGraph(graphVersion(1), digest, (graph) => {
    void graph.query("ASK {}");
  });
  await queryStarted.promise;
  await rejects(
    () => backend.release(graphVersion(1)),
    (e: unknown) => (e as { code: string }).code === "INDEX_BUSY",
  );
  const closing = backend.close();
  equal(f.released.length, 0);
  queryFinished.resolve();
  await reading;
  await closing;
  equal(f.released.length, 1);
});

import { semanticNeighborEvidence } from "./backend.ts";
import type { ModelNeighborPage } from "./ldkit-reader.ts";

Deno.test("semantic page composition forwards default20/max50/lower limits and explicit partial discovery", async () => {
  const build = {
    repositoryId: descriptor.repositoryId,
    sourceDigest: descriptor.sourceDigest,
    recipeDigest: descriptor.recipe.digest,
    buildKey: descriptor.buildKey,
    artifactDigest: descriptor.artifactDigest,
  };
  const target = { build, nativeId: "pkg" };
  const calls: Array<
    { operation: string; limit: number | undefined; scope: string | undefined }
  > = [];
  const sourceNoise = Array.from(
    { length: 80 },
    (_, i) => ({ predicate: "urn:ase:source:line", value: i }),
  );
  const page = (
    operation: string,
    options: { scope?: string; limit?: number },
  ): ModelNeighborPage => {
    calls.push({ operation, limit: options.limit, scope: options.scope });
    // The reader has already filtered these source triples before its LIMIT.
    // Composition must consume the explicit page, never infer completeness
    // from the independent source result or leak extra source metadata.
    return Object.assign({
      items: Array.from(
        { length: options.limit! },
        (_, i) => ({
          direction: operation === "references"
            ? "in" as const
            : "out" as const,
          property: "ownedMember",
          predicate: "urn:ase:vocab:prop:ownedMember",
          otherIri: `urn:ase:element:${i}`,
        }),
      ),
      limit: options.limit!,
      complete: false,
    }, { sourceNoise, total: 999 });
  };
  const reader = {
    neighborsPage: (
      _target: unknown,
      options: { scope?: string; limit?: number; direction?: string } = {},
    ) =>
      Promise.resolve(
        page(options.direction === "in" ? "references" : "inspect", options),
      ),
    referencesToPage: (
      _target: unknown,
      options: { scope?: string; limit?: number } = {},
    ) => Promise.resolve(page("references", options)),
  };
  for (const operation of ["inspect", "references"] as const) {
    for (const requested of [undefined, 50, 3, 90]) {
      const evidence = await semanticNeighborEvidence(
        reader,
        target,
        operation,
        "user",
        requested,
      );
      const limit = requested === undefined ? 20 : Math.min(requested, 50);
      equal(evidence.neighbors.length, limit);
      deepStrictEqual(evidence.neighborPage, { limit, complete: false });
      deepStrictEqual(Object.keys(evidence).sort(), [
        "neighborPage",
        "neighbors",
      ]);
      deepStrictEqual(calls.at(-1), { operation, limit, scope: "user" });
    }
  }
  await rejects(
    () => semanticNeighborEvidence(reader, target, "inspect", "user", 0),
    /positive integer/,
  );
});

Deno.test("semantic page composition preserves positively complete small discoveries", async () => {
  const build = {
    repositoryId: descriptor.repositoryId,
    sourceDigest: descriptor.sourceDigest,
    recipeDigest: descriptor.recipe.digest,
    buildKey: descriptor.buildKey,
    artifactDigest: descriptor.artifactDigest,
  };
  const empty = () => Promise.resolve({ items: [], limit: 2, complete: true });
  const evidence = await semanticNeighborEvidence(
    { neighborsPage: empty, referencesToPage: empty },
    { build, nativeId: "pkg" },
    "inspect",
    "user",
    2,
  );
  deepStrictEqual(evidence, {
    neighbors: [],
    neighborPage: { limit: 2, complete: true },
  });
});

Deno.test("graph cursors bind commit/build/projection/target/scope/filter but allow a new page size", async () => {
  const build = {
    repositoryId: descriptor.repositoryId,
    sourceDigest: digest,
    recipeDigest: descriptor.recipe.digest,
    buildKey: descriptor.buildKey,
    artifactDigest: descriptor.artifactDigest,
  };
  const projection = {
    kind: "rdf-quads",
    projectorVersion: "v1",
    artifactDigest: build.artifactDigest,
    projectionDigest: "f".repeat(64),
  };
  const pin = { version: graphVersion(1), projection };
  let last: unknown;
  const reader = {
    neighborsPage: (_: unknown, options: unknown) => {
      last = options;
      return Promise.resolve({
        items: [],
        limit: 2,
        complete: false,
        nativeTruncated: false,
        nextOffset: 2,
      });
    },
    referencesToPage: () => Promise.reject(new Error("unused")),
  };
  const target = { build, nativeId: "pkg" };
  const first = await semanticNeighborEvidence(
    reader,
    target,
    "inspect",
    "user",
    { property: "ownedMember", limit: 2 },
    pin,
  );
  const cursor = first.neighborPage.nextCursor!;
  await semanticNeighborEvidence(reader, target, "inspect", "user", {
    property: "ownedMember",
    cursor,
    limit: 1,
  }, pin);
  deepStrictEqual(last, {
    scope: "user",
    direction: "out",
    limit: 1,
    property: "ownedMember",
    offset: 2,
  });
  for (
    const changed of [
      { target: { ...target, nativeId: "other" } },
      { target: { ...target, build: { ...build, buildKey: "0".repeat(64) } } },
      { pin: { ...pin, version: graphVersion(2) } },
      {
        pin: {
          ...pin,
          projection: { ...projection, projectionDigest: "0".repeat(64) },
        },
      },
      { scope: "library" as const },
      { direction: "in" as const },
      { property: "owner" },
    ]
  ) {
    await rejects(() =>
      semanticNeighborEvidence(
        reader,
        changed.target ?? target,
        "inspect",
        changed.scope ?? "user",
        {
          property: changed.property ?? "ownedMember",
          direction: changed.direction,
          cursor,
        },
        changed.pin ?? pin,
      ), /cursor does not match/);
  }
  await rejects(
    () =>
      semanticNeighborEvidence(reader, target, "inspect", "user", {
        cursor: "not-a-cursor",
      }, pin),
    /cursor does not match/,
  );
});

Deno.test("bounded SPARQL queries preserve provenance, enforce SELECT/ASK, and surface timeouts", async () => {
  const f = graphFixture();
  const backend = createModelSemanticBackend(f.options);
  let limits: unknown;
  f.options.native.query = (request) => {
    limits = request.limits;
    return Promise.resolve({
      form: "solutions",
      variables: ["x"],
      rows: [],
      truncated: true,
    });
  };
  const answer = await backend.queryGraph(
    graphVersion(1),
    digest,
    "SELECT ?x WHERE { ?x ?p ?o }",
  );
  equal(answer.mode, "sparql");
  equal(answer.version, graphVersion(1));
  equal(answer.build.sourceDigest, digest);
  equal(answer.projection.artifactDigest, answer.build.artifactDigest);
  equal((limits as { maxResults: number }).maxResults, 50);
  equal((limits as { maxBytes: number }).maxBytes, 65536);
  equal((limits as { timeoutMs: number }).timeoutMs <= 5000, true);
  equal((limits as { timeoutMs: number }).timeoutMs > 0, true);
  equal(answer.result.form === "solutions" && answer.result.truncated, true);
  for (
    const expression of [
      "INSERT DATA {}",
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
      "DESCRIBE ?s WHERE { ?s ?p ?o }",
      "SELECT * FROM <urn:foreign> WHERE {?s ?p ?o}",
      "SELECT * WHERE { SERVICE <https://example.invalid> {?s ?p ?o}}",
      "x".repeat(4097),
    ]
  ) {
    await rejects(() =>
      backend.queryGraph(graphVersion(1), digest, expression)
    );
  }
  f.options.native.query = () =>
    Promise.reject(
      new (class extends Error {
        code = "INDEX_TIMEOUT";
        recovery = "Retry";
      })("deadline"),
    );
  await rejects(
    () => backend.queryGraph(graphVersion(1), digest, "ASK {}"),
    (error: unknown) => {
      const failure =
        error as import("../../../domain/model/consultation/context.ts").ModelNavigationError;
      equal(failure.code, "INDEX_TIMEOUT");
      deepStrictEqual(failure.evidence.build, answer.build);
      deepStrictEqual(failure.evidence.projection, answer.projection);
      return true;
    },
  );
  await backend.close();
});

Deno.test("native preparation failure retains every known build and projection field", async () => {
  const f = graphFixture();
  f.options.native.load = () =>
    Promise.reject(new Error("native worker unavailable"));
  const backend = createModelSemanticBackend(f.options);
  await rejects(
    () => backend.queryGraph(graphVersion(1), digest, "ASK {}"),
    (error: unknown) => {
      const failure =
        error as import("../../../domain/model/consultation/context.ts").ModelNavigationError;
      equal(failure.code, "INDEX_UNAVAILABLE");
      equal(failure.evidence.version, graphVersion(1));
      equal(failure.evidence.build?.sourceDigest, digest);
      equal(failure.evidence.projection?.kind, "rdf-quads");
      equal(
        failure.evidence.projection?.artifactDigest,
        failure.evidence.build?.artifactDigest,
      );
      equal(failure.recovery.length > 0, true);
      return true;
    },
  );
  await backend.close();
});

Deno.test("continuation refuses the proven offset boundary instead of emitting an unusable cursor", async () => {
  const build = {
    repositoryId: descriptor.repositoryId,
    sourceDigest: digest,
    recipeDigest: descriptor.recipe.digest,
    buildKey: descriptor.buildKey,
    artifactDigest: descriptor.artifactDigest,
  };
  const pin = {
    version: graphVersion(1),
    projection: {
      kind: "rdf-quads",
      projectorVersion: "v1",
      artifactDigest: build.artifactDigest,
      projectionDigest: "f".repeat(64),
    },
  };
  let nextOffset = 1_000_000;
  const reader = {
    neighborsPage: () =>
      Promise.resolve({ items: [], limit: 1, complete: false, nextOffset }),
    referencesToPage: () => Promise.reject(new Error("unused")),
  };
  const first = await semanticNeighborEvidence(
    reader,
    { build, nativeId: "pkg" },
    "inspect",
    "user",
    { limit: 1 },
    pin,
  );
  equal(typeof first.neighborPage.nextCursor, "string");
  nextOffset++;
  await rejects(
    () =>
      semanticNeighborEvidence(
        reader,
        { build, nativeId: "pkg" },
        "inspect",
        "user",
        { limit: 1, cursor: first.neighborPage.nextCursor },
        pin,
      ),
    (error: unknown) =>
      (error as { code: string }).code === "INDEX_QUERY_LIMIT",
  );
});
