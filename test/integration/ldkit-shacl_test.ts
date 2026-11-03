/** W6 qualification with the real pinned JS libraries (Deno, no native
 * compilation, no Toolkit): LDkit 2.10.1 `createLens` over the
 * read-only SemanticIndexQueryEngine source, and rdf-validate-shacl
 * 0.6.0 over the versioned shapes. The index below is a credible port
 * double backed by a quad store; the coordinator re-runs the same
 * reader/service against the real Oxigraph native index.
 *
 * Run: deno test --allow-read --allow-env test/integration/ldkit-shacl_test.ts
 */
import assert from "node:assert/strict";
import {
  lintModelDiagnostics,
  type ModelDiagnosticFacts,
} from "../../src/domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";
import type { ModelSemanticIndex } from "../../src/application/model/semantic/index-service.ts";
import type {
  RdfQuadDto,
  RdfTermDto,
  SemanticQueryRequest,
} from "../../src/application/model/semantic/queries/inputs.ts";
import { compareDiagnostics } from "../../src/application/model/diagnostics/shapes.ts";
import {
  ASE_VOCAB,
  propPredicate,
} from "../../src/adapters/out/oxigraph/rdf.ts";
import {
  BoundModelReader,
  createLdkitLens,
  modelReaderContext,
  PackageSchema,
  PartUsageSchema,
  SemanticIndexQueryEngine,
} from "../../src/adapters/out/oxigraph/ldkit-reader.ts";
import {
  createRdfValidateShaclEngine,
  type ShaclEngine,
  ShaclModelDiagnostics,
} from "../../src/adapters/out/shacl/diagnostics.ts";

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
const PKG = "urn:ase:model:repo-one:pkg";
const PART = "urn:ase:model:repo-one:part";
const ATTR = "urn:ase:model:repo-one:attr";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const QUADS: RdfQuadDto[] = [
  {
    subject: iri(PKG),
    predicate: RDF_TYPE,
    object: iri("urn:ase:metaclass:Package"),
  },
  { subject: iri(PKG), predicate: ASE_VOCAB.nativeId, object: lit("pkg") },
  { subject: iri(PKG), predicate: ASE_VOCAB.metaclass, object: lit("Package") },
  { subject: iri(PKG), predicate: ASE_VOCAB.name, object: lit("Golden") },
  {
    subject: iri(PKG),
    predicate: ASE_VOCAB.qualifiedName,
    object: lit("Golden"),
  },
  {
    subject: iri(PKG),
    predicate: propPredicate("ownedMember"),
    object: iri(PART),
  },
  {
    subject: iri(PKG),
    predicate: propPredicate("ownedMember"),
    object: iri(ATTR),
  },
  {
    subject: iri(PART),
    predicate: RDF_TYPE,
    object: iri("urn:ase:metaclass:PartUsage"),
  },
  { subject: iri(PART), predicate: ASE_VOCAB.nativeId, object: lit("part") },
  {
    subject: iri(PART),
    predicate: ASE_VOCAB.metaclass,
    object: lit("PartUsage"),
  },
  { subject: iri(PART), predicate: ASE_VOCAB.name, object: lit("p") },
  {
    subject: iri(PART),
    predicate: ASE_VOCAB.qualifiedName,
    object: lit("Golden::p"),
  },
  { subject: iri(PART), predicate: propPredicate("owner"), object: iri(PKG) },
  {
    subject: iri(ATTR),
    predicate: RDF_TYPE,
    object: iri("urn:ase:metaclass:AttributeUsage"),
  },
  { subject: iri(ATTR), predicate: ASE_VOCAB.nativeId, object: lit("attr") },
  {
    subject: iri(ATTR),
    predicate: ASE_VOCAB.metaclass,
    object: lit("AttributeUsage"),
  },
  { subject: iri(ATTR), predicate: ASE_VOCAB.name, object: lit("a") },
];

/** Small quad-pattern SELECT evaluator for the deterministic pattern
 * queries `SemanticIndexQueryEngine` generates (`?s ?p ?o` projected). */
function patternTokens(sparql: string): string[] {
  const start = sparql.indexOf("{");
  const end = sparql.lastIndexOf("}");
  const body = sparql.slice(start + 1, end).replace(/\.\s*$/, "").trim();
  return body.match(
    /<[^>]*>|"(?:\\.|[^"\\])*"(\^\^<[^>]*>|@[A-Za-z-]+)?|_:\S+|\?\w+/g,
  ) ?? [];
}

function tokenMatches(
  token: string,
  term: RdfTermDto,
  variable: string,
  row: Record<string, RdfTermDto>,
): boolean {
  if (token === `?${variable}`) {
    row[variable] = term;
    return true;
  }
  if (token.startsWith("<")) {
    return term.kind === "iri" && term.value === token.slice(1, -1);
  }
  if (token.startsWith("_:")) {
    return term.kind === "blank" && term.value === token.slice(2);
  }
  if (token.startsWith('"')) {
    if (term.kind !== "literal") return false;
    const match = /^"((?:\\.|[^"\\])*)"(?:\^\^<([^>]*)>|@(\S+))?$/.exec(token);
    if (!match) return false;
    const lexical = match[1].replace(/\\(.)/g, "$1");
    return term.value === lexical &&
      (match[2] ? term.datatype === match[2] : true) &&
      (match[3] ? term.language === match[3] : true);
  }
  return false;
}

function fakeIndex(
  sourceQuads: readonly RdfQuadDto[] = QUADS,
): ModelSemanticIndex & {
  requests: SemanticQueryRequest[];
} {
  const requests: SemanticQueryRequest[] = [];
  return {
    requests,
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
      // Contract double for the exact SELECT/CONSTRUCT forms generated by
      // the real LDkit lens. It returns RDF graph DTOs, never JS entities.
      const typeMatch =
        /\?iri <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <(urn:ase:metaclass:[^>]+)>/
          .exec(request.sparql);
      if (typeMatch) {
        let subjects = sourceQuads.filter((q) =>
          q.predicate === RDF_TYPE && q.object.value === typeMatch[1]
        ).map((q) => q.subject.value);
        const values = /VALUES \?iri\s*\{([^}]+)\}/.exec(request.sparql);
        if (values) {
          const allowed = [...values[1].matchAll(/<([^>]+)>/g)].map((m) =>
            m[1]
          );
          subjects = subjects.filter((id) => allowed.includes(id));
        }
        if (/COUNT\(DISTINCT \?iri\)/i.test(request.sparql)) {
          return Promise.resolve({
            form: "solutions" as const,
            variables: ["count"],
            rows: [{
              count: {
                kind: "literal" as const,
                value: String(subjects.length),
                datatype: "http://www.w3.org/2001/XMLSchema#integer",
              },
            }],
            truncated: false,
          });
        }
        if (request.sparql.startsWith("CONSTRUCT")) {
          const template = request.sparql.slice(
            0,
            request.sparql.indexOf("WHERE"),
          );
          const predicates = [...template.matchAll(/\?iri <([^>]+)>/g)].map((
            m,
          ) => m[1]);
          const quads: RdfQuadDto[] = subjects.flatMap((id) => [
            {
              subject: iri(id),
              predicate: RDF_TYPE,
              object: iri("https://ldkit.io/ontology/Resource"),
            },
            ...sourceQuads.filter((q) =>
              q.subject.value === id && q.predicate !== RDF_TYPE &&
              predicates.includes(q.predicate)
            ),
          ]);
          return Promise.resolve({
            form: "graph" as const,
            quads: quads.slice(0, request.limits?.maxResults ?? 1000),
            truncated: quads.length > (request.limits?.maxResults ?? 1000),
          });
        }
      }
      const tokens = patternTokens(request.sparql);
      if (tokens.length !== 3 || !request.sparql.includes("?s ?p ?o")) {
        return Promise.reject(
          new Error(`Fake index only serves quad patterns: ${request.sparql}`),
        );
      }
      const rows: Record<string, RdfTermDto>[] = [];
      for (const quad of sourceQuads) {
        const row: Record<string, RdfTermDto> = {};
        if (
          tokenMatches(tokens[0], quad.subject, "s", row) &&
          tokenMatches(tokens[1], iri(quad.predicate), "p", row) &&
          tokenMatches(tokens[2], quad.object, "o", row)
        ) rows.push(row);
      }

      return Promise.resolve({
        form: "solutions" as const,
        variables: ["s", "p", "o"],
        rows,
        truncated: false,
      });
    },
  };
}

Deno.test("real LDkit lens reads through the readonly QueryEngine port", async () => {
  const index = fakeIndex();
  const lens = await createLdkitLens(PackageSchema, { index, build });
  // Read-only facade: no LDkit update surface leaks out.
  assert.deepEqual(
    Object.keys(lens).sort(),
    ["build", "count", "find", "findByIri", "findByIris", "refOf", "refsOf"],
  );
  const pkg = await lens.findByIri(PKG);

  assert.equal(pkg?.$id, PKG);
  assert.equal(pkg?.nativeId, "pkg");
  assert.equal(pkg?.name, "Golden");
  assert.equal(pkg?.declaredName, null);
  assert.equal(pkg?.owner, null);
  assert.deepEqual([...(pkg?.ownedMember ?? [])].sort(), [ATTR, PART].sort());
  // $id -> BuildElementRef only through the verified codec.
  assert.equal(lens.refOf(pkg!).ref.nativeId, "pkg");
  assert.deepEqual({ ...lens.refOf(pkg!).ref.build }, { ...build });
  assert.equal(lens.refOf(pkg!).scope, "user");
  const packages = await lens.find();
  assert.deepEqual(packages.map((entity) => entity.$id), [PKG]);
  assert.equal(await lens.count(), 1);
  const parts = await (await createLdkitLens(PartUsageSchema, { index, build }))
    .find();
  assert.deepEqual(parts.map((entity) => entity.$id), [PART]);
  assert.equal(parts[0]?.name, "p");
  // Foreign-repository $id refused before querying.
  assert.throws(() => lens.refOf("urn:ase:model:repo-two:pkg"));
  await assert.rejects(() => lens.findByIri("urn:ase:model:repo-two:pkg"));
  assert.equal(
    index.requests.every((r) =>
      r.build.artifactDigest === build.artifactDigest
    ),
    true,
  );
  assert.ok(index.requests.length > 0, "LDkit must go through the index port");
});

Deno.test("engine surface stays readonly and BoundModelReader shares the port", async () => {
  const index = fakeIndex();
  const engine = new SemanticIndexQueryEngine(index, modelReaderContext(build));
  await assert.rejects(() => engine.queryVoid(), /read-only|refused/i);
  const quads: string[] = [];
  for await (const quad of engine.match(undefined, undefined, undefined)) {
    quads.push(`${(quad.subject as { value: string }).value}`);
  }
  assert.equal(quads.length, QUADS.length);
  const reader = new BoundModelReader(index, build);
  assert.equal(reader.refFromIri(PART).ref.nativeId, "part");
});

const facts: ModelDiagnosticFacts = {
  units: [
    {
      location: {
        elementId: "sys",
        qualifiedName: "Sys",
        source: { file: "model.sysml", line: 1, column: 1 },
      },
      kind: "conversation",
      hasInvocationBudget: false,
      accountableHumanDeclared: true,
    },
    {
      location: { elementId: "plan", qualifiedName: "Sys::plan" },
      kind: "plan",
      hasInvocationBudget: true,
      accountableHumanDeclared: true,
    },
  ],
  effects: [],
  networkCapabilities: [
    {
      location: { elementId: "policy", qualifiedName: "Sys::policy" },
      allowedHosts: ["b.example", "a.example"],
      mandateHosts: ["a.example"],
    },
    {
      location: { elementId: "policy-ok" },
      allowedHosts: ["a.example"],
      mandateHosts: ["a.example"],
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

function countingEngine(inner: ShaclEngine): ShaclEngine & { calls: number } {
  const engine = {
    engineId: inner.engineId,
    engineVersion: inner.engineVersion,
    calls: 0,
    validate(input: { shapesTurtle: string; dataNTriples: string }) {
      engine.calls++;
      return inner.validate(input);
    },
  };
  return engine;
}

Deno.test("real SHACL engine matches the TS lint; masks stay outside reports", async () => {
  const engine = countingEngine(await createRdfValidateShaclEngine());
  const store = new Map<string, Uint8Array>();
  const cache = {
    getProjection(kind: string, version: string, artifact: string) {
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
      store.set([kind, version, artifact].join(":"), bytes);
      return Promise.resolve({
        stored: true,
        bytes: bytes.length,
        digest: digest("0"),
      });
    },
  };
  const service = new ShaclModelDiagnostics({ engine, cache });
  const report = await service.validateBuild({ build, facts });
  assert.equal(report.conforms, false);
  assert.equal(report.unmappedResults, 0);
  assert.equal(report.identity.engineId, "rdf-validate-shacl");
  assert.equal(report.identity.engineVersion, "0.6.0");
  const comparison = compareDiagnostics({
    shacl: report.diagnostics,
    reference: lintModelDiagnostics(facts),
    codes: ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"],
  });
  assert.deepEqual(
    {
      equal: comparison.equal,
      matched: comparison.matched,
      mismatched: comparison.mismatched,
    },
    { equal: true, matched: 2, mismatched: [] },
  );
  // Severity/target/message/remedy/source all ride in the compared diagnostics.
  const loop = report.diagnostics.find((d) => d.code === "LOOP_WITHOUT_BUDGET");
  assert.equal(loop?.severity, "warning");
  assert.equal(loop?.elementId, "sys");
  assert.equal(loop?.remedy?.template, "work-budget");
  assert.deepEqual(loop?.source, { file: "model.sysml", line: 1, column: 1 });
  // User masks are a separate concern: never inside the immutable report.
  assert.equal("masked" in report, false);
  assert.equal(JSON.stringify(report).includes("mask"), false);

  const clean = await service.validateBuild({
    build: { ...build, artifactDigest: digest("8") },
    facts: cleanFacts,
  });
  assert.equal(clean.conforms, true);
  assert.deepEqual([...clean.diagnostics], []);

  // Cache: identical input hits; corrupt bytes recompute with the real engine.
  const callsBefore = engine.calls;
  await service.validateBuild({ build, facts });
  assert.equal(engine.calls, callsBefore);
  const key = [...store.keys()].find((k) => k.includes(build.artifactDigest)) ??
    [...store.keys()][0];
  store.set(
    key!,
    new TextEncoder().encode('{"conforms":"yes","diagnostics":"nope"}'),
  );
  const recomputed = await service.validateBuild({ build, facts });
  assert.equal(engine.calls, callsBefore + 1);
  assert.equal(recomputed.conforms, false);
  assert.equal(recomputed.diagnostics.length, 2);
});

Deno.test("real SHACL preserves anonymous facts and separate facts targeting one element", async () => {
  const edgeFacts: ModelDiagnosticFacts = {
    units: [
      {
        location: { qualifiedName: "Anonymous" },
        kind: "conversation",
        hasInvocationBudget: false,
        accountableHumanDeclared: true,
      },
      {
        location: { elementId: "shared", qualifiedName: "Shared" },
        kind: "conversation",
        hasInvocationBudget: false,
        accountableHumanDeclared: true,
      },
      {
        location: { elementId: "shared", qualifiedName: "Shared" },
        kind: "plan",
        hasInvocationBudget: true,
        accountableHumanDeclared: true,
      },
    ],
    effects: [],
    networkCapabilities: [
      {
        location: { qualifiedName: "AnonymousPolicy" },
        allowedHosts: ["b.example"],
        mandateHosts: [],
      },
      {
        location: { elementId: "shared-policy" },
        allowedHosts: ["b.example"],
        mandateHosts: [],
      },
      {
        location: { elementId: "shared-policy" },
        allowedHosts: ["c.example"],
        mandateHosts: [],
      },
    ],
  };
  const service = new ShaclModelDiagnostics({
    engine: await createRdfValidateShaclEngine(),
  });
  const report = await service.validateBuild({
    build,
    facts: edgeFacts,
    options: { strictUnmapped: true },
  });
  assert.equal(report.unmappedResults, 0);
  assert.deepEqual(
    report.diagnostics,
    lintModelDiagnostics(edgeFacts).filter((d) =>
      ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"].includes(d.code)
    ),
  );
});

Deno.test("real LDkit scalar inspection stays within 16 quads for a Package with 150 members", async () => {
  const { scalarInspectionSchema, SCALAR_INSPECT_QUAD_BUDGET } = await import(
    "../../src/adapters/out/oxigraph/backend.ts"
  );
  const members: RdfQuadDto[] = Array.from(
    { length: 150 },
    (_, i) => ({
      subject: iri(PKG),
      predicate: propPredicate("ownedMember"),
      object: iri(`urn:ase:model:repo-one:wide-${i}`),
    }),
  );
  const index = fakeIndex([...QUADS, ...members]);
  const lens = await createLdkitLens(scalarInspectionSchema("Package"), {
    index,
    build,
    limits: { maxResults: SCALAR_INSPECT_QUAD_BUDGET },
  });
  const pkg = await lens.findByIri(PKG);
  assert.equal(pkg?.nativeId, "pkg");
  assert.equal(pkg?.name, "Golden");
  assert.equal(pkg?.declaredName, null);
  assert.equal(index.requests.every((r) => r.limits?.maxResults === 16), true);
  assert.equal(
    index.requests.every((r) =>
      !r.sparql.includes(propPredicate("ownedMember"))
    ),
    true,
  );
});
