import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
/** Real W5/W6 contract runs, executed by the coordinator only.
 *
 * Gates (all off by default, like the Toolkit suites):
 * - native index: ASSEMBLY_SEMANTIC_INTEGRATION=1 and
 *   ASSEMBLY_SEMANTIC_INDEX_ADDON=<path to built ase-semantic-index-napi .node>
 * - SHACL engine: ASSEMBLY_SHACL_INTEGRATION=1 (deps pinned in deno.json)
 *
 * The element source and projection cache below are W2 port doubles;
 * everything downstream of them (projector, service, process executor,
 * Oxigraph addon, LDkit reader, SHACL mapping) is production code.
 */
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import {
  lintModelDiagnostics,
  type ModelDiagnosticFacts,
} from "../../src/domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { sha256HexOfBytes } from "../../src/application/model/builds/service.ts";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";
import {
  ModelSemanticIndexService,
  SemanticIndexError,
} from "../../src/application/model/semantic/index-service.ts";
import type { SemanticProjectionCache } from "../../src/application/model/semantic/ports/out/semantic-projection-cache.port.ts";
import { compareDiagnostics } from "../../src/application/model/diagnostics/shapes.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import {
  DenoChildProcessRequester,
  type DenoChildRequesterOptions,
  OxigraphNativeIndex,
  ProcessSemanticIndexExecutor,
  semanticProcessCommandArgs,
} from "../../src/adapters/out/oxigraph/oxigraph.ts";
import { BoundModelReader } from "../../src/adapters/out/oxigraph/ldkit-reader.ts";
import {
  createRdfValidateShaclEngine,
  ShaclModelDiagnostics,
} from "../../src/adapters/out/shacl/diagnostics.ts";

const addonPath = readAssemblyEnv("ASSEMBLY_SEMANTIC_INDEX_ADDON");
const nativeEnabled = readAssemblyEnv("ASSEMBLY_SEMANTIC_INTEGRATION") === "1";
const shaclEnabled = readAssemblyEnv("ASSEMBLY_SHACL_INTEGRATION") === "1";

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

class MemoryProjectionCache implements SemanticProjectionCache {
  #store = new Map<string, Uint8Array>();
  #leases = new Map<string, string>();
  #key = (kind: string, version: string, artifact: string) =>
    [kind, version, artifact].join(":");
  hasProjection(kind: string, version: string, artifact: string) {
    return Promise.resolve(this.#store.has(this.#key(kind, version, artifact)));
  }
  getProjection(kind: string, version: string, artifact: string) {
    const bytes = this.#store.get(this.#key(kind, version, artifact));
    if (!bytes) {
      return Promise.reject(
        new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
      );
    }
    return Promise.resolve(bytes);
  }
  putProjection(
    kind: string,
    version: string,
    artifact: string,
    bytes: Uint8Array,
  ) {
    this.#store.set(this.#key(kind, version, artifact), bytes);
    return Promise.resolve({
      stored: true,
      bytes: bytes.length,
      digest: digest("0"),
    });
  }
  acquireLease(key: string, owner: string) {
    if (this.#leases.has(key)) return Promise.resolve(false);
    this.#leases.set(key, owner);
    return Promise.resolve(true);
  }
  releaseLease(key: string, owner: string) {
    if (this.#leases.get(key) === owner) this.#leases.delete(key);
    return Promise.resolve();
  }
}

async function nativeService(options: Partial<DenoChildRequesterOptions> = {}) {
  const requester = new DenoChildProcessRequester({
    addonPath: addonPath!,
    expectedAddonSha256: await sha256HexOfBytes(
      await Deno.readFile(addonPath!),
    ),
    ...options,
  });
  const service = new ModelSemanticIndexService({
    source: {
      verifiedElements() {
        return Promise.resolve({ elements, libraryNativeIds: [] });
      },
    },
    projector: new DeterministicRdfModelProjector(),
    cache: new MemoryProjectionCache(),
    native: new OxigraphNativeIndex(
      new ProcessSemanticIndexExecutor(requester),
    ),
  });
  return { service, requester };
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

const shaclFacts: ModelDiagnosticFacts = {
  units: [
    {
      location: { elementId: "sys", qualifiedName: "Sys" },
      kind: "conversation",
      hasInvocationBudget: false,
      accountableHumanDeclared: true,
    },
    {
      location: { elementId: "plan" },
      kind: "plan",
      hasInvocationBudget: true,
      accountableHumanDeclared: true,
    },
  ],
  effects: [],
  networkCapabilities: [
    {
      location: { elementId: "policy" },
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

Deno.test({
  name: "real SHACL engine matches the TS lint on both qualified rules",
  ignore: !shaclEnabled,
  async fn() {
    const service = new ShaclModelDiagnostics({
      engine: () => createRdfValidateShaclEngine(),
    });
    const report = await service.validateBuild({ build, facts: shaclFacts });
    assert.equal(report.conforms, false);
    assert.equal(report.unmappedResults, 0);
    const comparison = compareDiagnostics({
      shacl: report.diagnostics,
      reference: lintModelDiagnostics(shaclFacts),
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
  },
});
