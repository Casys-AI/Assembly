import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { sha256HexOfBytes } from "../../../application/model/builds/service.ts";
import {
  BuildStoreError,
  type BuildStoreErrorCode,
} from "../../../application/model/builds/ports/out/build-store.port.ts";
import type { ModelRdfProjector } from "../../../application/model/semantic/ports/out/rdf-projector.port.ts";
import type { JsonObject } from "../../../domain/model/records/compiled-model.ts";
import {
  artifactPayload,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { buildRefFromDescriptor } from "../../../domain/model/value-objects/element-ref.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  ASE_VOCAB,
  DeterministicRdfModelProjector,
  listPredicate,
  parseNQuads,
} from "./rdf.ts";
import {
  prepareSemanticProjection,
  type SemanticPreparationDependencies,
  type SemanticProjectionPreparationInput,
} from "./preparation.ts";

const recipe: BuildRecipeInputs = {
  toolkit: { version: "semantic-fixture", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 2,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "semantic-fixture",
};
const elements: JsonObject[] = [{
  "@id": "package",
  "@type": "Package",
  ownedMember: [{ "@id": "part" }, { "@id": "part" }],
  emptyList: [],
}, {
  "@id": "part",
  "@type": "PartUsage",
  typing: [{ "@id": "library-part" }],
}, {
  "@id": "library-part",
  "@type": "PartDefinition",
  isLibraryElement: true,
}];
const realProjector = new DeterministicRdfModelProjector();

async function fixture(rows = elements) {
  const bytes = new TextEncoder().encode(artifactPayload({
    provider: {
      name: "sysml-toolkit",
      version: recipe.engineVersion,
      format: recipe.format,
    },
    engineVersion: recipe.engineVersion,
    elements: rows,
  }));
  const sourceDigest = await modelSourceDigest({
    "fixture.sysml": "package Fixture { part p; }",
  });
  const digest = await recipeDigest(recipe);
  const descriptor = buildDescriptor({
    repositoryId: "preparation-fixture",
    sourceDigest,
    recipe,
    recipeDigest: digest,
    buildKey: await buildKey(sourceDigest, digest),
    artifactDigest: await sha256HexOfBytes(bytes),
    bytes: bytes.byteLength,
  });
  const input = { build: buildRefFromDescriptor(descriptor), descriptor };
  const expected = await realProjector.project({
    build: input.build,
    elements: rows,
    libraryNativeIds: rows.filter((row) => row.isLibraryElement === true)
      .map((row) => String(row["@id"])),
  });
  return { input, bytes, expected };
}

const key = (kind: string, version: string, artifact: string) =>
  JSON.stringify([kind, version, artifact]);
function failure(code: string) {
  return (error: unknown): boolean => {
    equal((error as { code?: string }).code, code);
    return true;
  };
}
function storedFailure(code: BuildStoreErrorCode) {
  return new BuildStoreError(code, { fixture: true }, code);
}

type PreparationStore = SemanticPreparationDependencies["store"];
class Store implements PreparationStore {
  readonly projections = new Map<string, Uint8Array>();
  readonly acquisitions: { key: string; owner: string; ttlMs: number }[] = [];
  readonly releases: { key: string; owner: string }[] = [];
  readonly reads: string[][] = [];
  readonly puts: { key: string; bytes: Uint8Array }[] = [];
  getError?: Error;
  projectionError?: Error;
  putError?: Error;
  persistedDigest?: string;
  leaseOwner?: string;
  constructor(readonly bytes: Uint8Array) {}
  get(_digest: string): Promise<Uint8Array> {
    if (this.getError) return Promise.reject(this.getError);
    return Promise.resolve(this.bytes.slice());
  }
  hasProjection(
    kind: string,
    version: string,
    artifact: string,
  ): Promise<boolean> {
    return Promise.resolve(this.projections.has(key(kind, version, artifact)));
  }
  getProjection(
    kind: string,
    version: string,
    artifact: string,
  ): Promise<Uint8Array> {
    this.reads.push([kind, version, artifact]);
    if (this.projectionError) return Promise.reject(this.projectionError);
    const bytes = this.projections.get(key(kind, version, artifact));
    return bytes
      ? Promise.resolve(bytes.slice())
      : Promise.reject(storedFailure("BUILD_BLOB_MISSING"));
  }
  async putProjection(
    kind: string,
    version: string,
    artifact: string,
    bytes: Uint8Array,
  ) {
    if (this.putError) throw this.putError;
    const identity = key(kind, version, artifact);
    this.puts.push({ key: identity, bytes: bytes.slice() });
    this.projections.set(identity, bytes.slice());
    return {
      stored: true,
      bytes: bytes.byteLength,
      digest: this.persistedDigest ?? await sha256HexOfBytes(bytes),
    };
  }
  acquireLease(
    leaseKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    this.acquisitions.push({ key: leaseKey, owner, ttlMs });
    if (this.leaseOwner && this.leaseOwner !== owner) {
      return Promise.resolve(false);
    }
    this.leaseOwner = owner;
    return Promise.resolve(true);
  }
  releaseLease(leaseKey: string, owner: string): Promise<void> {
    this.releases.push({ key: leaseKey, owner });
    if (this.leaseOwner === owner) this.leaseOwner = undefined;
    return Promise.resolve();
  }
}

function dependencies(store: Store): SemanticPreparationDependencies {
  return {
    store,
    vault: { getVerified: () => Promise.resolve(null) },
    leaseOwner: "preparer:fixture-owner",
    leaseWaitAttempts: 1,
    sleep: () => Promise.resolve(),
  };
}
function projectorWith(
  project: ModelRdfProjector["project"],
): ModelRdfProjector {
  return {
    kind: realProjector.kind,
    projectorVersion: realProjector.projectorVersion,
    project,
  };
}

Deno.test("semantic preparation persists the exact projector bytes, library classification and occurrences", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  let actualInput: Parameters<ModelRdfProjector["project"]>[0] | undefined;
  const prepared = await prepareSemanticProjection(input, {
    ...dependencies(store),
    projector: projectorWith((received) => {
      actualInput = received;
      return realProjector.project(received);
    }),
  });
  deepStrictEqual(prepared, { projection: expected.projection });
  deepStrictEqual(Object.keys(prepared), ["projection"]);
  deepStrictEqual(actualInput?.build, input.build);
  deepStrictEqual(actualInput?.libraryNativeIds, ["library-part"]);
  deepStrictEqual(actualInput?.elements, elements);
  deepStrictEqual(store.puts[0]?.bytes, expected.quads);
  equal(
    await sha256HexOfBytes(store.puts[0]!.bytes),
    prepared.projection.projectionDigest,
  );
  notEqual(prepared.projection.projectionDigest, input.build.artifactDigest);
  equal(store.puts.length, 1);
  equal(store.acquisitions.length, 1);
  deepStrictEqual(store.releases, [{
    key: store.acquisitions[0]!.key,
    owner: "preparer:fixture-owner",
  }]);
  const quads = parseNQuads(new TextDecoder().decode(store.puts[0]!.bytes));
  equal(quads.length, expected.quadCount);
  ok(
    quads.some((quad) => quad.subject.value === "urn:ase:library:library-part"),
  );
  const list = quads.find((quad) =>
    quad.predicate === listPredicate("emptyList")
  )!;
  ok(quads.some((quad) =>
    quad.subject.value === list.object.value &&
    quad.predicate === ASE_VOCAB.length && quad.object.value === "0"
  ));
  const members = quads.find((quad) =>
    quad.predicate === listPredicate("ownedMember")
  )!;
  equal(
    quads.filter((quad) =>
      quad.subject.value === members.object.value &&
      quad.predicate === ASE_VOCAB.occurrence
    ).length,
    2,
  );
});

Deno.test("semantic preparation cache restart verifies persisted bytes and never invokes projector or lease", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  store.projections.set(
    key(
      expected.projection.kind,
      expected.projection.projectorVersion,
      expected.projection.artifactDigest,
    ),
    expected.quads,
  );
  const prepared = await prepareSemanticProjection(input, {
    ...dependencies(store),
    projector: projectorWith(() =>
      Promise.reject(new Error("cache hit must not project"))
    ),
  });
  deepStrictEqual(prepared, { projection: expected.projection });
  equal(store.puts.length, 0);
  equal(store.acquisitions.length, 0);
  equal(store.releases.length, 0);
});

Deno.test("semantic preparation treats corrupt and unavailable projection entries as failures, never misses", async () => {
  const { input, bytes } = await fixture();
  for (
    const code of [
      "BUILD_BLOB_CORRUPT",
      "BUILD_STORE_UNAVAILABLE",
      "BUILD_STORE_BUSY",
    ] as const
  ) {
    const store = new Store(bytes);
    store.projectionError = storedFailure(code);
    await rejects(() =>
      prepareSemanticProjection(input, {
        ...dependencies(store),
        projector: projectorWith(() =>
          Promise.reject(new Error("must not project"))
        ),
      }), failure(code));
    equal(store.puts.length, 0);
    equal(store.acquisitions.length, 0);
  }
});

Deno.test("semantic preparation refuses published projection metadata with missing bytes without repair", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  const ref = expected.projection;
  store.projections.set(
    key(ref.kind, ref.projectorVersion, ref.artifactDigest),
    expected.quads,
  );
  store.projectionError = storedFailure("BUILD_BLOB_MISSING");
  await rejects(() =>
    prepareSemanticProjection(input, {
      ...dependencies(store),
      projector: projectorWith(() => {
        throw new Error("Cannot repair incomplete published projection");
      }),
    }), failure("BUILD_BLOB_MISSING"));
  equal(store.reads.length, 2);
  equal(store.acquisitions.length, 0);
  equal(store.puts.length, 0);
});

Deno.test("semantic preparation accepts verified concurrent publication after an initial metadata miss", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  const ref = expected.projection;
  store.projections.set(
    key(ref.kind, ref.projectorVersion, ref.artifactDigest),
    expected.quads,
  );
  const read = store.getProjection.bind(store);
  let first = true;
  store.getProjection = (...args) => {
    if (first) {
      first = false;
      return Promise.reject(storedFailure("BUILD_BLOB_MISSING"));
    }
    return read(...args);
  };
  const actual = await prepareSemanticProjection(input, {
    ...dependencies(store),
    projector: projectorWith(() => {
      throw new Error("Concurrent complete projection must be reused");
    }),
  });
  deepStrictEqual(actual.projection, ref);
  equal(store.acquisitions.length, 0);
  equal(store.puts.length, 0);
});

Deno.test("semantic preparation recovers exact absent A from vault without an artifact rewrite", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  store.getError = storedFailure("BUILD_BLOB_MISSING");
  const vaultReads: string[] = [];
  const result = await prepareSemanticProjection(input, {
    ...dependencies(store),
    vault: {
      getVerified(digest) {
        vaultReads.push(digest);
        return Promise.resolve(bytes);
      },
    },
  });
  deepStrictEqual(vaultReads, [input.build.artifactDigest]);
  deepStrictEqual(result, { projection: expected.projection });
  equal(store.puts.length, 1);
});

Deno.test("semantic preparation refuses missing or corrupt vault bytes and preserves cache failure when vault is absent", async () => {
  const { input, bytes } = await fixture();
  const missing = new Store(bytes);
  missing.getError = storedFailure("BUILD_BLOB_MISSING");
  await rejects(
    () => prepareSemanticProjection(input, dependencies(missing)),
    failure("BUILD_UNAVAILABLE"),
  );
  equal(missing.puts.length, 0);
  const corruptVault = storedFailure("BUILD_BLOB_CORRUPT");
  await rejects(() =>
    prepareSemanticProjection(input, {
      ...dependencies(missing),
      vault: { getVerified: () => Promise.reject(corruptVault) },
    }), (error) => error === corruptVault);
  for (
    const code of [
      "BUILD_BLOB_CORRUPT",
      "BUILD_STORE_UNAVAILABLE",
      "BUILD_STORE_BUSY",
    ] as const
  ) {
    const cache = new Store(bytes);
    cache.getError = storedFailure(code);
    await rejects(
      () => prepareSemanticProjection(input, dependencies(cache)),
      (error) => error === cache.getError,
    );
    equal(cache.reads.length, 0);
  }
});

Deno.test("semantic preparation preserves exact vault recovery for corrupt, unavailable and busy artifact caches", async () => {
  const { input, bytes, expected } = await fixture();
  for (
    const code of [
      "BUILD_BLOB_CORRUPT",
      "BUILD_STORE_UNAVAILABLE",
      "BUILD_STORE_BUSY",
    ] as const
  ) {
    const cache = new Store(bytes);
    cache.getError = storedFailure(code);
    const reads: string[] = [];
    const result = await prepareSemanticProjection(input, {
      ...dependencies(cache),
      vault: {
        getVerified(digest) {
          reads.push(digest);
          return Promise.resolve(bytes);
        },
      },
    });
    deepStrictEqual(result.projection, expected.projection);
    deepStrictEqual(reads, [input.build.artifactDigest]);
    // A recovery is a read. The only write port is the derived RDF projection.
    equal(cache.puts.length, 1);
  }
});

Deno.test("semantic preparation validates the cached A before falling through to an exact vault and preserves incompatibility", async () => {
  const { input, bytes, expected } = await fixture();
  const corrupt = bytes.slice();
  corrupt[0] ^= 1;
  const cache = new Store(corrupt);
  const result = await prepareSemanticProjection(input, {
    ...dependencies(cache),
    vault: { getVerified: () => Promise.resolve(bytes) },
  });
  deepStrictEqual(result.projection, expected.projection);
  const unsupported = {
    ...input.descriptor,
    recipe: { ...input.descriptor.recipe, irVersion: "unsupported" },
  };
  const { digest: _digest, ...recipe } = unsupported.recipe;
  unsupported.recipe.digest = await recipeDigest(recipe);
  unsupported.buildKey = await buildKey(
    unsupported.sourceDigest,
    unsupported.recipe.digest,
  );
  let vaultRead = false;
  await rejects(() =>
    prepareSemanticProjection({
      build: buildRefFromDescriptor(unsupported),
      descriptor: unsupported,
    }, {
      ...dependencies(new Store(bytes)),
      vault: {
        getVerified() {
          vaultRead = true;
          return Promise.resolve(bytes);
        },
      },
    }), failure("BUILD_MATERIALIZATION_INCOMPATIBLE"));
  equal(vaultRead, false);
});

Deno.test("semantic preparation revalidates bytes recovered from its vault port", async () => {
  const { input, bytes } = await fixture();
  const store = new Store(bytes);
  store.getError = storedFailure("BUILD_BLOB_MISSING");
  const corrupt = bytes.slice();
  corrupt[0] ^= 1;
  await rejects(() =>
    prepareSemanticProjection(input, {
      ...dependencies(store),
      vault: { getVerified: () => Promise.resolve(corrupt) },
    }), failure("BUILD_CORRUPT"));
  equal(store.reads.length, 0);
});

Deno.test("semantic preparation refuses changed build A, S, R or K before reading projection bytes", async () => {
  const { input, bytes } = await fixture();
  const cases: { input: SemanticProjectionPreparationInput; code: string }[] = [
    {
      input: {
        ...input,
        build: { ...input.build, artifactDigest: "1".repeat(64) },
      },
      code: "BUILD_DESCRIPTOR_MISMATCH",
    },
    {
      input: {
        ...input,
        build: { ...input.build, sourceDigest: "2".repeat(64) },
      },
      code: "BUILD_SOURCE_MISMATCH",
    },
    {
      input: {
        ...input,
        descriptor: {
          ...input.descriptor,
          recipe: { ...input.descriptor.recipe, normalizerVersion: 7 },
        },
      },
      code: "BUILD_DESCRIPTOR_MISMATCH",
    },
    {
      input: { ...input, build: { ...input.build, buildKey: "3".repeat(64) } },
      code: "BUILD_DESCRIPTOR_MISMATCH",
    },
  ];
  for (const entry of cases) {
    const store = new Store(bytes);
    await rejects(
      () => prepareSemanticProjection(entry.input, dependencies(store)),
      failure(entry.code),
    );
    equal(store.reads.length, 0);
    equal(store.acquisitions.length, 0);
    equal(store.puts.length, 0);
  }
});

Deno.test("semantic preparation never publishes altered projector context, artifact identity or digest", async () => {
  const { input, bytes, expected } = await fixture();
  const alterations = [{ projectorVersion: "wrong-context" }, {
    artifactDigest: "1".repeat(64),
  }, { projectionDigest: "2".repeat(64) }];
  for (const altered of alterations) {
    const store = new Store(bytes);
    await rejects(() =>
      prepareSemanticProjection(input, {
        ...dependencies(store),
        projector: projectorWith(() =>
          Promise.resolve({
            ...expected,
            projection: { ...expected.projection, ...altered },
          })
        ),
      }), failure("INDEX_PROJECTION_CORRUPT"));
    equal(store.puts.length, 0);
    equal(store.releases.length, 1);
    equal(store.leaseOwner, undefined);
  }
});

Deno.test("semantic preparation detects persistence disagreement and releases its lease after coded failures", async () => {
  const { input, bytes } = await fixture();
  const store = new Store(bytes);
  store.persistedDigest = "f".repeat(64);
  await rejects(
    () => prepareSemanticProjection(input, dependencies(store)),
    failure("INDEX_PROJECTION_CORRUPT"),
  );
  equal(store.releases.length, 1);
  const rejected = new Store(bytes);
  rejected.putError = storedFailure("BUILD_BLOB_CONFLICT");
  await rejects(
    () => prepareSemanticProjection(input, dependencies(rejected)),
    failure("BUILD_BLOB_CONFLICT"),
  );
  equal(rejected.releases.length, 1);
  equal(rejected.leaseOwner, undefined);
});

Deno.test("semantic preparation never projects or puts without a lease and bounds lease waiting", async () => {
  const { input, bytes } = await fixture();
  const store = new Store(bytes);
  store.leaseOwner = "another-process";
  let waits = 0;
  await rejects(() =>
    prepareSemanticProjection(input, {
      ...dependencies(store),
      leaseWaitAttempts: 2,
      sleep: () => {
        waits++;
        return Promise.resolve();
      },
      projector: projectorWith(() =>
        Promise.reject(new Error("must not project under another lease"))
      ),
    }), failure("INDEX_BUSY"));
  equal(waits, 2);
  equal(store.acquisitions.length, 3);
  equal(store.puts.length, 0);
  equal(store.releases.length, 0);
  equal(store.leaseOwner, "another-process");
});

Deno.test("semantic preparation rechecks the cache after acquiring the lease", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  const acquire = store.acquireLease.bind(store);
  store.acquireLease = (leaseKey, owner, ttl) => {
    store.projections.set(
      key(
        expected.projection.kind,
        expected.projection.projectorVersion,
        expected.projection.artifactDigest,
      ),
      expected.quads,
    );
    return acquire(leaseKey, owner, ttl);
  };
  const result = await prepareSemanticProjection(input, {
    ...dependencies(store),
    projector: projectorWith(() =>
      Promise.reject(new Error("completed peer must be reused"))
    ),
  });
  deepStrictEqual(result, { projection: expected.projection });
  equal(store.puts.length, 0);
  equal(store.releases.length, 1);
});

Deno.test("semantic preparation shares committed bytes across distinct concurrent lease owners", async () => {
  const { input, bytes, expected } = await fixture();
  const store = new Store(bytes);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let projects = 0;
  const projector = projectorWith(async (received) => {
    projects++;
    started();
    await blocked;
    return await realProjector.project(received);
  });
  const first = prepareSemanticProjection(input, {
    ...dependencies(store),
    leaseOwner: "first-process",
    projector,
  });
  await entered;
  const second = prepareSemanticProjection(input, {
    ...dependencies(store),
    leaseOwner: "second-process",
    projector,
    sleep: async () => {
      release();
      await first;
    },
  });
  const results = await Promise.all([first, second]);
  deepStrictEqual(results, [{ projection: expected.projection }, {
    projection: expected.projection,
  }]);
  equal(projects, 1);
  equal(store.puts.length, 1);
  deepStrictEqual(
    new Set(store.acquisitions.map((entry) => entry.owner)),
    new Set(["first-process", "second-process"]),
  );
  deepStrictEqual(store.releases.map((entry) => entry.owner), [
    "first-process",
  ]);
});

Deno.test("semantic preparation refuses artifact bytes masquerading as cached or newly projected RDF", async () => {
  const { input, bytes, expected } = await fixture();
  const cached = new Store(bytes);
  cached.projections.set(
    key(
      expected.projection.kind,
      expected.projection.projectorVersion,
      expected.projection.artifactDigest,
    ),
    bytes,
  );
  await rejects(
    () => prepareSemanticProjection(input, dependencies(cached)),
    failure("INDEX_PROJECTION_CORRUPT"),
  );
  equal(cached.puts.length, 0);
  equal(cached.acquisitions.length, 0);
  const produced = new Store(bytes);
  await rejects(() =>
    prepareSemanticProjection(input, {
      ...dependencies(produced),
      projector: projectorWith(() =>
        Promise.resolve({
          ...expected,
          quads: bytes,
          projection: {
            ...expected.projection,
            projectionDigest: input.build.artifactDigest,
          },
        })
      ),
    }), failure("INDEX_PROJECTION_CORRUPT"));
  equal(produced.puts.length, 0);
  equal(produced.releases.length, 1);
});

Deno.test("semantic preparation refuses verified library classification without a canonical native ID", async () => {
  const valid = await fixture();
  const malformedRows = elements.map((row) => ({ ...row }));
  delete malformedRows[2]!["@id"];
  const bytes = new TextEncoder().encode(artifactPayload({
    provider: {
      name: "sysml-toolkit",
      version: recipe.engineVersion,
      format: recipe.format,
    },
    engineVersion: recipe.engineVersion,
    elements: malformedRows,
  }));
  const descriptor = {
    ...valid.input.descriptor,
    artifactDigest: await sha256HexOfBytes(bytes),
    bytes: bytes.byteLength,
  };
  const store = new Store(bytes);
  await rejects(() =>
    prepareSemanticProjection({
      build: buildRefFromDescriptor(descriptor),
      descriptor,
    }, dependencies(store)), failure("INDEX_PROJECTION_CORRUPT"));
  equal(store.reads.length, 0);
  equal(store.puts.length, 0);
});
