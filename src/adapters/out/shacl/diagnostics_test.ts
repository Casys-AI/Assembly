import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  lintModelDiagnostics,
  type ModelDiagnosticFacts,
} from "../../../domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../../domain/model/value-objects/element-ref.ts";
import { compareDiagnostics } from "../../../application/model/diagnostics/shapes.ts";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import { parseNQuads } from "../oxigraph/rdf.ts";
import {
  FACTS_VOCAB,
  projectDiagnosticFacts,
  type ShaclEngine,
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

Deno.test("facts projection publishes budgets and computed outside hosts", () => {
  const projected = projectDiagnosticFacts(facts, build);
  const quads = parseNQuads(projected.ntriples);
  const sys = projected.units[0]!.node;
  const budget = quads.find((quad) =>
    quad.subject.kind === "iri" && quad.subject.value === sys &&
    quad.predicate === `${FACTS_VOCAB}hasInvocationBudget`
  );
  equal(budget?.object.kind === "literal" && budget.object.value, "false");
  const outside = quads.filter((quad) =>
    quad.predicate === `${FACTS_VOCAB}outsideHost`
  );
  equal(outside.length, 1);
  equal(
    outside[0]?.object.kind === "literal" && outside[0].object.value,
    "b.example",
  );
  deepStrictEqual(
    [...projected.capabilities[0]!.outsideHosts],
    ["b.example"],
  );
});

/** Canned engine double: the results a SHACL Core engine returns for the
 * two versioned shapes on the projected facts above. Mapping — not an
 * engine reimplementation — is what these tests prove; the real engine
 * is exercised by the gated integration test. */
function cannedEngine(extraResults = false): ShaclEngine & { calls: number } {
  const engine = {
    engineId: "rdf-validate-shacl",
    engineVersion: "0.6.0",
    calls: 0,
    validate(input: { dataNTriples: string }) {
      engine.calls++;
      const results = [];
      if (input.dataNTriples.includes(`"false"^^`)) {
        results.push({
          focusNode: projectDiagnosticFacts(facts, build).units[0]!.node,
          path: `${FACTS_VOCAB}hasInvocationBudget`,
          value: "false",
          message: "LOOP_WITHOUT_BUDGET",
        });
      }
      if (input.dataNTriples.includes("outsideHost")) {
        results.push({
          focusNode: projectDiagnosticFacts(facts, build).capabilities[0]!.node,
          path: `${FACTS_VOCAB}outsideHost`,
          value: "b.example",
          message: "CAPABILITY_BEYOND_MANDATE",
        });
      }
      if (extraResults) {
        results.push({
          focusNode: projectDiagnosticFacts(facts, build).units[0]!.node,
          path: `${FACTS_VOCAB}unknownProperty`,
          message: "SOMETHING_ELSE",
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
  const report = await service.validateBuild({ build, facts });
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
    build: { ...build, artifactDigest: digest("8") },
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
  const first = await service.validateBuild({ build, facts });
  equal(first.unmappedResults, 1);
  equal(engine.calls, 1);
  const second = await service.validateBuild({ build, facts });
  equal(engine.calls, 1); // identity hit: engine not re-run
  deepStrictEqual(second.identity, first.identity);
  // New shapes bytes → new identity → engine runs again.
  const reshaped = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(`${shapes}# v2\n`),
    cache,
  });
  const third = await reshaped.validateBuild({ build, facts });
  equal(engine.calls, 2);
  equal(third.identity.shapesDigest === first.identity.shapesDigest, false);
  await rejects(
    () =>
      service.validateBuild({
        build: { ...build, artifactDigest: digest("9") },
        facts,
        options: { strictUnmapped: true },
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "ModelShapesError",
  );
});

Deno.test("corrupt cached reports are recomputed, never cast into validity", async () => {
  const engine = cannedEngine();
  const cache = memoryCache();
  // Inject corruption on reads while keeping the valid stored bytes intact;
  // recomputation must still obey the fake's immutable write contract.
  const getProjection = cache.getProjection;
  let corruptBytes: Uint8Array | undefined;
  cache.getProjection = (kind, version, artifact) =>
    corruptBytes
      ? Promise.resolve(corruptBytes)
      : getProjection(kind, version, artifact);
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
    cache,
  });
  const first = await service.validateBuild({ build, facts });
  equal(engine.calls, 1);
  // Tamper with the stored bytes: invalid severity + non-boolean conforms.
  const key = [...cache.store.keys()][0] as string;
  const tampered = JSON.parse(
    new TextDecoder().decode(cache.store.get(key)),
  ) as Record<string, unknown>;
  tampered.conforms = "yes";
  (tampered.diagnostics as Record<string, unknown>[])[0]!.severity = "critical";
  corruptBytes = new TextEncoder().encode(JSON.stringify(tampered));
  const second = await service.validateBuild({ build, facts });
  equal(engine.calls, 2); // recomputed, corruption not returned
  equal(second.conforms, first.conforms);
  deepStrictEqual(
    second.diagnostics.map((d) => d.severity),
    first.diagnostics.map((d) => d.severity),
  );
  // Garbage bytes are also a miss, not an error or a valid report.
  corruptBytes = new TextEncoder().encode("{not json");
  const third = await service.validateBuild({ build, facts });
  equal(engine.calls, 3);
  equal(third.diagnostics.length, first.diagnostics.length);
});

Deno.test("cache key covers facts and repository, not only A", async () => {
  const engine = cannedEngine();
  const cache = memoryCache();
  const service = new ShaclModelDiagnostics({
    engine,
    loadShapes: () => Promise.resolve(shapes),
    cache,
  });
  await service.validateBuild({ build, facts });
  equal(engine.calls, 1);
  await service.validateBuild({ build, facts }); // identical: hit
  equal(engine.calls, 1);
  // Same A, different facts: no stale hit.
  const clean = await service.validateBuild({ build, facts: cleanFacts });
  equal(engine.calls, 2);
  equal(clean.conforms, true);
  // Same A and facts, another repository: no cross-repository hit.
  await service.validateBuild({
    build: { ...build, repositoryId: "repo-two" },
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
    facts: cleanFacts,
  });
  await service.validateBuild({ build: longBuild, facts: cleanFacts });
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
      facts: cleanFacts,
    });
  }
  await service.validateBuild({
    build: longBuild,
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
    const first = await service.validateBuild({ build, facts });
    const variant = { ...build, [field]: digest("a") };
    const changed = await service.validateBuild({ build: variant, facts });
    deepStrictEqual(changed.build, variant);
    deepStrictEqual(changed.identity, first.identity);
    equal(engine.calls, 2);
    equal(cache.store.size, 2);
    for (const expectedBuild of [build, variant]) {
      const hit = await service.validateBuild({ build: expectedBuild, facts });
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
