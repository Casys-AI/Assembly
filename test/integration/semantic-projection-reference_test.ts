/** Small complete production composition: repository pin → disposable preparer
 * → shared KV reference → native process. No compiler or user stores. */
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  artifactDigest,
  artifactPayload,
  buildDescriptor,
  buildKey,
  recipeDigest,
} from "../../src/domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { buildRefFromDescriptor } from "../../src/domain/model/value-objects/element-ref.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import { SemanticProjectionProcessClient } from "../../src/adapters/out/oxigraph/process-client.ts";
import { openNativeSemanticIndex } from "../../src/adapters/out/oxigraph/runtime.ts";
import { createModelSemanticBackend } from "../../src/adapters/out/oxigraph/backend.ts";
import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";

const nativeEnabled = readAssemblyEnv("ASSEMBLY_SEMANTIC_INTEGRATION") === "1";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function fixture(id: number) {
  const sources = { "model.sysml": `package P${id};` };
  const sourceDigest = await modelSourceDigest(sources);
  const elements: JsonObject[] = [
    {
      "@id": "pkg",
      "@type": "Package",
      name: `P${id}`,
      ownedMember: [{ "@id": "part" }, { "@id": "part" }, { "@id": "library" }],
      emptyList: [],
    },
    { "@id": "part", "@type": "PartUsage", owner: { "@id": "pkg" } },
    { "@id": "library", "@type": "PartDefinition", isLibraryElement: true },
  ];
  const recipe = {
    toolkit: { version: "fixture-1", bundleDigest: "b".repeat(64) },
    format: "ase-toolkit-normalized-json-v1",
    normalizerVersion: 2,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "fixture-1",
  };
  const artifact = {
    provider: {
      name: "sysml-toolkit",
      version: "fixture-1",
      format: recipe.format,
    },
    engineVersion: recipe.engineVersion,
    elements,
  };
  const bytes = new TextEncoder().encode(artifactPayload(artifact));
  const recipeHash = await recipeDigest(recipe);
  const descriptor = buildDescriptor({
    repositoryId: "reference-integration",
    sourceDigest,
    recipe,
    recipeDigest: recipeHash,
    buildKey: await buildKey(sourceDigest, recipeHash),
    artifactDigest: await artifactDigest(artifact),
    bytes: bytes.byteLength,
  });
  const build = buildRefFromDescriptor(descriptor);
  const expected = await new DeterministicRdfModelProjector().project({
    build,
    elements,
    libraryNativeIds: ["library"],
  });
  return {
    version: `commit:${String(id).repeat(40)}`,
    sources,
    sourceDigest,
    bytes,
    descriptor,
    build,
    expected,
  };
}

Deno.test({
  name:
    "reference production composition matches RDF/count, reloads cache, recovers vault and queries while another child waits",
  ignore: !nativeEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-semantic-ref-production-",
    });
    const storage = {
      cachePath: join(directory, "cache.kv"),
      vaultDirectory: join(directory, "vault"),
    };
    const store = await KvModelBuildStore.open({ path: storage.cachePath });
    const vault = new FileBuildVault({ directory: storage.vaultDirectory });
    const first = await fixture(1), second = await fixture(2);
    const fixtures = new Map([first, second].map((f) => [f.version, f]));
    const controls: number[] = [];
    const spawned: number[] = [], exited: number[] = [];
    const thirdSpawn = gate();
    const preparer = new SemanticProjectionProcessClient({
      ...storage,
      observer: {
        onSpawn({ pid }) {
          spawned.push(pid);
          if (spawned.length === 3) thirdSpawn.resolve();
        },
        onExit({ pid }) {
          exited.push(pid);
        },
        onControl({ bytes }) {
          controls.push(bytes);
        },
      },
    });
    const native = await openNativeSemanticIndex({
      buildCachePath: storage.cachePath,
    });
    let byteLoads = 0, resolves = 0;
    const backend = createModelSemanticBackend({
      repositoryId: first.build.repositoryId,
      repository: {
        header(version) {
          const f = fixtures.get(version)!;
          return Promise.resolve({
            version,
            sources: f.sources,
            sourceDigest: f.sourceDigest,
          });
        },
        descriptorAt: (version) =>
          Promise.resolve(fixtures.get(version)!.descriptor),
      },
      buildService: {
        resolve() {
          resolves++;
          throw new Error("Parent artifact materialization is prohibited");
        },
      },
      projectionPreparer: preparer,
      native: {
        load() {
          byteLoads++;
          throw new Error("Parent RDF transport is prohibited");
        },
        loadReference: (input) => native.native.loadReference!(input),
        query: (input) => native.native.query(input),
        isLoaded: (build) => native.native.isLoaded(build),
        release: (build) => native.native.release(build),
      },
    });
    try {
      await store.put(first.build.artifactDigest, first.bytes);
      await vault.putVerified(second.build.artifactDigest, second.bytes);
      const readFirst = () =>
        backend.readGraph(first.version, first.sourceDigest, async (graph) => {
          assert.deepEqual(graph.projection, first.expected.projection);
          const result = await graph.query(
            "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }",
          );
          assert.equal(result.form, "solutions");
          if (result.form === "solutions") {
            assert.equal(
              Number(result.rows[0]!.count.value),
              first.expected.quadCount,
            );
          }
          return graph.projection;
        });
      const cold = await readFirst();
      const persisted = await store.getProjection(
        cold!.kind,
        cold!.projectorVersion,
        cold!.artifactDigest,
      );
      assert.deepEqual(persisted, first.expected.quads);
      await backend.release(first.version);
      assert.deepEqual(await readFirst(), cold);
      const projection = second.expected.projection;
      const leaseKey =
        `projection:${projection.kind}:${projection.projectorVersion}:${projection.artifactDigest}`;
      assert.equal(
        await store.acquireLease(leaseKey, "controlled-other-preparer", 60_000),
        true,
      );
      let settled = false;
      const waiting = backend.readGraph(
        second.version,
        second.sourceDigest,
        (graph) => {
          assert.deepEqual(graph.build, second.build);
          assert.deepEqual(graph.projection, second.expected.projection);
          return graph.query("ASK { ?s ?p ?o }");
        },
      ).finally(() => settled = true);
      try {
        await thirdSpawn.promise;
        // The other real preparation process owns no query-worker slot.
        await readFirst();
        assert.equal(settled, false);
        assert.equal(preparer.stats().active, 1);
      } finally {
        await store.releaseLease(leaseKey, "controlled-other-preparer");
      }
      assert.deepEqual(await waiting, { form: "boolean", value: true });
      assert.equal(await store.has(second.build.artifactDigest), false);
      assert.equal(byteLoads, 0);
      assert.equal(resolves, 0);
      assert.equal(controls.length, 6);
      assert(controls.every((size) => size < 2048));
      assert.deepEqual(exited, spawned);
    } finally {
      await preparer.close();
      await backend.close();
      await native.close();
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
