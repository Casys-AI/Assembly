import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { kill } from "node:process";
import { set as setBlob } from "@kitsonk/kv-toolbox/blob";
import {
  artifactPayload,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest,
} from "../../src/domain/model/value-objects/build.ts";
import { buildRefFromDescriptor } from "../../src/domain/model/value-objects/element-ref.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { sha256HexOfBytes } from "../../src/application/model/builds/service.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import { SemanticProjectionProcessClient } from "../../src/adapters/out/oxigraph/process-client.ts";

const recipe: BuildRecipeInputs = {
  toolkit: {
    version: "semantic-process-fixture",
    bundleDigest: "8".repeat(64),
  },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 2,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "semantic-process-fixture",
};
const elements = [
  {
    "@id": "part",
    "@type": "PartDefinition",
    ownedMember: [{ "@id": "lib" }, { "@id": "lib" }],
    empty: [],
  },
  {
    "@id": "lib",
    "@type": "PartDefinition",
    isLibraryElement: true,
    name: "Library Part",
  },
];
async function fixture(repositoryId = "semantic-process-fixture") {
  const directory = await Deno.makeTempDir({
    prefix: "ase-semantic-preparation-",
  });
  const cachePath = join(directory, "cache.kv");
  const vaultDirectory = join(directory, "vault");
  const bytes = new TextEncoder().encode(artifactPayload({
    engineVersion: recipe.engineVersion,
    provider: {
      name: "sysml-toolkit",
      version: recipe.engineVersion,
      format: recipe.format,
    },
    elements,
  }));
  const sourceDigest = await modelSourceDigest({
    "fixture.sysml": "package Fixture { part def Part; }",
  });
  const digest = await recipeDigest(recipe);
  const descriptor = buildDescriptor({
    repositoryId,
    sourceDigest,
    recipe,
    recipeDigest: digest,
    buildKey: await buildKey(sourceDigest, digest),
    artifactDigest: await sha256HexOfBytes(bytes),
    bytes: bytes.byteLength,
  });
  const build = buildRefFromDescriptor(descriptor);
  return { directory, cachePath, vaultDirectory, bytes, descriptor, build };
}
function failure(code: string) {
  return (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === code;
}
async function waitForProjection(store: KvModelBuildStore): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    if ((await store.stats()).projectionCount > 0) return;
    if (performance.now() > deadline) {
      throw new Error("Timed out waiting for fixture commit marker");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test("semantic preparation process: cold exact projection, small controls, complete cache restart", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  let client: SemanticProjectionProcessClient | undefined;
  const controls: { direction: string; bytes: number }[] = [];
  const spawned: number[] = [], exited: number[] = [];
  try {
    await store.put(f.build.artifactDigest, f.bytes);
    const expected = await new DeterministicRdfModelProjector().project({
      build: f.build,
      elements,
      libraryNativeIds: ["lib"],
    });
    client = new SemanticProjectionProcessClient({
      ...f,
      observer: {
        onControl: (item) => controls.push(item),
        onSpawn: ({ pid }) => spawned.push(pid),
        onExit: ({ pid }) => exited.push(pid),
      },
    });
    const first = await client.prepare({
      build: f.build,
      descriptor: f.descriptor,
    });
    deepStrictEqual(first, { projection: expected.projection });
    deepStrictEqual(
      await store.getProjection(
        first.projection.kind,
        first.projection.projectorVersion,
        f.build.artifactDigest,
      ),
      expected.quads,
    );
    deepStrictEqual(exited, spawned);
    equal(controls.length, 2);
    ok(controls.every((entry) => entry.bytes < 4096));
    await client.close();
    client = new SemanticProjectionProcessClient(f);
    deepStrictEqual(
      await client.prepare({ build: f.build, descriptor: f.descriptor }),
      first,
    );
    equal((await store.stats()).projectionCount, 1);
  } finally {
    await client?.close();
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process permits KV writes but denies mutation of the nested durable vault", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  await store.close();
  await Deno.mkdir(f.vaultDirectory, { recursive: true });
  const sentinel = join(f.vaultDirectory, "durable-sentinel");
  await Deno.writeTextFile(sentinel, "durable artifact");
  const before = await Deno.readFile(sentinel);
  const client = new SemanticProjectionProcessClient({
    ...f,
    processUrl: new URL(
      "../support/semantic-projection-permission-probe.ts",
      import.meta.url,
    ),
  });
  try {
    await client.prepare({ build: f.build, descriptor: f.descriptor });
    deepStrictEqual(await Deno.readFile(sentinel), before);
    const names: string[] = [];
    for await (const entry of Deno.readDir(f.vaultDirectory)) {
      names.push(entry.name);
    }
    deepStrictEqual(names, ["durable-sentinel"]);
  } finally {
    await client.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: exact vault recovery without artifact in KV; missing and corrupt vault fail", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  const client = new SemanticProjectionProcessClient(f);
  const vault = new FileBuildVault({ directory: f.vaultDirectory });
  try {
    await rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("BUILD_UNAVAILABLE"),
    );
    await Deno.mkdir(f.vaultDirectory, { recursive: true });
    await Deno.writeTextFile(
      join(f.vaultDirectory, `${f.build.artifactDigest}.zst`),
      "corrupt vault",
    );
    await rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("BUILD_BLOB_CORRUPT"),
    );
    await vault.putVerified(f.build.artifactDigest, f.bytes);
    const result = await client.prepare({
      build: f.build,
      descriptor: f.descriptor,
    });
    equal(result.projection.artifactDigest, f.build.artifactDigest);
    equal(await store.has(f.build.artifactDigest), false);
    equal((await store.stats()).projectionCount, 1);
  } finally {
    await client.close();
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: wrong A, recipe and corrupted persisted projection are failures", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  const client = new SemanticProjectionProcessClient(f);
  try {
    await store.put(f.build.artifactDigest, f.bytes);
    await rejects(
      () =>
        client.prepare({
          build: { ...f.build, artifactDigest: "f".repeat(64) },
          descriptor: f.descriptor,
        }),
      failure("BUILD_DESCRIPTOR_MISMATCH"),
    );
    const altered = {
      ...f.descriptor,
      recipe: { ...f.descriptor.recipe, engineVersion: "wrong-engine" },
    };
    await rejects(
      () => client.prepare({ build: f.build, descriptor: altered }),
      failure("BUILD_DESCRIPTOR_MISMATCH"),
    );
    const prepared = await client.prepare({
      build: f.build,
      descriptor: f.descriptor,
    });
    const kv = await Deno.openKv(f.cachePath);
    try {
      const key = [
        "proj-meta",
        prepared.projection.kind,
        prepared.projection.projectorVersion,
        f.build.artifactDigest,
      ];
      const current = await kv.get<Record<string, unknown>>(key);
      await kv.set(key, { ...current.value, sha256: "0".repeat(64) });
    } finally {
      kv.close();
    }
    await rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("BUILD_BLOB_CORRUPT"),
    );
    const damaged = await Deno.openKv(f.cachePath);
    try {
      const metaKey = [
        "proj-meta",
        prepared.projection.kind,
        prepared.projection.projectorVersion,
        f.build.artifactDigest,
      ];
      const prior = await damaged.get<Record<string, unknown>>(metaKey);
      await damaged.set(metaKey, {
        ...prior.value,
        sha256: prepared.projection.projectionDigest,
      });
      const published = await damaged.get(metaKey);
      const physicalPrefix = [
        "proj-bytes",
        prepared.projection.projectionDigest,
      ];
      for await (const entry of damaged.list({ prefix: physicalPrefix })) {
        await damaged.delete(entry.key);
      }
      await rejects(
        () => client.prepare({ build: f.build, descriptor: f.descriptor }),
        failure("BUILD_BLOB_MISSING"),
      );
      deepStrictEqual(await damaged.get(metaKey), published);
      let physicalKeys = 0;
      for await (const _entry of damaged.list({ prefix: physicalPrefix })) {
        physicalKeys++;
      }
      equal(
        physicalKeys,
        0,
        "Preparation must not repair a published incomplete projection",
      );
    } finally {
      damaged.close();
    }
  } finally {
    await client.close();
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: concurrent clients publish one immutable projection with independent lifetimes", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  const clients = [
    new SemanticProjectionProcessClient(f),
    new SemanticProjectionProcessClient(f),
  ];
  try {
    await store.put(f.build.artifactDigest, f.bytes);
    const [left, right] = await Promise.all(
      clients.map((client) =>
        client.prepare({ build: f.build, descriptor: f.descriptor })
      ),
    );
    deepStrictEqual(left, right);
    equal((await store.stats()).projectionCount, 1);
    equal((await store.stats()).leaseCount, 0);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: healthy vault recovers corrupt A cache without repair, while corrupt RDF still refuses", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  const client = new SemanticProjectionProcessClient(f);
  const vault = new FileBuildVault({ directory: f.vaultDirectory });
  try {
    await store.put(f.build.artifactDigest, f.bytes);
    const raw = await Deno.openKv(f.cachePath);
    try {
      await setBlob(
        raw,
        ["build", "blob", f.build.artifactDigest],
        new Uint8Array([1, 2, 3]).buffer,
      );
    } finally {
      raw.close();
    }
    await rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("BUILD_BLOB_CORRUPT"),
    );
    await vault.putVerified(f.build.artifactDigest, f.bytes);
    const prepared = await client.prepare({
      build: f.build,
      descriptor: f.descriptor,
    });
    equal(prepared.projection.artifactDigest, f.build.artifactDigest);
    await rejects(
      () => store.get(f.build.artifactDigest),
      failure("BUILD_BLOB_CORRUPT"),
    );
    const corruptProjection = await Deno.openKv(f.cachePath);
    try {
      const metaKey = [
        "proj-meta",
        prepared.projection.kind,
        prepared.projection.projectorVersion,
        f.build.artifactDigest,
      ];
      const meta = await corruptProjection.get<Record<string, unknown>>(
        metaKey,
      );
      await corruptProjection.set(metaKey, {
        ...meta.value,
        sha256: "0".repeat(64),
      });
    } finally {
      corruptProjection.close();
    }
    await rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("BUILD_BLOB_CORRUPT"),
    );
  } finally {
    await client.close();
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: timeout and crash terminate observed children", async () => {
  const f = await fixture();
  try {
    for (
      const [fixtureName, expected, timeoutMs] of [
        ["semantic-projection-hang.ts", "INDEX_TIMEOUT", 500],
        ["semantic-projection-crash.ts", "INDEX_UNAVAILABLE", 5000],
      ] as const
    ) {
      const spawned: number[] = [], exited: number[] = [];
      const client = new SemanticProjectionProcessClient({
        ...f,
        timeoutMs,
        processUrl: new URL(`../support/${fixtureName}`, import.meta.url),
        observer: {
          onSpawn: ({ pid }) => spawned.push(pid),
          onExit: ({ pid }) => exited.push(pid),
        },
      });
      try {
        await rejects(
          () => client.prepare({ build: f.build, descriptor: f.descriptor }),
          failure(expected),
        );
      } finally {
        await client.close();
      }
      equal(spawned.length, 1);
      deepStrictEqual(exited, spawned);
      for (const pid of spawned) {
        let alive = true;
        try {
          kill(pid, 0);
        } catch {
          alive = false;
        }
        equal(alive, false);
      }
    }
  } finally {
    await Deno.remove(f.directory, { recursive: true });
  }
});

Deno.test("semantic preparation process: close refuses post-commit late success; fresh client reuses verified committed cache", async () => {
  const f = await fixture();
  const store = await KvModelBuildStore.open({ path: f.cachePath });
  const spawned: number[] = [], exited: number[] = [];
  const client = new SemanticProjectionProcessClient({
    ...f,
    processUrl: new URL(
      "../support/semantic-projection-stall-after-commit.ts",
      import.meta.url,
    ),
    observer: {
      onSpawn: ({ pid }) => spawned.push(pid),
      onExit: ({ pid }) => exited.push(pid),
    },
  });
  let retry: SemanticProjectionProcessClient | undefined;
  try {
    await store.put(f.build.artifactDigest, f.bytes);
    const result = rejects(
      () => client.prepare({ build: f.build, descriptor: f.descriptor }),
      failure("INDEX_UNAVAILABLE"),
    );
    await waitForProjection(store);
    await client.close();
    await result;
    deepStrictEqual(exited, spawned);
    equal((await store.stats()).projectionCount, 1);
    retry = new SemanticProjectionProcessClient(f);
    const prepared = await retry.prepare({
      build: f.build,
      descriptor: f.descriptor,
    });
    equal(prepared.projection.artifactDigest, f.build.artifactDigest);
    equal((await store.stats()).projectionCount, 1);
  } finally {
    await client.close();
    await retry?.close();
    await store.close();
    await Deno.remove(f.directory, { recursive: true });
  }
});
