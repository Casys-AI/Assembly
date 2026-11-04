import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import {
  BLOB_KEY,
  BLOB_META_KEY,
  set as setBlob,
} from "@kitsonk/kv-toolbox/blob";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";
import { SemanticIndexError } from "../../src/application/model/semantic/index-service.ts";
import {
  KvModelBuildReadLimitError,
  KvModelBuildStore,
} from "../../src/adapters/out/deno-kv/kv-store.ts";
import { sha256 } from "../../src/domain/model/value-objects/artifact.ts";
import { MAX_PRIVATE_PAYLOAD_BYTES } from "../../src/infrastructure/native/private-payload.ts";
import { semanticProcessCommandArgs } from "../../src/adapters/out/oxigraph/oxigraph.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import {
  type NativeSemanticIndexRuntime,
  openNativeSemanticIndex,
} from "../../src/adapters/out/oxigraph/runtime.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";

const nativeEnabled = readAssemblyEnv("ASSEMBLY_SEMANTIC_INTEGRATION") === "1";

Deno.test("native command permits exact-cache KV operations and denies all nested vault mutations", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "native-cache-permissions-",
  });
  const path = `${directory}/builds/cache.kv`;
  const snapshotDirectory = `${directory}/snapshots`;
  const vaultDirectory = `${directory}/builds/vault`;
  const sentinel = `${vaultDirectory}/durable-sentinel`;
  try {
    await Deno.mkdir(snapshotDirectory);
    await Deno.mkdir(vaultDirectory, { recursive: true });
    await Deno.writeTextFile(sentinel, "durable artifact");
    const original = await Deno.readFile(sentinel);
    const cache = await KvModelBuildStore.open({ path });
    try {
      await cache.putProjection(
        "rdf-quads",
        "permissions-v1",
        "a".repeat(64),
        new Uint8Array([1, 2, 3]),
      );
    } finally {
      await cache.close();
    }
    const args = semanticProcessCommandArgs(
      {
        addonPath: "/unused/addon.node",
        expectedAddonSha256: "0".repeat(64),
        buildCachePath: path,
        hostModule: new URL(
          "../support/semantic-native-permission-probe.ts",
          import.meta.url,
        ).href,
      },
      "permission-test",
      snapshotDirectory,
    );
    const child = await new Deno.Command(Deno.execPath(), {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(child.success, true, new TextDecoder().decode(child.stderr));
    assert.equal(
      new TextDecoder().decode(child.stdout).trim(),
      "KV works; vault mutations denied",
    );
    assert.deepEqual(await Deno.readFile(sentinel), original);
    const names: string[] = [];
    for await (const entry of Deno.readDir(vaultDirectory)) {
      names.push(entry.name);
    }
    assert.deepEqual(names, ["durable-sentinel"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("bounded projection reads stop before oversized allocations and preserve corruption and SHA checks", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "bounded-projection-cache-",
  });
  const path = `${directory}/cache.kv`;
  const cache = await KvModelBuildStore.open({ path });
  const raw = await Deno.openKv(path);
  let serial = 0;
  const limits = { maxUncompressedBytes: 32, maxCompressedBytes: 128 };
  const write = async (
    bytes: Uint8Array,
    metadata: { bytes?: number; sha256?: string } = {},
    compressed = Uint8Array.from(zstdCompressSync(bytes)),
  ) => {
    const artifact = (++serial).toString(16).padStart(64, "0");
    const physical = ["proj", "rdf-quads", "bounded-v1", artifact];
    const meta = ["proj-meta", "rdf-quads", "bounded-v1", artifact];
    await setBlob(raw, physical, Uint8Array.from(compressed).buffer);
    await raw.set(meta, {
      bytes: bytes.length,
      sha256: await sha256(bytes),
      ...metadata,
    });
    return { artifact, physical, meta };
  };
  const read = (fixture: { artifact: string }) =>
    cache.getProjectionBounded(
      "rdf-quads",
      "bounded-v1",
      fixture.artifact,
      limits,
    );
  const corrupt = (stage: string) => (error: unknown) =>
    error instanceof BuildStoreError && error.code === "BUILD_BLOB_CORRUPT" &&
    error.context.stage === stage;
  const limited = (stage: string) => (error: unknown) =>
    error instanceof KvModelBuildReadLimitError &&
    error.context.stage === stage;
  try {
    const validBytes = new Uint8Array([1, 2, 3, 4]);
    const valid = await write(validBytes);
    assert.deepEqual(await read(valid), validBytes);
    assert.deepEqual(
      await read(await write(new Uint8Array())),
      new Uint8Array(),
    );
    const oversize = await write(new Uint8Array(256));
    await assert.rejects(() => read(oversize), limited("projection-meta"));
    // Generic reads remain unbounded; this seam adds a consumer-specific limit.
    assert.equal(
      (await cache.getProjection("rdf-quads", "bounded-v1", oversize.artifact))
        .length,
      256,
    );
    await raw.delete([...oversize.physical, BLOB_META_KEY]);
    await assert.rejects(() => read(oversize), limited("projection-meta"));

    const expansion = await write(new Uint8Array(8192), { bytes: 8 });
    await assert.rejects(() => read(expansion), corrupt("decompress"));
    const malformed = await write(validBytes, {}, new Uint8Array([1, 2, 3]));
    await assert.rejects(() => read(malformed), corrupt("decompress"));
    const wrongDigest = await write(validBytes, { sha256: "0".repeat(64) });
    await assert.rejects(() => read(wrongDigest), corrupt("verify"));

    const compressedMeta = await write(validBytes);
    await raw.set([...compressedMeta.physical, BLOB_META_KEY], {
      kind: "buffer",
      size: 1024,
    });
    await assert.rejects(
      () => read(compressedMeta),
      limited("compressed-meta"),
    );
    await raw.set([...compressedMeta.physical, BLOB_META_KEY], {
      kind: "buffer",
      size: 1,
    });
    await assert.rejects(
      () => read(compressedMeta),
      corrupt("compressed-chunks"),
    );
    const compressedStream = await write(validBytes, {}, new Uint8Array(129));
    await raw.set([...compressedStream.physical, BLOB_META_KEY], {
      kind: "buffer",
    });
    await assert.rejects(
      () => read(compressedStream),
      limited("compressed-chunks"),
    );
    const emptyChunk = await write(validBytes);
    await raw.set([...emptyChunk.physical, BLOB_KEY, 1], new Uint8Array());
    await assert.rejects(() => read(emptyChunk), corrupt("compressed-chunks"));
  } finally {
    raw.close();
    await cache.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("existing-only build cache rejects absent and uninitialized stores without semantic writes", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "semantic-consumer-cache-",
  });
  try {
    const absent = `${directory}/missing/cache.kv`;
    await assert.rejects(
      () => KvModelBuildStore.open({ path: absent, existingOnly: true }),
      (error: unknown) =>
        error instanceof BuildStoreError &&
        error.code === "BUILD_STORE_UNAVAILABLE",
    );
    await assert.rejects(
      () => Deno.stat(`${directory}/missing`),
      Deno.errors.NotFound,
    );
    const path = `${directory}/empty.kv`;
    const uninitialized = await Deno.openKv(path);
    uninitialized.close();
    await assert.rejects(
      () => KvModelBuildStore.open({ path, existingOnly: true }),
      (error: unknown) =>
        error instanceof BuildStoreError &&
        error.code === "BUILD_STORE_UNAVAILABLE",
    );
    const raw = await Deno.openKv(path);
    try {
      assert.equal((await raw.get(["format"])).value, null);
      await raw.set(["format"], { schema: 99 });
      await assert.rejects(() =>
        KvModelBuildStore.open({ path, existingOnly: true })
      );
      assert.deepEqual((await raw.get(["format"])).value, { schema: 99 });
      await raw.delete(["format"]);
    } finally {
      raw.close();
    }
    const writer = await KvModelBuildStore.open({ path });
    await writer.close();
    const consumer = await KvModelBuildStore.open({ path, existingOnly: true });
    await consumer.close();
    const alias = `${directory}/alias.kv`;
    await Deno.symlink(path, alias);
    await assert.rejects(() =>
      KvModelBuildStore.open({ path: alias, existingOnly: true })
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function keyVersions(path: string): Promise<unknown[]> {
  const kv = await Deno.openKv(path);
  try {
    const entries: unknown[] = [];
    for await (const entry of kv.list({ prefix: [] })) {
      entries.push([entry.key, entry.versionstamp]);
    }
    return entries;
  } finally {
    kv.close();
  }
}

Deno.test({
  name:
    "native reference loading verifies KV locally, preserves pins and survives cache restart",
  ignore: !nativeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "native-semantic-reference-",
    });
    const path = `${directory}/cache.kv`;
    let runtime: NativeSemanticIndexRuntime | undefined;
    try {
      const build: BuildRef = {
        repositoryId: "reference-integration",
        sourceDigest: "1".repeat(64),
        recipeDigest: "2".repeat(64),
        buildKey: "3".repeat(64),
        artifactDigest: "4".repeat(64),
      };
      const secondBuild = {
        ...build,
        sourceDigest: "6".repeat(64),
        buildKey: "7".repeat(64),
      };
      const projected = await new DeterministicRdfModelProjector().project({
        build,
        libraryNativeIds: [],
        elements: [{
          "@id": "pkg",
          "@type": "Package",
          declaredName: "Reference",
          ownedMember: [{ "@id": "part" }, { "@id": "part" }],
          empty: [],
        }, { "@id": "part", "@type": "PartUsage", declaredName: "p" }],
      });
      runtime = await openNativeSemanticIndex({ buildCachePath: path });
      await assert.rejects(
        () =>
          runtime!.native.loadReference({
            build,
            projection: projected.projection,
          }),
        (error: unknown) =>
          error instanceof BuildStoreError &&
          error.code === "BUILD_STORE_UNAVAILABLE",
      );
      await assert.rejects(() => Deno.stat(path), Deno.errors.NotFound);
      const cache = await KvModelBuildStore.open({ path });
      try {
        await cache.putProjection(
          projected.projection.kind,
          projected.projection.projectorVersion,
          build.artifactDigest,
          projected.quads,
        );
      } finally {
        await cache.close();
      }
      const before = await keyVersions(path);
      await assert.rejects(
        () =>
          runtime!.native.loadReference({
            build,
            projection: {
              ...projected.projection,
              projectionDigest: "0".repeat(64),
            },
          }),
        (error: unknown) =>
          error instanceof SemanticIndexError &&
          error.code === "INDEX_PROJECTION_CORRUPT",
      );
      assert.equal(await runtime.native.isLoaded(build), false);
      await assert.rejects(
        () =>
          runtime!.native.loadReference({
            build,
            projection: {
              ...projected.projection,
              projectorVersion: "absent-version",
            },
          }),
        (error: unknown) =>
          error instanceof BuildStoreError &&
          error.code === "BUILD_BLOB_MISSING",
      );
      const loaded = await runtime.native.loadReference({
        build,
        projection: projected.projection,
      });
      assert.equal(loaded.quadCount, projected.quadCount);
      assert.equal(await runtime.native.isLoaded(build), true);
      assert.deepEqual(
        await runtime.native.query({
          build,
          sparql: "ASK { ?s ?p ?o }",
          limits: { maxResults: 1, maxBytes: 1024, timeoutMs: 5000 },
        }),
        { form: "boolean", value: true },
      );
      const count = await runtime.native.query({
        build,
        sparql: "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }",
        limits: { maxResults: 1, maxBytes: 1024, timeoutMs: 5000 },
      });
      assert.equal(count.form, "solutions");
      if (count.form === "solutions") {
        assert.equal(count.rows[0]?.n.value, String(projected.quadCount));
      }
      await runtime.native.loadReference({
        build: secondBuild,
        projection: projected.projection,
      });
      await runtime.native.release(build);
      assert.equal(await runtime.native.isLoaded(build), false);
      assert.equal(await runtime.native.isLoaded(secondBuild), true);
      await runtime.close();
      runtime = await openNativeSemanticIndex({ buildCachePath: path });
      assert.deepEqual(
        await runtime.native.loadReference({
          build,
          projection: projected.projection,
        }),
        { quadCount: projected.quadCount },
      );
      assert.deepEqual(
        await keyVersions(path),
        before,
        "native consumer must not put or sweep semantic data",
      );
      const raw = await Deno.openKv(path);
      try {
        await raw.set([
          "proj-meta",
          projected.projection.kind,
          projected.projection.projectorVersion,
          build.artifactDigest,
        ], {
          sha256: projected.projection.projectionDigest,
          bytes: MAX_PRIVATE_PAYLOAD_BYTES + 1,
        });
        await assert.rejects(
          () =>
            runtime!.native.loadReference({
              build: secondBuild,
              projection: projected.projection,
            }),
          (error: unknown) =>
            error instanceof SemanticIndexError &&
            error.code === "INDEX_QUERY_LIMIT",
        );
        await raw.set([
          "proj-meta",
          projected.projection.kind,
          projected.projection.projectorVersion,
          build.artifactDigest,
        ], { sha256: "invalid", bytes: projected.quads.byteLength });
      } finally {
        raw.close();
      }
      await assert.rejects(
        () =>
          runtime!.native.loadReference({
            build: secondBuild,
            projection: projected.projection,
          }),
        (error: unknown) =>
          error instanceof BuildStoreError &&
          error.code === "BUILD_BLOB_CORRUPT",
      );
      assert.equal(await runtime.native.isLoaded(secondBuild), false);
      assert.equal(
        await runtime.native.isLoaded(build),
        true,
        "failed read must not erase an already loaded graph",
      );
    } finally {
      await runtime?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
