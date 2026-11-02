/** Model build service (W2d): ensure/resolve verified artifact bytes.
 *
 * Identities S/R/K/A and the descriptor come from domain/model-build; this
 * application service only orchestrates the injected store, vault, compiler
 * and materializer. No native handle or generation appears here, and there
 * is no fallback engine: a cache miss rebuilds only under the exact recipe,
 * otherwise BUILD_RECIPE_UNAVAILABLE — never a fake Git corruption.
 */
import { sha256Bytes } from "../../../domain/primitives/sha256-bytes.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  CompiledModel,
  CompilerDescriptor,
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
  ModelBuildError,
  parseBuildDescriptorStrict,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import {
  modelSourceDigest,
  type ModelSources,
} from "../../../domain/model/value-objects/sources.ts";
import type {
  BuildArtifactPayload,
  BuildMaterializer,
} from "./ports/out/build-materializer.port.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "./ports/out/build-store.port.ts";
import type { ModelBuildVaultPort } from "./ports/out/build-vault.port.ts";
import type { ModelCompiler } from "./ports/out/model-compiler.port.ts";
import { WeightedLruCache } from "../../support/weighted-lru.ts";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_BUILD_LEASE_TTL_MS = 60_000;
/** Completed verified snapshots, conservatively weighted, per service instance. */
const DEFAULT_BUILD_MEMORY_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_BUILD_MAX_IN_FLIGHT = 32;

interface ModelBuildServiceOptions {
  readonly repositoryId: string;
  readonly store: ModelBuildStore;
  readonly vault?: ModelBuildVaultPort;
  readonly compiler?: ModelCompiler;
  readonly materializer: BuildMaterializer;
  readonly maxArtifactBytes?: number;
  /** Byte budget for private completed verified snapshots (default 64 MiB).
   * An entry exceeding this whole budget is returned without retention. */
  readonly memoryCacheBytes?: number;
  /** Bounds distinct concurrent resolutions independently of completed bytes. */
  readonly maxInFlightResolutions?: number;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
  readonly leaseWaitAttempts?: number;
  readonly leaseWaitDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedModelBuild {
  readonly descriptor: BuildDescriptor;
  /** Defensive copy of the compact canonical artifact bytes. */
  readonly artifactBytes: Uint8Array;
  readonly artifact: BuildArtifactPayload;
  readonly compiled: CompiledModel;
  readonly origin: "cache" | "vault" | "rebuilt" | "memory";
}

export type ModelBuildServiceErrorCode =
  | "BUILD_DESCRIPTOR_MISMATCH"
  | "BUILD_SOURCE_MISMATCH"
  | "BUILD_CORRUPT"
  | "BUILD_MATERIALIZATION_INCOMPATIBLE"
  | "BUILD_RECIPE_UNAVAILABLE"
  | "BUILD_OUTPUT_MISMATCH"
  | "BUILD_UNAVAILABLE"
  | "ARTIFACT_TOO_LARGE"
  | "BUILD_INVALID_INPUT";

const SERVICE_RECOVERY: Record<ModelBuildServiceErrorCode, string> = {
  BUILD_DESCRIPTOR_MISMATCH:
    "Re-derive the descriptor from the commit sources and exact recipe, then retry.",
  BUILD_SOURCE_MISMATCH:
    "Resolve with the exact sources of the commit named by the descriptor.",
  BUILD_CORRUPT:
    "Restore verified bytes from the vault or rebuild under the exact recipe; do not trust these bytes.",
  BUILD_MATERIALIZATION_INCOMPATIBLE:
    "Materialize with a reader supporting this artifact schema/IR, or rebuild under a supported recipe.",
  BUILD_RECIPE_UNAVAILABLE:
    "Restore the artifact bytes from the vault/backup; this recipe can no longer be executed here.",
  BUILD_OUTPUT_MISMATCH:
    "Investigate compiler nondeterminism: the exact recipe produced different bytes for the same sources.",
  BUILD_UNAVAILABLE:
    "Retry once the build store or rebuild lease settles; the descriptor itself is not indicted.",
  ARTIFACT_TOO_LARGE:
    "Raise maxArtifactBytes only deliberately, or reduce the compiled model size.",
  BUILD_INVALID_INPUT:
    "Fix the caller: the compiled model and recipe disagree (see context.reason).",
};

export class ModelBuildServiceError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: ModelBuildServiceErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "ModelBuildServiceError";
    this.recovery = SERVICE_RECOVERY[code];
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  return await sha256Bytes(copyBytes(bytes));
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Only detached private compiler JSON graphs enter here. Freeze before walking
 * so aliases (and unexpected cycles) are visited once without retaining a set. */
function freezePrivateGraph<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezePrivateGraph(child);
  }
  return value;
}

function corrupt(reason: string, extra: Record<string, unknown> = {}): never {
  throw new ModelBuildServiceError(
    "BUILD_CORRUPT",
    { reason, ...extra },
    `Corrupt build artifact: ${reason}`,
  );
}

/** Compact canonical bytes whose sha256 is A (domain artifactPayload). */
export function artifactBytesFor(compiled: CompiledModel): Uint8Array {
  return encoder.encode(artifactPayload({
    provider: compiled.provider,
    engineVersion: compiled.engineVersion,
    elements: compiled.elements,
  }));
}

function parseProvider(value: unknown): CompilerDescriptor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    corrupt("provider is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (canonical(keys) !== canonical(["format", "name", "version"])) {
    corrupt("provider keys are not exactly name/version/format");
  }
  for (const key of ["name", "version", "format"]) {
    if (typeof record[key] !== "string" || !(record[key] as string)) {
      corrupt(`provider.${key} is not a non-empty string`);
    }
  }
  return {
    name: record.name as string,
    version: record.version as string,
    format: record.format as string,
  };
}

/** Strict parse of compact artifact bytes. Non-canonical encodings and
 * shape drift are corruption; an unknown schema version is incompatible
 * materialization, not corruption. */
export function parseArtifactBytes(bytes: Uint8Array): BuildArtifactPayload {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (cause) {
    corrupt("bytes are not valid UTF-8", { cause: String(cause) });
  }
  let value: unknown;
  try {
    value = JSON.parse(text!);
  } catch (cause) {
    corrupt("bytes are not valid JSON", { cause: String(cause) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    corrupt("artifact is not an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["v", "provider", "engineVersion", "elements"].includes(key)) {
      corrupt(`unexpected artifact field ${key}`);
    }
  }
  const v = record.v;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    corrupt("artifact v is not a safe integer >= 0");
  }
  if (v !== ARTIFACT_SCHEMA) {
    throw new ModelBuildServiceError(
      "BUILD_MATERIALIZATION_INCOMPATIBLE",
      {
        reason: "unsupported artifact schema",
        artifactSchema: v,
        supported: ARTIFACT_SCHEMA,
      },
      `Unsupported artifact schema: ${String(v)}`,
    );
  }
  if (
    typeof record.engineVersion !== "string" || !record.engineVersion ||
    !Array.isArray(record.elements) ||
    record.elements.some((el) =>
      !el || typeof el !== "object" || Array.isArray(el)
    )
  ) {
    corrupt("artifact engineVersion/elements have the wrong shape");
  }
  const provider = parseProvider(record.provider);
  const expected = artifactPayload({
    provider,
    engineVersion: record.engineVersion as string,
    elements: record.elements as JsonObject[],
  });
  if (expected !== text!) {
    corrupt("artifact bytes are not the canonical payload");
  }
  return {
    v: v as number,
    ...(provider ? { provider } : {}),
    engineVersion: record.engineVersion as string,
    elements: record.elements as JsonObject[],
  };
}

function frozenDescriptor(d: BuildDescriptor): BuildDescriptor {
  Object.freeze(d.recipe.toolkit);
  Object.freeze(d.recipe);
  return Object.freeze(d);
}

/** Validate S/R/K and the supported descriptor schema against an independently
 * established source digest. Callers must not substitute the descriptor's own S
 * for a repository/source binding check. No artifact or IR is materialized. */
export async function validateBuildDescriptor(
  descriptor: BuildDescriptor,
  repositoryId: string,
  sourceDigest: string,
  maxArtifactBytes = MAX_ARTIFACT_BYTES,
): Promise<BuildDescriptor> {
  let strict: BuildDescriptor;
  try {
    strict = parseBuildDescriptorStrict(descriptor);
  } catch (error) {
    if (error instanceof ModelBuildError) {
      throw new ModelBuildServiceError(
        "BUILD_DESCRIPTOR_MISMATCH",
        { reason: error.context.reason, path: error.context.path },
        "Build descriptor is not strictly valid",
      );
    }
    throw error;
  }
  if (strict.repositoryId !== repositoryId) {
    throw new ModelBuildServiceError(
      "BUILD_DESCRIPTOR_MISMATCH",
      {
        reason: "repositoryId differs",
        expected: repositoryId,
        actual: strict.repositoryId,
      },
      "Build descriptor belongs to another repository",
    );
  }
  if (strict.bytes > maxArtifactBytes) {
    throw new ModelBuildServiceError(
      "ARTIFACT_TOO_LARGE",
      { bytes: strict.bytes, maxArtifactBytes: maxArtifactBytes },
      "Descriptor artifact exceeds the size bound",
    );
  }
  if (sourceDigest !== strict.sourceDigest) {
    throw new ModelBuildServiceError(
      "BUILD_SOURCE_MISMATCH",
      {
        expectedSourceDigest: strict.sourceDigest,
        actualSourceDigest: sourceDigest,
      },
      "Sources do not match the descriptor source digest S",
    );
  }
  const { digest: _digest, ...recipeInputs } = strict.recipe;
  const recomputedRecipe = await recipeDigest(recipeInputs);
  if (recomputedRecipe !== strict.recipe.digest) {
    throw new ModelBuildServiceError(
      "BUILD_DESCRIPTOR_MISMATCH",
      {
        reason: "recipe digest R differs",
        expected: strict.recipe.digest,
        actual: recomputedRecipe,
      },
      "Descriptor recipe does not hash to its digest R",
    );
  }
  const recomputedKey = await buildKey(sourceDigest, recomputedRecipe);
  if (recomputedKey !== strict.buildKey) {
    throw new ModelBuildServiceError(
      "BUILD_DESCRIPTOR_MISMATCH",
      {
        reason: "build key K differs",
        expected: strict.buildKey,
        actual: recomputedKey,
      },
      "Descriptor build key K does not match S and R",
    );
  }
  if (strict.recipe.artifactSchema !== ARTIFACT_SCHEMA) {
    throw new ModelBuildServiceError(
      "BUILD_MATERIALIZATION_INCOMPATIBLE",
      {
        reason: "descriptor artifactSchema is not materializable here",
        artifactSchema: strict.recipe.artifactSchema,
        supported: ARTIFACT_SCHEMA,
      },
      "Descriptor artifact schema cannot be materialized here",
    );
  }
  return frozenDescriptor(strict);
}

/** Verify size, SHA-256, canonical encoding and engine without building an IR. */
export async function validateBuildArtifact(
  bytes: Uint8Array,
  descriptor: BuildDescriptor,
): Promise<BuildArtifactPayload> {
  if (bytes.byteLength !== descriptor.bytes) {
    corrupt("artifact byte length differs from descriptor", {
      artifactDigest: descriptor.artifactDigest,
      expectedBytes: descriptor.bytes,
      actualBytes: bytes.byteLength,
    });
  }
  const digest = await sha256HexOfBytes(bytes);
  if (digest !== descriptor.artifactDigest) {
    corrupt("artifact sha256 differs from descriptor A", {
      artifactDigest: descriptor.artifactDigest,
      actualSha256: digest,
    });
  }
  const artifact = parseArtifactBytes(bytes);
  const redigested = await artifactDigest({
    provider: artifact.provider,
    engineVersion: artifact.engineVersion,
    elements: artifact.elements,
  });
  if (redigested !== descriptor.artifactDigest) {
    corrupt("re-derived artifact digest differs from descriptor A", {
      artifactDigest: descriptor.artifactDigest,
      actualSha256: redigested,
    });
  }
  if (artifact.engineVersion !== descriptor.recipe.engineVersion) {
    corrupt("artifact engineVersion differs from descriptor recipe", {
      expected: descriptor.recipe.engineVersion,
      actual: artifact.engineVersion,
    });
  }
  return artifact;
}

/** Conservative graph allocation estimate, computed once at cache fill.
 * Counts actual artifact bytes, UTF-16 strings, property/array slots and object
 * overhead. Shared references are counted once; primitive occurrences may be
 * counted repeatedly, making the estimate conservative rather than a heap SLA.
 * No stringify/parse of the full compiled model is needed on warm reads. */
function resolvedBuildWeight(
  build: ResolvedModelBuild,
  key: string,
  maxBytes: number,
): number {
  const seen = new Set<object>();
  const pending: unknown[] = [build];
  let bytes = 128 + key.length * 2;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") bytes += 32 + value.length * 2;
    else if (value === null || typeof value !== "object") bytes += 16;
    else if (!seen.has(value)) {
      seen.add(value);
      bytes += 64;
      if (value instanceof Uint8Array) bytes += value.byteLength;
      else if (Array.isArray(value)) {
        bytes += value.length * 8;
        for (const child of value) pending.push(child);
      } else {
        for (const [name, child] of Object.entries(value)) {
          bytes += 32 + name.length * 2;
          pending.push(child);
        }
      }
    }
    // Admission needs no exact weight after the lower bound exceeds capacity.
    // Avoid scanning a full oversize IR or cloning a snapshot we cannot keep.
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}

export class ModelBuildService {
  readonly #repositoryId: string;
  readonly #store: ModelBuildStore;
  readonly #vault?: ModelBuildVaultPort;
  readonly #compiler?: ModelCompiler;
  readonly #materializer: BuildMaterializer;
  readonly #maxArtifactBytes: number;
  readonly #leaseOwner: string;
  readonly #leaseTtlMs: number;
  readonly #leaseWaitAttempts: number;
  readonly #leaseWaitDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #ownedCompiled = new WeakSet<CompiledModel>();
  readonly #inFlight = new Map<string, Promise<ResolvedModelBuild>>();
  readonly #memory: WeightedLruCache<ResolvedModelBuild>;
  readonly #maxInFlight: number;
  #memoryEpoch = 0;
  #memoryHits = 0;
  #memoryMisses = 0;

  constructor(options: ModelBuildServiceOptions) {
    if (!options.repositoryId || !options.store || !options.materializer) {
      throw new ModelBuildServiceError(
        "BUILD_INVALID_INPUT",
        { reason: "repositoryId, store and materializer are required" },
        "ModelBuildService requires repositoryId, store and materializer",
      );
    }
    const max = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new ModelBuildServiceError(
        "BUILD_INVALID_INPUT",
        {
          reason: "maxArtifactBytes must be a positive safe integer",
          maxArtifactBytes: max,
        },
        "Invalid maxArtifactBytes",
      );
    }
    const memoryBytes = options.memoryCacheBytes ??
      DEFAULT_BUILD_MEMORY_CACHE_BYTES;
    const maxInFlight = options.maxInFlightResolutions ??
      DEFAULT_BUILD_MAX_IN_FLIGHT;
    if (
      !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 ||
      !Number.isSafeInteger(maxInFlight) || maxInFlight <= 0
    ) {
      throw new ModelBuildServiceError("BUILD_INVALID_INPUT", {
        reason:
          "memoryCacheBytes and maxInFlightResolutions must be positive safe integers",
      }, "Invalid build memory cache limits");
    }
    this.#memory = new WeightedLruCache({ maxBytes: memoryBytes });
    this.#maxInFlight = maxInFlight;
    this.#repositoryId = options.repositoryId;
    this.#store = options.store;
    this.#vault = options.vault;
    this.#compiler = options.compiler;
    this.#materializer = options.materializer;
    this.#maxArtifactBytes = max;
    this.#leaseOwner = options.leaseOwner ??
      `build-service:${crypto.randomUUID()}`;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_BUILD_LEASE_TTL_MS;
    this.#leaseWaitAttempts = options.leaseWaitAttempts ?? 50;
    this.#leaseWaitDelayMs = options.leaseWaitDelayMs ?? 100;
    this.#sleep = options.sleep ??
      ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  /** Inspect bounded derivative memory, never an authority/admission cache. */
  memoryStats() {
    return {
      ...this.#memory.stats(),
      inFlight: this.#inFlight.size,
      maxInFlight: this.#maxInFlight,
      hits: this.#memoryHits,
      misses: this.#memoryMisses,
    };
  }

  /** Force subsequent reads to revalidate persistent bytes. Valid private memory
   * may otherwise serve reads even if disk is later lost/corrupted. Active reads
   * may finish, but cannot refill this cleared generation or be joined by new
   * reads; they remain counted against the in-flight bound until settled. */
  clearMemory(): void {
    this.#memory.clear();
    this.#memoryEpoch++;
  }

  /** Store the compact bytes of an already-compiled model under A
   * (verified put) and return the true descriptor. Never compiles. */
  async ensure(
    compiled: CompiledModel,
    recipe: BuildRecipeInputs,
  ): Promise<BuildDescriptor> {
    if (
      !compiled || typeof compiled !== "object" ||
      !compiled.sources || !Array.isArray(compiled.elements)
    ) {
      throw new ModelBuildServiceError(
        "BUILD_INVALID_INPUT",
        { reason: "compiled model with sources and elements is required" },
        "Invalid compiled model for ensure",
      );
    }
    if (compiled.engineVersion !== recipe.engineVersion) {
      throw new ModelBuildServiceError(
        "BUILD_INVALID_INPUT",
        {
          reason: "compiled engineVersion differs from recipe engineVersion",
          compiledEngineVersion: compiled.engineVersion,
          recipeEngineVersion: recipe.engineVersion,
        },
        "Compiled model does not match the supplied recipe",
      );
    }
    const sourceDigest = await modelSourceDigest(compiled.sources);
    if (compiled.sourceDigest !== sourceDigest) {
      throw new ModelBuildServiceError(
        "BUILD_SOURCE_MISMATCH",
        {
          expectedSourceDigest: sourceDigest,
          compiledSourceDigest: compiled.sourceDigest,
        },
        "Compiled sourceDigest does not match its sources",
      );
    }
    const recipeDigestValue = await recipeDigest(recipe);
    const key = await buildKey(sourceDigest, recipeDigestValue);
    const bytes = artifactBytesFor(compiled);
    if (bytes.byteLength > this.#maxArtifactBytes) {
      throw new ModelBuildServiceError(
        "ARTIFACT_TOO_LARGE",
        { bytes: bytes.byteLength, maxArtifactBytes: this.#maxArtifactBytes },
        "Compiled artifact exceeds the size bound",
      );
    }
    const digest = await artifactDigest({
      provider: compiled.provider,
      engineVersion: compiled.engineVersion,
      elements: compiled.elements,
    });
    const descriptor = frozenDescriptor(buildDescriptor({
      repositoryId: this.#repositoryId,
      sourceDigest,
      recipe,
      recipeDigest: recipeDigestValue,
      buildKey: key,
      artifactDigest: digest,
      bytes: bytes.byteLength,
    }));
    await this.#store.put(digest, bytes);
    return descriptor;
  }

  /** Full S/R/K agreement of the descriptor with these sources. */
  async #validateDescriptor(
    descriptor: BuildDescriptor,
    sources: ModelSources,
  ): Promise<BuildDescriptor> {
    return await validateBuildDescriptor(
      descriptor,
      this.#repositoryId,
      await modelSourceDigest(sources),
      this.#maxArtifactBytes,
    );
  }

  async #validatedArtifact(
    bytes: Uint8Array,
    descriptor: BuildDescriptor,
  ): Promise<BuildArtifactPayload> {
    return await validateBuildArtifact(bytes, descriptor);
  }

  /** Materialization compatibility, checked identically on hit and miss. */
  async #materializeVerified(
    descriptor: BuildDescriptor,
    artifact: BuildArtifactPayload,
    sources: ModelSources,
  ): Promise<CompiledModel> {
    let compiled: CompiledModel;
    try {
      compiled = await this.#materializer.materialize({
        artifact,
        sources,
        descriptor,
      });
    } catch (error) {
      if (error instanceof ModelBuildServiceError) throw error;
      throw new ModelBuildServiceError(
        "BUILD_MATERIALIZATION_INCOMPATIBLE",
        {
          artifactDigest: descriptor.artifactDigest,
          cause: error instanceof Error ? error.message : String(error),
        },
        "Verified artifact bytes cannot be materialized here",
      );
    }
    if (
      compiled.sourceDigest !== descriptor.sourceDigest ||
      compiled.engineVersion !== descriptor.recipe.engineVersion ||
      canonical(compiled.elements) !== canonical(artifact.elements)
    ) {
      throw new ModelBuildServiceError(
        "BUILD_MATERIALIZATION_INCOMPATIBLE",
        {
          reason: "materialized model disagrees with descriptor/artifact",
          artifactDigest: descriptor.artifactDigest,
        },
        "Materialized model does not match the verified artifact",
      );
    }
    return compiled;
  }

  async #fromBytes(
    bytes: Uint8Array,
    descriptor: BuildDescriptor,
    sources: ModelSources,
    origin: ResolvedModelBuild["origin"],
  ): Promise<ResolvedModelBuild> {
    const artifact = await this.#validatedArtifact(bytes, descriptor);
    const compiled = await this.#materializeVerified(
      descriptor,
      artifact,
      sources,
    );
    return {
      descriptor,
      artifactBytes: copyBytes(bytes),
      artifact,
      compiled,
      origin,
    };
  }

  /** Cache-then-vault read; `undefined` when both miss/are unreadable.
   * Incompatible materialization still throws (rebuild gives same A). */
  async #tryStored(
    descriptor: BuildDescriptor,
    sources: ModelSources,
  ): Promise<ResolvedModelBuild | undefined> {
    try {
      const bytes = await this.#store.get(descriptor.artifactDigest);
      return await this.#fromBytes(bytes, descriptor, sources, "cache");
    } catch (error) {
      if (
        error instanceof ModelBuildServiceError &&
        error.code === "BUILD_MATERIALIZATION_INCOMPATIBLE"
      ) throw error;
      // Missing/corrupt/unavailable here only means: fall through.
    }
    if (this.#vault) {
      try {
        const bytes = await this.#vault.getVerified(descriptor.artifactDigest);
        if (bytes !== null) {
          return await this.#fromBytes(bytes, descriptor, sources, "vault");
        }
      } catch (error) {
        if (
          error instanceof ModelBuildServiceError &&
          error.code === "BUILD_MATERIALIZATION_INCOMPATIBLE"
        ) throw error;
      }
    }
    return undefined;
  }

  /** Verified resolution, coalesced per complete verified descriptor and
   * rebuild policy. A identifies compact artifact bytes, not their source or
   * recipe binding: the returned descriptor and materialized sources belong
   * to this exact build. Failed work is evicted so a later resolve retries. */
  async resolve(
    descriptor: BuildDescriptor,
    sources: ModelSources,
    options?: { signal?: AbortSignal; allowRebuild?: boolean },
  ): Promise<ResolvedModelBuild> {
    return structuredClone(
      await this.#resolveSnapshot(descriptor, sources, options),
    );
  }

  /** Resolve an immutable shared compiled JSON graph. Private cache snapshots
   * share their bounded graph; unretained adapter output is detached first.
   * Call resolve instead when an isolated mutable result is required. */
  async resolveCompiled(
    descriptor: BuildDescriptor,
    sources: ModelSources,
    options?: { signal?: AbortSignal; allowRebuild?: boolean },
  ): Promise<CompiledModel> {
    const { compiled } = await this.#resolveSnapshot(
      descriptor,
      sources,
      options,
    );
    return freezePrivateGraph(
      this.#ownedCompiled.has(compiled) ? compiled : structuredClone(compiled),
    );
  }

  async #resolveSnapshot(
    descriptor: BuildDescriptor,
    sources: ModelSources,
    options?: { signal?: AbortSignal; allowRebuild?: boolean },
  ): Promise<ResolvedModelBuild> {
    options?.signal?.throwIfAborted();
    // Sources are strings: detach the caller's mutable dictionary before any
    // asynchronous validation, keeping S and materialization on one input.
    const sourceSnapshot = { ...sources };
    const strict = await this.#validateDescriptor(descriptor, sourceSnapshot);
    options?.signal?.throwIfAborted();
    // The service's materializer/reader compatibility is instance-local. Never
    // share snapshots between instances with a different reader implementation.
    const memoryKey = canonical({ descriptor: strict });
    const cached = this.#memory.get(memoryKey);
    if (cached) {
      this.#memoryHits++;
      return { ...cached, origin: "memory" };
    }
    this.#memoryMisses++;
    const epoch = this.#memoryEpoch;
    const key = canonical({
      memoryKey,
      epoch,
      allowRebuild: options?.allowRebuild !== false,
    });
    const existing = this.#inFlight.get(key);
    if (existing) {
      const value = await existing;
      options?.signal?.throwIfAborted();
      return value;
    }
    if (this.#inFlight.size >= this.#maxInFlight) {
      throw new ModelBuildServiceError("BUILD_UNAVAILABLE", {
        reason: "in-flight resolution capacity reached",
        maxInFlight: this.#maxInFlight,
      }, "Build resolution capacity reached; retry after active reads settle");
    }
    const work = this.#resolveValidated(
      strict,
      sourceSnapshot,
      options?.signal,
      options?.allowRebuild !== false,
    ).then((resolved) => {
      // An oversize result must still be isolated per public caller, but needs
      // no extra cache-owned clone. The in-flight result is never returned
      // directly; each waiter clones below. Clear generations need no snapshot
      // either, since their completions cannot re-enter the retained cache.
      if (this.#memoryEpoch !== epoch) return resolved;
      const capacity = this.#memory.stats().maxBytes;
      const weight = resolvedBuildWeight(resolved, memoryKey, capacity);
      if (weight > capacity) return resolved;
      // Fit entries detach all adapter/caller-owned graphs and byte buffers.
      // structuredClone preserves aliases, so the pre-clone graph weight also
      // applies to this private retained snapshot.
      const snapshot = structuredClone(resolved);
      this.#ownedCompiled.add(snapshot.compiled);
      this.#memory.set(memoryKey, snapshot, weight);
      return snapshot;
    });
    this.#inFlight.set(key, work);
    const settle = () => {
      if (this.#inFlight.get(key) === work) this.#inFlight.delete(key);
    };
    work.then(settle, settle);
    const value = await work;
    options?.signal?.throwIfAborted();
    return value;
  }

  async #resolveValidated(
    descriptor: BuildDescriptor,
    sources: ModelSources,
    signal?: AbortSignal,
    allowRebuild = true,
  ): Promise<ResolvedModelBuild> {
    let corruptError: ModelBuildServiceError | undefined;
    let storeUnavailableError: ModelBuildServiceError | undefined;
    const noteCorrupt = (error: unknown) => {
      if (corruptError) return;
      if (error instanceof ModelBuildServiceError) corruptError = error;
      else {
        corruptError = new ModelBuildServiceError(
          "BUILD_CORRUPT",
          {
            artifactDigest: descriptor.artifactDigest,
            cause: error instanceof Error ? error.message : String(error),
          },
          "Stored build bytes are corrupt",
        );
      }
    };
    // 1. Cache hit path: every check runs even on a hit.
    try {
      const bytes = await this.#store.get(descriptor.artifactDigest);
      return await this.#fromBytes(bytes, descriptor, sources, "cache");
    } catch (error) {
      if (
        error instanceof ModelBuildServiceError &&
        error.code === "BUILD_MATERIALIZATION_INCOMPATIBLE"
      ) throw error;
      if (
        error instanceof ModelBuildServiceError &&
        error.code === "BUILD_CORRUPT"
      ) noteCorrupt(error);
      else if (error instanceof BuildStoreError) {
        if (error.code === "BUILD_BLOB_CORRUPT") noteCorrupt(error);
        else if (error.code !== "BUILD_BLOB_MISSING") {
          const unavailable = new ModelBuildServiceError(
            "BUILD_UNAVAILABLE",
            {
              artifactDigest: descriptor.artifactDigest,
              storeCode: error.code,
            },
            "Build store is unavailable",
          );
          if (
            error.code !== "BUILD_STORE_UNAVAILABLE" &&
            error.code !== "BUILD_STORE_BUSY"
          ) throw unavailable;
          storeUnavailableError = unavailable;
        }
      } else throw error;
    }
    signal?.throwIfAborted();
    // 2. Vault: verified bytes keep history alive without any recipe.
    if (this.#vault) {
      try {
        const bytes = await this.#vault.getVerified(descriptor.artifactDigest);
        if (bytes !== null) {
          const resolved = await this.#fromBytes(
            bytes,
            descriptor,
            sources,
            "vault",
          );
          // Re-populating the cache is an optimization; the vault copy
          // remains authoritative if the cache refuses (e.g. quota).
          await this.#store.put(descriptor.artifactDigest, bytes)
            .catch(() => undefined);
          return resolved;
        }
      } catch (error) {
        if (
          error instanceof ModelBuildServiceError &&
          error.code === "BUILD_MATERIALIZATION_INCOMPATIBLE"
        ) throw error;
        if (
          error instanceof ModelBuildServiceError &&
          error.code === "BUILD_CORRUPT"
        ) noteCorrupt(error);
        else if (
          typeof (error as { code?: unknown })?.code === "string" &&
          (error as { code: string }).code === "BUILD_BLOB_CORRUPT"
        ) noteCorrupt(error);
        // Other vault failures allow an exact-recipe rebuild if the store is up.
      }
    }
    signal?.throwIfAborted();
    // A cache outage cannot hide verified durable history, but it also cannot
    // become a cache miss: rebuilding still requires the store's lease.
    if (storeUnavailableError) throw storeUnavailableError;
    if (!allowRebuild) {
      throw new ModelBuildServiceError("BUILD_UNAVAILABLE", {
        artifactDigest: descriptor.artifactDigest,
        reason:
          "verified hand-off bytes unavailable; compilation prohibited during publication",
      }, "Verified prepared build bytes are unavailable");
    }
    // 3. Exact-recipe rebuild, bounded by the store lease.
    try {
      return await this.#rebuild(descriptor, sources, signal);
    } catch (error) {
      if (
        corruptError && error instanceof ModelBuildServiceError &&
        (error.code === "BUILD_RECIPE_UNAVAILABLE" ||
          error.code === "BUILD_UNAVAILABLE")
      ) {
        throw new ModelBuildServiceError("BUILD_CORRUPT", {
          ...corruptError.context,
          rebuild: error.code,
        }, corruptError.message);
      }
      throw error;
    }
  }

  async #rebuild(
    descriptor: BuildDescriptor,
    sources: ModelSources,
    signal?: AbortSignal,
  ): Promise<ResolvedModelBuild> {
    const artifactDigestValue = descriptor.artifactDigest;
    const leaseKey = `build-rebuild:${artifactDigestValue}`;
    let acquired = await this.#store.acquireLease(
      leaseKey,
      this.#leaseOwner,
      this.#leaseTtlMs,
    );
    if (!acquired) {
      for (let attempt = 0; attempt < this.#leaseWaitAttempts; attempt++) {
        signal?.throwIfAborted();
        await this.#sleep(this.#leaseWaitDelayMs);
        const stored = await this.#tryStored(descriptor, sources);
        if (stored) return stored;
        acquired = await this.#store.acquireLease(
          leaseKey,
          this.#leaseOwner,
          this.#leaseTtlMs,
        );
        if (acquired) break;
      }
      if (!acquired) {
        throw new ModelBuildServiceError(
          "BUILD_UNAVAILABLE",
          {
            reason: "rebuild-lease-held",
            artifactDigest: artifactDigestValue,
            attempts: this.#leaseWaitAttempts,
          },
          "Another rebuild holds the lease and stored no verified bytes in time",
        );
      }
    }
    try {
      // Another owner may have finished between miss and lease.
      const stored = await this.#tryStored(descriptor, sources);
      if (stored) return stored;
      if (!this.#compiler) {
        throw new ModelBuildServiceError(
          "BUILD_RECIPE_UNAVAILABLE",
          { reason: "no-compiler", recipeDigest: descriptor.recipe.digest },
          "No compiler is available to rebuild this build",
        );
      }
      let availableRecipe: string;
      try {
        availableRecipe = await recipeDigest(await this.#compiler.recipe());
      } catch (error) {
        throw new ModelBuildServiceError(
          "BUILD_RECIPE_UNAVAILABLE",
          {
            reason: "compiler-recipe-unreadable",
            recipeDigest: descriptor.recipe.digest,
            cause: error instanceof Error ? error.message : String(error),
          },
          "The available compiler cannot declare an exact recipe",
        );
      }
      if (availableRecipe !== descriptor.recipe.digest) {
        throw new ModelBuildServiceError(
          "BUILD_RECIPE_UNAVAILABLE",
          { expectedRecipe: descriptor.recipe.digest, availableRecipe },
          "The exact recipe of this build is no longer executable here",
        );
      }
      signal?.throwIfAborted();
      const compiled = await this.#compiler.compile(sources);
      const bytes = artifactBytesFor(compiled);
      const rebuiltDigest = await artifactDigest({
        provider: compiled.provider,
        engineVersion: compiled.engineVersion,
        elements: compiled.elements,
      });
      if (
        compiled.sourceDigest !== descriptor.sourceDigest ||
        rebuiltDigest !== artifactDigestValue ||
        bytes.byteLength !== descriptor.bytes
      ) {
        throw new ModelBuildServiceError(
          "BUILD_OUTPUT_MISMATCH",
          {
            expectedArtifactDigest: artifactDigestValue,
            actualArtifactDigest: rebuiltDigest,
            expectedBytes: descriptor.bytes,
            actualBytes: bytes.byteLength,
          },
          "Exact-recipe rebuild produced different artifact bytes",
        );
      }
      const artifact = await this.#validatedArtifact(bytes, descriptor);
      const materialized = await this.#materializeVerified(
        descriptor,
        artifact,
        sources,
      );
      // Verified put before the lease is released: lease waiters in other
      // processes must observe complete bytes, never a partial rebuild.
      await this.#store.put(artifactDigestValue, bytes);
      signal?.throwIfAborted();
      return {
        descriptor,
        artifactBytes: copyBytes(bytes),
        artifact,
        compiled: materialized,
        origin: "rebuilt",
      };
    } finally {
      await this.#store.releaseLease(leaseKey, this.#leaseOwner)
        .catch(() => undefined);
    }
  }
}
