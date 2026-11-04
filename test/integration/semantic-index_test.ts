import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
/** Real W5/W6 contract runs, executed by the coordinator only.
 *
 * Gates (all off by default, like the Toolkit suites):
 * - native index: ASSEMBLY_SEMANTIC_INTEGRATION=1 and
 *   ASSEMBLY_SEMANTIC_INDEX_ADDON=<path to built ase-semantic-index-napi .node>
 * - native SHACL: ASSEMBLY_SHACL_INTEGRATION=1 and the same addon path
 *
 * The element source and projection cache below are W2 port doubles;
 * everything downstream of them (projector, service, process executor,
 * Oxigraph addon, LDkit reader, SHACL mapping) is production code.
 */
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import {
  lintModelDiagnostics,
  projectModelDiagnosticFacts,
} from "../../src/domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { sha256HexOfBytes } from "../../src/application/model/builds/service.ts";
import {
  SemanticIndexError,
} from "../../src/application/model/semantic/index-service.ts";
import { compareDiagnostics } from "../../src/application/model/diagnostics/shapes.ts";
import { propPredicate } from "../../src/adapters/out/oxigraph/rdf.ts";
import {
  buildElementIri,
  buildGraphIri,
} from "../../src/adapters/out/oxigraph/iri.ts";
import {
  nativeFixtureFailure,
  nativeProjectionMeasurements,
  nativeSemanticBackendFixture,
  nativeSemanticFixture,
} from "../support/semantic-native.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { sourceLiterals } from "../../src/domain/model/projections/source-facts.ts";
import { semanticShaclFixture } from "../fixtures/semantic-shacl.ts";
import { admitSelect, bindFocus } from "../../src/adapters/out/shacl/query.ts";
import {
  type DenoChildRequesterOptions,
  semanticProcessCommandArgs,
} from "../../src/adapters/out/oxigraph/oxigraph.ts";
import { BoundModelReader } from "../../src/adapters/out/oxigraph/ldkit-reader.ts";
import {
  createNativeShaclEngine,
  ShaclModelDiagnostics,
} from "../../src/adapters/out/shacl/diagnostics.ts";

const addonPath = readAssemblyEnv("ASSEMBLY_SEMANTIC_INDEX_ADDON");
const shaclEnabled = readAssemblyEnv("ASSEMBLY_SHACL_INTEGRATION") === "1";
const nativeEnabled = readAssemblyEnv("ASSEMBLY_SEMANTIC_INTEGRATION") === "1";

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "semantic-fixture",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};
const elements: JsonObject[] = [
  {
    "@id": "pkg",
    "@type": "Package",
    declaredName: "Golden",
    qualifiedName: "Golden",
    ownedMember: [{ "@id": "part" }, { "@id": "attr" }, { "@id": "part" }],
    "sysx:related": { "@id": "attr" },
  },
  {
    "@id": "part",
    "@type": "PartUsage",
    declaredName: "p",
    qualifiedName: "Golden::p",
    owner: { "@id": "pkg" },
  },
  {
    "@id": "attr",
    "@type": "AttributeUsage",
    declaredName: "a",
    qualifiedName: "Golden::a",
    owner: { "@id": "pkg" },
  },
];

async function nativeService(options: Partial<DenoChildRequesterOptions> = {}) {
  return await nativeSemanticFixture({
    addonPath: addonPath!,
    elements,
    requesterOptions: options,
  });
}

Deno.test({
  name:
    "native Oxigraph index serves bounded read-only queries through the killable process",
  ignore: !addonPath || !nativeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { service, requester } = await nativeService();
    try {
      const status = await service.ensureProjection(build);
      assert.equal(status.state, "ready");
      assert.ok((status.quadCount ?? 0) > 10);
      assert.notEqual(
        status.projection?.projectionDigest,
        build.artifactDigest,
      );

      const reader = new BoundModelReader(service, build);
      const part = await reader.getElement("part");
      assert.equal(part?.metaclass, "PartUsage");
      assert.equal(part?.name, "p");
      assert.equal(part?.qualifiedName, "Golden::p");
      assert.equal((await reader.getByIri(part!.$id))?.nativeId, "part");

      const members = await reader.orderedMembers(
        { build, nativeId: "pkg" },
        "ownedMember",
      );
      assert.deepEqual([...members], [
        "urn:ase:model:semantic-fixture:part",
        "urn:ase:model:semantic-fixture:attr",
        "urn:ase:model:semantic-fixture:part",
      ]);

      const neighbors = await reader.neighborsPage({ build, nativeId: "pkg" });
      assert.equal(neighbors.complete, true);
      const owned = neighbors.items.filter((item) =>
        item.property === "ownedMember"
      );
      assert.deepEqual(
        owned.map((item) => ({
          id: item.other?.ref.nativeId,
          position: item.position,
        })),
        [
          { id: "part", position: 0 },
          { id: "attr", position: 1 },
          { id: "part", position: 2 },
        ],
      );
      assert.equal(new Set(owned.map((item) => item.occurrence)).size, 3);
      assert.ok(
        owned.every((item) =>
          !!item.occurrence && item.predicate === propPredicate("ownedMember")
        ),
      );
      const related = neighbors.items.filter((item) =>
        item.property === "sysx:related"
      );
      assert.equal(related.length, 1);
      assert.equal(related[0]?.other?.ref.nativeId, "attr");
      assert.equal(related[0]?.predicate, propPredicate("sysx:related"));

      const descendants = await reader.descendantsOf({
        build,
        nativeId: "pkg",
      });
      assert.deepEqual(
        descendants.map((view) => view.nativeId).sort(),
        ["attr", "part"],
      );

      // Admission: updates and federation never reach the engine.
      await assert.rejects(
        () => reader.query("INSERT DATA { <a> <b> <c> }"),
      );
      await assert.rejects(
        () =>
          reader.query(
            "SELECT * WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } }",
          ),
      );
      await assert.rejects(
        () =>
          reader.query(
            "SELECT * FROM <urn:ase:build:other> WHERE { ?s ?p ?o }",
          ),
      );

      // Index loss (process killed) is not data loss: ensure reloads
      // from the cached projection without touching any source.
      await requester.recycle("test");
      assert.equal((await service.status(build)).state, "absent");
      assert.equal((await service.ensureProjection(build)).state, "ready");
      assert.equal(
        (await reader.getElement("attr"))?.metaclass,
        "AttributeUsage",
      );
      await service.release(build);
      assert.equal((await service.status(build)).state, "absent");
    } finally {
      await requester.close();
    }
  },
});

Deno.test({
  name:
    "native semantic aggregate deadline kills the old child and reloads a tiny cached dataset",
  ignore: !addonPath || !nativeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const directory = await Deno.makeTempDir({
      dir: await Deno.realPath(
        new URL("../../.data/toolchains/", import.meta.url),
      ),
      prefix: "semantic-timeout-",
    });
    const children: Deno.ChildProcess[] = [];
    const options = {
      addonPath: addonPath!,
      expectedAddonSha256: await sha256HexOfBytes(
        await Deno.readFile(addonPath!),
      ),
    };
    const { service, requester } = await nativeService({
      snapshotDirectory: directory,
      snapshotStorage: {
        create: (root, epoch) =>
          Deno.makeTempDir({ dir: root, prefix: `${epoch}-` }),
        remove: (path) => Deno.remove(path, { recursive: true }),
      },
      spawnChild(epoch, snapshotDirectory) {
        const child = new Deno.Command(Deno.execPath(), {
          args: semanticProcessCommandArgs(options, epoch, snapshotDirectory),
          stdin: "piped",
          stdout: "piped",
          stderr: "inherit",
        }).spawn();
        children.push(child);
        return child;
      },
    });
    try {
      assert.equal((await service.ensureProjection(build)).state, "ready");
      const reader = new BoundModelReader(service, build);
      assert.equal((await reader.getElement("part"))?.metaclass, "PartUsage");
      assert.equal(children.length, 1);
      const original = children[0]!;
      // Finite 16^8 combinations, streamed into one aggregate row. RAND keeps
      // this genuine execution work rather than a constant cardinality answer;
      // the preloaded dataset itself remains the three-element fixture above.
      const values = Array.from({ length: 16 }, (_, i) => i).join(" ");
      const workload = Array.from(
        { length: 8 },
        (_, i) => `VALUES ?v${i} { ${values} }`,
      ).join("\n");
      await assert.rejects(
        () =>
          service.queryReadOnly({
            build,
            sparql:
              `SELECT (COUNT(*) AS ?count) WHERE { ${workload} FILTER(RAND() >= 0) }`,
            limits: { timeoutMs: 100, maxResults: 1, maxBytes: 1024 },
          }),
        (error: unknown) =>
          error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
      );
      const exit = await original.status;
      assert.equal(
        exit.signal,
        "SIGKILL",
        "the deadline must reclaim the actual native child",
      );
      assert.equal((await service.status(build)).state, "absent");
      assert.equal((await service.ensureProjection(build)).state, "ready");
      assert.equal(children.length, 2);
      assert.notEqual(children[1]!.pid, original.pid);
      assert.equal(
        (await reader.getElement("attr"))?.metaclass,
        "AttributeUsage",
      );
      console.log(
        JSON.stringify({
          qualification: "native timeout/recycle",
          timeoutMs: 100,
          oldPid: original.pid,
          oldExit: exit,
          replacementPid: children[1]!.pid,
        }),
      );
    } finally {
      await requester.close();
      await Promise.all(children.map((child) => child.status));
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "real native SHACL engine matches the TS lint on both qualified rules",
  ignore: !shaclEnabled || !addonPath,
  async fn() {
    const fixture = semanticShaclFixture();
    const native = await nativeSemanticFixture({
      addonPath: addonPath!,
      elements: fixture.elements,
    });
    try {
      const service = new ShaclModelDiagnostics({
        engine: createNativeShaclEngine,
      });
      const report = await service.validateBuild({
        build,
        facts: fixture.facts,
        graph: await native.graph(build),
      });
      assert.equal(report.conforms, false);
      assert.equal(report.unmappedResults, 0);
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
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL prebinding reaches nested W3C scopes without changing the full graph",
  ignore: !shaclEnabled || !addonPath,
  async fn() {
    const native = await nativeService();
    try {
      const graph = await native.graph(build);
      const part = buildElementIri({ build, nativeId: "part" }, "user");
      const attr = buildElementIri({ build, nativeId: "attr" }, "user");
      const absent = buildElementIri({ build, nativeId: "absent" }, "user");
      const named = buildGraphIri(build);
      const name = `<${propPredicate("declaredName")}>`;
      const patterns = [
        `FILTER (?this = <${part}>)`,
        `{ FILTER(false) } UNION { FILTER (?this = <${part}>) }`,
        `{ { FILTER (?this = <${part}>) } FILTER(bound(?this)) } FILTER(true)`,
        `BIND (?this AS ?that) FILTER (?that = <${part}>)`,
        `{ FILTER(bound(?this)) } ?this ${name} "p" FILTER(bound(?this))`,
        `{ SELECT ?this WHERE { FILTER (?this = <${part}>) } }`,
        `GRAPH <${named}> { FILTER(bound(?this)) ?this ${name} "p" }`,
        `FILTER(EXISTS { GRAPH <${named}> { ?this ${name} "p" } })`,
      ];
      for (const pattern of patterns) {
        const result = await graph.query(
          bindFocus(admitSelect(`SELECT ?this WHERE { ${pattern} }`), [
            part,
            attr,
          ]),
        );
        assert.equal(result.form, "solutions");
        if (result.form !== "solutions") {
          throw new Error("Expected SELECT solutions");
        }
        assert.equal(result.truncated, false);
        assert.deepEqual(
          result.rows.map((row) => row.this?.value),
          [part],
          pattern,
        );
      }
      const exists = await graph.query(
        bindFocus(
          admitSelect(
            `SELECT ?this (EXISTS { GRAPH <${named}> { ?this ${name} "p" } } AS ?present) WHERE {}`,
          ),
          [part, attr],
        ),
      );
      assert.equal(exists.form, "solutions");
      if (exists.form !== "solutions") {
        throw new Error("Expected SELECT solutions");
      }
      assert.deepEqual(
        exists.rows.map((row) => [row.this?.value, row.present?.value]).sort(),
        [[attr, "false"], [part, "true"]].sort(),
      );
      const pattern =
        `OPTIONAL { ?this ${name} ?value } FILTER NOT EXISTS { ?this ${name} "a" } FILTER (!BOUND(?value) || ?value = "p")`;
      const compiled = admitSelect(
        `SELECT DISTINCT ?this ?value WHERE { ${pattern} } ORDER BY ?this`,
      );
      const rows = async (sparql: string) => {
        const result = await graph.query(sparql);
        assert.equal(result.form, "solutions");
        if (result.form !== "solutions") {
          throw new Error("Expected SELECT solutions");
        }
        assert.equal(result.truncated, false);
        return result.rows.map((row) =>
          JSON.stringify(Object.entries(row).sort())
        ).sort();
      };
      const focuses = [part, attr, absent];
      const batched = await rows(bindFocus(compiled, focuses));
      const independent = (await Promise.all(focuses.map((iri) =>
        rows(
          `SELECT DISTINCT ?this ?value WHERE { BIND(<${iri}> AS ?this) ${
            pattern.replaceAll("?this", `<${iri}>`)
          } }`,
        )
      ))).flat().sort();
      assert.deepEqual(batched, independent);
      assert.equal(batched.length, 2);
      assert.ok(batched.some((row) => row.includes(absent)));
      assert.deepEqual(await rows(bindFocus(compiled, [part, part])), [
        batched.find((row) => row.includes(part)),
      ]);
      assert.deepEqual(await rows(bindFocus(compiled, [])), []);
      assert.equal(
        (await new BoundModelReader(native.service, build).getElement("part"))
          ?.name,
        "p",
      );
    } finally {
      await native.requester.close();
    }
  },
});

Deno.test({
  name:
    "real native semantic backend validates exact build and projection with both diagnostics",
  ignore: !shaclEnabled || !addonPath,
  async fn() {
    const fixture = semanticShaclFixture();
    const native = await nativeSemanticBackendFixture({
      addonPath: addonPath!,
      ...fixture,
    });
    try {
      const answer = await native.backend.validate(native.version);
      const pin = await native.backend.readGraph(
        native.version,
        native.build.sourceDigest,
        (graph) => ({ build: graph.build, projection: graph.projection }),
      );
      assert.equal(answer.version, native.version);
      assert.equal(answer.sourceDigest, native.build.sourceDigest);
      assert.equal(answer.advisory, true);
      assert.deepEqual(answer.report.build, native.build);
      assert.deepEqual(answer.report.build, pin.build);
      assert.deepEqual(answer.report.projection, pin.projection);
      assert.equal(
        answer.report.projection?.artifactDigest,
        native.descriptor.artifactDigest,
      );
      assert.match(
        answer.report.projection?.projectionDigest ?? "",
        /^[0-9a-f]{64}$/,
      );
      assert.match(answer.report.contextDigest ?? "", /^[0-9a-f]{64}$/);
      assert.equal(answer.report.conforms, false);
      assert.equal(answer.report.unmappedResults, 0);
      assert.equal(answer.report.diagnostics.length, 2);
      assert.equal(answer.comparison.equal, true);
      assert.equal(answer.comparison.matched, 2);
      assert.deepEqual(answer.comparison.mismatched, []);
      assert.deepEqual(
        (await native.backend.validate(native.version)).report,
        answer.report,
      );
    } finally {
      await native.close();
    }
  },
});

Deno.test({
  name:
    "real native SHACL compiled Toolkit witness preserves budget, plan and network graph paths",
  ignore: !toolkitIntegrationEnabled || !addonPath,
  async fn() {
    const repositoryId = "git:d9db4850-4c32-5b9a-879e-4744cb9e3c3e";
    const sources = await loadInitialSources();
    sources["work-plans.sysml"] = await Deno.readTextFile(
      new URL("../../models/work-plans.sysml", import.meta.url),
    );
    const marker = "part liveBuilder : ConversationSystem {";
    const plan = `
      perform action executePlan : AssemblyWorkPlans::ExecuteClosedPlan;
      allocate executePlan to admissionGate;
      part planAccess : AssemblyInvocations::BehaviorAccess {
        attribute :>> name = "Execute plan";
        attribute :>> description = "Execute a complete bounded work plan.";
        attribute :>> enabled = true;
        ref item :>> input : AssemblyWorkPlans::WorkPlanRequest;
      }
      bind planAccess.caller = builder;
      bind planAccess.target = executePlan;
    `;
    const json = (hosts: string[]) => JSON.stringify(JSON.stringify(hosts));
    const original = sources["configuration.sysml"]!;
    assert.equal(original.split(marker).length, 2);
    assert.ok(original.includes('attribute :>> allowedHosts = "[]";'));
    assert.ok(original.includes('attribute networkHosts : String = "[]";'));
    sources["configuration.sysml"] = original.replace(marker, marker + plan)
      .replace(
        'attribute :>> allowedHosts = "[]";',
        `attribute :>> allowedHosts = ${json(["a.example", "b.example"])};`,
      )
      .replace(
        'attribute networkHosts : String = "[]";',
        `attribute networkHosts : String = ${json(["a.example"])};`,
      );
    const budget =
      `part invocationBudget : APEWorkBudget::InvocationBudgetPolicy {
    attribute :>> id = "initial-dossier-invocations";
    attribute :>> revision = 1;
    attribute :>> unit = "agent-invocation";
    attribute :>> limit = 1000;
    attribute :>> onExhausted = "wait";
    attribute :>> exhaustionRecipient = "local-control";
}`;
    assert.ok(sources["configuration.sysml"]!.includes(budget));
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const recipe = await compiler.recipe();
    for (const budgeted of [true, false]) {
      const exactSources = {
        ...sources,
        "configuration.sysml": budgeted
          ? sources["configuration.sysml"]!
          : sources["configuration.sysml"]!.replace(budget, ""),
      };
      const compiled = await compiler.compile(exactSources);
      const revision = {
        ...compiled,
        version: `native-shacl-toolkit-${budgeted ? "budget" : "missing"}`,
      };
      const model = await validateSourceExecutable(
        revision,
        repositoryId,
      );
      assert.equal(model.identity.projectId, repositoryId);
      const facts = projectModelDiagnosticFacts(revision, [model]);
      const conversation = facts.graphContext!.units.find((unit) =>
        unit.kind === "conversation"
      );
      const plans = facts.graphContext!.units.filter((unit) =>
        unit.kind === "plan"
      );
      assert.equal(conversation?.elementId, model.identity.systemId);
      assert.equal(conversation?.ownerSystemId, model.identity.systemId);
      assert.equal(
        plans.length,
        1,
        "real BehaviorAccess must admit one owner-exposed plan",
      );
      assert.ok(
        plans.every((unit) => unit.ownerSystemId === model.identity.systemId),
      );
      const budgetElement = compiled.elements.find((element) =>
        element.qualifiedName ===
          "AssemblyLiveBuilder::liveBuilder::invocationBudget"
      );
      if (budgeted) {
        assert.ok(budgetElement);
        assert.equal(model.workBudgetPolicy?.elementId, budgetElement["@id"]);
        assert.equal(conversation?.budgetPolicyId, budgetElement["@id"]);
        assert.ok(
          plans.every((unit) => unit.budgetPolicyId === budgetElement["@id"]),
        );
      } else {
        assert.equal(model.workBudgetPolicy, undefined);
        assert.equal(conversation?.budgetPolicyId, undefined);
        assert.ok(plans.every((unit) => unit.budgetPolicyId === undefined));
      }
      const literals = sourceLiterals(compiled.elements);
      for (const capability of facts.graphContext!.capabilities) {
        const allowed = literals.filter((literal) =>
          literal.owner === capability.policyElementId &&
          literal.name === "allowedHosts"
        );
        const network = literals.filter((literal) =>
          literal.owner === capability.ownerSystemId &&
          literal.name === "networkHosts"
        );
        assert.equal(
          allowed.length,
          1,
          "compiled SkillPolicy must identify its exact native attribute",
        );
        assert.equal(
          network.length,
          1,
          "compiled owner must identify its exact network attribute",
        );
        assert.equal(
          capability.allowedHostsAttributeId,
          allowed[0]!.attributeId,
        );
        assert.equal(
          capability.networkHostsAttributeId,
          network[0]!.attributeId,
        );
      }
      assert.deepEqual(model.skillPolicy?.allowedHosts, [
        "a.example",
        "b.example",
      ]);
      assert.deepEqual(model.configuration.network?.allowedHosts, [
        "a.example",
      ]);
      const native = await nativeSemanticBackendFixture({
        addonPath: addonPath!,
        repositoryId,
        observeLoad: (load, artifactBytes) =>
          console.log(JSON.stringify({
            qualification: "compiled Toolkit native projection load",
            budgeted,
            artifactBytes,
            projection: load.projection,
            ...nativeProjectionMeasurements(load.quads, compiled.elements),
          })),
        observeQuery: (observation) =>
          console.log(JSON.stringify({
            qualification: "compiled Toolkit native SELECT",
            budgeted,
            ...observation,
          })),
        elements: compiled.elements,
        facts,
        sources: exactSources,
        compiled,
        recipe,
      });
      try {
        const answer = await native.backend.validate(native.version);
        const expected = lintModelDiagnostics(facts).filter((diagnostic) =>
          ["LOOP_WITHOUT_BUDGET", "CAPABILITY_BEYOND_MANDATE"].includes(
            diagnostic.code,
          )
        );
        assert.deepEqual(answer.report.diagnostics, expected);
        assert.equal(
          answer.report.diagnostics.filter((diagnostic) =>
            diagnostic.code === "LOOP_WITHOUT_BUDGET"
          ).length,
          budgeted ? 0 : 2,
        );
        assert.equal(
          answer.report.diagnostics.filter((diagnostic) =>
            diagnostic.code === "CAPABILITY_BEYOND_MANDATE"
          ).length,
          1,
        );
        assert.equal(answer.comparison.equal, true);
        assert.equal(answer.comparison.matched, budgeted ? 1 : 3);
        assert.deepEqual(answer.report.build, native.build);
        assert.equal(native.build.repositoryId, repositoryId);
        assert.equal(answer.report.build.repositoryId, repositoryId);
        assert.equal(
          answer.report.projection?.artifactDigest,
          native.descriptor.artifactDigest,
        );
        console.log(JSON.stringify({
          qualification: "compiled Toolkit to native SHACL",
          budgeted,
          elements: compiled.elements.length,
          findings: answer.report.diagnostics.length,
          build: native.build,
          projection: answer.report.projection,
        }));
      } catch (error) {
        console.log(JSON.stringify({
          qualification: "compiled Toolkit native SHACL failure",
          budgeted,
          ...nativeFixtureFailure(error),
        }));
        throw error;
      } finally {
        await native.close();
      }
    }
  },
});
