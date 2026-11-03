import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { DeterministicRdfModelProjector } from "../../../adapters/out/oxigraph/rdf.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import {
  type BuildRef,
  buildRefKey,
  parseProjectionRef,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import { BuildStoreError } from "../builds/ports/out/build-store.port.ts";
import {
  admitReadOnlySparql,
  contextualProjectorVersion,
  effectiveQueryLimits,
  HARD_QUERY_LIMITS,
  ModelSemanticIndexService,
  SemanticIndexError,
} from "./index-service.ts";
import { type ModelRdfProjector } from "./ports/out/rdf-projector.port.ts";
import { type NativeSemanticIndexPort } from "./ports/out/native-semantic-index.port.ts";
import { type SemanticProjectionCache } from "./ports/out/semantic-projection-cache.port.ts";
import { type SemanticQueryResult } from "./queries/inputs.ts";
import { type VerifiedBuildElementsSource } from "./ports/out/verified-build-elements-source.port.ts";

function referenceGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

function referenceHarness(
  prepare: (build: BuildRef) => Promise<{ projection: ProjectionRef }>,
  loadGate?: Promise<void>,
) {
  const loaded = new Set<string>();
  const loads: Array<{ build: BuildRef; projection: ProjectionRef }> = [];
  const native: NativeSemanticIndexPort = {
    load() {
      throw new Error("Reference mode must never call the byte loader");
    },
    async loadReference(input) {
      loads.push(input);
      await loadGate;
      loaded.add(buildRefKey(input.build));
      return { quadCount: 17 };
    },
    query: () => Promise.resolve({ form: "boolean", value: true }),
    release(input) {
      loaded.delete(buildRefKey(input));
      return Promise.resolve();
    },
    isLoaded: (input) => Promise.resolve(loaded.has(buildRefKey(input))),
  };
  return {
    service: new ModelSemanticIndexService({ native, preparer: { prepare } }),
    native,
    loaded,
    loads,
  };
}

function preparedRef(input: BuildRef): { projection: ProjectionRef } {
  return {
    projection: {
      kind: "rdf-quads",
      projectorVersion: "ase-rdf-quads-v2:verified-context",
      artifactDigest: input.artifactDigest,
      projectionDigest: "9".repeat(64),
    },
  };
}

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};
const quadsText =
  `<urn:ase:model:repo-one:el-1> <urn:ase:vocab:nativeId> "el-1" <urn:ase:build:${
    digest("4")
  }> .\n`;

Deno.test("reference preparation coalesces and publishes ready only after native acknowledgment", async () => {
  const preparation = referenceGate();
  const loading = referenceGate();
  let calls = 0;
  const h = referenceHarness(async (input) => {
    calls++;
    await preparation.promise;
    return preparedRef(input);
  }, loading.promise);
  const one = h.service.ensureProjection(build);
  const two = h.service.ensureProjection({ ...build });
  equal(one, two);
  equal(calls, 1);
  equal((await h.service.status(build)).state, "loading");
  preparation.resolve();
  await Promise.resolve();
  await Promise.resolve();
  equal((await h.service.status(build)).state, "loading");
  loading.resolve();
  const ready = await one;
  deepStrictEqual(await two, ready);
  equal(ready.state, "ready");
  equal(ready.quadCount, 17);
  equal(h.loads.length, 1);
  deepStrictEqual(Object.keys(h.loads[0]!).sort(), ["build", "projection"]);
  deepStrictEqual(h.loads[0]!.build, build);
  equal(
    new TextEncoder().encode(JSON.stringify(h.loads[0])).length < 1024,
    true,
  );
});

Deno.test("reference mode refuses missing consumer and never falls back after coded preparation failure", async () => {
  throws(
    () =>
      new ModelSemanticIndexService({
        native: new FakeNative(),
        preparer: { prepare: (input) => Promise.resolve(preparedRef(input)) },
      }),
    /requires a native reference consumer/,
  );
  const failure = new BuildStoreError(
    "BUILD_BLOB_CORRUPT",
    {},
    "Corrupt cache",
  );
  const h = referenceHarness(() => Promise.reject(failure));
  await rejects(() => h.service.ensureProjection(build), (e) => e === failure);
  equal(h.loads.length, 0);
  equal((await h.service.status(build)).failureCode, "BUILD_BLOB_CORRUPT");
});

Deno.test("reference mode rejects mismatched artifact, kind, malformed and colliding projection refs", async () => {
  for (
    const patch of [
      { artifactDigest: "8".repeat(64) },
      { kind: "other-kind" },
      { projectionDigest: "invalid" },
      { projectionDigest: build.artifactDigest },
    ]
  ) {
    const h = referenceHarness((input) =>
      Promise.resolve({
        projection: { ...preparedRef(input).projection, ...patch },
      })
    );
    await rejects(
      () => h.service.ensureProjection(build),
      (e: unknown) =>
        (e as { code?: string }).code === "INDEX_PROJECTION_CORRUPT",
    );
    equal(h.loads.length, 0);
  }
});

Deno.test("existing graph queries remain independent while another reference is preparing", async () => {
  const preparation = referenceGate();
  const h = referenceHarness(async (input) => {
    if (input.artifactDigest !== build.artifactDigest) {
      await preparation.promise;
    }
    return preparedRef(input);
  });
  await h.service.ensureProjection(build);
  const nextBuild = { ...build, artifactDigest: "8".repeat(64) };
  const pending = h.service.ensureProjection(nextBuild);
  deepStrictEqual(
    await h.service.queryReadOnly({ build, sparql: "ASK { ?s ?p ?o }" }),
    { form: "boolean", value: true },
  );
  equal((await h.service.status(nextBuild)).state, "loading");
  preparation.resolve();
  await pending;
});

Deno.test("reference preparation keeps complete build pins when two builds share A", async () => {
  const pins: BuildRef[] = [];
  const h = referenceHarness((input) => {
    pins.push(input);
    return Promise.resolve(preparedRef(input));
  });
  const historical = {
    ...build,
    sourceDigest: "7".repeat(64),
    buildKey: "8".repeat(64),
  };
  await Promise.all([
    h.service.ensureProjection(build),
    h.service.ensureProjection(historical),
  ]);
  deepStrictEqual(pins, [build, historical]);
  equal(h.loaded.size, 2);
  await h.service.release(build);
  equal((await h.service.status(historical)).state, "ready");
});

Deno.test("release waits for in-flight reference load and leaves no late ready state", async () => {
  const loading = referenceGate();
  const h = referenceHarness(
    (input) => Promise.resolve(preparedRef(input)),
    loading.promise,
  );
  const ensuring = h.service.ensureProjection(build);
  const releasing = h.service.release(build);
  loading.resolve();
  await Promise.all([ensuring, releasing]);
  equal((await h.service.status(build)).state, "absent");
  equal(h.loaded.size, 0);
});

class FakeNative implements NativeSemanticIndexPort {
  loaded = new Set<string>();
  loads = 0;
  queries: string[] = [];
  gate: (() => void) | undefined;
  load(input: { build: BuildRef }) {
    this.loads++;
    this.loaded.add(input.build.artifactDigest);
    return Promise.resolve({ quadCount: 1 });
  }
  async query(input: { sparql: string }): Promise<SemanticQueryResult> {
    this.queries.push(input.sparql);
    if (this.gate) await new Promise<void>((resolve) => this.gate = resolve);
    return { form: "boolean", value: true };
  }
  release(input: BuildRef) {
    this.loaded.delete(input.artifactDigest);
    return Promise.resolve();
  }
  isLoaded(input: BuildRef) {
    return Promise.resolve(this.loaded.has(input.artifactDigest));
  }
}

class FakeCache implements SemanticProjectionCache {
  store = new Map<string, Uint8Array>();
  leases = new Map<string, string>();
  puts = 0;
  key(kind: string, version: string, artifact: string) {
    return [kind, version, artifact].join(":");
  }
  hasProjection(kind: string, version: string, artifact: string) {
    return Promise.resolve(this.store.has(this.key(kind, version, artifact)));
  }
  getProjection(kind: string, version: string, artifact: string) {
    const bytes = this.store.get(this.key(kind, version, artifact));
    if (!bytes) {
      return Promise.reject(
        new BuildStoreError(
          "BUILD_BLOB_MISSING",
          {},
          "missing projection",
        ),
      );
    }
    return Promise.resolve(bytes);
  }
  async putProjection(
    kind: string,
    version: string,
    artifact: string,
    bytes: Uint8Array,
  ) {
    this.puts++;
    this.store.set(this.key(kind, version, artifact), bytes);
    return {
      stored: true,
      bytes: bytes.length,
      digest: await sha256(new TextDecoder().decode(bytes)),
    };
  }
  acquireLease(key: string, owner: string) {
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, owner);
    return Promise.resolve(true);
  }
  releaseLease(key: string, owner: string) {
    if (this.leases.get(key) === owner) this.leases.delete(key);
    return Promise.resolve();
  }
}

function harness(overrides: {
  native?: FakeNative;
  cache?: FakeCache;
  lyingProjector?: boolean;
  maxConcurrentQueries?: number;
  maxQueuedQueries?: number;
} = {}) {
  const native = overrides.native ?? new FakeNative();
  const cache = overrides.cache ?? new FakeCache();
  let sourceCalls = 0;
  let projectCalls = 0;
  const source: VerifiedBuildElementsSource = {
    verifiedElements() {
      sourceCalls++;
      return Promise.resolve({
        elements: [{ "@id": "el-1", "@type": "PartUsage" }],
        libraryNativeIds: [],
      });
    },
  };
  const projector: ModelRdfProjector = {
    kind: "rdf-quads",
    projectorVersion: "ase-rdf-quads-v1",
    async project(input) {
      projectCalls++;
      return {
        quads: new TextEncoder().encode(quadsText),
        projection: parseProjectionRef({
          kind: "rdf-quads",
          projectorVersion: await contextualProjectorVersion(
            "ase-rdf-quads-v1",
            input.build,
            input.libraryNativeIds,
          ),
          artifactDigest: input.build.artifactDigest,
          projectionDigest: overrides.lyingProjector
            ? digest("9")
            : await sha256(quadsText),
        }),
        quadCount: 1,
      };
    },
  };
  const service = new ModelSemanticIndexService({
    source,
    projector,
    cache,
    native,
    maxConcurrentQueries: overrides.maxConcurrentQueries,
    maxQueuedQueries: overrides.maxQueuedQueries,
    sleep: () => Promise.resolve(),
  });
  return {
    service,
    native,
    cache,
    counts: () => ({ sourceCalls, projectCalls }),
  };
}

Deno.test("ensure projects once, caches bytes and moves the ready pointer after load", async () => {
  const { service, native, cache, counts } = harness();
  const [first, second] = await Promise.all([
    service.ensureProjection(build),
    service.ensureProjection(build),
  ]);
  equal(first.state, "ready");
  deepStrictEqual(first, second); // coalesced
  equal(counts().projectCalls, 1);
  equal(cache.puts, 1);
  equal(native.loads, 1);
  equal((await service.ensureProjection(build)).state, "ready");
  equal(counts().projectCalls, 1); // still loaded: no work
  deepStrictEqual(
    await service.queryReadOnly({ build, sparql: "ASK {}" }),
    { form: "boolean", value: true },
  );
});

Deno.test("a warm cache verifies metadata; index loss reloads without reprojecting", async () => {
  const { service, native, cache, counts } = harness();
  await cache.putProjection(
    "rdf-quads",
    await contextualProjectorVersion("ase-rdf-quads-v1", build, []),
    build.artifactDigest,
    new TextEncoder().encode(quadsText),
  );
  equal((await service.ensureProjection(build)).state, "ready");
  equal(counts().projectCalls, 0);
  native.loaded.clear(); // simulate native process loss
  equal((await service.status(build)).state, "absent");
  equal((await service.ensureProjection(build)).state, "ready");
  equal(counts().projectCalls, 0);
  equal(native.loads, 2);
});

Deno.test("queries require a ready index and release returns to absent", async () => {
  const { service } = harness();
  await rejects(
    () => service.queryReadOnly({ build, sparql: "ASK {}" }),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_MISSING",
  );
  await service.ensureProjection(build);
  await service.release(build);
  equal((await service.status(build)).state, "absent");
});

Deno.test("a projector whose digest lies is refused as corrupt", async () => {
  const { service } = harness({ lyingProjector: true });
  await rejects(
    () => service.ensureProjection(build),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_CORRUPT",
  );
  equal((await service.status(build)).state, "failed");
});

Deno.test("query admission refuses updates, SERVICE and client datasets", () => {
  for (
    const refused of [
      "INSERT DATA { <a> <b> <c> }",
      "DELETE WHERE { ?s ?p ?o }",
      "LOAD <https://example.invalid/x>",
      "SELECT * WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } }",
      "SELECT * FROM <urn:ase:build:other> WHERE { ?s ?p ?o }",
      "SELECT * FROM NAMED <urn:x> WHERE { ?s ?p ?o }",
      "WITH <urn:x> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }",
      "",
    ]
  ) {
    throws(() => admitReadOnlySparql(refused));
  }
  for (
    const admitted of [
      "SELECT * WHERE { ?s ?p ?o } LIMIT 10",
      "PREFIX ex: <urn:ex:> SELECT * WHERE { ?s ex:service ?from }",
      'ASK { ?s ?p "DELETE SERVICE FROM" }',
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
      "DESCRIBE <urn:ase:model:r:el-1>",
    ]
  ) {
    admitReadOnlySparql(admitted);
  }
});

Deno.test("query limits clamp to hard bounds and reject nonsense", () => {
  deepStrictEqual(
    effectiveQueryLimits({
      maxResults: HARD_QUERY_LIMITS.maxResults * 2,
      maxBytes: HARD_QUERY_LIMITS.maxBytes * 2,
      timeoutMs: HARD_QUERY_LIMITS.timeoutMs * 2,
    }),
    { ...HARD_QUERY_LIMITS },
  );
  throws(() => effectiveQueryLimits({ maxResults: 0 }));
  throws(() => effectiveQueryLimits({ timeoutMs: 1.5 }));
});

Deno.test("query concurrency is bounded with a bounded queue", async () => {
  const { service, native } = harness({
    maxConcurrentQueries: 1,
    maxQueuedQueries: 1,
  });
  await service.ensureProjection(build);
  native.gate = () => {};
  const first = service.queryReadOnly({ build, sparql: "ASK {}" });
  const second = service.queryReadOnly({ build, sparql: "ASK {}" });
  await rejects(
    () => service.queryReadOnly({ build, sparql: "ASK {}" }),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_BUSY",
  );
  native.gate!(); // release first; second then runs and re-arms the gate
  native.gate = undefined;
  deepStrictEqual(await first, { form: "boolean", value: true });
  // The second query re-armed the gate; release whatever is pending.
  (native as unknown as { gate?: () => void }).gate?.();
  deepStrictEqual(await second, { form: "boolean", value: true });
});

Deno.test("invalid concurrency, queue and lease options fail before work", () => {
  const { native } = harness();
  const options = {
    native,
    source: {
      verifiedElements: () =>
        Promise.resolve({ elements: [], libraryNativeIds: [] }),
    },
    projector: new DeterministicRdfModelProjector(),
  };
  for (
    const option of [
      { maxConcurrentQueries: 0 },
      { maxConcurrentQueries: NaN },
      { maxConcurrentQueries: 1.5 },
      { maxQueuedQueries: -1 },
      { maxQueuedQueries: Infinity },
      { leaseTtlMs: 0 },
      { leaseOwner: " " },
    ]
  ) {
    throws(
      () => new ModelSemanticIndexService({ ...options, ...option }),
      SemanticIndexError,
    );
  }
});

Deno.test("queue time counts against total deadline and expired entries never execute", async () => {
  const { service, native } = harness({
    maxConcurrentQueries: 1,
    maxQueuedQueries: 1,
  });
  await service.ensureProjection(build);
  native.gate = () => {};
  const first = service.queryReadOnly({
    build,
    sparql: "ASK {}",
    limits: { timeoutMs: 500 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = service.queryReadOnly({
    build,
    sparql: "ASK { ?s ?p ?o }",
    limits: { timeoutMs: 10 },
  });
  await rejects(
    second,
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
  );
  equal(native.queries.length, 1);
  const third = service.queryReadOnly({
    build,
    sparql: "ASK { ?a ?b ?c }",
    limits: { timeoutMs: 500 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  native.gate!();
  native.gate = undefined;
  await first;
  await third;
  deepStrictEqual(native.queries, ["ASK {}", "ASK { ?a ?b ?c }"]);
});

Deno.test("executing timeout retains slot until native operation settles", async () => {
  const { service, native } = harness({
    maxConcurrentQueries: 1,
    maxQueuedQueries: 0,
  });
  await service.ensureProjection(build);
  native.gate = () => {};
  await rejects(
    service.queryReadOnly({
      build,
      sparql: "ASK {}",
      limits: { timeoutMs: 10 },
    }),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
  );
  await rejects(
    service.queryReadOnly({ build, sparql: "ASK {}" }),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_BUSY",
  );
  native.gate!();
  native.gate = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.queryReadOnly({ build, sparql: "ASK {}" });
});

Deno.test("native receives only the remaining total query budget", async () => {
  const { service, native } = harness({ maxConcurrentQueries: 1 });
  await service.ensureProjection(build);
  const remaining: number[] = [];
  let finish!: () => void;
  native.query = async (
    input: { sparql: string; limits?: { timeoutMs: number } },
  ) => {
    remaining.push(input.limits!.timeoutMs);
    if (remaining.length === 1) {
      await new Promise<void>((resolve) => finish = resolve);
    }
    return { form: "boolean", value: true };
  };
  const first = service.queryReadOnly({ build, sparql: "ASK {}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = service.queryReadOnly({
    build,
    sparql: "ASK {}",
    limits: { timeoutMs: 500 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish();
  await first;
  await second;
  equal(remaining[1]! < 500, true);
  equal(remaining[1]! > 0, true);
});

Deno.test("release waits for inflight load and does not resurrect ready", async () => {
  const { service, native } = harness();
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => started = resolve);
  native.load = async (input: { build: BuildRef }) => {
    started();
    await new Promise<void>((resolve) => finish = resolve);
    native.loaded.add(input.build.artifactDigest);
    return { quadCount: 1 };
  };
  const loading = service.ensureProjection(build);
  await entered;
  const released = service.release(build);
  finish();
  await loading;
  await released;
  equal((await service.status(build)).state, "absent");
  equal(native.loaded.size, 0);
});

Deno.test("release removes queued queries without executing them", async () => {
  const { service, native } = harness({ maxConcurrentQueries: 1 });
  await service.ensureProjection(build);
  native.gate = () => {};
  const first = service.queryReadOnly({ build, sparql: "ASK {}" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = service.queryReadOnly({ build, sparql: "ASK { ?s ?p ?o }" });
  const rejected = rejects(
    queued,
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_MISSING",
  );
  await service.release(build);
  await rejected;
  native.gate!();
  native.gate = undefined;
  await first;
  equal(native.queries.length, 1);
});

Deno.test("same A in two repositories and library classifications has separate cache bytes", async () => {
  const cache = new FakeCache();
  const projector = new DeterministicRdfModelProjector();
  const loaded: string[] = [];
  const native = new FakeNative();
  native.load = (input: { build: BuildRef; quads?: Uint8Array }) => {
    loaded.push(new TextDecoder().decode(input.quads));
    return Promise.resolve({ quadCount: 1 });
  };
  let libraryNativeIds: string[] = [];
  let projections = 0;
  let reads = 0;
  const service = new ModelSemanticIndexService({
    cache,
    native,
    source: {
      verifiedElements: () => {
        reads++;
        return Promise.resolve({
          elements: [{ "@id": "el-1", "@type": "PartUsage" }],
          libraryNativeIds,
        });
      },
    },
    projector: {
      ...projector,
      kind: projector.kind,
      projectorVersion: projector.projectorVersion,
      project: (input) => {
        projections++;
        return projector.project(input);
      },
    },
  });
  const other = { ...build, repositoryId: "repo-two" };
  await service.ensureProjection(build);
  await service.ensureProjection(other);
  equal(cache.puts, 2);
  equal(loaded[0]!.includes("urn:ase:model:repo-one:"), true);
  equal(loaded[1]!.includes("urn:ase:model:repo-two:"), true);
  await service.release(build);
  await service.ensureProjection(build);
  equal(projections, 2); // actual service cache hit after release
  equal(reads, 3); // verify deterministic metadata even for a warm cache
  libraryNativeIds = ["el-1"];
  await service.release(build);
  await service.ensureProjection(build);
  equal(cache.puts, 3);
  equal(loaded[3]!.includes("urn:ase:library:el-1"), true);
});

Deno.test("prefixed names containing reserved words stay whole while bare clauses remain refused", () => {
  for (
    const name of [
      "ex:foo.FROM",
      "ex:foo:FROM",
      ":FROM",
      "ex:foo.SERVICE",
      "ex:foo:DELETE",
      ":INSERT",
      "ex:foo%2EFROM",
      "ex:foo\\.FROM",
    ]
  ) {
    const query =
      `PREFIX ex: <urn:ex:> PREFIX : <urn:default:> SELECT * WHERE { ?s ${name} ?o }`;
    admitReadOnlySparql(query);
    for (
      const clause of [
        "SERVICE <https://example.invalid> {?a ?b ?c}",
        "INSERT DATA {<a> <b> <c>}",
      ]
    ) {
      throws(
        () => admitReadOnlySparql(`${query.slice(0, -1)} ${clause} }`),
        SemanticIndexError,
      );
    }
  }
  for (
    const query of [
      "PREFIX ex: <urn:ex:> SELECT * FROM <urn:other> WHERE { ?s ex:foo.FROM ?o }",
      "PREFIX : <urn:default:> DELETE WHERE { ?s :FROM ?o }",
      "PREFIX ex: <urn:ex:> SELECT * WHERE { ?s ex:foo.FROM ?o. SERVICE <https://example.invalid> { ?a ?b ?c } }",
    ]
  ) throws(() => admitReadOnlySparql(query), SemanticIndexError);
  throws(
    () =>
      admitReadOnlySparql("CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}", [
        "SELECT",
        "ASK",
      ]),
    (error: unknown) => {
      equal((error as Error).message, "Only SELECT, ASK are admitted");
      equal(
        (error as SemanticIndexError).recovery.includes("CONSTRUCT"),
        false,
      );
      equal((error as SemanticIndexError).recovery.includes("DESCRIBE"), false);
      return true;
    },
  );
});
