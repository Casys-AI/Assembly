import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  BLOB_KEY,
  BLOB_META_KEY,
  getAsBlob,
  getMeta,
  set,
} from "@kitsonk/kv-toolbox/blob";

import {
  type CodecTimingObserver,
  observeCodec,
} from "../../../infrastructure/codec-timing.ts";
import {
  type BuildPutResult,
  BuildStoreError,
  type BuildStoreStats,
  type BuildSweepResult,
  type ModelBuildStore,
} from "../../../application/model/builds/ports/out/build-store.port.ts";

/** Deno KV adapter for ModelBuildStore (kv-toolbox blob, zstd-3 + checksum).
 *
 * Key layout (plan W2): ["format"] {schema:1};
 * ["build","blob",A] blob;
 * ["proj",kind,projectorVersion,A] historical blob; new projection bytes
 * ["proj-bytes",outputDigest], selected by CAS on ["proj-meta",kind,version,A]
 * {bytes,sha256,blobDigest?,at}; ["write-epoch"] fences quota accounting; ["lease",key] {expiresAt,owner} (see acquireLease note);
 * ["use",A] {at,bytes,class}. A/K are sha256 over uncompressed bytes.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const LEGACY_KEY = /^legacy:[0-9a-f]{64}$/;
const FORMAT_SCHEMA = 1;
const LEASE_GC_GRACE_MS = 60_000;
const USE_WRITE_INTERVAL_MS = 3_600_000;
const BUSY_MAX_ATTEMPTS = 200;

export interface KvModelBuildStoreOptions {
  readonly path: string;
  /** Consumers require an initialized regular cache file. This prevents
   * directory/schema initialization; SQLite itself still requires write access. */
  readonly existingOnly?: boolean;
  readonly quotaBytes?: number;
  /** Injectable clock (epoch ms) for lease/use tests; defaults to Date.now. */
  readonly now?: () => number;
  readonly observeCodecTiming?: CodecTimingObserver;
}

/** Adapter-only budgets for native projection consumers. The generic build
 * store port keeps its existing unbounded verified-read contract. */
export interface KvProjectionReadLimits {
  readonly maxUncompressedBytes: number;
  readonly maxCompressedBytes: number;
}

export class KvModelBuildReadLimitError extends Error {
  readonly code = "BUILD_STORE_READ_LIMIT";
  constructor(
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "KvModelBuildReadLimitError";
  }
}

interface LeaseValue {
  readonly expiresAt: number;
  readonly owner: string;
}
interface ProjMetaValue {
  /** Absent only for historical logical-identity physical keys. */
  readonly blobDigest?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly at: number;
}
interface UseValue {
  readonly at: number;
  readonly bytes: number;
  readonly class: string;
}

/** Rule 2: exact ArrayBuffer copy; never a subarray view or pooled Buffer. */
function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function exactBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function compress(
  bytes: Uint8Array,
  observer?: CodecTimingObserver,
): ArrayBuffer {
  // zstd level 3 with content checksum (node:zlib); output Buffer is pooled,
  // so it is copied into an exact ArrayBuffer before kv-toolbox sees it.
  return observeCodec(
    observer,
    "zstd.kv.compress-with-copy",
    bytes.byteLength,
    () => {
      const compressed = zstdCompressSync(bytes, {
        params: {
          [zlibConstants.ZSTD_c_compressionLevel]: 3,
          [zlibConstants.ZSTD_c_checksumFlag]: 1,
        },
      });
      return exactArrayBuffer(compressed);
    },
  );
}

function decompress(
  compressed: Uint8Array,
  context: Readonly<Record<string, unknown>>,
  label: string,
  maxOutputLength?: number,
  observer?: CodecTimingObserver,
): Uint8Array {
  try {
    return observeCodec(
      observer,
      "zstd.kv.decompress-with-copy",
      compressed.byteLength,
      () =>
        exactBytes(zstdDecompressSync(
          compressed,
          maxOutputLength === undefined ? undefined : { maxOutputLength },
        )),
    );
  } catch (cause) {
    throw new BuildStoreError(
      "BUILD_BLOB_CORRUPT",
      { ...context, stage: "decompress", cause: String(cause) },
      `Stored blob failed zstd decompression: ${label}`,
    );
  }
}

export function isBusyError(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

export { BUSY_MAX_ATTEMPTS };

export interface RetryBusyOptions {
  readonly maxAttempts?: number;
  /** Delay after the given failed attempt (0-based). Default: bounded
   * exponential backoff plus jitter. Tests inject a fixed function. */
  readonly delayMs?: (attempt: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Rule 6: every `check` (and idempotent blob write) goes through retryBusy.
 * Only recognized locked-database errors retry; anything else propagates on
 * the first attempt. Options exist so tests pin attempts, delays and
 * exhaustion deterministically (no timers, no randomness). */
export async function retryBusy<T>(
  operation: () => Promise<T>,
  options: RetryBusyOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? BUSY_MAX_ATTEMPTS;
  const sleep = options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      const backoff = options.delayMs
        ? options.delayMs(attempt)
        : Math.min(20, 2 ** Math.min(attempt, 5)) + random();
      await sleep(Math.max(0, backoff));
    }
  }
  throw new BuildStoreError(
    "BUILD_STORE_BUSY",
    { attempts: maxAttempts, cause: String(lastError) },
    "Deno KV stayed locked after retry budget exhaustion",
  );
}

function unavailable(operation: string, cause: unknown): BuildStoreError {
  return new BuildStoreError(
    "BUILD_STORE_UNAVAILABLE",
    {
      operation,
      cause: errorMessage(cause),
    },
    `Build store unavailable during ${operation}`,
  );
}

function assertDigest(digest: string): void {
  if (!HEX64.test(digest)) {
    throw new BuildStoreError(
      "BUILD_STORE_INVALID_INPUT",
      { digest, reason: "Expected 64 lowercase hex characters" },
      `Invalid blob digest: ${digest}`,
    );
  }
}

function assertArtifactKey(artifactKey: string): void {
  if (!HEX64.test(artifactKey) && !LEGACY_KEY.test(artifactKey)) {
    throw new BuildStoreError(
      "BUILD_STORE_INVALID_INPUT",
      { artifactKey, reason: "Expected artifact digest or legacy:<digest>" },
      `Invalid projection artifact key: ${artifactKey}`,
    );
  }
}

function assertSegment(value: string, name: string): void {
  if (!value || value.length > 128) {
    throw new BuildStoreError(
      "BUILD_STORE_INVALID_INPUT",
      { [name]: value, reason: "Expected 1-128 characters" },
      `Invalid projection ${name}`,
    );
  }
}

const blobKey = (digest: string): Deno.KvKey => ["build", "blob", digest];
const projKey = (
  kind: string,
  version: string,
  artifactKey: string,
): Deno.KvKey => ["proj", kind, version, artifactKey];
const projMetaKey = (
  kind: string,
  version: string,
  artifactKey: string,
): Deno.KvKey => ["proj-meta", kind, version, artifactKey];
const projectionBlobKey = (
  digest: string,
): Deno.KvKey => ["proj-bytes", digest];
const WRITE_EPOCH_KEY: Deno.KvKey = ["write-epoch"];
const leaseKey = (key: string): Deno.KvKey => ["lease", key];
const useKey = (digest: string): Deno.KvKey => ["use", digest];

export class KvModelBuildStore implements ModelBuildStore {
  readonly #kv: Deno.Kv;
  #closed = false;
  readonly #quotaBytes: number | null;
  readonly #now: () => number;
  readonly #observeCodecTiming?: CodecTimingObserver;

  private constructor(
    kv: Deno.Kv,
    options: {
      quotaBytes?: number;
      now?: () => number;
      observeCodecTiming?: CodecTimingObserver;
    },
  ) {
    this.#kv = kv;
    this.#quotaBytes = options.quotaBytes ?? null;
    this.#now = options.now ?? Date.now;
    this.#observeCodecTiming = options.observeCodecTiming;
  }

  static async open(
    options: KvModelBuildStoreOptions,
  ): Promise<KvModelBuildStore> {
    // Rule 1: without "unstable": ["kv"], Deno.openKv is silently undefined.
    if (typeof Deno.openKv !== "function") {
      throw new BuildStoreError(
        "BUILD_STORE_UNAVAILABLE",
        { path: options.path, reason: "Deno.openKv is undefined" },
        "Deno KV is unavailable (missing unstable kv flag)",
      );
    }
    if (options.existingOnly) {
      try {
        const info = await Deno.lstat(options.path);
        if (!info.isFile || info.isSymlink) {
          throw new Error("Expected an existing regular build cache file");
        }
      } catch (cause) {
        throw unavailable("open.existing", cause);
      }
    }
    const slash = options.path.lastIndexOf("/");
    if (!options.existingOnly && slash > 0) {
      await Deno.mkdir(options.path.slice(0, slash), { recursive: true })
        .catch((cause) => {
          throw unavailable("open.mkdir", cause);
        });
    }
    let kv: Deno.Kv;
    try {
      kv = await retryBusy(() => Deno.openKv(options.path));
    } catch (cause) {
      if (cause instanceof BuildStoreError) throw cause;
      throw unavailable("open", cause);
    }
    try {
      const format = await kv.get<{ schema: number }>(["format"]);
      if (format.value === null) {
        if (options.existingOnly) {
          throw new BuildStoreError(
            "BUILD_STORE_UNAVAILABLE",
            { path: options.path, reason: "Missing initialized format schema" },
            "Build cache must be initialized before consumer access",
          );
        }
        await retryBusy(() =>
          kv.atomic().check(format).set(["format"], { schema: FORMAT_SCHEMA })
            .commit()
        );
      } else if (format.value.schema !== FORMAT_SCHEMA) {
        throw new BuildStoreError(
          "BUILD_STORE_UNAVAILABLE",
          {
            path: options.path,
            reason: "Unsupported format schema",
            schema: format.value.schema,
          },
          "Unsupported build cache format schema",
        );
      }
    } catch (error) {
      kv.close();
      if (error instanceof BuildStoreError) throw error;
      throw unavailable("open.format", error);
    }
    // No sweep at open: an open from another process must never touch an
    // in-flight put (its meta is written last). Orphans are invisible and
    // removed by an explicit sweep() (W2g GC).
    return new KvModelBuildStore(kv, options);
  }

  async has(digest: string): Promise<boolean> {
    assertDigest(digest);
    try {
      const meta = await getMeta(this.#kv, blobKey(digest));
      return meta.value !== null;
    } catch (error) {
      throw unavailable("has", error);
    }
  }

  /** Verified read shared by blobs and projections: getAsBlob, decompress,
   * sha256 compared to `expectedSha256`; errors carry `context`. */
  async #readVerified(
    key: Deno.KvKey,
    expectedSha256: string,
    context: Readonly<Record<string, unknown>>,
    label: string,
    opts: {
      expectedBytes?: number;
      limits?: KvProjectionReadLimits;
    } = {},
  ): Promise<Uint8Array> {
    let compressed: Uint8Array;
    if (opts.limits) {
      compressed = await this.#readBoundedCompressed(
        key,
        opts.limits.maxCompressedBytes,
        context,
        label,
      );
    } else {
      // Rule 5: read via getAsBlob, never the quadratic per-chunk `get`.
      let blob: Blob | null;
      try {
        blob = await getAsBlob(this.#kv, key);
      } catch (error) {
        throw unavailable("get.blob", error);
      }
      if (blob === null) {
        throw new BuildStoreError(
          "BUILD_BLOB_MISSING",
          { ...context, reason: "Meta present but chunks missing" },
          `Incomplete blob stored for digest: ${label}`,
        );
      }
      compressed = new Uint8Array(await blob.arrayBuffer());
    }
    // A bounded reader rejects oversized declared output before reading chunks.
    // A stream expanding beyond its admitted metadata is corrupt, including
    // forged small metadata; zstd must stop before allocating that output.
    const maxOutputLength = opts.limits
      ? Math.max(
        1,
        Math.min(opts.expectedBytes!, opts.limits.maxUncompressedBytes),
      )
      : undefined;
    const bytes = decompress(
      compressed,
      context,
      label,
      maxOutputLength,
      this.#observeCodecTiming,
    );
    const actual = await sha256(bytes);
    if (
      actual !== expectedSha256 ||
      (opts.expectedBytes !== undefined &&
        bytes.byteLength !== opts.expectedBytes)
    ) {
      throw new BuildStoreError(
        "BUILD_BLOB_CORRUPT",
        {
          ...context,
          stage: "verify",
          expectedBytes: opts.expectedBytes,
          actualBytes: bytes.byteLength,
          expectedSha256,
          actualSha256: actual,
        },
        `Stored blob sha256 mismatch: ${label}`,
      );
    }
    return bytes;
  }

  async #readBoundedCompressed(
    key: Deno.KvKey,
    limit: number,
    context: Readonly<Record<string, unknown>>,
    label: string,
  ): Promise<Uint8Array> {
    let meta;
    try {
      meta = await getMeta(this.#kv, key);
    } catch (error) {
      throw unavailable("get.blob.meta", error);
    }
    if (meta.value === null) {
      throw new BuildStoreError(
        "BUILD_BLOB_MISSING",
        context,
        `Incomplete blob: ${label}`,
      );
    }
    const declared = meta.value.size;
    if (
      declared !== undefined &&
      (!Number.isSafeInteger(declared) || declared < 0)
    ) {
      throw new BuildStoreError("BUILD_BLOB_CORRUPT", {
        ...context,
        stage: "compressed-meta",
      }, "Malformed compressed byte length");
    }
    if (declared !== undefined && declared > limit) {
      throw new KvModelBuildReadLimitError(
        { ...context, stage: "compressed-meta", bytes: declared, limit },
        "Stored projection exceeds the compressed input budget",
      );
    }
    // kv-toolbox getAsBlob collects every chunk before returning. A bounded
    // consumer uses one geometrically grown buffer capped by its budget, so
    // tiny chunks cannot create unbounded object overhead. The one-entry batch
    // also bounds read-ahead allocation; no per-chunk KV get/cumulative concat.
    const prefix = [...key, BLOB_KEY];
    let compressed = new Uint8Array(Math.min(limit, 65_536));
    let chunks = 0;
    let bytes = 0;
    try {
      for await (
        const entry of this.#kv.list<Uint8Array<ArrayBuffer>>(
          { prefix },
          { batchSize: 1 },
        )
      ) {
        if (
          entry.key.length !== prefix.length + 1 ||
          entry.key[prefix.length] !== chunks + 1 ||
          !(entry.value instanceof Uint8Array) || entry.value.byteLength === 0
        ) {
          throw new BuildStoreError("BUILD_BLOB_CORRUPT", {
            ...context,
            stage: "compressed-chunks",
          }, "Malformed compressed blob chunks");
        }
        bytes += entry.value.byteLength;
        if (declared !== undefined && bytes > declared) {
          throw new BuildStoreError("BUILD_BLOB_CORRUPT", {
            ...context,
            stage: "compressed-chunks",
          }, "Compressed bytes exceed their metadata");
        }
        if (bytes > limit) {
          throw new KvModelBuildReadLimitError(
            { ...context, stage: "compressed-chunks", bytes, limit },
            "Stored projection exceeds the compressed input budget",
          );
        }
        if (bytes > compressed.byteLength) {
          const grown = new Uint8Array(
            Math.min(limit, Math.max(bytes, compressed.byteLength * 2)),
          );
          grown.set(compressed);
          compressed = grown;
        }
        compressed.set(entry.value, bytes - entry.value.byteLength);
        chunks++;
      }
    } catch (error) {
      if (
        error instanceof BuildStoreError ||
        error instanceof KvModelBuildReadLimitError
      ) throw error;
      throw unavailable("get.blob.chunks", error);
    }
    if (chunks === 0) {
      throw new BuildStoreError(
        "BUILD_BLOB_MISSING",
        context,
        `Incomplete blob: ${label}`,
      );
    }
    if (declared !== undefined && bytes !== declared) {
      throw new BuildStoreError("BUILD_BLOB_CORRUPT", {
        ...context,
        stage: "compressed-chunks",
      }, "Compressed byte length does not match its metadata");
    }
    return compressed.subarray(0, bytes);
  }

  /** Blob head: meta marks completeness (rule 3), then verified read. */
  async #readBlob(digest: string): Promise<Uint8Array> {
    let meta;
    try {
      meta = await getMeta(this.#kv, blobKey(digest));
    } catch (error) {
      throw unavailable("get.meta", error);
    }
    if (meta.value === null) {
      throw new BuildStoreError(
        "BUILD_BLOB_MISSING",
        { digest },
        `No complete blob stored for digest: ${digest}`,
      );
    }
    return this.#readVerified(blobKey(digest), digest, { digest }, digest);
  }

  async get(digest: string): Promise<Uint8Array> {
    assertDigest(digest);
    // No use accounting on reads (W2g owns recency): a verified read must
    // not depend on an ancillary write.
    return await this.#readBlob(digest);
  }

  async put(digest: string, bytes: Uint8Array): Promise<BuildPutResult> {
    assertDigest(digest);
    // Pin caller-owned views before the first await: later mutation must
    // never write different bytes beneath an already chosen content key.
    bytes = exactBytes(bytes);
    const actual = await sha256(bytes);
    // Rule 4: immutable digest keys; different content is a conflict.
    if (actual !== digest) {
      throw new BuildStoreError(
        "BUILD_BLOB_CONFLICT",
        { digest, actualSha256: actual },
        `Refusing to store bytes whose sha256 differs from key: ${digest}`,
      );
    }
    let exists = false;
    try {
      exists = (await getMeta(this.#kv, blobKey(digest))).value !== null;
    } catch (error) {
      throw unavailable("put.meta", error);
    }
    if (exists) {
      try {
        await this.#readBlob(digest);
        await this.#touchUse(digest, bytes.byteLength);
        return { stored: false, bytes: bytes.byteLength, digest };
      } catch (error) {
        if (
          !(error instanceof BuildStoreError) ||
          (error.code !== "BUILD_BLOB_CORRUPT" &&
            error.code !== "BUILD_BLOB_MISSING")
        ) throw error;
        // Unreadable entry under its own digest: rewrite it in place below
        // (sha256(bytes) == digest already checked). No delete first: set
        // rewrites the whole blob, and a delete window let two concurrent
        // repairers erase each other's entry (W2c reserve).
      }
    }
    // Reserve the logical bytes before the multi-batch blob write. A failed
    // or crashed put leaves its use reservation charged; retrying the same
    // digest completes it without another charge. Never expire a reservation
    // while an arbitrarily slow writer may still finish.
    await this.#touchUse(digest, bytes.byteLength);
    try {
      await retryBusy(() =>
        set(
          this.#kv,
          blobKey(digest),
          compress(bytes, this.#observeCodecTiming),
        )
      );
    } catch (error) {
      if (error instanceof BuildStoreError) throw error;
      throw unavailable("put.set", error);
    }
    // Rule 3: verified put — re-read, check length + sha256, then announce.
    try {
      await this.#readBlob(digest);
    } catch (error) {
      if (
        error instanceof BuildStoreError && error.code === "BUILD_BLOB_CORRUPT"
      ) {
        throw new BuildStoreError(
          "BUILD_BLOB_CORRUPT",
          { digest, stage: "put-verify" },
          `Put verification failed: ${digest}`,
        );
      }
      throw error;
    }
    await this.#touchUse(digest, bytes.byteLength);
    return { stored: true, bytes: bytes.byteLength, digest };
  }

  async hasProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
  ): Promise<boolean> {
    assertSegment(kind, "kind");
    assertSegment(projectorVersion, "projectorVersion");
    assertArtifactKey(artifactKey);
    try {
      const meta = await this.#kv.get<ProjMetaValue>(
        projMetaKey(kind, projectorVersion, artifactKey),
      );
      return meta.value !== null;
    } catch (error) {
      throw unavailable("hasProjection", error);
    }
  }

  async getProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
  ): Promise<Uint8Array> {
    return await this.#getProjection(kind, projectorVersion, artifactKey);
  }

  async getProjectionBounded(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
    limits: KvProjectionReadLimits,
  ): Promise<Uint8Array> {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new BuildStoreError(
          "BUILD_STORE_INVALID_INPUT",
          { reason: name },
          "Invalid projection read budget",
        );
      }
    }
    if (
      !Number.isSafeInteger(limits.maxCompressedBytes) ||
      !Number.isSafeInteger(limits.maxUncompressedBytes)
    ) {
      throw new BuildStoreError(
        "BUILD_STORE_INVALID_INPUT",
        {},
        "Missing projection read budget",
      );
    }
    return await this.#getProjection(
      kind,
      projectorVersion,
      artifactKey,
      limits,
    );
  }

  async #getProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
    limits?: KvProjectionReadLimits,
  ): Promise<Uint8Array> {
    assertSegment(kind, "kind");
    assertSegment(projectorVersion, "projectorVersion");
    assertArtifactKey(artifactKey);
    let meta;
    try {
      meta = await this.#kv.get<ProjMetaValue>(
        projMetaKey(kind, projectorVersion, artifactKey),
      );
    } catch (error) {
      throw unavailable("getProjection.meta", error);
    }
    if (meta.value === null) {
      throw new BuildStoreError("BUILD_BLOB_MISSING", {
        kind,
        projectorVersion,
        artifactKey,
      }, `No projection stored: ${kind}/${projectorVersion}/${artifactKey}`);
    }
    return await this.#projectionBytes(
      kind,
      projectorVersion,
      artifactKey,
      meta.value,
      limits,
    );
  }

  async #projectionBytes(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
    meta: ProjMetaValue,
    limits?: KvProjectionReadLimits,
  ): Promise<Uint8Array> {
    if (
      !HEX64.test(meta.sha256) || !Number.isSafeInteger(meta.bytes) ||
      meta.bytes < 0 ||
      (meta.blobDigest !== undefined && !HEX64.test(meta.blobDigest))
    ) {
      throw new BuildStoreError("BUILD_BLOB_CORRUPT", {
        kind,
        projectorVersion,
        artifactKey,
        stage: "meta",
      }, "Projection metadata is malformed");
    }
    if (limits && meta.bytes > limits.maxUncompressedBytes) {
      throw new KvModelBuildReadLimitError(
        {
          kind,
          projectorVersion,
          artifactKey,
          stage: "projection-meta",
          bytes: meta.bytes,
          limit: limits.maxUncompressedBytes,
        },
        "Stored projection exceeds the uncompressed output budget",
      );
    }
    const key = meta.blobDigest === undefined
      ? projKey(kind, projectorVersion, artifactKey)
      : projectionBlobKey(meta.blobDigest);
    return await this.#readVerified(
      key,
      meta.sha256,
      { kind, projectorVersion, artifactKey },
      `${kind}/${projectorVersion}/${artifactKey}`,
      { expectedBytes: meta.bytes, limits },
    );
  }

  async putProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
    bytes: Uint8Array,
  ): Promise<BuildPutResult> {
    assertSegment(kind, "kind");
    assertSegment(projectorVersion, "projectorVersion");
    assertArtifactKey(artifactKey);
    bytes = exactBytes(bytes);
    const digest = await sha256(bytes);
    const metaKey = projMetaKey(kind, projectorVersion, artifactKey);
    let physicalReady = false;
    for (let round = 0; round < BUSY_MAX_ATTEMPTS; round++) {
      let existing;
      try {
        existing = await this.#kv.get<ProjMetaValue>(metaKey);
      } catch (error) {
        throw unavailable("putProjection.meta", error);
      }
      if (existing.value !== null) {
        try {
          // Verify exactly the metadata version used by our eventual CAS.
          const prior = await this.#projectionBytes(
            kind,
            projectorVersion,
            artifactKey,
            existing.value,
          );
          const existingSha256 = await sha256(prior);
          if (existingSha256 !== digest) {
            throw new BuildStoreError(
              "BUILD_BLOB_CONFLICT",
              {
                kind,
                projectorVersion,
                artifactKey,
                existingSha256,
                actualSha256: digest,
              },
              `Refusing to overwrite immutable projection: ${kind}/${projectorVersion}/${artifactKey}`,
            );
          }
          return { stored: false, bytes: bytes.byteLength, digest };
        } catch (error) {
          if (
            !(error instanceof BuildStoreError) ||
            (error.code !== "BUILD_BLOB_CORRUPT" &&
              error.code !== "BUILD_BLOB_MISSING")
          ) throw error;
          // An unreadable old version can be repaired only if this exact
          // versionstamp is still current when publication commits.
        }
      }
      if (!physicalReady) {
        // Do not allocate a new physical blob for an already-full store.
        // This preflight is advisory; publication below repeats the quota
        // scan and couples its admission to the epoch CAS.
        if (!await this.#quotaEpoch(existing, { bytes: bytes.byteLength })) {
          continue;
        }
        const key = projectionBlobKey(digest);
        try {
          await this.#readVerified(
            key,
            digest,
            { kind, projectorVersion, artifactKey },
            digest,
            { expectedBytes: bytes.byteLength },
          );
        } catch (error) {
          if (
            !(error instanceof BuildStoreError) ||
            (error.code !== "BUILD_BLOB_CORRUPT" &&
              error.code !== "BUILD_BLOB_MISSING")
          ) throw error;
          try {
            await retryBusy(() =>
              set(this.#kv, key, compress(bytes, this.#observeCodecTiming))
            );
          } catch (cause) {
            if (cause instanceof BuildStoreError) throw cause;
            throw unavailable("putProjection.set", cause);
          }
        }
        await this.#readVerified(
          key,
          digest,
          { kind, projectorVersion, artifactKey },
          digest,
          { expectedBytes: bytes.byteLength },
        );
        physicalReady = true;
      }
      const published = await this.#publishAccounted(existing, {
        bytes: bytes.byteLength,
        sha256: digest,
        blobDigest: digest,
        at: this.#now(),
      });
      if (published) return { stored: true, bytes: bytes.byteLength, digest };
      // Another publisher changed the logical entry or quota epoch. Re-read
      // its verified bytes; identical is idempotent, different is a conflict.
      // A loser never removes shared chunks or logical metadata.
    }
    throw new BuildStoreError("BUILD_STORE_BUSY", {
      kind,
      projectorVersion,
      artifactKey,
      attempts: BUSY_MAX_ATTEMPTS,
    }, "Projection publication contention did not settle");
  }

  /** Rule 7: expiresAt in the value, taken/retaken by CAS on versionstamp.
   * Single entry per leased key (owner in the value) so exactly one CAS wins;
   * expireIn is only garbage collection, never the lease itself. */
  async acquireLease(
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (!key || !owner || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new BuildStoreError(
        "BUILD_STORE_INVALID_INPUT",
        {
          key,
          owner,
          ttlMs,
          reason: "Lease requires key, owner and ttlMs > 0",
        },
        "Invalid lease request",
      );
    }
    for (let round = 0; round < BUSY_MAX_ATTEMPTS; round++) {
      let entry;
      try {
        entry = await this.#kv.get<LeaseValue>(leaseKey(key));
      } catch (error) {
        throw unavailable("acquireLease.get", error);
      }
      const now = this.#now();
      if (
        entry.value !== null && entry.value.expiresAt > now &&
        entry.value.owner !== owner
      ) {
        return false;
      }
      const result = await retryBusy(() =>
        this.#kv.atomic().check(entry)
          .set(
            leaseKey(key),
            { expiresAt: now + ttlMs, owner } satisfies LeaseValue,
            { expireIn: ttlMs + LEASE_GC_GRACE_MS },
          )
          .commit()
      );
      if (result.ok) return true;
      // CAS lost: loop re-reads; a live foreign lease resolves false above.
    }
    throw new BuildStoreError(
      "BUILD_STORE_BUSY",
      { key, owner, attempts: BUSY_MAX_ATTEMPTS },
      `Lease contention did not settle: ${key}`,
    );
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    let entry;
    try {
      entry = await this.#kv.get<LeaseValue>(leaseKey(key));
    } catch (error) {
      throw unavailable("releaseLease.get", error);
    }
    if (entry.value === null || entry.value.owner !== owner) return;
    await retryBusy(() =>
      this.#kv.atomic().check(entry).delete(leaseKey(key)).commit()
    );
  }

  async sweep(): Promise<BuildSweepResult> {
    let orphanChunkKeysRemoved = 0;
    let orphanEntries = 0;
    for (
      const [prefix, len] of [[["build", "blob"], 3], [["proj"], 4], [[
        "proj-bytes",
      ], 2]] as const
    ) {
      const swept = await this.#sweepPrefix([...prefix], len);
      orphanChunkKeysRemoved += swept.removed;
      orphanEntries += swept.entries;
    }
    let expiredLeasesRemoved = 0;
    const now = this.#now();
    const expired: Deno.KvEntry<LeaseValue>[] = [];
    try {
      for await (
        const entry of this.#kv.list<LeaseValue>({ prefix: ["lease"] })
      ) {
        if (entry.value && entry.value.expiresAt <= now) {
          expired.push(entry);
        }
      }
    } catch (error) {
      throw unavailable("sweep.listLeases", error);
    }
    for (const entry of expired) {
      // CAS on the read versionstamp: a lease retaken since the list is
      // left alone (ok:false), only successful commits are counted.
      const result = await retryBusy(() =>
        this.#kv.atomic().check(entry).delete(entry.key).commit()
      );
      if (result.ok) expiredLeasesRemoved++;
    }
    return { orphanChunkKeysRemoved, orphanEntries, expiredLeasesRemoved };
  }

  /** Delete chunk keys whose entry has no completeness meta. */
  async #sweepPrefix(
    prefix: Deno.KvKey,
    entryKeyLength: number,
  ): Promise<{ removed: number; entries: number }> {
    const metas = new Set<string>();
    const chunks = new Map<string, Deno.KvKey[]>();
    try {
      for await (const entry of this.#kv.list({ prefix })) {
        const key = entry.key;
        const entryId = JSON.stringify(key.slice(0, entryKeyLength));
        if (
          key.length === entryKeyLength + 1 &&
          key[entryKeyLength] === BLOB_META_KEY
        ) {
          metas.add(entryId);
        } else if (
          key.length === entryKeyLength + 2 &&
          key[entryKeyLength] === BLOB_KEY
        ) {
          const list = chunks.get(entryId) ?? [];
          list.push(key);
          chunks.set(entryId, list);
        }
      }
    } catch (error) {
      throw unavailable("sweep.list", error);
    }
    let removed = 0;
    let entries = 0;
    for (const [entryId, keys] of chunks) {
      if (metas.has(entryId)) continue;
      const entryKey = JSON.parse(entryId) as Deno.KvKey;
      // CAS "meta absent" per entry: if the meta appeared since the list
      // (an in-flight put completed), delete nothing for this entry.
      let entryRemoved = 0;
      let complete = true;
      for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500);
        let op = this.#kv.atomic().check({
          key: [...entryKey, BLOB_META_KEY],
          versionstamp: null,
        });
        for (const key of batch) op = op.delete(key);
        const result = await retryBusy(() => op.commit());
        if (!result.ok) {
          complete = false;
          break;
        }
        entryRemoved += batch.length;
      }
      removed += entryRemoved;
      if (complete) entries++;
    }
    return { removed, entries };
  }

  async stats(): Promise<BuildStoreStats> {
    let blobCount = 0;
    let uncompressedBytes = 0;
    let projectionCount = 0;
    let leaseCount = 0;
    try {
      for await (const entry of this.#kv.list<UseValue>({ prefix: ["use"] })) {
        if (entry.value) {
          if (
            !Number.isSafeInteger(entry.value.bytes) || entry.value.bytes < 0
          ) throw new Error("Malformed build byte accounting");
          blobCount++;
          uncompressedBytes += entry.value.bytes;
        }
      }
      for await (
        const entry of this.#kv.list<ProjMetaValue>({ prefix: ["proj-meta"] })
      ) {
        if (entry.value) {
          if (
            !Number.isSafeInteger(entry.value.bytes) || entry.value.bytes < 0
          ) throw new Error("Malformed projection byte accounting");
          projectionCount++;
          uncompressedBytes += entry.value.bytes;
        }
      }
      for await (const _entry of this.#kv.list({ prefix: ["lease"] })) {
        leaseCount++;
      }
    } catch (error) {
      throw unavailable("stats", error);
    }
    return {
      blobCount,
      projectionCount,
      leaseCount,
      uncompressedBytes,
      quotaBytes: this.#quotaBytes,
      overQuota: this.#quotaBytes !== null &&
        uncompressedBytes > this.#quotaBytes,
    };
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#kv.close();
    }
    return Promise.resolve();
  }

  /** Every accounting publication increments a shared KV epoch. A quota
   * scan is admitted only by a CAS checking that epoch and the exact logical
   * entry, so concurrent handles/processes cannot both spend one allowance.
   * The epoch is used even by unlimited handles, so their metadata mutations
   * invalidate any finite-quota scan already in flight. */
  async #quotaEpoch<T extends { readonly bytes: number }>(
    existing: Deno.KvEntryMaybe<T>,
    value: { readonly bytes: number },
  ): Promise<Deno.KvEntryMaybe<number> | null> {
    const priorBytes = existing.value === null ? 0 : existing.value.bytes;
    if (
      !Number.isSafeInteger(priorBytes) || priorBytes < 0 ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0
    ) {
      throw new BuildStoreError(
        "BUILD_BLOB_CORRUPT",
        { key: existing.key, stage: "accounting" },
        "Invalid accounted byte length; restore cache metadata before retrying",
      );
    }
    const epoch = await this.#kv.get<number>(WRITE_EPOCH_KEY);
    const additionalBytes = value.bytes - priorBytes;
    if (this.#quotaBytes !== null && additionalBytes > 0) {
      const current = await this.stats();
      if (
        !Number.isSafeInteger(current.uncompressedBytes) ||
        current.uncompressedBytes < 0
      ) throw unavailable("quota.scan", "Malformed byte accounting");
      if (current.uncompressedBytes + additionalBytes > this.#quotaBytes) {
        const [latestEpoch, latestEntry] = await this.#kv.getMany<[number, T]>([
          WRITE_EPOCH_KEY,
          existing.key,
        ]);
        if (
          latestEpoch.versionstamp !== epoch.versionstamp ||
          latestEntry.versionstamp !== existing.versionstamp
        ) return null;
        throw new BuildStoreError("BUILD_STORE_QUOTA_EXCEEDED", {
          quotaBytes: this.#quotaBytes,
          uncompressedBytes: current.uncompressedBytes,
          additionalBytes,
        }, "Build cache quota would be exceeded");
      }
    }
    return epoch;
  }

  async #publishAccounted<T extends { readonly bytes: number }>(
    existing: Deno.KvEntryMaybe<T>,
    value: T,
  ): Promise<boolean> {
    try {
      const epoch = await this.#quotaEpoch(existing, value);
      if (!epoch) return false;
      const result = await retryBusy(() =>
        this.#kv.atomic().check(epoch).check(existing)
          .set(existing.key, value).set(WRITE_EPOCH_KEY, (epoch.value ?? 0) + 1)
          .commit()
      );
      return result.ok;
    } catch (error) {
      if (error instanceof BuildStoreError) throw error;
      throw unavailable("quota.publish", error);
    }
  }

  /** Durable byte reservation and last-use accounting. New reservations are
   * deliberately retained after a failed multi-batch write, rather than
   * risking quota reuse while another same-digest writer is still active. */
  async #touchUse(digest: string, bytes: number): Promise<void> {
    for (let round = 0; round < BUSY_MAX_ATTEMPTS; round++) {
      let entry;
      try {
        entry = await this.#kv.get<UseValue>(useKey(digest));
      } catch (error) {
        throw unavailable("use.get", error);
      }
      const now = this.#now();
      if (
        entry.value !== null && entry.value.bytes === bytes &&
        now - entry.value.at < USE_WRITE_INTERVAL_MS
      ) return;
      if (
        await this.#publishAccounted(entry, { at: now, bytes, class: "build" })
      ) return;
    }
    throw new BuildStoreError("BUILD_STORE_BUSY", {
      digest,
      attempts: BUSY_MAX_ATTEMPTS,
    }, "Build quota reservation contention did not settle");
  }
}
