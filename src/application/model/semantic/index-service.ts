/** Semantic index use-case (W5): a derived, rebuildable index
 * over the deterministic RDF projection of one verified build.
 *
 * The index grants no rights and publishes nothing: Git/build identity
 * stays authoritative, queries are read-only against the single build the
 * caller already resolved, and losing the index only costs a reload from
 * the W2 projection cache (or a re-projection). No storage, process or
 * native dependency lives here; the W2 store appears only as the narrow
 * `SemanticProjectionCache` port in `ports/out/`.
 */
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import {
  type BuildRef,
  buildRefKey,
  parseBuildRef,
  parseProjectionRef,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import { BuildStoreError } from "../builds/ports/out/build-store.port.ts";
import type {
  SemanticQueryLimits,
  SemanticQueryRequest,
  SemanticQueryResult,
} from "./queries/inputs.ts";
import type { NativeSemanticIndexPort } from "./ports/out/native-semantic-index.port.ts";
import type { SemanticProjectionPreparer } from "./ports/out/semantic-projection-preparer.port.ts";
import type { VerifiedBuildElementsSource } from "./ports/out/verified-build-elements-source.port.ts";
import type { ModelRdfProjector } from "./ports/out/rdf-projector.port.ts";
import type { SemanticProjectionCache } from "./ports/out/semantic-projection-cache.port.ts";

export const DEFAULT_QUERY_LIMITS: SemanticQueryLimits = Object.freeze({
  maxResults: 1_000,
  maxBytes: 1_048_576,
  timeoutMs: 5_000,
});
export const HARD_QUERY_LIMITS: SemanticQueryLimits = Object.freeze({
  maxResults: 10_000,
  maxBytes: 8_388_608,
  timeoutMs: 30_000,
});
/** A SPARQL `LIMIT` clause never replaces these execution bounds. */
export const MAX_QUERY_BYTES = 65_536;

export interface SemanticIndexStatus {
  readonly build: BuildRef;
  readonly state: "absent" | "loading" | "ready" | "failed";
  readonly projection?: ProjectionRef;
  readonly quadCount?: number;
  readonly failureCode?: string;
}

/** Consumer-facing port. There is deliberately no source-write method. */
export interface ModelSemanticIndex {
  /** Load (or reload) the build's projection; resolves ready only after
   * the native side verified the digest and the named graph. */
  ensureProjection(build: BuildRef): Promise<SemanticIndexStatus>;
  /** Read-only SPARQL against the pinned build dataset. Requires a prior
   * successful `ensureProjection` for the same build. */
  queryReadOnly(
    request: SemanticQueryRequest,
  ): Promise<SemanticQueryResult>;
  /** Drop the in-memory index for this build. Cached projection bytes
   * stay in the W2 store; Git is never touched. */
  release(build: BuildRef): Promise<void>;
  status(build: BuildRef): Promise<SemanticIndexStatus>;
}

/** Parameters that affect RDF bytes belong in the projection version. S/R/K
 * are build provenance, not projection inputs; repository scope and verified
 * library classification are inputs in addition to immutable A.elements. */
export async function contextualProjectorVersion(
  baseVersion: string,
  build: BuildRef,
  libraryNativeIds: readonly string[],
): Promise<string> {
  if (
    typeof baseVersion !== "string" || !baseVersion ||
    baseVersion.length > 63 ||
    !Array.isArray(libraryNativeIds) ||
    libraryNativeIds.some((id) =>
      typeof id !== "string" || !id || id.length > 2048 || id.includes("\0")
    )
  ) {
    throw new SemanticIndexError("INDEX_INVALID_INPUT", {
      reason:
        "Expected base projector version (1–63 characters) and verified native IDs",
    }, "Invalid projection context");
  }
  const scope = JSON.stringify([
    parseBuildRef(build).repositoryId,
    [...new Set(libraryNativeIds)].sort(),
  ]);
  return `${baseVersion}:${await sha256(scope)}`;
}

export type SemanticIndexErrorCode =
  | "INDEX_INVALID_INPUT"
  | "INDEX_QUERY_REFUSED"
  | "INDEX_PROJECTION_MISSING"
  | "INDEX_PROJECTION_CORRUPT"
  | "INDEX_QUERY_LIMIT"
  | "INDEX_TIMEOUT"
  | "INDEX_BUSY"
  | "INDEX_UNAVAILABLE";

const RECOVERY: Record<SemanticIndexErrorCode, string> = {
  INDEX_INVALID_INPUT:
    "Fix the caller: build reference, query text or limits are malformed (see context.reason).",
  INDEX_QUERY_REFUSED:
    "Use a read-only query form admitted by this caller without FROM, SERVICE or update operations; the dataset is pinned to the build.",
  INDEX_PROJECTION_MISSING:
    "Call ensureProjection(build) first; queries never trigger a hidden projection or load.",
  INDEX_PROJECTION_CORRUPT:
    "Drop the cached rdf-quads projection for this artifact and re-project from the verified build bytes.",
  INDEX_QUERY_LIMIT:
    "Narrow the query; result, byte and time budgets are enforced during execution, not only by LIMIT.",
  INDEX_TIMEOUT:
    "Retry with a narrower query; queue residence counts against the deadline and native execution must recycle its worker on a hard timeout.",
  INDEX_BUSY:
    "Retry shortly or release an idle build; index residency, query concurrency or queue quota is saturated.",
  INDEX_UNAVAILABLE:
    "Ensure the native semantic-index addon is built and its worker starts; there is no fallback engine.",
};

export class SemanticIndexError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: SemanticIndexErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "SemanticIndexError";
    this.recovery = RECOVERY[code];
  }
}

// SPARQL 1.1 PN_PREFIX / PN_LOCAL. Consume the whole prefixed name so
// punctuation inside a legal local name cannot reveal a false bare keyword.
const PN_BASE = String
  .raw`[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]`;
const PN_U = `(?:${PN_BASE}|_)`;
const PN_CHAR = `(?:${PN_U}|[-0-9\u00B7\u0300-\u036F\u203F-\u2040])`;
const PN_ESCAPE = String.raw`(?:%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%])`;
const PN_LOCAL_EDGE = `(?:${PN_CHAR}|:|${PN_ESCAPE})`;
const PREFIXED_NAME = new RegExp(
  `^(?:${PN_BASE}(?:(?:${PN_CHAR}|\\.)*${PN_CHAR})?)?:` +
    `(?:(?:${PN_U}|[:0-9]|${PN_ESCAPE})(?:(?:${PN_CHAR}|[.:]|${PN_ESCAPE})*${PN_LOCAL_EDGE})?)?`,
  "u",
);

/** Bare-word SPARQL tokens: literals, IRIs, prefixed names (`ex:from`)
 * and variables (`?from`) can never masquerade as keywords. */
function sparqlBareWords(query: string): string[] {
  const words: string[] = [];
  let index = 0;
  const charAt = (at: number) => query[at] ?? "";
  while (index < query.length) {
    const char = charAt(index);
    if (char === "#") {
      const end = query.indexOf("\n", index);
      index = end < 0 ? query.length : end + 1;
      continue;
    }
    if (char === "<") {
      const iri = /^<[^<>\s]*>/.exec(query.slice(index));
      index += iri ? iri[0].length : 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const triple = query.startsWith(char.repeat(3), index);
      const closer = triple ? char.repeat(3) : char;
      index += closer.length;
      while (index < query.length) {
        if (charAt(index) === "\\") {
          index += 2;
          continue;
        }
        if (query.startsWith(closer, index)) {
          index += closer.length;
          break;
        }
        index++;
      }
      continue;
    }
    const prefixed = PREFIXED_NAME.exec(query.slice(index));
    if (prefixed) {
      words.push(prefixed[0]);
      index += prefixed[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(query.slice(index));
    if (word) {
      words.push(word[0]);
      index += word[0].length;
      continue;
    }
    if (char === "?" || char === "$") {
      const variable = /^[?$][A-Za-z0-9_]*/.exec(query.slice(index));
      words.push(variable?.[0] ?? char);
      index += variable?.[0].length ?? 1;
      continue;
    }
    index++;
  }
  return words;
}

const FORBIDDEN_KEYWORDS = new Set([
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "CREATE",
  "DROP",
  "COPY",
  "MOVE",
  "ADD",
  "SERVICE",
  "FROM",
  "USING",
  "WITH",
  "INTO",
]);

/** Lexical admission pre-filter. The authoritative check is the native
 * algebra (AST) inspection: updates, LOAD/SERVICE and any client-chosen
 * dataset are refused there too. Both layers must pass. */
export function admitReadOnlySparql(
  sparql: string,
  allowedForms: readonly string[] = ["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"],
): void {
  if (
    typeof sparql !== "string" || !sparql.trim() ||
    new TextEncoder().encode(sparql).length > MAX_QUERY_BYTES
  ) {
    throw new SemanticIndexError(
      "INDEX_INVALID_INPUT",
      { reason: `Expected 1–${MAX_QUERY_BYTES} query bytes` },
      "Invalid SPARQL query size",
    );
  }
  const words = sparqlBareWords(sparql);
  const bare = words.filter((word) =>
    !word.includes(":") && !word.startsWith("?") && !word.startsWith("$")
  ).map((word) => word.toUpperCase());
  let position = 0;
  while (bare[position] === "PREFIX" || bare[position] === "BASE") {
    position++;
  }
  const form = bare[position];
  if (!allowedForms.includes(form ?? "")) {
    throw new SemanticIndexError(
      "INDEX_QUERY_REFUSED",
      { reason: `Query form ${form ?? "<empty>"} is not read-only` },
      `Only ${allowedForms.join(", ")} are admitted`,
    );
  }
  for (const word of bare) {
    if (FORBIDDEN_KEYWORDS.has(word)) {
      throw new SemanticIndexError(
        "INDEX_QUERY_REFUSED",
        { reason: `Forbidden keyword ${word}` },
        `SPARQL keyword ${word} is not admitted`,
      );
    }
  }
}

export function effectiveQueryLimits(
  limits?: Partial<SemanticQueryLimits>,
): SemanticQueryLimits {
  const merged = { ...DEFAULT_QUERY_LIMITS, ...(limits ?? {}) };
  for (
    const key of ["maxResults", "maxBytes", "timeoutMs"] as const
  ) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: `limits.${key} must be a safe integer >= 1` },
        `Invalid query limit: ${key}`,
      );
    }
  }
  return Object.freeze({
    maxResults: Math.min(merged.maxResults, HARD_QUERY_LIMITS.maxResults),
    maxBytes: Math.min(merged.maxBytes, HARD_QUERY_LIMITS.maxBytes),
    timeoutMs: Math.min(merged.timeoutMs, HARD_QUERY_LIMITS.timeoutMs),
  });
}

interface ModelSemanticIndexSharedOptions {
  readonly native: NativeSemanticIndexPort;
  readonly maxConcurrentQueries?: number;
  readonly maxQueuedQueries?: number;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Byte preparation is an explicit test/tool seam, never a fallback when a
 * reference preparer or native reference consumer fails. */
type ModelSemanticIndexServiceOptions =
  & ModelSemanticIndexSharedOptions
  & (
    | {
      readonly preparer: SemanticProjectionPreparer;
      readonly source?: never;
      readonly projector?: never;
      readonly cache?: never;
    }
    | {
      readonly preparer?: never;
      readonly source: VerifiedBuildElementsSource;
      readonly projector: ModelRdfProjector;
      readonly cache?: SemanticProjectionCache;
    }
  );

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** W5 use-case: projection lifecycle + bounded read-only queries. */
export class ModelSemanticIndexService implements ModelSemanticIndex {
  readonly #source?: VerifiedBuildElementsSource;
  readonly #projector?: ModelRdfProjector;
  readonly #preparer?: SemanticProjectionPreparer;
  readonly #cache?: SemanticProjectionCache;
  readonly #native: NativeSemanticIndexPort;
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #leaseOwner: string;
  readonly #leaseTtlMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #ready = new Map<string, SemanticIndexStatus>();
  readonly #inflight = new Map<string, Promise<SemanticIndexStatus>>();
  #activeQueries = 0;
  readonly #queryQueue: Array<
    { buildKey: string; start: () => void; reject: (error: Error) => void }
  > = [];
  readonly #releasing = new Map<string, Promise<void>>();

  constructor(options: ModelSemanticIndexServiceOptions) {
    this.#source = options.source;
    this.#projector = options.projector;
    this.#preparer = options.preparer;
    this.#cache = options.cache;
    this.#native = options.native;
    if (this.#preparer && !this.#native.loadReference) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Reference preparation requires a native reference consumer",
      );
    }
    this.#maxConcurrent = options.maxConcurrentQueries ?? 4;
    this.#maxQueued = options.maxQueuedQueries ?? 32;
    this.#leaseOwner = options.leaseOwner ?? "semantic-index";
    this.#leaseTtlMs = options.leaseTtlMs ?? 120_000;
    for (
      const [key, value, minimum] of [
        ["maxConcurrentQueries", this.#maxConcurrent, 1],
        ["maxQueuedQueries", this.#maxQueued, 0],
        ["leaseTtlMs", this.#leaseTtlMs, 1],
      ] as const
    ) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new SemanticIndexError("INDEX_INVALID_INPUT", {
          reason: `${key} must be a safe integer >= ${minimum}`,
        }, "Invalid semantic index option");
      }
    }
    if (typeof this.#leaseOwner !== "string" || !this.#leaseOwner.trim()) {
      throw new SemanticIndexError("INDEX_INVALID_INPUT", {
        reason: "leaseOwner must be non-empty",
      }, "Invalid lease owner");
    }
    this.#sleep = options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  ensureProjection(buildInput: BuildRef): Promise<SemanticIndexStatus> {
    const build = parseBuildRef(buildInput);
    const key = buildRefKey(build);
    const releasing = this.#releasing.get(key);
    if (releasing) return releasing.then(() => this.ensureProjection(build));
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const task = this.#ensure(build, key).finally(() => {
      if (this.#inflight.get(key) === task) this.#inflight.delete(key);
    });
    this.#inflight.set(key, task);
    return task;
  }

  async #ensure(
    build: BuildRef,
    key: string,
  ): Promise<SemanticIndexStatus> {
    const current = this.#ready.get(key);
    if (current?.state === "ready" && await this.#native.isLoaded(build)) {
      return current;
    }
    this.#ready.set(key, { build, state: "loading" });
    let knownProjection: ProjectionRef | undefined;
    try {
      let projection: ProjectionRef;
      let quadCount: number;
      if (this.#preparer) {
        const prepared = await this.#preparer.prepare(build);
        try {
          projection = parseProjectionRef(prepared.projection);
        } catch {
          throw new SemanticIndexError(
            "INDEX_PROJECTION_CORRUPT",
            {},
            "Preparer returned an invalid projection reference",
          );
        }
        if (
          projection.kind !== "rdf-quads" ||
          projection.artifactDigest !== build.artifactDigest ||
          projection.projectionDigest === build.artifactDigest
        ) {
          throw new SemanticIndexError(
            "INDEX_PROJECTION_CORRUPT",
            {},
            "Prepared projection does not match the requested build",
          );
        }
        knownProjection = projection;
        ({ quadCount } = await this.#native.loadReference!({
          build,
          projection,
        }));
      } else {
        const bytes = await this.#projectionBytes(build);
        projection = bytes.projection;
        knownProjection = projection;
        ({ quadCount } = await this.#native.load({ build, ...bytes }));
      }
      // The ready pointer moves only after the native side verified the
      // digest and graph; A/B loads never disturb each other's pointer.
      const ready: SemanticIndexStatus = Object.freeze({
        build,
        state: "ready" as const,
        projection,
        quadCount,
      });
      this.#ready.set(key, ready);
      return ready;
    } catch (error) {
      this.#ready.set(key, {
        build,
        state: "failed",
        ...(knownProjection ? { projection: knownProjection } : {}),
        failureCode: typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "INDEX_UNAVAILABLE",
      });
      throw error;
    }
  }

  async #projectionBytes(build: BuildRef): Promise<{
    quads: Uint8Array;
    projection: ProjectionRef;
  }> {
    if (!this.#projector || !this.#source) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Byte projection was not configured",
      );
    }
    const { kind } = this.#projector;
    // Classification is verified build metadata, never guessed from element names.
    const { elements, libraryNativeIds } = await this.#source.verifiedElements(
      build,
    );
    const projectorVersion = await contextualProjectorVersion(
      this.#projector.projectorVersion,
      build,
      libraryNativeIds,
    );
    const cached = await this.#readCache(build, projectorVersion);
    if (cached) return cached;
    let leaseHeld = false;
    const leaseKey =
      `semantic-projection:${kind}:${projectorVersion}:${build.artifactDigest}`;
    if (this.#cache) {
      leaseHeld = await this.#cache.acquireLease(
        leaseKey,
        this.#leaseOwner,
        this.#leaseTtlMs,
      );
      if (!leaseHeld) {
        // Another owner is projecting the same immutable bytes; wait for
        // its cache entry, then fall through to an idempotent re-project.
        for (let attempt = 0; attempt < 5; attempt++) {
          await this.#sleep(50);
          const settled = await this.#readCache(build, projectorVersion);
          if (settled) return settled;
        }
      }
    }
    try {
      const projected = await this.#projector.project({
        build,
        elements,
        libraryNativeIds,
      });
      if (
        projected.projection.kind !== kind ||
        projected.projection.projectorVersion !== projectorVersion ||
        projected.projection.artifactDigest !== build.artifactDigest
      ) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          { reason: "Projector returned a mismatched projection ref" },
          "Projection identity does not match the requested build",
        );
      }
      const digest = await sha256(utf8Decoder.decode(projected.quads));
      if (digest !== projected.projection.projectionDigest) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          { reason: "Projector digest does not match its bytes" },
          "Projection bytes fail their stated digest",
        );
      }
      if (digest === build.artifactDigest) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          { reason: "Projection digest must differ from A" },
          "Projection digest collides with the artifact digest",
        );
      }
      await this.#cache?.putProjection(
        kind,
        projectorVersion,
        build.artifactDigest,
        projected.quads,
      );
      return { quads: projected.quads, projection: projected.projection };
    } finally {
      if (leaseHeld) {
        await this.#cache?.releaseLease(leaseKey, this.#leaseOwner);
      }
    }
  }

  async #readCache(build: BuildRef, projectorVersion: string): Promise<
    { quads: Uint8Array; projection: ProjectionRef } | undefined
  > {
    if (!this.#cache || !this.#projector) return undefined;
    const { kind } = this.#projector;
    let quads: Uint8Array;
    try {
      quads = await this.#cache.getProjection(
        kind,
        projectorVersion,
        build.artifactDigest,
      );
    } catch (error) {
      if (
        error instanceof BuildStoreError &&
        error.code === "BUILD_BLOB_MISSING"
      ) {
        return undefined;
      }
      throw error;
    }
    // The store verified the bytes against its own record; the
    // projection digest is content-derived, so cached bytes authenticate
    // themselves. Graph/build agreement is re-verified natively on load.
    const projectionDigest = await sha256(utf8Decoder.decode(quads));
    return {
      quads,
      projection: Object.freeze({
        kind,
        projectorVersion,
        artifactDigest: build.artifactDigest,
        projectionDigest,
      }),
    };
  }

  async queryReadOnly(
    request: SemanticQueryRequest,
  ): Promise<SemanticQueryResult> {
    const build = parseBuildRef(request.build);
    admitReadOnlySparql(request.sparql);
    const limits = effectiveQueryLimits(request.limits);
    // One caller deadline includes status, queue residence and native execution.
    const deadline = performance.now() + limits.timeoutMs;
    let expired = false;
    let cancelQueued: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = buildRefKey(build);
    const timeout = () =>
      new SemanticIndexError("INDEX_TIMEOUT", {
        reason: "Total query deadline exceeded",
      }, "Semantic query timed out");
    const work = (async () => {
      const status = await this.status(build);
      if (expired) throw timeout();
      if (status.state !== "ready" || this.#releasing.has(key)) {
        throw new SemanticIndexError("INDEX_PROJECTION_MISSING", {
          reason: `Index state is ${status.state}`,
          build: key,
        }, "Semantic index is not loaded for this build");
      }
      await this.#acquireQuerySlot(
        key,
        deadline,
        (cancel) => cancelQueued = cancel,
      );
      try {
        if (expired || performance.now() >= deadline) throw timeout();
        if (
          this.#releasing.has(key) || this.#ready.get(key)?.state !== "ready"
        ) {
          throw new SemanticIndexError("INDEX_PROJECTION_MISSING", {
            build: key,
          }, "Semantic index was released while queued");
        }
        return await this.#native.query({
          build,
          sparql: request.sparql,
          limits: {
            ...limits,
            timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          },
        });
      } finally {
        // A caller timeout does not free an executing native slot. The adapter
        // must terminate its worker within the remaining execution budget.
        this.#releaseQuerySlot();
      }
    })();
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            cancelQueued?.();
            reject(timeout());
          }, limits.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  release(buildInput: BuildRef): Promise<void> {
    const build = parseBuildRef(buildInput);
    const key = buildRefKey(build);
    const existing = this.#releasing.get(key);
    if (existing) return existing;
    const task = (async () => {
      // Let an already-started load settle before dropping it; it must not
      // publish ready after release has returned.
      await this.#inflight.get(key)?.catch(() => {});
      for (const queued of [...this.#queryQueue]) {
        if (queued.buildKey === key) {
          queued.reject(
            new SemanticIndexError(
              "INDEX_PROJECTION_MISSING",
              { build: key },
              "Semantic index released while queued",
            ),
          );
        }
      }
      await this.#native.release(build);
      this.#ready.delete(key);
    })().finally(() => this.#releasing.delete(key));
    this.#releasing.set(key, task);
    return task;
  }

  async status(buildInput: BuildRef): Promise<SemanticIndexStatus> {
    const build = parseBuildRef(buildInput);
    const key = buildRefKey(build);
    const known = this.#ready.get(key);
    if (!known) return { build, state: "absent" };
    if (known.state === "ready" && !(await this.#native.isLoaded(build))) {
      // Index loss is not data loss: downgrade and let ensure reload.
      const absent: SemanticIndexStatus = { build, state: "absent" };
      this.#ready.set(key, absent);
      return absent;
    }
    return known;
  }

  #acquireQuerySlot(
    buildKey: string,
    deadline: number,
    registerCancel: (cancel: (() => void) | undefined) => void,
  ): Promise<void> {
    if (this.#activeQueries < this.#maxConcurrent) {
      this.#activeQueries++;
      return Promise.resolve();
    }
    if (this.#queryQueue.length >= this.#maxQueued) {
      return Promise.reject(
        new SemanticIndexError(
          "INDEX_BUSY",
          { reason: "Query queue is full" },
          "Semantic index query quota exceeded",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const remove = () => {
        registerCancel(undefined);
        clearTimeout(timer);
        const index = this.#queryQueue.indexOf(entry);
        if (index >= 0) this.#queryQueue.splice(index, 1);
      };
      const entry = {
        buildKey,
        start: () => {
          remove();
          this.#activeQueries++;
          resolve();
        },
        reject: (error: Error) => {
          remove();
          reject(error);
        },
      };
      const timer = setTimeout(
        () =>
          entry.reject(
            new SemanticIndexError("INDEX_TIMEOUT", {
              reason: "Query expired in queue",
            }, "Semantic query timed out"),
          ),
        Math.max(0, deadline - performance.now()),
      );
      this.#queryQueue.push(entry);
      registerCancel(() =>
        entry.reject(
          new SemanticIndexError("INDEX_TIMEOUT", {
            reason: "Total query deadline exceeded while queued",
          }, "Semantic query timed out"),
        )
      );
    });
  }

  #releaseQuerySlot(): void {
    this.#activeQueries--;
    const next = this.#queryQueue.shift();
    if (next) next.start();
  }
}
