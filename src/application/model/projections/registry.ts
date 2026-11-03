/** Pure model projection registry (W2f): kind + projectorVersion + A
 * (+ canonical parameters), shared computation, byte-weighted LRU and
 * pending/ready/failed statuses. Projections carry no runtime state and
 * grant no authority; the cache stores encoded bytes and every read
 * decodes a fresh value, so a consumer mutation cannot pollute the cache
 * — without ever structuredClone-ing a full model revision.
 *
 * The current pointer is separate per (kind, projectorVersion, parameters): `request` fixes
 * the requested artifact, and a slow projection for A finishing after B
 * was requested never replaces B. Historical `get` moves no pointer.
 */
import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../builds/ports/out/build-store.port.ts";
import { sha256HexOfBytes } from "../builds/service.ts";
import { WeightedLruCache } from "../../support/weighted-lru.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ProjectionParams = Readonly<Record<string, string>>;

interface ProjectionContext {
  readonly kind: string;
  readonly projectorVersion: string;
  readonly artifactDigest: string;
  readonly params?: ProjectionParams;
  readonly signal?: AbortSignal;
}

interface ProjectionDefinition<T = unknown> {
  readonly kind: string;
  /** projectorVersion: bump on any output-affecting change. */
  readonly version: string;
  /** Persist through ModelBuildStore projections when a store is given.
   * Default true. The persisted envelope preserves JSON, text and byte forms. */
  readonly persistent?: boolean;
  compute(ctx: ProjectionContext): Promise<T>;
  encode?(value: T): Uint8Array;
  decode?(bytes: Uint8Array): T;
}

/** Ready means resident and synchronously retrievable in this registry. Disk
 * contents are verified only by get/request and never inferred by status. */
type ProjectionState = "unrequested" | "pending" | "ready" | "failed";

export interface ProjectionStatus {
  readonly kind: string;
  readonly projectorVersion: string;
  readonly artifactDigest: string;
  readonly params?: ProjectionParams;
  readonly state: ProjectionState;
  readonly projectionDigest?: string;
  readonly bytes?: number;
  /** Retained failure snapshots cap code/message at 128/2048 UTF-16 units.
   * Subscriber events and the error rejected to the caller remain complete. */
  readonly error?: { readonly code: string; readonly message: string };
}

interface CurrentProjection {
  readonly kind: string;
  readonly projectorVersion: string;
  readonly params?: ProjectionParams;
  readonly requestedArtifact?: string;
  readonly availableArtifact?: string;
  readonly state: ProjectionState;
  readonly projectionDigest?: string;
}

interface ProjectionRequestOptions {
  readonly params?: ProjectionParams;
  readonly signal?: AbortSignal;
}

type ModelProjectionErrorCode =
  | "PROJECTION_NOT_REGISTERED"
  | "PROJECTION_INVALID_INPUT"
  | "PROJECTION_FAILED";

export class ModelProjectionError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: ModelProjectionErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "ModelProjectionError";
    this.recovery = code === "PROJECTION_NOT_REGISTERED"
      ? "Register a projector for this kind before requesting it."
      : code === "PROJECTION_INVALID_INPUT"
      ? "Fix the caller: kind, version, artifact digest or parameters are malformed."
      : "Inspect context.cause; the failed projection was not cached and may be retried.";
  }
}

type EntryForm = "bytes" | "text" | "json";
interface Entry {
  readonly bytes: Uint8Array;
  readonly form: EntryForm;
  readonly projectionDigest: string;
}

const STORE_HEADER = encoder.encode("\0ASE-PROJECTION/1\n");
const STORE_FORMS: EntryForm[] = ["json", "text", "bytes"];

function encodeStoredProjection(entry: Entry): Uint8Array {
  const stored = new Uint8Array(STORE_HEADER.length + 1 + entry.bytes.length);
  stored.set(STORE_HEADER);
  stored[STORE_HEADER.length] = STORE_FORMS.indexOf(entry.form);
  stored.set(entry.bytes, STORE_HEADER.length + 1);
  return stored;
}

function decodeStoredProjection(
  stored: Uint8Array,
  customDecoder: boolean,
): Pick<Entry, "bytes" | "form"> {
  if (stored[0] !== 0) {
    // Legacy board JSON and explicitly decoded legacy raw payloads.
    return { bytes: copyBytes(stored), form: customDecoder ? "bytes" : "json" };
  }
  const form = STORE_FORMS[stored[STORE_HEADER.length]];
  if (!STORE_HEADER.every((byte, index) => stored[index] === byte) || !form) {
    throw new BuildStoreError(
      "BUILD_BLOB_CORRUPT",
      {},
      "Invalid projection envelope",
    );
  }
  return { bytes: stored.slice(STORE_HEADER.length + 1), form };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function invalidInput(
  reason: string,
  extra: Record<string, unknown> = {},
): never {
  throw new ModelProjectionError(
    "PROJECTION_INVALID_INPUT",
    { reason, ...extra },
    `Invalid projection request: ${reason}`,
  );
}

function checkSegment(value: unknown, name: string): string {
  if (
    typeof value !== "string" || !value || value.length > 128 ||
    [...value].some((ch) => ch.codePointAt(0)! < 0x20)
  ) invalidInput(`${name} must be 1-128 visible characters`, { [name]: value });
  return value as string;
}

function checkArtifact(value: unknown): string {
  if (!isSha256Hex(value)) {
    invalidInput("artifactDigest must be 64 lowercase hex characters", {
      artifactDigest: value,
    });
  }
  return value as string;
}

function checkParams(
  params: ProjectionParams | undefined,
): ProjectionParams | undefined {
  if (params === undefined) return undefined;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    invalidInput("params must be an object of strings");
  }
  const entries = Object.entries(params);
  if (entries.length > 32) invalidInput("params are limited to 32 entries");
  for (const [key, value] of entries) {
    if (
      !key || key.length > 128 || typeof value !== "string" ||
      value.length > 512
    ) {
      invalidInput("param keys are 1-128 chars and values strings up to 512", {
        key,
      });
    }
  }
  return entries.length === 0 ? undefined : Object.freeze({ ...params });
}

/** Canonical in-memory key: kind + version + A + sorted parameters. */
export function projectionKey(
  kind: string,
  projectorVersion: string,
  artifactDigest: string,
  params?: ProjectionParams,
): string {
  params = checkParams(params);
  return canonical({
    kind,
    projectorVersion,
    artifactDigest,
    ...(params ? { params } : {}),
  });
}

/** Digest of the parameters alone, for keys that cannot carry them raw. */
export async function projectionParamsDigest(
  params?: ProjectionParams,
): Promise<string | undefined> {
  params = checkParams(params);
  if (!params) return undefined;
  return await canonicalDigest(params);
}

/** Store-side artifact key: A itself, or sha256({A, params}) with params. */
export async function projectionArtifactKey(
  artifactDigest: string,
  params?: ProjectionParams,
): Promise<string> {
  params = checkParams(params);
  if (!params) return artifactDigest;
  return await canonicalDigest({ artifactDigest, params });
}

function errorInfo(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    code: typeof code === "string" && code ? code : "PROJECTION_FAILED",
    message: errorMessage(error),
  };
}

function retainedErrorText(text: string, maxLength: number): string {
  // Copy through bytes: a sliced string can otherwise retain the backing
  // storage of an arbitrarily large projector error.
  return decoder.decode(encoder.encode(text.slice(0, maxLength)));
}

interface ModelProjectionRegistryOptions {
  readonly maxBytes: number;
  /** Independent cap for each completed-state history (failures and current
   * pointers), default 1000. Older states become unrequested. Active requests
   * are never discarded and may temporarily exceed this history budget. */
  readonly maxRetainedStates?: number;
  readonly store?: ModelBuildStore;
}

interface CurrentPointer {
  requestedArtifact: string;
  availableArtifact?: string;
}

export class ModelProjectionRegistry {
  readonly #definitions = new Map<string, ProjectionDefinition>();
  readonly #cache: WeightedLruCache<Entry>;
  readonly #pending = new Map<string, Promise<Entry>>();
  readonly #statuses = new Map<string, ProjectionStatus>();
  readonly #current = new Map<string, CurrentPointer>();
  readonly #activeCurrent = new Map<string, number>();
  readonly #maxRetainedStates: number;
  readonly #listeners = new Set<(status: ProjectionStatus) => void>();
  readonly #store?: ModelBuildStore;

  constructor(options: ModelProjectionRegistryOptions) {
    const maxRetainedStates = options.maxRetainedStates ?? 1000;
    if (!Number.isSafeInteger(maxRetainedStates) || maxRetainedStates <= 0) {
      throw new RangeError("maxRetainedStates must be a positive safe integer");
    }
    this.#maxRetainedStates = maxRetainedStates;
    this.#cache = new WeightedLruCache<Entry>({
      maxBytes: options.maxBytes,
      weigh: (_key, entry) => entry.bytes.byteLength,
    });
    this.#store = options.store;
  }

  register<T>(definition: ProjectionDefinition<T>): void {
    checkSegment(definition.kind, "kind");
    checkSegment(definition.version, "version");
    if (typeof definition.compute !== "function") {
      invalidInput("projector compute is required", { kind: definition.kind });
    }
    this.#definitions.set(
      definition.kind,
      definition as ProjectionDefinition,
    );
  }

  projectorVersion(kind: string): string | undefined {
    return this.#definitions.get(kind)?.version;
  }

  #definition(kind: string): ProjectionDefinition {
    checkSegment(kind, "kind");
    const definition = this.#definitions.get(kind);
    if (!definition) {
      throw new ModelProjectionError(
        "PROJECTION_NOT_REGISTERED",
        { kind },
        `No projector registered for kind: ${kind}`,
      );
    }
    return definition;
  }

  #currentKey(
    kind: string,
    version: string,
    params?: ProjectionParams,
  ): string {
    return canonical({ kind, version, ...(params ? { params } : {}) });
  }

  #setStatus(status: ProjectionStatus): void {
    const key = projectionKey(
      status.kind,
      status.projectorVersion,
      status.artifactDigest,
      status.params,
    );
    // Pending and ready already live in #pending and #cache. Retaining a
    // duplicate here would outlive byte eviction, including oversize values.
    this.#statuses.delete(key);
    if (status.state === "failed") {
      this.#statuses.set(key, {
        ...status,
        ...(status.error
          ? {
            error: {
              code: retainedErrorText(status.error.code, 128),
              message: retainedErrorText(status.error.message, 2048),
            },
          }
          : {}),
      });
      while (this.#statuses.size > this.#maxRetainedStates) {
        this.#statuses.delete(this.#statuses.keys().next().value!);
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch {
        // A broken subscriber never breaks a projection read.
      }
    }
  }

  #pruneCurrent(): void {
    let completed = this.#current.size - this.#activeCurrent.size;
    for (const key of this.#current.keys()) {
      if (completed <= this.#maxRetainedStates) break;
      if (!this.#activeCurrent.has(key)) {
        this.#current.delete(key);
        completed--;
      }
    }
  }

  subscribe(listener: (status: ProjectionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  status(
    kind: string,
    artifactDigest: string,
    options: ProjectionRequestOptions = {},
  ): ProjectionStatus {
    const definition = this.#definition(kind);
    const artifact = checkArtifact(artifactDigest);
    const params = checkParams(options.params);
    const key = projectionKey(kind, definition.version, artifact, params);
    const base = {
      kind,
      projectorVersion: definition.version,
      artifactDigest: artifact,
      ...(params ? { params } : {}),
    };
    if (this.#pending.has(key)) return { ...base, state: "pending" };
    const entry = this.#cache.peek(key);
    if (entry) {
      return {
        ...base,
        state: "ready",
        projectionDigest: entry.projectionDigest,
        bytes: entry.bytes.byteLength,
      };
    }
    const previous = this.#statuses.get(key);
    if (previous?.state === "failed") return previous;
    // A completed but evicted/oversize value is not ready. Persisted bytes
    // might exist, but only a new asynchronous read can verify and admit them.
    this.#statuses.delete(key);
    return { ...base, state: "unrequested" };
  }

  current(
    kind: string,
    options: ProjectionRequestOptions = {},
  ): CurrentProjection {
    const definition = this.#definition(kind);
    const params = checkParams(options.params);
    const base = {
      kind,
      projectorVersion: definition.version,
      ...(params ? { params } : {}),
    } as const;
    const currentKey = this.#currentKey(kind, definition.version, params);
    const pointer = this.#current.get(currentKey);
    if (pointer) {
      this.#current.delete(currentKey);
      this.#current.set(currentKey, pointer);
    }
    if (!pointer) return { ...base, state: "unrequested" };
    const requested = this.status(kind, pointer.requestedArtifact, { params });
    const availableArtifact = requested.state === "ready"
      ? pointer.requestedArtifact
      : pointer.availableArtifact;
    const available = availableArtifact
      ? this.#cache.peek(projectionKey(
        kind,
        definition.version,
        availableArtifact,
        params,
      ))
      : undefined;
    return {
      ...base,
      requestedArtifact: pointer.requestedArtifact,
      ...(available ? { availableArtifact } : {}),
      state: requested.state,
      ...(available && availableArtifact === pointer.requestedArtifact
        ? { projectionDigest: available.projectionDigest }
        : {}),
    };
  }

  /** Ready memory value only; decoded fresh, never starts a computation. */
  peek<T>(
    kind: string,
    artifactDigest: string,
    options: ProjectionRequestOptions = {},
  ): T | undefined {
    const definition = this.#definition(kind);
    const artifact = checkArtifact(artifactDigest);
    const params = checkParams(options.params);
    const entry = this.#cache.get(
      projectionKey(kind, definition.version, artifact, params),
    );
    return entry
      ? this.#decode<T>(definition as ProjectionDefinition<T>, entry)
      : undefined;
  }

  getCurrent<T>(
    kind: string,
    options: ProjectionRequestOptions = {},
  ): T | undefined {
    const current = this.current(kind, options);
    return current.availableArtifact
      ? this.peek<T>(kind, current.availableArtifact, options)
      : undefined;
  }

  stats(): {
    entries: number;
    bytes: number;
    maxBytes: number;
    pending: number;
    retainedStatuses: number;
    currentPointers: number;
    activeCurrentPointers: number;
    maxRetainedStates: number;
  } {
    return {
      ...this.#cache.stats(),
      pending: this.#pending.size,
      retainedStatuses: this.#statuses.size,
      currentPointers: this.#current.size,
      activeCurrentPointers: this.#activeCurrent.size,
      maxRetainedStates: this.#maxRetainedStates,
    };
  }

  invalidate(
    kind: string,
    artifactDigest: string,
    options: ProjectionRequestOptions = {},
  ): void {
    const definition = this.#definition(kind);
    const artifact = checkArtifact(artifactDigest);
    const params = checkParams(options.params);
    const key = projectionKey(kind, definition.version, artifact, params);
    this.#cache.delete(key);
    this.#statuses.delete(key);
  }

  #encode<T>(
    definition: ProjectionDefinition<T>,
    value: T,
  ): { bytes: Uint8Array; form: EntryForm } {
    if (definition.encode) {
      return {
        bytes: copyBytes(definition.encode(value)),
        form: definition.decode ? "bytes" : "json",
      };
    }
    if (value instanceof Uint8Array) {
      return { bytes: copyBytes(value), form: "bytes" };
    }
    if (typeof value === "string") {
      return { bytes: encoder.encode(value), form: "text" };
    }
    return { bytes: encoder.encode(canonical(value)), form: "json" };
  }

  #decode<T>(definition: ProjectionDefinition<T>, entry: Entry): T {
    try {
      if (definition.decode) return definition.decode(copyBytes(entry.bytes));
      if (entry.form === "bytes") return copyBytes(entry.bytes) as T;
      const text = decoder.decode(entry.bytes);
      if (entry.form === "text") return text as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ModelProjectionError) throw error;
      throw new ModelProjectionError(
        "PROJECTION_FAILED",
        {
          kind: definition.kind,
          stage: "decode",
          cause: errorMessage(error),
        },
        `Projection decode failed: ${definition.kind}`,
      );
    }
  }

  /** Shared load/compute for one key. Joins never move any pointer. */
  async get<T>(
    kind: string,
    artifactDigest: string,
    options: ProjectionRequestOptions = {},
  ): Promise<T> {
    const definition = this.#definition(kind) as ProjectionDefinition<T>;
    const artifact = checkArtifact(artifactDigest);
    const params = checkParams(options.params);
    options.signal?.throwIfAborted();
    const key = projectionKey(kind, definition.version, artifact, params);
    const cached = this.#cache.get(key);
    if (cached) return this.#decode<T>(definition, cached);
    const pending = this.#pending.get(key);
    if (pending) return this.#decode<T>(definition, await pending);
    const base: Omit<ProjectionStatus, "state"> = {
      kind,
      projectorVersion: definition.version,
      artifactDigest: artifact,
      ...(params ? { params } : {}),
    };
    this.#setStatus({ ...base, state: "pending" });
    const work = this.#loadOrCompute(
      definition,
      artifact,
      params,
      options.signal,
    )
      .then((entry) => {
        this.#setStatus(
          this.#cache.has(key)
            ? {
              ...base,
              state: "ready",
              projectionDigest: entry.projectionDigest,
              bytes: entry.bytes.byteLength,
            }
            : { ...base, state: "unrequested" },
        );
        return entry;
      }, (error: unknown) => {
        this.#setStatus({ ...base, state: "failed", error: errorInfo(error) });
        throw error;
      });
    this.#pending.set(key, work);
    const settle = () => {
      if (this.#pending.get(key) === work) this.#pending.delete(key);
    };
    work.then(settle, settle);
    return this.#decode<T>(definition, await work);
  }

  /** Like `get`, and fixes the requested artifact of the current pointer.
   * Completion advances the available artifact only while this artifact
   * is still the requested one. */
  async request<T>(
    kind: string,
    artifactDigest: string,
    options: ProjectionRequestOptions = {},
  ): Promise<T> {
    const artifact = checkArtifact(artifactDigest);
    const params = checkParams(options.params);
    const definition = this.#definition(kind);
    const currentKey = this.#currentKey(kind, definition.version, params);
    const pointer = this.#current.get(currentKey) ?? {
      requestedArtifact: artifact,
    };
    pointer.requestedArtifact = artifact;
    this.#current.delete(currentKey);
    this.#current.set(currentKey, pointer);
    this.#activeCurrent.set(
      currentKey,
      (this.#activeCurrent.get(currentKey) ?? 0) + 1,
    );
    this.#pruneCurrent();
    const work = this.get<T>(kind, artifact, { ...options, params });
    work.then(() => {
      if (
        pointer.requestedArtifact === artifact &&
        this.#cache.has(
          projectionKey(kind, definition.version, artifact, params),
        )
      ) {
        pointer.availableArtifact = artifact;
      }
    }, () => undefined);
    try {
      return await work;
    } finally {
      const active = this.#activeCurrent.get(currentKey)! - 1;
      if (active) this.#activeCurrent.set(currentKey, active);
      else this.#activeCurrent.delete(currentKey);
      this.#pruneCurrent();
    }
  }

  async #loadOrCompute<T>(
    definition: ProjectionDefinition<T>,
    artifact: string,
    params: ProjectionParams | undefined,
    signal?: AbortSignal,
  ): Promise<Entry> {
    const key = projectionKey(
      definition.kind,
      definition.version,
      artifact,
      params,
    );
    let storeKey: string | undefined;
    if (this.#store && definition.persistent !== false) {
      storeKey = await projectionArtifactKey(artifact, params);
      try {
        const bytes = await this.#store.getProjection(
          definition.kind,
          definition.version,
          storeKey,
        );
        const payload = decodeStoredProjection(bytes, !!definition.decode);
        const entry: Entry = {
          ...payload,
          projectionDigest: await sha256HexOfBytes(payload.bytes),
        };
        // Prove these persisted bytes still decode under this projector
        // before serving them as ready; undecodable bytes recompute.
        this.#decode<T>(definition, entry);
        this.#cache.set(key, entry, entry.bytes.byteLength);
        return entry;
      } catch (error) {
        const isDecodeFailure = error instanceof ModelProjectionError &&
          error.context.stage === "decode";
        // Missing, corrupt, undecodable or unavailable cache: compute.
        // Storage trouble never blocks a pure recomputation.
        if (!(error instanceof BuildStoreError) && !isDecodeFailure) {
          throw error;
        }
      }
    }
    signal?.throwIfAborted();
    let value: T;
    try {
      value = await definition.compute({
        kind: definition.kind,
        projectorVersion: definition.version,
        artifactDigest: artifact,
        ...(params ? { params } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const info = errorInfo(error);
      if (info.code !== "PROJECTION_FAILED") throw error;
      throw new ModelProjectionError(
        "PROJECTION_FAILED",
        {
          kind: definition.kind,
          artifactDigest: artifact,
          cause: info.message,
        },
        `Projection computation failed: ${definition.kind}`,
      );
    }
    const { bytes, form } = this.#encode<T>(definition, value);
    const entry: Entry = {
      bytes,
      form,
      projectionDigest: await sha256HexOfBytes(bytes),
    };
    if (this.#store && definition.persistent !== false && storeKey) {
      // Quota/busy failures are advisory; an immutable identity conflict is
      // a projector contract failure and must remain visible to the caller.
      await this.#store.putProjection(
        definition.kind,
        definition.version,
        storeKey,
        encodeStoredProjection(entry),
      ).catch((error: unknown) => {
        if (
          error instanceof BuildStoreError &&
          error.code === "BUILD_BLOB_CONFLICT"
        ) {
          throw error;
        }
      });
    }
    // Admit only after immutable persistence accepts the value.
    // Oversize entries are served without retention.
    this.#cache.set(key, entry, entry.bytes.byteLength);
    return entry;
  }
}
