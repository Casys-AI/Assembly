/** Narrow build-cache port: content-addressed blobs, projections, leases.
 *
 * No Deno KV (or any storage) dependency lives here. Digests and projection
 * identities address uncompressed bytes; compression is an adapter-internal
 * storage representation. `get`/`getProjection` only ever resolve with bytes
 * whose length and sha256 have been verified against their identity, and a
 * KV failure is never a fake miss.
 */

export type BuildStoreErrorCode =
  | "BUILD_BLOB_CORRUPT"
  | "BUILD_BLOB_MISSING"
  | "BUILD_BLOB_CONFLICT"
  | "BUILD_STORE_UNAVAILABLE"
  | "BUILD_STORE_BUSY"
  | "BUILD_STORE_QUOTA_EXCEEDED"
  | "BUILD_STORE_INVALID_INPUT";

const RECOVERY: Record<BuildStoreErrorCode, string> = {
  BUILD_BLOB_CORRUPT:
    "Rebuild the artifact from its commit descriptor and put it again under the same digest: put rewrites an unreadable entry. Failing that, delete cache.kv, then retry.",
  BUILD_BLOB_MISSING:
    "Rebuild the artifact from its commit descriptor and put it into the store, then retry.",
  BUILD_BLOB_CONFLICT:
    "Keep the existing immutable entry; recompute the digest from the exact uncompressed bytes and put under that digest instead.",
  BUILD_STORE_UNAVAILABLE:
    'Ensure Deno runs with "unstable": ["kv"] in deno.json and the cache directory is writable, then retry.',
  BUILD_STORE_BUSY:
    "Retry the operation; if contention persists, reduce concurrent writers on this cache file.",
  BUILD_STORE_QUOTA_EXCEEDED:
    "Raise quotaBytes or evict cold artifacts (retention/GC lot) before putting new blobs.",
  BUILD_STORE_INVALID_INPUT:
    "Fix the caller: the argument is malformed (see context.reason). The cache is not at fault; do not delete it.",
};

/** Machine-readable store failure: `{code, context, recovery}`. */
export class BuildStoreError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: BuildStoreErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "BuildStoreError";
    this.recovery = RECOVERY[code];
  }
}

export interface BuildPutResult {
  /** `false` when an identical verified entry already existed (put skipped). */
  readonly stored: boolean;
  /** Length of the uncompressed bytes. */
  readonly bytes: number;
  /** sha256 (lowercase hex) of the uncompressed bytes; equals the digest for blobs. */
  readonly digest: string;
}

export interface BuildSweepResult {
  readonly orphanChunkKeysRemoved: number;
  readonly orphanEntries: number;
  readonly expiredLeasesRemoved: number;
}

export interface BuildStoreStats {
  readonly blobCount: number;
  readonly projectionCount: number;
  readonly leaseCount: number;
  /** Sum of uncompressed blob + projection bytes known to the store. */
  readonly uncompressedBytes: number;
  readonly quotaBytes: number | null;
  readonly overQuota: boolean;
}

export interface ModelBuildStore {
  /** True only when a complete, meta-marked blob exists for `digest`. */
  has(digest: string): Promise<boolean>;
  /** Verified uncompressed bytes for `digest`.
   * @throws BuildStoreError BUILD_BLOB_MISSING when absent or incomplete,
   * BUILD_BLOB_CORRUPT when stored bytes fail length/sha256 verification. */
  get(digest: string): Promise<Uint8Array>;
  /** Store `bytes` (uncompressed) under their sha256 `digest`.
   * Idempotent: an identical verified entry is skipped (`stored: false`);
   * an existing unreadable entry (corrupt or incomplete) is rewritten.
   * @throws BuildStoreError BUILD_BLOB_CONFLICT when sha256(bytes) != digest. */
  put(digest: string, bytes: Uint8Array): Promise<BuildPutResult>;
  hasProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
  ): Promise<boolean>;
  /** Verified uncompressed projection bytes; same error contract as `get`. */
  getProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
  ): Promise<Uint8Array>;
  putProjection(
    kind: string,
    projectorVersion: string,
    artifactKey: string,
    bytes: Uint8Array,
  ): Promise<BuildPutResult>;
  /** Take or retake a lease by CAS on `expiresAt`; exactly one winner.
   * Resolves `false` when a live lease is held by another owner. */
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Release a lease only when `owner` currently holds it. */
  releaseLease(key: string, owner: string): Promise<void>;
  /** Remove blob chunks without a completeness meta and expired leases.
   * Explicit only, never at open: call only with no put in progress in
   * another handle (W2g GC), since an in-flight multi-batch put has no
   * meta yet. Orphans are invisible (`has` false, `get` MISSING). */
  sweep(): Promise<BuildSweepResult>;
  stats(): Promise<BuildStoreStats>;
  close(): Promise<void>;
}
