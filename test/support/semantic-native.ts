import type { JsonObject } from "../../src/domain/model/records/compiled-model.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import type { ShaclGraphRead } from "../../src/application/model/diagnostics/queries/inputs.ts";
import type { NativeSemanticIndexPort } from "../../src/application/model/semantic/ports/out/native-semantic-index.port.ts";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";
import { sha256HexOfBytes } from "../../src/application/model/builds/service.ts";
import { ModelSemanticIndexService } from "../../src/application/model/semantic/index-service.ts";
import type { SemanticProjectionCache } from "../../src/application/model/semantic/ports/out/semantic-projection-cache.port.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import {
  DenoChildProcessRequester,
  type DenoChildRequesterOptions,
  OxigraphNativeIndex,
  ProcessSemanticIndexExecutor,
} from "../../src/adapters/out/oxigraph/oxigraph.ts";

/** Port cache double; projection, process transport and query execution are real. */
export class MemorySemanticProjectionCache implements SemanticProjectionCache {
  readonly store = new Map<string, Uint8Array>();
  readonly #leases = new Map<string, string>();
  #key(kind: string, version: string, artifact: string) {
    return [kind, version, artifact].join(":");
  }
  hasProjection(kind: string, version: string, artifact: string) {
    return Promise.resolve(this.store.has(this.#key(kind, version, artifact)));
  }
  getProjection(kind: string, version: string, artifact: string) {
    const bytes = this.store.get(this.#key(kind, version, artifact));
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
    this.store.set(this.#key(kind, version, artifact), bytes);
    return Promise.resolve({
      stored: true,
      bytes: bytes.length,
      digest: "0".repeat(64),
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

export async function nativeSemanticFixture(input: {
  readonly addonPath: string;
  readonly elements: readonly JsonObject[];
  readonly requesterOptions?: Partial<DenoChildRequesterOptions>;
}) {
  const requester = new DenoChildProcessRequester({
    addonPath: input.addonPath,
    expectedAddonSha256: await sha256HexOfBytes(
      await Deno.readFile(input.addonPath),
    ),
    ...input.requesterOptions,
  });
  const native = new OxigraphNativeIndex(
    new ProcessSemanticIndexExecutor(requester),
  );
  const service = new ModelSemanticIndexService({
    source: {
      verifiedElements: () =>
        Promise.resolve({
          elements: input.elements,
          libraryNativeIds: input.elements.filter((element) =>
            element.isLibraryElement === true
          )
            .map((element) => String(element["@id"])),
        }),
    },
    projector: new DeterministicRdfModelProjector(),
    cache: new MemorySemanticProjectionCache(),
    native,
  });
  return {
    service,
    requester,
    native,
    async graph(build: BuildRef): Promise<ShaclGraphRead> {
      const status = await service.ensureProjection(build);
      if (status.state !== "ready" || !status.projection) {
        throw new Error("Native fixture requires a completed exact projection");
      }
      return {
        build,
        projection: status.projection,
        query: (sparql, limits) =>
          service.queryReadOnly({ build, sparql, limits }),
      };
    },
  };
}

/** Machine-readable failure fields retained by test diagnostics; the error itself
 * is rethrown unchanged and no query source or result values are included. */
export function nativeFixtureFailure(error: unknown) {
  const failure = error as {
    code?: unknown;
    context?: unknown;
    recovery?: unknown;
  } | null;
  return {
    code: typeof failure?.code === "string" ? failure.code : "UNKNOWN",
    context: failure?.context ?? null,
    recovery: failure?.recovery ?? null,
  };
}

export interface NativeFixtureQueryObservation {
  readonly ordinal: number;
  readonly durationMs: number;
  readonly queryBytes: number;
  readonly limits: Parameters<NativeSemanticIndexPort["query"]>[0]["limits"];
  readonly status: "complete" | "failed";
  readonly form?: string;
  readonly rowCount?: number;
  readonly truncated?: boolean;
  readonly code?: string;
  readonly context?: unknown;
  readonly recovery?: unknown;
}

/** Repository and verified-build port doubles, as in backend_test.ts; all graph
 * preparation, backend validation, native execution and report mapping are real. */
export async function nativeSemanticBackendFixture(input: {
  addonPath: string;
  repositoryId?: string;
  observeLoad?: (
    input: Parameters<NativeSemanticIndexPort["load"]>[0],
    artifactBytes: number,
  ) => void;
  observeQuery?: (observation: NativeFixtureQueryObservation) => void;
  elements: JsonObject[];
  facts:
    import("../../src/domain/model/policies/diagnostics.ts").ModelDiagnosticFacts;
  sources?:
    import("../../src/domain/model/value-objects/sources.ts").ModelSources;
  compiled?:
    import("../../src/domain/model/records/compiled-model.ts").CompiledModel;
  recipe?:
    import("../../src/domain/model/value-objects/build.ts").BuildRecipeInputs;
}) {
  const { createModelSemanticBackend } = await import(
    "../../src/adapters/out/oxigraph/backend.ts"
  );
  const {
    artifactDigest,
    artifactPayload,
    buildDescriptor,
    buildKey,
    recipeDigest,
  } = await import("../../src/domain/model/value-objects/build.ts");
  const { modelSourceDigest } = await import(
    "../../src/domain/model/value-objects/sources.ts"
  );
  const { buildRefFromDescriptor } = await import(
    "../../src/domain/model/value-objects/element-ref.ts"
  );
  const sources = input.sources ??
    { "model.sysml": "package SemanticFixture;" };
  const recipe = input.recipe ?? {
    toolkit: { version: "native-fixture", bundleDigest: "b".repeat(64) },
    format: "ase-toolkit-normalized-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "native-fixture",
  };
  const sourceDigest = await modelSourceDigest(sources);
  const recipeHash = await recipeDigest(recipe);
  const artifact = {
    v: 1,
    ...(input.compiled?.provider ? { provider: input.compiled.provider } : {}),
    engineVersion: recipe.engineVersion,
    elements: input.elements,
  };
  const artifactBytes = new TextEncoder().encode(artifactPayload(artifact));
  const descriptor = buildDescriptor({
    repositoryId: input.repositoryId ?? "semantic-backend-fixture",
    sourceDigest,
    recipe,
    recipeDigest: recipeHash,
    buildKey: await buildKey(sourceDigest, recipeHash),
    artifactDigest: await artifactDigest(artifact),
    bytes: artifactBytes.length,
  });
  const compiled = input.compiled ??
    await (await import("../../src/domain/model/value-objects/artifact.ts"))
      .materialize(input.elements, sources, recipe.engineVersion);
  const native = await nativeSemanticFixture({
    addonPath: input.addonPath,
    elements: input.elements,
  });
  const version = `commit:${"a".repeat(40)}`;
  const cache = new MemorySemanticProjectionCache();
  let queryOrdinal = 0;
  const observedNative: NativeSemanticIndexPort = {
    load: async (load) => {
      input.observeLoad?.(load, artifactBytes.length);
      return await native.native.load(load);
    },
    query: async (query) => {
      const ordinal = ++queryOrdinal;
      const started = performance.now();
      const metadata = {
        ordinal,
        queryBytes: new TextEncoder().encode(query.sparql).length,
        limits: query.limits,
      };
      try {
        const result = await native.native.query(query);
        input.observeQuery?.({
          ...metadata,
          durationMs: performance.now() - started,
          status: "complete",
          form: result.form,
          ...(result.form === "solutions"
            ? { rowCount: result.rows.length, truncated: result.truncated }
            : {}),
        });
        return result;
      } catch (error) {
        input.observeQuery?.({
          ...metadata,
          durationMs: performance.now() - started,
          status: "failed",
          ...nativeFixtureFailure(error),
        });
        throw error;
      }
    },
    release: (build) => native.native.release(build),
    isLoaded: (build) => native.native.isLoaded(build),
  };
  const backend = createModelSemanticBackend({
    repositoryId: descriptor.repositoryId,
    repository: {
      header: (requested) =>
        Promise.resolve({ version: requested, sourceDigest, sources }),
      descriptorAt: () => Promise.resolve(descriptor),
    },
    buildService: {
      resolve: () =>
        Promise.resolve({
          descriptor,
          artifactBytes,
          artifact,
          compiled,
          origin: "memory" as const,
        }),
    },
    native: observedNative,
    cache,
    diagnosticsReader: {
      read: () =>
        Promise.resolve({ version, digest: sourceDigest, input: input.facts }),
    },
  });
  return {
    backend,
    version,
    descriptor,
    build: buildRefFromDescriptor(descriptor),
    async close() {
      try {
        await backend.close();
      } finally {
        await native.requester.close();
      }
    },
  };
}

/** Byte-only diagnostic over canonical N-Quads: no second graph or full text copy.
 * Ignore blank-looking text inside literals/IRIs; count actual blank term occurrences.
 */
export function nativeProjectionMeasurements(
  quads: Uint8Array,
  elements: readonly JsonObject[],
) {
  let quadCount = 0,
    blankTermCount = 0,
    blankLabelBytes = 0,
    maxBlankLabelBytes = 0;
  let inIri = false, inLiteral = false, escaped = false;
  for (let offset = 0; offset < quads.length; offset++) {
    const byte = quads[offset]!;
    if (byte === 10) quadCount++;
    if (inLiteral) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) inLiteral = false;
      continue;
    }
    if (inIri) {
      if (byte === 62) inIri = false;
      continue;
    }
    if (byte === 34) {
      inLiteral = true;
      continue;
    }
    if (byte === 60) {
      inIri = true;
      continue;
    }
    if (
      byte !== 95 || quads[offset + 1] !== 58 ||
      (offset > 0 && quads[offset - 1] !== 32 && quads[offset - 1] !== 10)
    ) continue;
    let end = offset + 2;
    while (end < quads.length && quads[end] !== 32) end++;
    const length = end - offset - 2;
    blankTermCount++;
    blankLabelBytes += length;
    maxBlankLabelBytes = Math.max(maxBlankLabelBytes, length);
    offset = end - 1;
  }
  const encoder = new TextEncoder();
  let libraryElementCount = 0,
    libraryJsonBytes = 0,
    userJsonBytes = 0,
    sourceTextBytes = 0;
  for (const element of elements) {
    const bytes = encoder.encode(JSON.stringify(element)).byteLength;
    if (typeof element["sysx:sourceText"] === "string") {
      sourceTextBytes += encoder.encode(element["sysx:sourceText"]).byteLength;
    }
    if (element.isLibraryElement === true) {
      libraryElementCount++;
      libraryJsonBytes += bytes;
    } else userJsonBytes += bytes;
  }
  return {
    elementCount: elements.length,
    quadCount,
    quadBytes: quads.byteLength,
    blankTermCount,
    blankLabelBytes,
    maxBlankLabelBytes,
    libraryElementCount,
    libraryJsonBytes,
    userJsonBytes,
    sourceTextBytes,
  };
}
