/** Real LDkit qualification uses its read-only port double without a native
 * gate. SHACL cases execute grouped SELECTs against the exact full native graph
 * when ASSEMBLY_SHACL_INTEGRATION and ASSEMBLY_SEMANTIC_INDEX_ADDON are provided. */
import assert from "node:assert/strict";
import {
  lintModelDiagnostics,
  type ModelDiagnosticFacts,
} from "../../src/domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { ModelShapesError } from "../../src/application/model/diagnostics/shapes.ts";
import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
import {
  diagnosticModelElements,
  semanticShaclFixture,
} from "../fixtures/semantic-shacl.ts";
import {
  MemorySemanticProjectionCache,
  nativeSemanticFixture,
} from "../support/semantic-native.ts";
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
  createNativeShaclEngine,
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
    object: iri("https://www.omg.org/spec/SysML#Package"),
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
    object: iri("https://www.omg.org/spec/SysML#PartUsage"),
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
    object: iri("https://www.omg.org/spec/SysML#AttributeUsage"),
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
        /\?iri <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <(https:\/\/www\.omg\.org\/spec\/SysML#[^>]+)>/
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

const addonPath = readAssemblyEnv("ASSEMBLY_SEMANTIC_INDEX_ADDON");
const shaclEnabled = readAssemblyEnv("ASSEMBLY_SHACL_INTEGRATION") === "1" &&
  !!addonPath;

function countingEngine(inner: ShaclEngine): ShaclEngine & { calls: number } {
  return {
    engineId: inner.engineId,
    engineVersion: inner.engineVersion,
    calls: 0,
    validate(input) {
      this.calls++;
      return inner.validate(input);
    },
  };
}

const validationFailed = (error: unknown) =>
  error instanceof ModelShapesError && error.code === "SHACL_VALIDATION_FAILED";
const invalidContext = (error: unknown) =>
  error instanceof ModelShapesError && error.code === "SHAPES_INVALID_INPUT";

Deno.test({
  name: "real native SHACL missing network attribute keeps the mandate empty",
  ignore: !shaclEnabled,
  async fn() {
    const fixture = semanticShaclFixture();
    // Retain a real array-valued attribute on this owner, but give it an
    // unrelated source name. No networkHosts attribute remains on sys.
    fixture.elements.find((element) => element["@id"] === "sys-networkHosts")!
      .declaredName = "auditHosts";
    fixture.elements.find((element) =>
      element["@id"] === "sys-networkHosts-literal"
    )!.value = '["b.example"]';
    const facts: ModelDiagnosticFacts = {
      ...fixture.facts,
      graphContext: {
        ...fixture.facts.graphContext!,
        capabilities: fixture.facts.graphContext!.capabilities.map(
          ({ networkHostsAttributeId, ...association }) =>
            association.policyElementId === "policy"
              ? association
              : { ...association, networkHostsAttributeId },
        ),
      },
      networkCapabilities: fixture.facts.networkCapabilities.map((capability) =>
        capability.location.elementId === "policy"
          ? { ...capability, mandateHosts: [] }
          : capability
      ),
    };
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    try {
      const report = await new ShaclModelDiagnostics({
        engine: createNativeShaclEngine,
      }).validateBuild({ build, facts, graph: await native.graph(build) });
      assert.deepEqual(report.diagnostics, lintModelDiagnostics(facts));
      assert.equal(report.conforms, false);
      assert.equal(report.unmappedResults, 0);
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL attribute ownership rejects another policy's attribute",
  ignore: !shaclEnabled,
  async fn() {
    const fixture = semanticShaclFixture();
    const facts: ModelDiagnosticFacts = {
      ...fixture.facts,
      graphContext: {
        ...fixture.facts.graphContext!,
        capabilities: fixture.facts.graphContext!.capabilities.map(
          (association) =>
            association.policyElementId === "policy"
              ? {
                ...association,
                allowedHostsAttributeId: "policy-ok-allowedHosts",
              }
              : association,
        ),
      },
    };
    const cache = new MemorySemanticProjectionCache();
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    try {
      const service = new ShaclModelDiagnostics({
        engine: createNativeShaclEngine,
        cache,
      });
      const graph = await native.graph(build);
      await assert.rejects(
        () => service.validateBuild({ build, facts, graph }),
        validationFailed,
      );
      assert.equal(cache.store.size, 0);
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL matches the TS lint; masks, clean reports and cache remain exact",
  ignore: !shaclEnabled,
  async fn() {
    const fixture = semanticShaclFixture();
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    const engine = countingEngine(await createNativeShaclEngine());
    const cache = new MemorySemanticProjectionCache();
    const service = new ShaclModelDiagnostics({ engine, cache });
    try {
      const graph = await native.graph(build);
      const queries: string[] = [];
      const trackedGraph = {
        ...graph,
        query: async (...args: Parameters<typeof graph.query>) => {
          queries.push(args[0]);
          return await graph.query(...args);
        },
      };
      const before = await graph.query(
        "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }",
      );
      const [report, inspected] = await Promise.all([
        service.validateBuild({
          build,
          facts: fixture.facts,
          graph: trackedGraph,
        }),
        new BoundModelReader(native.service, build).getElement("sys"),
      ]);
      assert.equal(inspected?.metaclass, "PartUsage");
      assert.equal(report.conforms, false);
      assert.equal(report.unmappedResults, 0);
      assert.equal(report.identity.engineId, "assembly-native-shacl-sparql");
      assert.equal(
        report.identity.engineVersion,
        "1.0.0+oxigraph-0.5.12+sparqljs-3.7.4",
      );
      assert.equal(
        queries.length,
        3,
        "one focus check and one SELECT per active constraint",
      );
      const comparison = compareDiagnostics({
        shacl: report.diagnostics,
        reference: lintModelDiagnostics(fixture.facts),
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
      const loop = report.diagnostics.find((d) =>
        d.code === "LOOP_WITHOUT_BUDGET"
      );
      assert.equal(loop?.severity, "warning");
      assert.equal(loop?.elementId, "sys");
      assert.equal(loop?.remedy?.template, "work-budget");
      assert.deepEqual(loop?.source, {
        file: "model.sysml",
        line: 1,
        column: 1,
      });
      assert.equal("masked" in report, false);
      assert.equal(JSON.stringify(report).includes("mask"), false);
      assert.deepEqual(
        await graph.query("SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }"),
        before,
      );

      const callsBefore = engine.calls;
      assert.deepEqual(
        await service.validateBuild({ build, facts: fixture.facts, graph }),
        report,
      );
      assert.equal(engine.calls, callsBefore);
      const key = [...cache.store.keys()][0]!;
      cache.store.set(
        key,
        new TextEncoder().encode('{"conforms":"yes","diagnostics":"nope"}'),
      );
      await assert.rejects(
        () => service.validateBuild({ build, facts: fixture.facts, graph }),
        validationFailed,
      );
      assert.equal(
        engine.calls,
        callsBefore,
        "corruption must fail without silently recomputing",
      );
      assert.equal(
        new TextDecoder().decode(cache.store.get(key)),
        '{"conforms":"yes","diagnostics":"nope"}',
      );

      const cleanFixture = semanticShaclFixture(true);
      const cleanBuild = { ...build, artifactDigest: digest("8") };
      const cleanNative = await nativeSemanticFixture({
        addonPath: addonPath!,
        elements: cleanFixture.elements,
      });
      try {
        const cleanGraph = await cleanNative.graph(cleanBuild);
        const clean = await service.validateBuild({
          build: cleanBuild,
          facts: cleanFixture.facts,
          graph: cleanGraph,
        });
        assert.equal(clean.conforms, true);
        assert.deepEqual([...clean.diagnostics], []);
        assert.notEqual(
          cleanGraph.projection?.projectionDigest,
          graph.projection?.projectionDigest,
        );
        assert.equal(
          cache.store.size,
          2,
          "a different full graph has its own immutable cache slot",
        );
      } finally {
        await cleanNative.requester.close();
      }
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL preserves shared plans and policies for each owner and collapses duplicate rows",
  ignore: !shaclEnabled,
  async fn() {
    const escapedHost = 'quo"te.example';
    const elements = diagnosticModelElements({
      systems: [
        {
          id: "owner-a",
          hosts: ["a.example", "b.example"],
          budgetPolicyId: "budget-a",
        },
        { id: "owner-b", hosts: [] },
      ],
      plans: ["shared"],
      policies: [{
        id: "shared-policy",
        ownerSystemId: "owner-a",
        hosts: [
          "a.example",
          "b.example",
          "c.example",
          escapedHost,
          "c.example",
        ],
      }],
    });
    const facts: ModelDiagnosticFacts = {
      graphContext: {
        units: [
          {
            elementId: "owner-a",
            kind: "conversation",
            ownerSystemId: "owner-a",
            budgetPolicyId: "budget-a",
          },
          {
            elementId: "owner-b",
            kind: "conversation",
            ownerSystemId: "owner-b",
          },
          {
            elementId: "shared",
            kind: "plan",
            ownerSystemId: "owner-a",
            budgetPolicyId: "budget-a",
          },
          { elementId: "shared", kind: "plan", ownerSystemId: "owner-b" },
          { elementId: "shared", kind: "plan", ownerSystemId: "owner-b" },
        ],
        capabilities: [
          {
            policyElementId: "shared-policy",
            ownerSystemId: "owner-a",
            allowedHostsAttributeId: "shared-policy-allowedHosts",
            networkHostsAttributeId: "owner-a-networkHosts",
          },
          {
            policyElementId: "shared-policy",
            ownerSystemId: "owner-b",
            allowedHostsAttributeId: "shared-policy-allowedHosts",
            networkHostsAttributeId: "owner-b-networkHosts",
          },
          {
            policyElementId: "shared-policy",
            ownerSystemId: "owner-b",
            allowedHostsAttributeId: "shared-policy-allowedHosts",
            networkHostsAttributeId: "owner-b-networkHosts",
          },
        ],
      },
      units: [
        {
          location: { elementId: "owner-a" },
          kind: "conversation",
          hasInvocationBudget: true,
          accountableHumanDeclared: true,
        },
        {
          location: { elementId: "owner-b" },
          kind: "conversation",
          hasInvocationBudget: false,
          accountableHumanDeclared: true,
        },
        {
          location: { elementId: "shared", qualifiedName: "Shared" },
          kind: "plan",
          hasInvocationBudget: false,
          accountableHumanDeclared: true,
        },
      ],
      effects: [],
      networkCapabilities: [
        {
          location: {
            elementId: "shared-policy",
            qualifiedName: "SharedPolicy",
          },
          ownerSystemId: "owner-a",
          allowedHosts: [
            "a.example",
            "b.example",
            "c.example",
            escapedHost,
            "c.example",
          ],
          mandateHosts: ["a.example", "b.example"],
        },
        {
          location: {
            elementId: "shared-policy",
            qualifiedName: "SharedPolicy",
          },
          ownerSystemId: "owner-b",
          allowedHosts: [
            "a.example",
            "b.example",
            "c.example",
            escapedHost,
            "c.example",
          ],
          mandateHosts: [],
        },
      ],
    };
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements,
    });
    try {
      const graph = await native.graph(build);
      const observed: Array<Record<string, RdfTermDto>> = [];
      const report = await new ShaclModelDiagnostics({
        engine: createNativeShaclEngine,
      }).validateBuild({
        build,
        facts,
        options: { strictUnmapped: true },
        graph: {
          ...graph,
          query: async (...args) => {
            const result = await graph.query(...args);
            if (result.form !== "solutions") return result;
            observed.push(...result.rows);
            return { ...result, rows: [...result.rows, ...result.rows] };
          },
        },
      });
      assert.equal(report.unmappedResults, 0);
      assert.deepEqual(
        report.diagnostics,
        lintModelDiagnostics(facts).filter((d) =>
          ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"].includes(d.code)
        ),
      );
      assert.equal(report.diagnostics.length, 4);
      const shared = "urn:ase:model:repo-one:shared";
      assert.equal(
        observed.some((r) =>
          r.this?.value === shared &&
          r.ownerSystem?.value === "urn:ase:model:repo-one:owner-a"
        ),
        false,
      );
      assert.equal(
        observed.some((r) =>
          r.this?.value === shared &&
          r.ownerSystem?.value === "urn:ase:model:repo-one:owner-b"
        ),
        true,
      );
      // Equal host findings still represent two distinct admitted owners.
      const equalElements = diagnosticModelElements({
        systems: [
          {
            id: "owner-a",
            hosts: ["a.example", "b.example"],
            budgetPolicyId: "budget-a",
          },
          { id: "owner-b", hosts: ["a.example", "b.example"] },
        ],
        plans: ["shared"],
        policies: [{
          id: "shared-policy",
          ownerSystemId: "owner-a",
          hosts: [
            "a.example",
            "b.example",
            "c.example",
            escapedHost,
            "c.example",
          ],
        }],
      });
      const equalNative = await nativeSemanticFixture({
        addonPath: addonPath!,
        elements: equalElements,
      });
      try {
        const equalFacts = {
          ...facts,
          networkCapabilities: facts.networkCapabilities.map((capability) => ({
            ...capability,
            mandateHosts: ["a.example", "b.example"],
          })),
        };
        const equalReport = await new ShaclModelDiagnostics({
          engine: createNativeShaclEngine,
        }).validateBuild({
          build,
          facts: equalFacts,
          graph: await equalNative.graph(build),
        });
        const expected = lintModelDiagnostics(equalFacts).filter((d) =>
          ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"].includes(d.code)
        );
        assert.deepEqual(equalReport.diagnostics, expected);
        const equalHosts = equalReport.diagnostics.filter((d) =>
          d.code === "CAPABILITY_BEYOND_MANDATE"
        );
        assert.equal(
          equalHosts.length,
          2,
          "one finding per policy-owner even when serialized diagnostics agree",
        );
        assert.deepEqual(equalHosts[0], equalHosts[1]);
      } finally {
        await equalNative.requester.close();
      }
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL reads compiler-pinned redefined attributes without name traversal",
  ignore: !shaclEnabled,
  async fn() {
    const policyIds = [
      "direct-redefines",
      "direct-feature",
      "owned-feature",
      "owned-general",
    ];
    const ref = (id: string) => ({ "@id": id });
    const elements = diagnosticModelElements({
      systems: [{
        id: "sys",
        hosts: ["a.example"],
        budgetPolicyId: "budget-sys",
      }],
      policies: policyIds.map((id) => ({
        id,
        ownerSystemId: "sys",
        hosts: ["b.example"],
      })),
    });
    elements.push(
      {
        "@id": "allowed-declaration",
        "@type": "AttributeUsage",
        declaredName: "allowedHosts",
      },
      {
        "@id": "network-declaration",
        "@type": "AttributeUsage",
        declaredName: "networkHosts",
      },
    );
    for (const [index, policy] of policyIds.entries()) {
      const attribute = elements.find((element) =>
        element["@id"] === `${policy}-allowedHosts`
      )!;
      delete attribute.declaredName;
      if (index < 2) {
        attribute[index === 0 ? "redefines" : "redefinedFeature"] = [
          ref("allowed-declaration"),
        ];
      } else {
        const redefinition = `${policy}-redefinition`;
        attribute.ownedRedefinition = [ref(redefinition)];
        elements.push({
          "@id": redefinition,
          "@type": "Redefinition",
          [index === 2 ? "redefinedFeature" : "general"]: ref(
            "allowed-declaration",
          ),
        });
      }
    }
    const network = elements.find((element) =>
      element["@id"] === "sys-networkHosts"
    )!;
    delete network.declaredName;
    network.redefinedFeature = [ref("network-declaration")];
    // The supplied compiler context pins sys-networkHosts. This unrelated attribute is
    // deliberately not pinned; query evaluation must not discover another name
    // through its ancestor and silently broaden the admitted network scope.
    elements.push(
      {
        "@id": "other-network",
        "@type": "AttributeUsage",
        owner: ref("sys"),
        declaredName: "otherHosts",
        redefines: [ref("network-declaration")],
      },
      {
        "@id": "other-network-value",
        "@type": "FeatureValue",
        featureWithValue: ref("other-network"),
        value: ref("other-network-literal"),
      },
      {
        "@id": "other-network-literal",
        "@type": "LiteralString",
        value: '["b.example"]',
      },
    );
    const facts: ModelDiagnosticFacts = {
      graphContext: {
        units: [{
          elementId: "sys",
          kind: "conversation",
          ownerSystemId: "sys",
          budgetPolicyId: "budget-sys",
        }],
        capabilities: policyIds.map((policyElementId) => ({
          policyElementId,
          ownerSystemId: "sys",
          allowedHostsAttributeId: `${policyElementId}-allowedHosts`,
          networkHostsAttributeId: "sys-networkHosts",
        })),
      },
      units: [{
        location: { elementId: "sys" },
        kind: "conversation",
        hasInvocationBudget: true,
        accountableHumanDeclared: true,
      }],
      effects: [],
      networkCapabilities: policyIds.map((elementId) => ({
        location: { elementId },
        ownerSystemId: "sys",
        allowedHosts: ["b.example"],
        mandateHosts: ["a.example"],
      })),
    };
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements,
    });
    try {
      const report = await new ShaclModelDiagnostics({
        engine: createNativeShaclEngine,
      }).validateBuild({ build, facts, graph: await native.graph(build) });
      assert.deepEqual(report.diagnostics, lintModelDiagnostics(facts));
      assert.equal(report.unmappedResults, 0);
      assert.equal(report.conforms, false);
      assert.equal(report.diagnostics.length, 4);
      assert.ok(
        report.diagnostics.every((diagnostic) =>
          diagnostic.code === "CAPABILITY_BEYOND_MANDATE" &&
          diagnostic.message.endsWith("b.example.")
        ),
      );
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL refuses anonymous facts, missing associations and mismatched graph scope",
  ignore: !shaclEnabled,
  async fn() {
    const fixture = semanticShaclFixture();
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    const engine = countingEngine(await createNativeShaclEngine());
    const service = new ShaclModelDiagnostics({ engine });
    try {
      const graph = await native.graph(build);
      const anonymousUnit = {
        ...fixture.facts.units[0]!,
        location: { qualifiedName: "Anonymous" },
      };
      const anonymousPolicy = {
        ...fixture.facts.networkCapabilities[0]!,
        location: { qualifiedName: "AnonymousPolicy" },
      };
      for (
        const facts of [
          { ...fixture.facts, graphContext: undefined },
          {
            ...fixture.facts,
            units: [...fixture.facts.units, {
              ...fixture.facts.units[0]!,
              kind: "plan" as const,
            }],
            graphContext: {
              ...fixture.facts.graphContext!,
              units: [...fixture.facts.graphContext!.units, {
                elementId: "sys",
                kind: "plan" as const,
                ownerSystemId: "sys",
              }],
            },
          },
          {
            ...fixture.facts,
            units: [anonymousUnit, ...fixture.facts.units.slice(1)],
          },
          {
            ...fixture.facts,
            networkCapabilities: [
              anonymousPolicy,
              ...fixture.facts.networkCapabilities.slice(1),
            ],
          },
          {
            ...fixture.facts,
            graphContext: {
              ...fixture.facts.graphContext!,
              units: fixture.facts.graphContext!.units.filter((u) =>
                u.elementId !== "plan"
              ),
            },
          },
        ]
      ) {
        await assert.rejects(
          () => service.validateBuild({ build, facts, graph }),
          invalidContext,
        );
      }
      await assert.rejects(
        () =>
          service.validateBuild(
            { build, facts: fixture.facts } as unknown as Parameters<
              ShaclModelDiagnostics["validateBuild"]
            >[0],
          ),
        invalidContext,
      );
      await assert.rejects(
        () =>
          service.validateBuild({
            build,
            facts: fixture.facts,
            graph: { ...graph, build: { ...build, repositoryId: "foreign" } },
          }),
        invalidContext,
      );
      assert.equal(
        engine.calls,
        0,
        "invalid provenance must fail before evaluating constraints",
      );
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL refuses truncated focus and constraint results without caching a partial report",
  ignore: !shaclEnabled,
  async fn() {
    const fixture = semanticShaclFixture();
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    try {
      const graph = await native.graph(build);
      for (const truncatedCall of [1, 2]) {
        let calls = 0;
        const cache = new MemorySemanticProjectionCache();
        const service = new ShaclModelDiagnostics({
          engine: createNativeShaclEngine,
          cache,
        });
        await assert.rejects(() =>
          service.validateBuild({
            build,
            facts: fixture.facts,
            graph: {
              ...graph,
              query: async (...args) => {
                const result = await graph.query(...args);
                calls++;
                return result.form === "solutions" && calls === truncatedCall
                  ? { ...result, truncated: true }
                  : result;
              },
            },
          }), validationFailed);
        assert.equal(calls, truncatedCall);
        assert.equal(cache.store.size, 0);
      }
    } finally {
      await native.requester.close();
    }
  },
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
