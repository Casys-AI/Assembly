/** Bounded, pinned compiler memoization (W3 hand-off).
 *
 * Wraps one `ModelCompiler` so a candidate compiled and verified outside the
 * repository lock is never compiled again under it: entries are keyed by the
 * exact build identities (S = source digest, R = recipe digest), coalesced
 * per key while in flight, verified on store (S recomputed from the input
 * sources, A recomputed from the compiled artifact) and copied defensively
 * in and out. Failures are never cached. The recipe is pinned per instance
 * (single-flight, cached after the first success): a toolkit package swap
 * requires a new instance, exactly like a process restart — a different R
 * can therefore never silently reuse bytes compiled under another recipe.
 * Pure application code: ports and domain digests only. */
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import {
  artifactDigest,
  artifactPayload,
  buildKey,
  recipeDigest as computeRecipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type {
  ModelCompiler,
  ModelCompilerRecipe,
} from "./ports/out/model-compiler.port.ts";
import { WeightedLruCache } from "../../support/weighted-lru.ts";

interface MemoizedModelCompilerOptions {
  /** Completed compilations kept at most (default 4). */
  readonly maxEntries?: number;
  /** Total canonical artifact bytes kept at most (default 256 MiB). */
  readonly maxBytes?: number;
}

interface MemoizedCompilerStats {
  /** Real compilations delegated to the inner compiler. */
  readonly compilations: number;
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly bytes: number;
}

interface PinnedBuild {
  readonly compiled: CompiledModel;
  readonly artifactDigest: string;
  readonly buildKey: string;
}

const encoder = new TextEncoder();

export class MemoizedModelCompiler implements ModelCompiler {
  readonly #inner: ModelCompiler;
  readonly #maxEntries: number;
  readonly #cache: WeightedLruCache<PinnedBuild>;
  readonly #inFlight = new Map<string, Promise<PinnedBuild>>();
  #recipe?: Promise<ModelCompilerRecipe>;
  #recipeDigest?: Promise<string>;
  #compilations = 0;
  #hits = 0;
  #misses = 0;

  constructor(
    inner: ModelCompiler,
    options: MemoizedModelCompilerOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? 4;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("MemoizedModelCompiler maxEntries must be >= 1");
    }
    this.#inner = inner;
    this.#maxEntries = maxEntries;
    this.#cache = new WeightedLruCache({
      maxBytes: options.maxBytes ?? 256 * 1_048_576,
    });
  }

  /** Pinned recipe: one successful read per instance, cloned per caller. */
  async recipe(): Promise<ModelCompilerRecipe> {
    if (!this.#recipe) {
      const pending = (async () => await this.#inner.recipe())();
      this.#recipe = pending;
      pending.catch(() => {
        if (this.#recipe === pending) {
          this.#recipe = undefined;
          this.#recipeDigest = undefined;
        }
      });
    }
    return structuredClone(await this.#recipe);
  }

  async #pinnedRecipeDigest(): Promise<string> {
    if (!this.#recipeDigest) {
      this.#recipeDigest = (async () =>
        await computeRecipeDigest(await this.recipe()))();
      this.#recipeDigest.catch(() => {
        this.#recipeDigest = undefined;
      });
    }
    return await this.#recipeDigest;
  }

  async compile(sources: Sources): Promise<CompiledModel> {
    const sourceDigest = await modelSourceDigest(sources);
    const pinnedRecipe = await this.#pinnedRecipeDigest();
    const key = `${sourceDigest}:${pinnedRecipe}`;
    const hit = this.#cache.get(key);
    if (hit) {
      if (hit.compiled.sourceDigest !== sourceDigest) {
        this.#cache.delete(key);
        throw new Error("Pinned compilation no longer matches its sources");
      }
      this.#hits++;
      return structuredClone(hit.compiled);
    }
    this.#misses++;
    let work = this.#inFlight.get(key);
    if (!work) {
      work = this.#compileAndPin(key, sourceDigest, pinnedRecipe, sources);
      this.#inFlight.set(key, work);
      const settle = () => {
        if (this.#inFlight.get(key) === work) this.#inFlight.delete(key);
      };
      work.then(settle, settle);
    }
    const pinned = await work;
    return structuredClone(pinned.compiled);
  }

  async #compileAndPin(
    key: string,
    sourceDigest: string,
    pinnedRecipe: string,
    sources: Sources,
  ): Promise<PinnedBuild> {
    this.#compilations++;
    const compiled = await this.#inner.compile(structuredClone(sources));
    if (compiled.sourceDigest !== sourceDigest) {
      throw new Error(
        "Compiler produced a model whose source digest differs from its input",
      );
    }
    const pinned: PinnedBuild = {
      compiled: structuredClone(compiled),
      artifactDigest: await artifactDigest({
        ...(compiled.provider ? { provider: compiled.provider } : {}),
        engineVersion: compiled.engineVersion,
        elements: compiled.elements,
      }),
      buildKey: await buildKey(sourceDigest, pinnedRecipe),
    };
    const weight = encoder.encode(artifactPayload({
      provider: compiled.provider,
      engineVersion: compiled.engineVersion,
      elements: compiled.elements,
    })).byteLength;
    while (
      this.#cache.stats().entries >= this.#maxEntries &&
      !this.#cache.has(key)
    ) {
      const oldest = this.#cache.keys()[0];
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    this.#cache.set(key, pinned, Math.max(1, weight));
    return pinned;
  }

  /** Measured hand-off evidence: real inner compilations vs pinned hits. */
  stats(): MemoizedCompilerStats {
    const cache = this.#cache.stats();
    return {
      compilations: this.#compilations,
      hits: this.#hits,
      misses: this.#misses,
      entries: cache.entries,
      bytes: cache.bytes,
    };
  }

  /** Drop every pinned build and the pinned recipe (new pin on next use). */
  clear(): void {
    this.#cache.clear();
    this.#inFlight.clear();
    this.#recipe = undefined;
    this.#recipeDigest = undefined;
  }
}
