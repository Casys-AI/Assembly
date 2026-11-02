import { deepStrictEqual, equal, notEqual, throws } from "node:assert/strict";
import type {
  CompiledModel,
  JsonObject,
} from "../../../domain/model/records/compiled-model.ts";
import {
  ARTIFACT_SCHEMA,
  artifactDigest,
  artifactPayload,
  type BuildDescriptor,
  buildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import {
  modelSourceDigest,
  type ModelSources,
} from "../../../domain/model/value-objects/sources.ts";
import type { BuildMaterializer } from "./ports/out/build-materializer.port.ts";
import {
  type BuildPutResult,
  BuildStoreError,
  type BuildStoreStats,
  type BuildSweepResult,
  type ModelBuildStore,
} from "./ports/out/build-store.port.ts";
import type { ModelBuildVaultPort } from "./ports/out/build-vault.port.ts";
import {
  artifactBytesFor,
  ModelBuildService,
  ModelBuildServiceError,
  parseArtifactBytes,
  sha256HexOfBytes,
} from "./service.ts";

const sources: ModelSources = {
  "model.sysml": "package Golden { part p; }",
  "other.sysml": "package Other { part q; }",
};
const recipe: BuildRecipeInputs = {
  toolkit: { version: "native-1", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 1,
  irVersion: "0.1",
  artifactSchema: ARTIFACT_SCHEMA,
  engineVersion: "native-1",
};
const oldRecipe: BuildRecipeInputs = {
  ...recipe,
  toolkit: { version: "wasm-0", bundleDigest: "8".repeat(64) },
  engineVersion: "wasm-0",
};
const provider = {
  name: "sysml-toolkit",
  version: "native-1",
  format: "ase-toolkit-normalized-json-v1",
};
const elements: JsonObject[] = [
  { "@id": "e2", "@type": "PartUsage", qualifiedName: "Golden::p" },
  { "@id": "e1", "@type": "Package", qualifiedName: "Golden" },
];

async function compiledFixture(
  els: JsonObject[] = elements,
  engineVersion = recipe.engineVersion,
  src: ModelSources = sources,
): Promise<CompiledModel> {
  return {
    provider,
    sources: src,
    elements: els,
    documents: [],
    sourceDigest: await modelSourceDigest(src),
    semanticDigest: "sem",
    provenanceDigest: "prov",
    sourceHashes: {},
    engineVersion,
  };
}

async function descriptorFixture(
  r: BuildRecipeInputs = recipe,
  els: JsonObject[] = elements,
  withProvider = true,
): Promise<{ descriptor: BuildDescriptor; bytes: Uint8Array }> {
  const sourceDigest = await modelSourceDigest(sources);
  const rd = await recipeDigest(r);
  const input = {
    ...(withProvider ? { provider } : {}),
    engineVersion: r.engineVersion,
    elements: els,
  };
  const text = artifactPayload(input);
  return {
    descriptor: buildDescriptor({
      repositoryId: "repo-1",
      sourceDigest,
      recipe: r,
      recipeDigest: rd,
      buildKey: await buildKey(sourceDigest, rd),
      artifactDigest: await artifactDigest(input),
      bytes: new TextEncoder().encode(text).length,
    }),
    bytes: new TextEncoder().encode(text),
  };
}

class FakeStore implements ModelBuildStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  now = 1_000;
  getCount = 0;
  putCount = 0;
  failGetWithCorrupt = false;
  unavailableCode?: "BUILD_STORE_UNAVAILABLE" | "BUILD_STORE_BUSY";
  has(digest: string): Promise<boolean> {
    return Promise.resolve(this.blobs.has(digest));
  }
  get(digest: string): Promise<Uint8Array> {
    this.getCount++;
    if (this.unavailableCode) {
      return Promise.reject(
        new BuildStoreError(this.unavailableCode, {}, "offline"),
      );
    }
    if (this.failGetWithCorrupt) {
      return Promise.reject(
        new BuildStoreError("BUILD_BLOB_CORRUPT", { digest }, "corrupt"),
      );
    }
    const bytes = this.blobs.get(digest);
    if (!bytes) {
      return Promise.reject(
        new BuildStoreError("BUILD_BLOB_MISSING", { digest }, "missing"),
      );
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Promise.resolve(copy);
  }
  async put(digest: string, bytes: Uint8Array): Promise<BuildPutResult> {
    if (this.unavailableCode) {
      throw new BuildStoreError(this.unavailableCode, {}, "offline");
    }
    const actual = await sha256HexOfBytes(bytes);
    if (actual !== digest) {
      throw new BuildStoreError(
        "BUILD_BLOB_CONFLICT",
        { digest, actualSha256: actual },
        "conflict",
      );
    }
    this.putCount++;
    const existed = this.blobs.has(digest);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.blobs.set(digest, copy);
    return { stored: !existed, bytes: bytes.byteLength, digest };
  }
  hasProjection(): Promise<boolean> {
    return Promise.resolve(false);
  }
  getProjection(): Promise<Uint8Array> {
    return Promise.reject(
      new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
    );
  }
  putProjection(
    _k: string,
    _v: string,
    _a: string,
    bytes: Uint8Array,
  ): Promise<BuildPutResult> {
    return sha256HexOfBytes(bytes).then((digest) => ({
      stored: true,
      bytes: bytes.byteLength,
      digest,
    }));
  }
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const held = this.leases.get(key);
    if (held && held.expiresAt > this.now && held.owner !== owner) {
      return Promise.resolve(false);
    }
    this.leases.set(key, { owner, expiresAt: this.now + ttlMs });
    return Promise.resolve(true);
  }
  releaseLease(key: string, owner: string): Promise<void> {
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
    return Promise.resolve();
  }
  sweep(): Promise<BuildSweepResult> {
    return Promise.resolve({
      orphanChunkKeysRemoved: 0,
      orphanEntries: 0,
      expiredLeasesRemoved: 0,
    });
  }
  stats(): Promise<BuildStoreStats> {
    return Promise.resolve({
      blobCount: this.blobs.size,
      projectionCount: 0,
      leaseCount: this.leases.size,
      uncompressedBytes: [...this.blobs.values()].reduce(
        (n, b) => n + b.byteLength,
        0,
      ),
      quotaBytes: null,
      overQuota: false,
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMaterializer implements BuildMaterializer {
  fail = false;
  calls = 0;
  materialize(input: Parameters<BuildMaterializer["materialize"]>[0]) {
    this.calls++;
    if (this.fail) {
      return Promise.reject(new Error("IR version unsupported here"));
    }
    return compiledFixture(
      input.artifact.elements,
      input.artifact.engineVersion,
      input.sources,
    ).then((compiled) => ({
      ...compiled,
      provider: input.artifact.provider,
      sourceDigest: input.descriptor.sourceDigest,
    }));
  }
}

class FakeCompiler {
  compileCalls = 0;
  elements: JsonObject[] = elements;
  gate: Promise<void> | null = null;
  constructor(private currentRecipe: BuildRecipeInputs = recipe) {}
  recipe(): Promise<BuildRecipeInputs> {
    return Promise.resolve(this.currentRecipe);
  }
  async compile(src: ModelSources): Promise<CompiledModel> {
    this.compileCalls++;
    if (this.gate) await this.gate;
    return compiledFixture(
      this.elements,
      this.currentRecipe.engineVersion,
      src,
    );
  }
}

class FakeVault implements ModelBuildVaultPort {
  readonly blobs = new Map<string, Uint8Array>();
  getVerified(digest: string): Promise<Uint8Array | null> {
    const bytes = this.blobs.get(digest);
    if (!bytes) return Promise.resolve(null);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Promise.resolve(copy);
  }
  putVerified(digest: string, bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const existed = this.blobs.has(digest);
    this.blobs.set(digest, copy);
    return Promise.resolve({
      stored: !existed,
      bytes: bytes.byteLength,
      digest,
    });
  }
  has(digest: string): Promise<boolean> {
    return Promise.resolve(this.blobs.has(digest));
  }
}

function serviceWith(patch: {
  store?: FakeStore;
  vault?: FakeVault;
  compiler?: FakeCompiler;
  materializer?: FakeMaterializer;
  maxArtifactBytes?: number;
  leaseWaitAttempts?: number;
  memoryCacheBytes?: number;
  maxInFlightResolutions?: number;
} = {}) {
  const store = patch.store ?? new FakeStore();
  const materializer = patch.materializer ?? new FakeMaterializer();
  const service = new ModelBuildService({
    repositoryId: "repo-1",
    store,
    vault: patch.vault,
    compiler: patch.compiler,
    materializer,
    maxArtifactBytes: patch.maxArtifactBytes,
    leaseOwner: "test-owner",
    leaseTtlMs: 10_000,
    leaseWaitAttempts: patch.leaseWaitAttempts ?? 2,
    leaseWaitDelayMs: 0,
    sleep: () => Promise.resolve(),
    memoryCacheBytes: patch.memoryCacheBytes,
    maxInFlightResolutions: patch.maxInFlightResolutions,
  });
  return { service, store, materializer };
}

async function serviceCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelBuildServiceError) return error.code;
    throw error;
  }
  throw new Error("expected ModelBuildServiceError");
}

Deno.test("build service ensure stores compact bytes and returns the true descriptor", async () => {
  const { service, store } = serviceWith();
  const compiled = await compiledFixture();
  const descriptor = await service.ensure(compiled, recipe);
  const expected = await descriptorFixture();
  deepStrictEqual({ ...descriptor }, { ...expected.descriptor });
  deepStrictEqual(
    store.blobs.get(descriptor.artifactDigest),
    artifactBytesFor(compiled),
  );
  const resolved = await service.resolve(descriptor, sources);
  equal(resolved.origin, "cache");
  deepStrictEqual(resolved.compiled.elements, elements);
  deepStrictEqual(resolved.artifactBytes, expected.bytes);
});

Deno.test("build service ensure refuses inconsistent compiled input and oversize", async () => {
  const { service } = serviceWith();
  const badDigest = {
    ...(await compiledFixture()),
    sourceDigest: "f".repeat(64),
  };
  equal(
    await serviceCode(service.ensure(badDigest, recipe)),
    "BUILD_SOURCE_MISMATCH",
  );
  const badEngine = await compiledFixture(elements, "other-engine");
  equal(
    await serviceCode(service.ensure(badEngine, recipe)),
    "BUILD_INVALID_INPUT",
  );
  const tiny = serviceWith({ maxArtifactBytes: 10 }).service;
  equal(
    await serviceCode(tiny.ensure(await compiledFixture(), recipe)),
    "ARTIFACT_TOO_LARGE",
  );
});

Deno.test("build service validates S, R, K and size before trusting bytes", async () => {
  const { service, store } = serviceWith();
  const { descriptor, bytes } = await descriptorFixture();
  store.blobs.set(descriptor.artifactDigest, bytes);
  equal(
    await serviceCode(service.resolve(descriptor, {
      "model.sysml": "package Changed { }",
      "other.sysml": sources["other.sysml"]!,
    })),
    "BUILD_SOURCE_MISMATCH",
  );
  const badRecipe = {
    ...descriptor,
    recipe: { ...descriptor.recipe, format: "tampered-format" },
  };
  equal(
    await serviceCode(service.resolve(badRecipe, sources)),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  const badKey = { ...descriptor, buildKey: "f".repeat(64) };
  equal(
    await serviceCode(service.resolve(badKey, sources)),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  const badSize = { ...descriptor, bytes: descriptor.bytes + 1 };
  equal(await serviceCode(service.resolve(badSize, sources)), "BUILD_CORRUPT");
  // A wrong artifactDigest is a different build: strict parse passes, but
  // the bytes under it cannot be the ones this test stored above.
  const badA = { ...descriptor, artifactDigest: "f".repeat(64) };
  notEqual(
    await serviceCode(service.resolve(badA, sources)),
    "INVALID_REPOSITORY",
  );
});

Deno.test("build service distinguishes corrupt hit, missing build and dead recipe", async () => {
  const { descriptor, bytes } = await descriptorFixture();
  // Corrupt hit: one flipped byte, same length, no way to rebuild.
  const flipped = new Uint8Array(bytes);
  flipped[20] = flipped[20]! ^ 0x01;
  const corruptStore = new FakeStore();
  corruptStore.blobs.set(descriptor.artifactDigest, flipped);
  equal(
    await serviceCode(
      serviceWith({ store: corruptStore }).service.resolve(descriptor, sources),
    ),
    "BUILD_CORRUPT",
  );
  // Missing everywhere, no compiler: recipe unavailable, not corruption.
  equal(
    await serviceCode(serviceWith().service.resolve(descriptor, sources)),
    "BUILD_RECIPE_UNAVAILABLE",
  );
  // Missing, compiler only offers another recipe: never compiles.
  const wrongCompiler = new FakeCompiler(oldRecipe);
  equal(
    await serviceCode(
      serviceWith({ compiler: wrongCompiler }).service.resolve(
        descriptor,
        sources,
      ),
    ),
    "BUILD_RECIPE_UNAVAILABLE",
  );
  equal(wrongCompiler.compileCalls, 0);
});

Deno.test("build service rebuilds a miss only under the exact recipe and same A", async () => {
  const { descriptor } = await descriptorFixture();
  const compiler = new FakeCompiler();
  const { service, store } = serviceWith({ compiler });
  const resolved = await service.resolve(descriptor, sources);
  equal(resolved.origin, "rebuilt");
  equal(resolved.descriptor.artifactDigest, descriptor.artifactDigest);
  equal(store.blobs.has(descriptor.artifactDigest), true);
  equal(store.leases.size, 0);
  const second = await service.resolve(descriptor, sources);
  equal(second.origin, "memory");
  equal(compiler.compileCalls, 1);
});

Deno.test("build service refuses a rebuilt output mismatch and evicts the failure", async () => {
  const { descriptor } = await descriptorFixture();
  const compiler = new FakeCompiler();
  compiler.elements = [{ "@id": "zz", "@type": "PartUsage" }];
  const { service, store } = serviceWith({ compiler });
  equal(
    await serviceCode(service.resolve(descriptor, sources)),
    "BUILD_OUTPUT_MISMATCH",
  );
  equal(store.blobs.has(descriptor.artifactDigest), false);
  compiler.elements = elements;
  const resolved = await service.resolve(descriptor, sources);
  equal(resolved.origin, "rebuilt");
});

Deno.test("build service checks materialization compatibility on hit and on miss", async () => {
  const { descriptor, bytes } = await descriptorFixture();
  const hitMaterializer = new FakeMaterializer();
  hitMaterializer.fail = true;
  const hitStore = new FakeStore();
  hitStore.blobs.set(descriptor.artifactDigest, bytes);
  equal(
    await serviceCode(
      serviceWith({ store: hitStore, materializer: hitMaterializer }).service
        .resolve(descriptor, sources),
    ),
    "BUILD_MATERIALIZATION_INCOMPATIBLE",
  );
  const missMaterializer = new FakeMaterializer();
  missMaterializer.fail = true;
  const miss = serviceWith({
    materializer: missMaterializer,
    compiler: new FakeCompiler(),
  });
  equal(
    await serviceCode(miss.service.resolve(descriptor, sources)),
    "BUILD_MATERIALIZATION_INCOMPATIBLE",
  );
  // Incompatible rebuilt bytes are not announced through a verified put.
  equal(miss.store.putCount, 0);
});

Deno.test("build service coalesces concurrent rebuilds of one verified build", async () => {
  const { descriptor } = await descriptorFixture();
  const compiler = new FakeCompiler();
  let release!: () => void;
  compiler.gate = new Promise<void>((res) => {
    release = res;
  });
  const { service } = serviceWith({ compiler });
  const pending = [
    service.resolve(descriptor, sources),
    service.resolve(descriptor, sources),
    service.resolve(descriptor, sources),
  ];
  // Let all three callers reach the gated compile before releasing it.
  await new Promise((res) => setTimeout(res, 0));
  release();
  const results = await Promise.all(pending);
  equal(compiler.compileCalls, 1);
  for (const result of results) {
    equal(result.descriptor.artifactDigest, descriptor.artifactDigest);
  }
});

Deno.test("build service bounds rebuild waiting behind a foreign lease", async () => {
  const { descriptor } = await descriptorFixture();
  const compiler = new FakeCompiler();
  const { service, store } = serviceWith({ compiler, leaseWaitAttempts: 2 });
  const leaseKey = `build-rebuild:${descriptor.artifactDigest}`;
  equal(await store.acquireLease(leaseKey, "other-process", 10_000), true);
  equal(
    await serviceCode(service.resolve(descriptor, sources)),
    "BUILD_UNAVAILABLE",
  );
  equal(compiler.compileCalls, 0);
  await store.releaseLease(leaseKey, "other-process");
  const resolved = await service.resolve(descriptor, sources);
  equal(resolved.origin, "rebuilt");
});

Deno.test("build service keeps dead-recipe history readable from verified vault bytes", async () => {
  const { descriptor, bytes } = await descriptorFixture(
    oldRecipe,
    elements,
    false,
  );
  const vault = new FakeVault();
  vault.blobs.set(descriptor.artifactDigest, bytes);
  // No compiler at all: the old (WASM-era) recipe can never run again.
  const { service, store } = serviceWith({ vault });
  const resolved = await service.resolve(descriptor, sources);
  equal(resolved.origin, "vault");
  equal(resolved.compiled.engineVersion, "wasm-0");
  // Vault hit re-populates the cache with the same verified bytes.
  deepStrictEqual(store.blobs.get(descriptor.artifactDigest), bytes);
  // Already verified private memory remains valid even if persistent bytes
  // later become corrupt. Clearing it forces the persistent verification path.
  store.failGetWithCorrupt = true;
  equal((await service.resolve(descriptor, sources)).origin, "memory");
  service.clearMemory();
  const repaired = await service.resolve(descriptor, sources);
  equal(repaired.origin, "vault");
});

Deno.test("build service keeps other cache failures terminal before the vault", async () => {
  const { descriptor } = await descriptorFixture();
  const store = new FakeStore();
  store.get = () =>
    Promise.reject(
      new BuildStoreError("BUILD_STORE_INVALID_INPUT", {}, "invalid"),
    );
  const vault = new FakeVault();
  let vaultReads = 0;
  vault.getVerified = () => {
    vaultReads++;
    return Promise.resolve(null);
  };
  const { service } = serviceWith({ store, vault });
  try {
    await service.resolve(descriptor, sources);
    throw new Error("expected invalid cache input failure");
  } catch (error) {
    if (!(error instanceof ModelBuildServiceError)) throw error;
    equal(error.code, "BUILD_UNAVAILABLE");
    equal(error.context.storeCode, "BUILD_STORE_INVALID_INPUT");
  }
  equal(vaultReads, 0);
});

for (
  const storeCode of ["BUILD_STORE_UNAVAILABLE", "BUILD_STORE_BUSY"] as const
) {
  Deno.test(`build service reads durable history during ${storeCode}`, async () => {
    const { descriptor, bytes } = await descriptorFixture(
      oldRecipe,
      elements,
      false,
    );
    for (const allowRebuild of [true, false]) {
      const store = new FakeStore();
      store.unavailableCode = storeCode;
      const vault = new FakeVault();
      vault.blobs.set(descriptor.artifactDigest, bytes);
      const { service } = serviceWith({ store, vault });
      const resolved = await service.resolve(descriptor, sources, {
        allowRebuild,
      });
      equal(resolved.origin, "vault");
      equal(resolved.compiled.engineVersion, "wasm-0");
      deepStrictEqual(resolved.descriptor, descriptor);
      equal(store.blobs.size, 0);
      equal(store.leases.size, 0);
    }
  });

  Deno.test(`build service preserves ${storeCode} when durable fallback fails`, async () => {
    const { descriptor, bytes } = await descriptorFixture();
    for (
      const failure of ["absent", "missing", "offline", "corrupt"] as const
    ) {
      const store = new FakeStore();
      store.unavailableCode = storeCode;
      const compiler = new FakeCompiler();
      const vault = failure === "absent" ? undefined : new FakeVault();
      if (failure === "offline") {
        vault!.getVerified = () => Promise.reject(new Error("vault offline"));
      }
      if (failure === "corrupt") {
        const corrupt = new Uint8Array(bytes);
        corrupt[20] = corrupt[20]! ^ 0x01;
        vault!.blobs.set(descriptor.artifactDigest, corrupt);
      }
      const { service, materializer } = serviceWith({ store, vault, compiler });
      try {
        await service.resolve(descriptor, sources);
        throw new Error(`expected unavailable for ${failure}`);
      } catch (error) {
        if (!(error instanceof ModelBuildServiceError)) throw error;
        equal(error.code, "BUILD_UNAVAILABLE");
        equal(error.context.storeCode, storeCode);
      }
      equal(materializer.calls, 0);
      equal(compiler.compileCalls, 0);
      equal(store.leases.size, 0);
      equal(store.blobs.size, 0);
    }
  });

  Deno.test(`build service preserves vault incompatibility during ${storeCode}`, async () => {
    const { descriptor, bytes } = await descriptorFixture();
    const store = new FakeStore();
    store.unavailableCode = storeCode;
    const vault = new FakeVault();
    vault.blobs.set(descriptor.artifactDigest, bytes);
    const materializer = new FakeMaterializer();
    materializer.fail = true;
    const compiler = new FakeCompiler();
    const { service } = serviceWith({ store, vault, materializer, compiler });
    equal(
      await serviceCode(service.resolve(descriptor, sources)),
      "BUILD_MATERIALIZATION_INCOMPATIBLE",
    );
    equal(compiler.compileCalls, 0);
    equal(store.blobs.size, 0);
  });
}

Deno.test("artifact bytes parsing rejects non-canonical bytes and future schemas", () => {
  const pretty = new TextEncoder().encode(
    JSON.stringify({ v: 1, engineVersion: "x", elements: [] }, null, 2),
  );
  let code = "";
  try {
    parseArtifactBytes(pretty);
  } catch (error) {
    if (error instanceof ModelBuildServiceError) code = error.code;
    else throw error;
  }
  equal(code, "BUILD_CORRUPT");
  const future = new TextEncoder().encode(
    JSON.stringify({ v: 2, engineVersion: "x", elements: [] }),
  );
  code = "";
  try {
    parseArtifactBytes(future);
  } catch (error) {
    if (error instanceof ModelBuildServiceError) code = error.code;
    else throw error;
  }
  equal(code, "BUILD_MATERIALIZATION_INCOMPATIBLE");
});

Deno.test("publication resolution refuses cache loss without invoking the compiler", async () => {
  const { descriptor, bytes } = await descriptorFixture();
  const compiler = new FakeCompiler();
  const { service, store } = serviceWith({ compiler });
  equal(
    await serviceCode(
      service.resolve(descriptor, sources, { allowRebuild: false }),
    ),
    "BUILD_UNAVAILABLE",
  );
  equal(compiler.compileCalls, 0);
  store.blobs.set(descriptor.artifactDigest, bytes);
  equal(
    (await service.resolve(descriptor, sources, { allowRebuild: false }))
      .origin,
    "cache",
  );
  equal(compiler.compileCalls, 0);
});

Deno.test("build service never coalesces source bindings of identical artifact bytes", async () => {
  const { service, materializer } = serviceWith();
  // Compact A excludes source text: comments/empty models can legitimately
  // yield the same artifact while their immutable source identities differ.
  const sourceA = { "empty.sysml": "// source A\n" };
  const sourceB = { "empty.sysml": "// source B\n" };
  const [descriptorA, descriptorB] = await Promise.all([
    service.ensure(
      await compiledFixture([], recipe.engineVersion, sourceA),
      recipe,
    ),
    service.ensure(
      await compiledFixture([], recipe.engineVersion, sourceB),
      recipe,
    ),
  ]);
  equal(descriptorA.artifactDigest, descriptorB.artifactDigest);
  notEqual(descriptorA.sourceDigest, descriptorB.sourceDigest);
  notEqual(descriptorA.buildKey, descriptorB.buildKey);
  const [resolvedA, resolvedB] = await Promise.all([
    service.resolve(descriptorA, sourceA),
    service.resolve(descriptorB, sourceB),
  ]);
  deepStrictEqual(resolvedA.descriptor, descriptorA);
  deepStrictEqual(resolvedB.descriptor, descriptorB);
  deepStrictEqual(resolvedA.compiled.sources, sourceA);
  deepStrictEqual(resolvedB.compiled.sources, sourceB);
  equal(resolvedA.compiled.sourceDigest, descriptorA.sourceDigest);
  equal(resolvedB.compiled.sourceDigest, descriptorB.sourceDigest);
  equal(materializer.calls, 2);
});

Deno.test("build service never coalesces recipe bindings of identical artifact bytes", async () => {
  const { service, materializer } = serviceWith();
  // Different normalizer/Toolkit bundles can emit identical provider output;
  // R/K still identify separate builds, even for the same S and A.
  const nextRecipe: BuildRecipeInputs = {
    ...recipe,
    toolkit: { ...recipe.toolkit, bundleDigest: "7".repeat(64) },
  };
  const compiled = await compiledFixture([]);
  const descriptorA = await service.ensure(compiled, recipe);
  const descriptorB = await service.ensure(compiled, nextRecipe);
  equal(descriptorA.artifactDigest, descriptorB.artifactDigest);
  equal(descriptorA.sourceDigest, descriptorB.sourceDigest);
  notEqual(descriptorA.recipe.digest, descriptorB.recipe.digest);
  notEqual(descriptorA.buildKey, descriptorB.buildKey);
  const [resolvedA, resolvedB] = await Promise.all([
    service.resolve(descriptorA, sources),
    service.resolve(descriptorB, sources),
  ]);
  deepStrictEqual(resolvedA.descriptor, descriptorA);
  deepStrictEqual(resolvedB.descriptor, descriptorB);
  deepStrictEqual(resolvedA.compiled.sources, sources);
  deepStrictEqual(resolvedB.compiled.sources, sources);
  equal(materializer.calls, 2);
});

Deno.test("verified memory hits skip store and materializer while revalidating descriptor and sources", async () => {
  const { service, store, materializer } = serviceWith();
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  equal((await service.resolve(descriptor, sources)).origin, "cache");
  equal((await service.resolve(descriptor, sources)).origin, "memory");
  equal(store.getCount, 1);
  equal(materializer.calls, 1);
  equal(service.memoryStats().entries, 1);
  equal(service.memoryStats().hits, 1);
  equal(
    await serviceCode(
      service.resolve(descriptor, { "changed.sysml": "package Changed;" }),
    ),
    "BUILD_SOURCE_MISMATCH",
  );
  equal(
    await serviceCode(
      service.resolve({ ...descriptor, buildKey: "f".repeat(64) }, sources),
    ),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  const badRecipe = {
    ...descriptor,
    recipe: { ...descriptor.recipe, digest: "f".repeat(64) },
  };
  equal(
    await serviceCode(service.resolve(badRecipe, sources)),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  equal(
    await serviceCode(
      service.resolve({ ...descriptor, artifactDigest: "invalid" }, sources),
    ),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  equal(store.getCount, 1);
  equal(materializer.calls, 1);
});

Deno.test("memory snapshots isolate every mutable returned graph and source input", async () => {
  const { service } = serviceWith();
  const inputSources = { "mutable.sysml": "package Mutable;" };
  const descriptor = await service.ensure(
    await compiledFixture(elements, recipe.engineVersion, inputSources),
    recipe,
  );
  const first = await service.resolve(descriptor, inputSources);
  const expected = structuredClone(first);
  Object.assign(first.descriptor, { sourceDigest: "f".repeat(64) });
  Object.assign(first.descriptor.recipe.toolkit, {
    bundleDigest: "0".repeat(64),
  });
  first.compiled.sources["mutable.sysml"] = "poison";
  first.compiled.elements[0].qualifiedName = "poison";
  first.compiled.documents.push({ poison: true });
  first.artifact.elements.push({ poison: true });
  first.artifactBytes.fill(0);
  inputSources["mutable.sysml"] = "caller changed input";
  const second = await service.resolve(descriptor, {
    "mutable.sysml": "package Mutable;",
  });
  equal(second.origin, "memory");
  deepStrictEqual(second.descriptor, expected.descriptor);
  deepStrictEqual(second.artifact, expected.artifact);
  deepStrictEqual(second.artifactBytes, expected.artifactBytes);
  deepStrictEqual(second.compiled, expected.compiled);
  second.compiled.elements.length = 0;
  deepStrictEqual(
    (await service.resolve(descriptor, { "mutable.sysml": "package Mutable;" }))
      .compiled,
    expected.compiled,
  );
});

Deno.test("completed memory keeps full S/R/K identity when A is shared", async () => {
  const { service, materializer } = serviceWith();
  const srcA = { "empty.sysml": "// A" };
  const srcB = { "empty.sysml": "// B" };
  const recipeB = {
    ...recipe,
    toolkit: { ...recipe.toolkit, bundleDigest: "7".repeat(64) },
  };
  const descriptorA = await service.ensure(
    await compiledFixture([], recipe.engineVersion, srcA),
    recipe,
  );
  const descriptorB = await service.ensure(
    await compiledFixture([], recipe.engineVersion, srcB),
    recipe,
  );
  const descriptorR = await service.ensure(
    await compiledFixture([], recipe.engineVersion, srcA),
    recipeB,
  );
  equal(descriptorA.artifactDigest, descriptorB.artifactDigest);
  equal(descriptorA.artifactDigest, descriptorR.artifactDigest);
  for (
    const [descriptor, src] of [[descriptorA, srcA], [descriptorB, srcB], [
      descriptorR,
      srcA,
    ]] as const
  ) {
    await service.resolve(descriptor, src);
    const memory = await service.resolve(descriptor, src);
    equal(memory.origin, "memory");
    deepStrictEqual(memory.descriptor, descriptor);
    deepStrictEqual(memory.compiled.sources, src);
    equal(memory.compiled.sourceDigest, descriptor.sourceDigest);
  }
  equal(materializer.calls, 3);
  equal(service.memoryStats().entries, 3);
});

Deno.test("memory byte quota evicts the least recently used build and refuses oversize retention", async () => {
  const probe = serviceWith();
  const srcA = { "e.sysml": "// A" };
  const srcB = { "e.sysml": "// B" };
  const srcC = { "e.sysml": "// C" };
  const descriptorA = await probe.service.ensure(
    await compiledFixture([], recipe.engineVersion, srcA),
    recipe,
  );
  await probe.service.resolve(descriptorA, srcA);
  const weight = probe.service.memoryStats().bytes;
  const { service, materializer } = serviceWith({
    store: probe.store,
    memoryCacheBytes: weight * 2,
  });
  const descriptorB = await service.ensure(
    await compiledFixture([], recipe.engineVersion, srcB),
    recipe,
  );
  const descriptorC = await service.ensure(
    await compiledFixture([], recipe.engineVersion, srcC),
    recipe,
  );
  await service.resolve(descriptorA, srcA);
  await service.resolve(descriptorB, srcB);
  equal((await service.resolve(descriptorA, srcA)).origin, "memory");
  await service.resolve(descriptorC, srcC);
  equal(service.memoryStats().entries, 2);
  equal(service.memoryStats().bytes <= weight * 2, true);
  equal((await service.resolve(descriptorA, srcA)).origin, "memory");
  equal((await service.resolve(descriptorB, srcB)).origin, "cache");
  equal(materializer.calls, 4);
  const tiny = serviceWith({ store: probe.store, memoryCacheBytes: 1 });
  await tiny.service.resolve(descriptorA, srcA);
  await tiny.service.resolve(descriptorA, srcA);
  equal(tiny.service.memoryStats().entries, 0);
  equal(tiny.service.memoryStats().bytes, 0);
  equal(tiny.materializer.calls, 2);
});

Deno.test("clearMemory forces disk verification and failed materializations remain retryable", async () => {
  const { service, store, materializer } = serviceWith();
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  await service.resolve(descriptor, sources);
  store.failGetWithCorrupt = true;
  equal((await service.resolve(descriptor, sources)).origin, "memory");
  service.clearMemory();
  equal(service.memoryStats().entries, 0);
  equal(
    await serviceCode(service.resolve(descriptor, sources)),
    "BUILD_CORRUPT",
  );
  equal(service.memoryStats().entries, 0);
  store.failGetWithCorrupt = false;
  materializer.fail = true;
  equal(
    await serviceCode(service.resolve(descriptor, sources)),
    "BUILD_MATERIALIZATION_INCOMPATIBLE",
  );
  equal(service.memoryStats().entries, 0);
  materializer.fail = false;
  equal((await service.resolve(descriptor, sources)).origin, "cache");
});

Deno.test("completed verified memory satisfies no-rebuild reads without another compilation", async () => {
  const compiler = new FakeCompiler();
  const { descriptor } = await descriptorFixture();
  const { service, store } = serviceWith({ compiler });
  equal((await service.resolve(descriptor, sources)).origin, "rebuilt");
  store.blobs.clear();
  equal(
    (await service.resolve(descriptor, sources, { allowRebuild: false }))
      .origin,
    "memory",
  );
  equal(compiler.compileCalls, 1);
  service.clearMemory();
  equal(
    await serviceCode(
      service.resolve(descriptor, sources, { allowRebuild: false }),
    ),
    "BUILD_UNAVAILABLE",
  );
  equal(compiler.compileCalls, 1);
});

Deno.test("in-flight resolution bound is separate from completed memory", async () => {
  const compiler = new FakeCompiler();
  const compiling = Promise.withResolvers<void>();
  const compile = compiler.compile.bind(compiler);
  compiler.compile = (src) => {
    compiling.resolve();
    return compile(src);
  };
  let release!: () => void;
  compiler.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service } = serviceWith({ compiler, maxInFlightResolutions: 1 });
  const { descriptor } = await descriptorFixture();
  const first = service.resolve(descriptor, sources);
  // Descriptor hashing is asynchronous; wait for actual gated work, not a timer.
  await compiling.promise;
  equal(service.memoryStats().inFlight, 1);
  const otherSource = { "different.sysml": "// different" };
  const other = await service.ensure(
    await compiledFixture([], recipe.engineVersion, otherSource),
    recipe,
  );
  equal(
    await serviceCode(service.resolve(other, otherSource)),
    "BUILD_UNAVAILABLE",
  );
  service.clearMemory();
  equal(
    await serviceCode(service.resolve(descriptor, sources)),
    "BUILD_UNAVAILABLE",
  );
  release();
  await first;
  equal(service.memoryStats().inFlight, 0);
  equal(
    service.memoryStats().entries,
    0,
    "pre-clear completion cannot refill cleared memory",
  );
});

Deno.test("oversize resolution skips private cache clone while isolating concurrent public results", async () => {
  const { service, materializer } = serviceWith({ memoryCacheBytes: 1 });
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  const originalClone = globalThis.structuredClone;
  let envelopeClones = 0;
  Object.defineProperty(globalThis, "structuredClone", {
    value: function <T>(value: T, options?: StructuredSerializeOptions): T {
      if (
        value && typeof value === "object" && "artifactBytes" in value &&
        "compiled" in value
      ) envelopeClones++;
      return originalClone(value, options);
    },
  });
  try {
    const [first, second] = await Promise.all([
      service.resolve(descriptor, sources),
      service.resolve(descriptor, sources),
    ]);
    equal(materializer.calls, 1, "one verified shared in-flight result");
    equal(
      envelopeClones,
      2,
      "one clone per caller; no rejected private snapshot clone",
    );
    equal(service.memoryStats().entries, 0);
    first.compiled.elements[0].qualifiedName = "poison";
    first.artifactBytes.fill(0);
    Object.assign(first.descriptor, { artifactDigest: "f".repeat(64) });
    equal(second.compiled.elements[0].qualifiedName, elements[0].qualifiedName);
    notEqual(second.artifactBytes[0], 0);
    equal(second.descriptor.artifactDigest, descriptor.artifactDigest);
    const third = await service.resolve(descriptor, sources);
    equal(materializer.calls, 2, "oversize is reverified, not retained");
    equal(envelopeClones, 3);
    equal(third.compiled.elements[0].qualifiedName, elements[0].qualifiedName);
  } finally {
    globalThis.structuredClone = originalClone;
  }
});

Deno.test("fit cache snapshots detach materializer-owned mutable output", async () => {
  class CapturingMaterializer extends FakeMaterializer {
    last?: CompiledModel;
    override async materialize(
      input: Parameters<BuildMaterializer["materialize"]>[0],
    ) {
      const value = await super.materialize(input);
      this.last = value;
      return value;
    }
  }
  const materializer = new CapturingMaterializer();
  const { service } = serviceWith({ materializer });
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  const first = await service.resolve(descriptor, sources);
  const baseline = structuredClone(first.compiled);
  equal(service.memoryStats().entries, 1);
  materializer.last!.elements[0].qualifiedName =
    "adapter mutated its own result";
  materializer.last!.documents.push({ poison: true });
  materializer.last!.sources["model.sysml"] = "adapter mutation";
  const second = await service.resolve(descriptor, sources);
  equal(second.origin, "memory");
  deepStrictEqual(second.compiled, baseline);
  deepStrictEqual(first.compiled, baseline);
});

Deno.test("compiled resolution shares deeply frozen concurrent and cached outputs", async () => {
  const { service, store, materializer } = serviceWith();
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  const [first, second] = await Promise.all([
    service.resolveCompiled(descriptor, sources),
    service.resolveCompiled(descriptor, sources),
  ]);
  const expected = structuredClone(second);
  equal(first, second);
  throws(() => {
    first.elements[0].qualifiedName = "poison";
  }, TypeError);
  throws(() => {
    first.sources["model.sysml"] = "poison";
  }, TypeError);
  throws(() => {
    first.documents.push({ poison: true });
  }, TypeError);
  equal(await service.resolveCompiled(descriptor, sources), first);
  deepStrictEqual(second, expected);
  deepStrictEqual(await service.resolveCompiled(descriptor, sources), expected);
  const mutable = (await service.resolve(descriptor, sources)).compiled;
  deepStrictEqual(mutable, expected);
  mutable.elements[0].qualifiedName = "mutable public copy";
  mutable.sources["model.sysml"] = "mutable public source";
  deepStrictEqual(first, expected);
  equal(store.getCount, 1);
  equal(materializer.calls, 1);
  equal(service.memoryStats().hits, 3);
});

Deno.test("compiled resolution retains validation, abort, publication and failure retry contracts", async () => {
  const { service, store, materializer } = serviceWith();
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  equal(
    await serviceCode(
      service.resolveCompiled(descriptor, {
        "changed.sysml": "package Changed;",
      }),
    ),
    "BUILD_SOURCE_MISMATCH",
  );
  equal(
    await serviceCode(
      service.resolveCompiled(
        { ...descriptor, buildKey: "f".repeat(64) },
        sources,
      ),
    ),
    "BUILD_DESCRIPTOR_MISMATCH",
  );
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  try {
    await service.resolveCompiled(descriptor, sources, {
      signal: controller.signal,
    });
    throw new Error("expected abort");
  } catch (error) {
    equal(error, controller.signal.reason);
  }
  equal(store.getCount, 0);
  materializer.fail = true;
  equal(
    await serviceCode(service.resolveCompiled(descriptor, sources)),
    "BUILD_MATERIALIZATION_INCOMPATIBLE",
  );
  materializer.fail = false;
  await service.resolveCompiled(descriptor, sources);
  equal(materializer.calls, 2);
  service.clearMemory();
  store.blobs.clear();
  equal(
    await serviceCode(
      service.resolveCompiled(descriptor, sources, { allowRebuild: false }),
    ),
    "BUILD_UNAVAILABLE",
  );
});

Deno.test("oversize compiled results freeze detached copies without freezing adapter output", async () => {
  class CapturingMaterializer extends FakeMaterializer {
    last?: CompiledModel;
    override async materialize(
      input: Parameters<BuildMaterializer["materialize"]>[0],
    ) {
      const value = await super.materialize(input);
      this.last = value;
      return value;
    }
  }
  const materializer = new CapturingMaterializer();
  const { service } = serviceWith({ materializer, memoryCacheBytes: 1 });
  const descriptor = await service.ensure(await compiledFixture(), recipe);
  const [first, second] = await Promise.all([
    service.resolveCompiled(descriptor, sources),
    service.resolveCompiled(descriptor, sources),
  ]);
  notEqual(first, second);
  equal(materializer.calls, 1);
  equal(service.memoryStats().entries, 0);
  throws(() => {
    first.elements[0].qualifiedName = "poison";
  }, TypeError);
  materializer.last!.elements[0].qualifiedName = "adapter mutation";
  materializer.last!.documents.push({ owned: true });
  equal(first.elements[0].qualifiedName, elements[0].qualifiedName);
  equal(second.elements[0].qualifiedName, elements[0].qualifiedName);
  equal(first.documents.length, 0);
});
