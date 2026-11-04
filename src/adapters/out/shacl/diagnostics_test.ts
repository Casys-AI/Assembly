import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  lintModelDiagnostics,
  type ModelDiagnosticFacts,
} from "../../../domain/model/policies/diagnostics.ts";
import {
  buildElementIri,
  type BuildRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  compareDiagnostics,
  ModelShapesError,
} from "../../../application/model/diagnostics/shapes.ts";
import { SemanticIndexError } from "../../../application/model/semantic/index-service.ts";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import type {
  ShaclGraphRead,
  ValidateShaclShapesInput,
} from "../../../application/model/diagnostics/queries/inputs.ts";
import {
  createNativeShaclEngine,
  FACTS_VOCAB,
  mapShaclResults,
  type ShaclEngine,
  type ShaclEngineInput,
  ShaclModelDiagnostics,
} from "./diagnostics.ts";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};
const shapes = "# test shapes bytes\n";
const facts: ModelDiagnosticFacts = {
  units: [
    {
      location: {
        elementId: "sys",
        qualifiedName: "Sys",
        source: { file: "model.sysml", line: 1, column: 1 },
      },
      kind: "conversation",
      hasInvocationBudget: false, // LOOP_WITHOUT_BUDGET (positive)
      accountableHumanDeclared: true,
    },
    {
      location: { elementId: "plan", qualifiedName: "Sys::plan" },
      kind: "plan",
      hasInvocationBudget: true, // negative
      accountableHumanDeclared: true,
    },
  ],
  effects: [],
  networkCapabilities: [
    {
      location: { elementId: "policy", qualifiedName: "Sys::policy" },
      allowedHosts: ["b.example", "a.example", "a.example"],
      mandateHosts: ["a.example"], // outside: b.example (positive)
    },
    {
      location: { elementId: "policy-ok" },
      allowedHosts: ["a.example"],
      mandateHosts: ["a.example", "c.example"], // negative
    },
  ],
};
const cleanFacts: ModelDiagnosticFacts = {
  units: [{
    location: { elementId: "sys" },
    kind: "conversation",
    hasInvocationBudget: true,
    accountableHumanDeclared: true,
  }],
  effects: [],
  networkCapabilities: [{
    location: { elementId: "policy" },
    allowedHosts: ["a.example"],
    mandateHosts: ["a.example"],
  }],
};

const graph: ShaclGraphRead = {
  build,
  projection: {
    kind: "rdf-quads",
    projectorVersion: `ase-rdf-quads-v4:${digest("6")}`,
    artifactDigest: build.artifactDigest,
    projectionDigest: digest("5"),
  },
  query: () =>
    Promise.reject(new Error("Canned mapping engine must not query")),
};
const context = {
  units: [
    { elementId: "sys", kind: "conversation" as const, ownerSystemId: "sys" },
    {
      elementId: "plan",
      kind: "plan" as const,
      ownerSystemId: "sys",
    },
  ],
  capabilities: [{
    policyElementId: "policy",
    ownerSystemId: "sys",
    allowedHostsAttributeId: "policy-hosts",
    networkHostsAttributeId: "sys-hosts",
  }, {
    policyElementId: "policy-ok",
    ownerSystemId: "sys",
    allowedHostsAttributeId: "policy-ok-hosts",
    networkHostsAttributeId: "sys-hosts",
  }],
};
Object.assign(facts, { graphContext: context });
Object.assign(cleanFacts, {
  graphContext: {
    units: [{
      elementId: "sys",
      kind: "conversation",
      ownerSystemId: "sys",
      budgetPolicyId: "budget",
    }],
    capabilities: [{
      policyElementId: "policy",
      ownerSystemId: "sys",
      allowedHostsAttributeId: "policy-hosts",
      networkHostsAttributeId: "sys-hosts",
    }],
  },
});
const iri = (nativeId: string, ref = build) =>
  buildElementIri({ build: ref, nativeId }, "user");

/** A mapping double. Native evaluation is qualified separately; no computed
 * verdict or host-set difference is passed to the real engine. */
function cannedEngine(extraResults = false): ShaclEngine & { calls: number } {
  const engine = {
    engineId: "assembly-native-shacl-sparql",
    engineVersion: "1.0.0",
    calls: 0,
    validate(input: ShaclEngineInput) {
      engine.calls++;
      const results = [];
      if (input.units.some((u) => !u.budgetPolicy)) {
        results.push({
          focusNode: iri("sys", input.graph.build),
          path: `${FACTS_VOCAB}hasInvocationBudget`,
        });
      }
      if (input.capabilities.length > 1) {
        results.push({
          focusNode: iri("policy", input.graph.build),
          ownerSystem: iri("sys", input.graph.build),
          path: `${FACTS_VOCAB}outsideHost`,
          value: "b.example",
        });
      }
      if (extraResults) {
        results.push({
          focusNode: iri("sys", input.graph.build),
          path: `${FACTS_VOCAB}unknownProperty`,
        });
      }
      return Promise.resolve({ conforms: results.length === 0, results });
    },
  };
  return engine;
}

function memoryCache() {
  // Mirror the real KvModelBuildStore segment contract on both reads
  // and writes: the fake must reject oversized projector versions too.
  const validateSegments = (kind: string, version: string) => {
    for (
      const [name, value] of [["kind", kind], ["projectorVersion", version]]
    ) {
      if (!value || value.length > 128) {
        throw new BuildStoreError("BUILD_STORE_INVALID_INPUT", {
          [name]: value,
        }, "Expected 1-128 characters");
      }
    }
  };
  const store = new Map<string, Uint8Array>();
  return {
    store,
    getProjection(kind: string, version: string, artifact: string) {
      validateSegments(kind, version);
      const bytes = store.get([kind, version, artifact].join(":"));
      if (!bytes) {
        return Promise.reject(
          new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
        );
      }
      return Promise.resolve(bytes);
    },
    putProjection(
      kind: string,
      version: string,
      artifact: string,
      bytes: Uint8Array,
    ) {
      validateSegments(kind, version);
      const key = [kind, version, artifact].join(":");
      const existing = store.get(key);
      if (
        existing &&
        (existing.length !== bytes.length ||
          existing.some((byte, index) => byte !== bytes[index]))
      ) {
        return Promise.reject(
          new BuildStoreError(
            "BUILD_BLOB_CONFLICT",
            {},
            "immutable projection",
          ),
        );
      }
      store.set(key, bytes);
      return Promise.resolve({
        stored: true,
        bytes: bytes.length,
        digest: digest("0"),
      });
    },
  };
}

const CODES = ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"];

Deno.test("SHACL-mapped diagnostics equal the TS lint on positives and negatives", async () => {
  const service = new ShaclModelDiagnostics({
    engine: cannedEngine(),
    loadShapes: () => Promise.resolve(shapes),
  });
  const report = await service.validateBuild({ graph, build, facts });
  equal(report.conforms, false);
  const comparison = compareDiagnostics({
    shacl: report.diagnostics,
    reference: lintModelDiagnostics(facts),
    codes: CODES,
  });
  deepStrictEqual(
    {
      equal: comparison.equal,
      matched: comparison.matched,
      onlyShacl: comparison.onlyShacl.length,
      onlyReference: comparison.onlyReference.length,
      mismatched: comparison.mismatched,
    },
    { equal: true, matched: 2, onlyShacl: 0, onlyReference: 0, mismatched: [] },
  );
  // Negative-only facts: no findings from either side for these codes.
  const clean = await service.validateBuild({
    graph,
    build,
    facts: cleanFacts,
  });
  equal(clean.conforms, true);
  deepStrictEqual([...clean.diagnostics], []);
  equal(
    compareDiagnostics({
      shacl: clean.diagnostics,
      reference: lintModelDiagnostics(cleanFacts),
      codes: CODES,
    }).equal,
    true,
  );
  // Reports are immutable values, masks nowhere inside.
  equal(Object.isFrozen(report), true);
  equal("masked" in report, false);
});

Deno.test("reports are cached by full identity; unmapped results are counted or refused", async () => {
  const engine = cannedEngine(true);
  const cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
    cache,
  });
  const first = await service.validateBuild({ graph, build, facts });
  equal(first.unmappedResults, 1);
  equal(engine.calls, 1);
  const second = await service.validateBuild({ graph, build, facts });
  equal(engine.calls, 1); // identity hit: engine not re-run
  deepStrictEqual(second.identity, first.identity);
  // New shapes bytes → new identity → engine runs again.
  const reshaped = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(`${shapes}# v2\n`),
    cache,
  });
  const third = await reshaped.validateBuild({ graph, build, facts });
  equal(engine.calls, 2);
  equal(third.identity.shapesDigest === first.identity.shapesDigest, false);
  await rejects(
    () =>
      service.validateBuild({
        graph,
        build,
        facts,
        options: { strictUnmapped: true },
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "ModelShapesError",
  );
});

Deno.test("corrupt cached reports fail loudly without a partial report or recomputation", async () => {
  const engine = cannedEngine();
  const cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
    cache,
  });
  await service.validateBuild({ graph, build, facts });
  const key = [...cache.store.keys()][0]!;
  const original = cache.store.get(key)!;
  const tampered = JSON.parse(new TextDecoder().decode(original));
  tampered.conforms = "yes";
  tampered.diagnostics[0].severity = "critical";
  for (
    const bytes of [
      new TextEncoder().encode(JSON.stringify(tampered)),
      new TextEncoder().encode("{not json"),
      new TextEncoder().encode(
        JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(original)),
          conforms: false,
          diagnostics: [],
          unmappedResults: 0,
        }),
      ),
      new TextEncoder().encode(
        JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(original)),
          conforms: true,
        }),
      ),
    ]
  ) {
    cache.store.set(key, bytes);
    await rejects(() => service.validateBuild({ graph, build, facts }), {
      code: "SHACL_VALIDATION_FAILED",
    });
    equal(engine.calls, 1);
  }
});

Deno.test("cache key covers facts and repository, not only A", async () => {
  const engine = cannedEngine();
  const cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
    cache,
  });
  await service.validateBuild({ graph, build, facts });
  equal(engine.calls, 1);
  await service.validateBuild({ graph, build, facts }); // identical: hit
  equal(engine.calls, 1);
  // Same A, different facts: no stale hit.
  const clean = await service.validateBuild({
    graph,
    build,
    facts: cleanFacts,
  });
  equal(engine.calls, 2);
  equal(clean.conforms, true);
  // Same A and facts, another repository: no cross-repository hit.
  await service.validateBuild({
    build: { ...build, repositoryId: "repo-two" },
    graph: { ...graph, build: { ...build, repositoryId: "repo-two" } },
    facts,
  });
  equal(engine.calls, 3);
});

Deno.test("SHACL cache versions fit W2 bounds and hash all contextual identity fields", async () => {
  const cache = memoryCache();
  const engine = cannedEngine();
  const longRepository = "repository-" + "r".repeat(240);
  const longBuild = { ...build, repositoryId: longRepository };
  const service = new ShaclModelDiagnostics({
    engine,
    cache,
    loadShapes: () => Promise.resolve(shapes),
  });
  const report = await service.validateBuild({
    build: longBuild,
    graph: { ...graph, build: longBuild },
    facts: cleanFacts,
  });
  await service.validateBuild({
    build: longBuild,
    graph: { ...graph, build: longBuild },
    facts: cleanFacts,
  });
  equal(engine.calls, 1);
  equal(report.build.repositoryId, longRepository);
  equal(report.identity.engineId, engine.engineId);
  const key = [...cache.store.keys()][0]!;
  equal(/^shacl-report:shacl-v2:[0-9a-f]{64}:[0-9a-f]{64}$/.test(key), true);
  const versions = new Set<string>();
  for (
    const variant of [
      {
        engine: { ...engine, engineId: "other-engine" },
        loadShapes: () => Promise.resolve(shapes),
      },
      {
        engine: { ...engine, engineVersion: "0.6.1" },
        loadShapes: () => Promise.resolve(shapes),
      },
      { engine, loadShapes: () => Promise.resolve(shapes + "# changed\n") },
    ]
  ) {
    await new ShaclModelDiagnostics({ ...variant, cache }).validateBuild({
      build: longBuild,
      graph: { ...graph, build: longBuild },
      facts: cleanFacts,
    });
  }
  await service.validateBuild({
    build: longBuild,
    graph: { ...graph, build: longBuild },
    facts: cleanFacts,
    options: { strictUnmapped: true },
  });
  for (const storedKey of cache.store.keys()) versions.add(storedKey);
  equal(versions.size, 5); // base + engine ID + engine version + shapes + options
});

Deno.test("immutable cache rejects different bytes in the same projection slot", async () => {
  const cache = memoryCache();
  const bytes = new Uint8Array([1, 2]);
  await cache.putProjection(
    "shacl-report",
    "version",
    build.artifactDigest,
    bytes,
  );
  await cache.putProjection(
    "shacl-report",
    "version",
    build.artifactDigest,
    bytes.slice(),
  );
  await rejects(
    () =>
      cache.putProjection(
        "shacl-report",
        "version",
        build.artifactDigest,
        new Uint8Array([1, 3]),
      ),
    (error: unknown) =>
      error instanceof BuildStoreError && error.code === "BUILD_BLOB_CONFLICT",
  );
  deepStrictEqual(
    await cache.getProjection("shacl-report", "version", build.artifactDigest),
    bytes,
  );
});

for (const field of ["sourceDigest", "recipeDigest", "buildKey"] as const) {
  Deno.test(`SHACL immutable cache separates builds differing only in ${field}`, async () => {
    const cache = memoryCache();
    const engine = cannedEngine();
    const service = new ShaclModelDiagnostics({
      engine,
      cache,
      loadShapes: () => Promise.resolve(shapes),
    });
    const first = await service.validateBuild({ graph, build, facts });
    const variant = { ...build, [field]: digest("a") };
    const changed = await service.validateBuild({
      build: variant,
      graph: { ...graph, build: variant },
      facts,
    });
    deepStrictEqual(changed.build, variant);
    deepStrictEqual(changed.identity, first.identity);
    equal(engine.calls, 2);
    equal(cache.store.size, 2);
    for (const expectedBuild of [build, variant]) {
      const hit = await service.validateBuild({
        build: expectedBuild,
        graph: { ...graph, build: expectedBuild },
        facts,
      });
      deepStrictEqual(hit.build, expectedBuild);
    }
    equal(engine.calls, 2);
  });
}

Deno.test("cache fake enforces the 128-character version boundary on reads and writes", async () => {
  const cache = memoryCache();
  const version = "v".repeat(128);
  const bytes = new Uint8Array([1]);
  await cache.putProjection(
    "shacl-report",
    version,
    build.artifactDigest,
    bytes,
  );
  deepStrictEqual(
    await cache.getProjection("shacl-report", version, build.artifactDigest),
    bytes,
  );
  for (const invalid of ["", "v".repeat(129)]) {
    await rejects(
      async () =>
        await cache.getProjection(
          "shacl-report",
          invalid,
          build.artifactDigest,
        ),
      (error: unknown) =>
        error instanceof BuildStoreError &&
        error.code === "BUILD_STORE_INVALID_INPUT",
    );
    await rejects(
      async () =>
        await cache.putProjection(
          "shacl-report",
          invalid,
          build.artifactDigest,
          bytes,
        ),
      (error: unknown) =>
        error instanceof BuildStoreError &&
        error.code === "BUILD_STORE_INVALID_INPUT",
    );
  }
});

const parameterizedShapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix f: <urn:ase:facts:> .
f:LoopWithoutBudgetShape a sh:NodeShape; sh:severity sh:Warning;
 sh:sparql [sh:message "LOOP_WITHOUT_BUDGET"; sh:select "SELECT ?this ?ownerSystem WHERE {}"].
f:CapabilityBeyondMandateShape a sh:NodeShape; sh:severity sh:Warning;
 sh:sparql [sh:message "CAPABILITY_BEYOND_MANDATE"; sh:select "SELECT ?this ?ownerSystem ?value WHERE { FILTER(false) }"].
`;

Deno.test("native engine runs one constraint per association group and deduplicates findings", async () => {
  const engine = await createNativeShaclEngine();
  let queries = 0;
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(parameterizedShapes),
  });
  const report = await service.validateBuild({
    build,
    facts,
    graph: {
      ...graph,
      query(sparql) {
        queries++;
        equal(sparql.includes("hasInvocationBudget"), false);
        equal(sparql.includes("outsideHosts"), false);
        const row = {
          this: { kind: "iri" as const, value: iri("sys") },
          ownerSystem: { kind: "iri" as const, value: iri("sys") },
        };
        return Promise.resolve({
          form: "solutions",
          variables: ["this", "ownerSystem"],
          rows: queries === 2 ? [row, row] : [],
          truncated: false,
        });
      },
    },
  });
  equal(queries, 3); // one provenance read and exactly two constraint SELECTs
  equal(report.diagnostics.length, 1);
  equal(report.diagnostics[0]!.elementId, "sys");
});

Deno.test("missing or malformed provenance is refused before querying or caching", async () => {
  const engine = cannedEngine();
  const cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    cache,
    loadShapes: () => Promise.resolve(shapes),
  });
  const variants = [
    { ...facts, graphContext: undefined },
    { ...facts, graphContext: { units: [], capabilities: [] } },
    {
      ...facts,
      graphContext: {
        ...context,
        capabilities: [{ policyElementId: "policy", ownerSystemId: "sys" }],
      },
    },
    {
      ...facts,
      graphContext: {
        ...context,
        units: [{
          elementId: "sys",
          kind: "conversation",
          ownerSystemId: "foreign",
        }],
      },
    },
    { ...facts, graphContext: { ...context, units: [null] } },
  ];
  for (const variant of variants) {
    await rejects(() =>
      service.validateBuild({
        build,
        graph,
        facts: variant as ModelDiagnosticFacts,
      }), { code: "SHAPES_INVALID_INPUT" });
  }
  await rejects(
    () => service.validateBuild({ build, facts } as ValidateShaclShapesInput),
    {
      code: "SHAPES_INVALID_INPUT",
    },
  );
  equal(engine.calls, 0);
  equal(cache.store.size, 0);
});

Deno.test("native failures and truncated focus or constraint results never cache success", async () => {
  const engine = await createNativeShaclEngine();
  for (const failedAt of [1, 2, 3]) {
    for (const mode of ["truncated", "failure", "scope"] as const) {
      let calls = 0;
      const cache = memoryCache();
      const service = new ShaclModelDiagnostics({
        engine,
        cache,
        loadShapes: () => Promise.resolve(parameterizedShapes),
      });
      await rejects(
        () =>
          service.validateBuild({
            build,
            facts,
            graph: {
              ...graph,
              query() {
                calls++;
                if (calls === failedAt && mode === "failure") {
                  return Promise.reject(new Error("native deadline exceeded"));
                }
                return Promise.resolve({
                  form: "solutions",
                  variables: ["this"],
                  rows: calls === failedAt && mode === "scope"
                    ? [{ this: { kind: "iri", value: "urn:foreign" } }]
                    : [],
                  truncated: calls === failedAt && mode === "truncated",
                });
              },
            },
          }),
        { code: "SHACL_VALIDATION_FAILED" },
      );
      equal(cache.store.size, 0);
      equal(calls, failedAt);
    }
  }
});

Deno.test("native timeout retains its structured internal cause without caching a report", async () => {
  const cache = memoryCache();
  const timeout = new SemanticIndexError(
    "INDEX_TIMEOUT",
    { timeoutMs: 5000, operation: "query" },
    "Native query deadline exceeded",
  );
  const service = new ShaclModelDiagnostics({
    engine: await createNativeShaclEngine(),
    cache,
    loadShapes: () => Promise.resolve(parameterizedShapes),
  });
  await rejects(
    () =>
      service.validateBuild({
        build,
        facts,
        graph: { ...graph, query: () => Promise.reject(timeout) },
      }),
    (error: unknown) => {
      if (!(error instanceof ModelShapesError)) return false;
      equal(error.code, "SHACL_VALIDATION_FAILED");
      equal(error.cause, timeout);
      deepStrictEqual(error.context.cause, {
        code: timeout.code,
        context: timeout.context,
        recovery: timeout.recovery,
      });
      equal(
        error.recovery,
        new ModelShapesError(
          "SHACL_VALIDATION_FAILED",
          {},
          "",
        ).recovery,
      );
      return true;
    },
  );
  equal(cache.store.size, 0);
});

Deno.test("unsupported constraint and shape forms fail before native reads", async () => {
  const service = new ShaclModelDiagnostics({
    engine: await createNativeShaclEngine(),
    loadShapes: () =>
      Promise.resolve(
        parameterizedShapes.replace(
          "SELECT ?this ?ownerSystem WHERE {}",
          "SELECT * WHERE {}",
        ),
      ),
  });
  await rejects(() => service.validateBuild({ graph, build, facts }), {
    code: "SHACL_VALIDATION_FAILED",
  });
});

Deno.test("different full projections separate immutable reports", async () => {
  const engine = cannedEngine(), cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    cache,
    loadShapes: () => Promise.resolve(shapes),
  });
  await service.validateBuild({ graph, build, facts });
  await service.validateBuild({
    graph: {
      ...graph,
      projection: { ...graph.projection!, projectionDigest: digest("6") },
    },
    build,
    facts,
  });
  equal(engine.calls, 2);
  equal(cache.store.size, 2);
});

Deno.test("identical outside hosts retain one finding per policy owner and collapse repeated rows", () => {
  const capability = {
    location: { elementId: "policy" },
    allowedHosts: ["outside.example"],
    mandateHosts: [],
  };
  const owners = ["urn:owner-a", "urn:owner-b"];
  const rows = owners.flatMap((ownerSystem) =>
    Array.from(
      { length: 2 },
      () => ({
        focusNode: "urn:policy",
        ownerSystem,
        path: `${FACTS_VOCAB}outsideHost`,
        value: "outside.example",
      }),
    )
  );
  const mapped = mapShaclResults({
    results: rows,
    projected: {
      units: [],
      capabilities: owners.map((ownerSystem) => ({
        node: "urn:policy",
        ownerSystem,
        capability,
      })),
    },
  });
  equal(mapped.unmappedResults, 0);
  equal(mapped.diagnostics.length, 2);
  deepStrictEqual(
    mapped.diagnostics,
    lintModelDiagnostics({
      units: [],
      effects: [],
      networkCapabilities: owners.map(() => capability),
    }),
  );
});

Deno.test("incompatible model projection kinds and versions fail before the engine runs", async () => {
  const engine = cannedEngine();
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
  });
  for (
    const projection of [
      { ...graph.projection!, kind: "other" },
      {
        ...graph.projection!,
        projectorVersion: `ase-rdf-quads-v2:${digest("6")}`,
      },
      {
        ...graph.projection!,
        projectorVersion: `ase-rdf-quads-v3:${digest("6")}`,
      },
      { ...graph.projection!, projectorVersion: "ase-rdf-quads-v4" },
      { ...graph.projection!, projectorVersion: "ase-rdf-quads-v4:" },
      {
        ...graph.projection!,
        projectorVersion: `ase-rdf-quads-v4:${"a".repeat(63)}`,
      },
      {
        ...graph.projection!,
        projectorVersion: `ase-rdf-quads-v4:${"A".repeat(64)}`,
      },
      {
        ...graph.projection!,
        projectorVersion: `ase-rdf-quads-v4:${digest("6")}:extra`,
      },
    ]
  ) {
    await rejects(
      () =>
        service.validateBuild({
          build,
          facts,
          graph: { ...graph, projection },
        }),
      { code: "SHAPES_INVALID_INPUT" },
    );
  }
  equal(engine.calls, 0);
  await service.validateBuild({ build, facts, graph });
  equal(engine.calls, 1);
});

Deno.test("SHACL metadata rejects literal impostors for RDF identities", async () => {
  const engine = await createNativeShaclEngine();
  const variants = [
    parameterizedShapes.replace(
      "a sh:NodeShape",
      'a "http://www.w3.org/ns/shacl#NodeShape"',
    ),
    parameterizedShapes.replace(
      "sh:severity sh:Warning",
      'sh:severity "http://www.w3.org/ns/shacl#Warning"',
    ),
    parameterizedShapes.replace(
      'sh:sparql [sh:message "LOOP_WITHOUT_BUDGET"; sh:select "SELECT ?this ?ownerSystem WHERE {}"]',
      'sh:sparql "urn:constraint" . <urn:constraint> sh:message "LOOP_WITHOUT_BUDGET"; sh:select "SELECT ?this ?ownerSystem WHERE {}"',
    ),
    parameterizedShapes.replace(
      '"LOOP_WITHOUT_BUDGET"',
      '"LOOP_WITHOUT_BUDGET"@en',
    ),
  ];
  for (const shapesTurtle of variants) {
    await rejects(() =>
      engine.validate({
        graph,
        shapesTurtle,
        units: [{ this: iri("sys"), ownerSystem: iri("sys") }],
        capabilities: [],
      }), { code: "SHACL_VALIDATION_FAILED" });
  }
});

Deno.test("parser loading failures return a coded unavailable engine error with cause", async () => {
  await rejects(
    () =>
      createNativeShaclEngine(() =>
        Promise.reject(new Error("module unavailable"))
      ),
    (error: unknown) => {
      const value = error as { code: string; context: Record<string, unknown> };
      equal(value.code, "SHACL_ENGINE_UNAVAILABLE");
      equal(value.context.cause, "module unavailable");
      equal(value.context.specifier, "npm:@rdfjs/parser-n3@2.1.0");
      return true;
    },
  );
});

Deno.test("generated query byte budget bounds focus and constraint groups before dispatch", async () => {
  const engine = await createNativeShaclEngine();
  for (const unique of [true, false]) {
    let calls = 0;
    const units = Array.from(
      { length: 2000 },
      (_, i) => ({
        this: `urn:unit:${unique ? i : 0}:${"é".repeat(30)}`,
        ownerSystem: "urn:owner",
      }),
    );
    await rejects(
      () =>
        engine.validate({
          shapesTurtle: parameterizedShapes,
          units,
          capabilities: [],
          graph: {
            ...graph,
            query() {
              calls++;
              return Promise.resolve({
                form: "solutions",
                variables: [],
                rows: [],
                truncated: false,
              });
            },
          },
        }),
      (error: unknown) => {
        const value = error as {
          code: string;
          context: Record<string, unknown>;
        };
        equal(value.code, "SHACL_VALIDATION_FAILED");
        equal(value.context.maxQueryBytes, 65536);
        equal(Number(value.context.queryBytes) > 65536, true);
        equal(typeof value.context.recovery, "string");
        return true;
      },
    );
    equal(calls, unique ? 0 : 1);
  }
});
