/** W2f composition: immutable pure projections, versioned read facades.
 * Only small version pins and in-flight string inputs are retained here.
 * Full revisions belong to repository/reader calls and never enter this cache. */
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../builds/ports/out/build-store.port.ts";
import {
  ModelRepositoryError,
  type ModelRepositoryPort,
} from "../repository.ts";
import type { ModelBoardReader } from "./ports/out/model-board-reader.port.ts";
import type { AuthorityMatrixReader } from "../../governance/authority-matrix.ts";
import type { ModelViewsReader } from "./ports/out/model-views-reader.port.ts";
import type { AuthorityMatrix } from "../../../domain/governance/records/authority-matrix.ts";
import {
  artifactDigest,
  type BuildDescriptor,
} from "../../../domain/model/value-objects/build.ts";
import {
  canonicalDigest,
  executionDigest,
  isSha256Hex,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";

import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
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
 * contents are verified only by get and never inferred by status. */
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
  /** Cap for retained failures, default 1000. Older states become unrequested. */
  readonly maxRetainedStates?: number;
  readonly store?: ModelBuildStore;
}

export class ModelProjectionRegistry {
  readonly #definitions = new Map<string, ProjectionDefinition>();
  readonly #cache: WeightedLruCache<Entry>;
  readonly #pending = new Map<string, Promise<Entry>>();
  readonly #statuses = new Map<string, ProjectionStatus>();
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

  stats(): {
    entries: number;
    bytes: number;
    maxBytes: number;
    pending: number;
    retainedStatuses: number;
    maxRetainedStates: number;
  } {
    return {
      ...this.#cache.stats(),
      pending: this.#pending.size,
      retainedStatuses: this.#statuses.size,
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

  /** Shared load/compute for one key. */
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

const CACHED_PROJECTION_KINDS = [
  "board",
  "authority-matrix",
  "views",
  "view-diagram",
  "plantuml",
] as const;
type CachedProjectionKind = typeof CACHED_PROJECTION_KINDS[number];
const DEFAULT_PROJECTOR_VERSIONS: Readonly<
  Record<CachedProjectionKind, string>
> = Object.freeze({
  board: "1",
  "authority-matrix": "1",
  views: "1",
  "view-diagram": "1",
  plantuml: "1",
});
interface BuildDescriptorPort {
  buildDescriptor(
    version: string,
    signal?: AbortSignal,
  ): Promise<BuildDescriptor | null>;
}
interface ProjectionPin {
  version: string;
  sourceDigest: string;
  artifactDigest?: string;
  origin: "descriptor" | "computed" | "legacy";
}
export interface CachedModelProjectionsOptions {
  repository:
    & Pick<ModelRepositoryPort, "at" | "header">
    & Partial<BuildDescriptorPort>
    & { descriptorAt?(version: string): Promise<BuildDescriptor | null> };
  repositoryId: string;
  projectId: string;
  createReaders(cachedViews: Pick<ModelViewsReader, "list">): {
    board: ModelBoardReader;
    authorityMatrix: AuthorityMatrixReader;
    views: ModelViewsReader;
  };
  buildStore?: ModelBuildStore;
  maxBytes?: number;
  maxPins?: number;
  toolkitIdentity?: string;
  projectorVersions?: Partial<Record<CachedProjectionKind, string>>;
}
interface VersionProjectionStatus {
  kind: CachedProjectionKind;
  version: string;
  state: ProjectionStatus["state"];
  projectorVersion: string;
  artifactDigest?: string;
  params?: ProjectionParams;
  projectionDigest?: string;
  bytes?: number;
  error?: ProjectionStatus["error"];
  pinOrigin?: ProjectionPin["origin"];
}
interface CurrentVersionProjection {
  kind: CachedProjectionKind;
  state: ProjectionStatus["state"];
  requestedVersion?: string;
  availableVersion?: string;
  requestedArtifact?: string;
  availableArtifact?: string;
  error?: ProjectionStatus["error"];
}
type ViewOptions = { viewId?: string };
interface Trigger {
  version: string;
  viewId?: string;
  pin: ProjectionPin;
}
type PureMatrix = Omit<AuthorityMatrix, "version" | "digest">;

function validateVersion(version: string): void {
  try {
    parseModelRevisionId(version);
  } catch {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid immutable model version",
    );
  }
}
function mismatch(version: string, receivedVersion: string): never {
  throw {
    code: "MODEL_VERSION_MISMATCH",
    context: { version, receivedVersion },
    recovery:
      "Correct the projection reader to return the requested model version before requesting it again.",
  };
}

export function createCachedModelProjections(
  options: CachedModelProjectionsOptions,
) {
  const { repository, repositoryId, projectId } = options;
  const maxPins = options.maxPins ?? 64;
  if (!Number.isInteger(maxPins) || maxPins < 1) {
    throw new Error("maxPins must be a positive integer");
  }
  const registry = new ModelProjectionRegistry({
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    store: options.buildStore,
  });
  const pins = new Map<string, ProjectionPin>();
  const pinWork = new Map<string, Promise<ProjectionPin>>();
  const triggers = new Map<string, Trigger>();
  const reads = new Map<string, Promise<unknown>>();
  const listeners = new Set<
    (status: ProjectionStatus & { versions: string[] }) => void
  >();
  const pointers = new Map<
    string,
    {
      requestedVersion: string;
      availableVersion?: string;
      state: ProjectionStatus["state"];
      error?: ProjectionStatus["error"];
    }
  >();
  let head: string | undefined;
  let epoch = 0;
  const readers = options.createReaders({
    list: (version) => views.list(version),
  });

  function retain(pin: ProjectionPin) {
    pins.delete(pin.version);
    pins.set(pin.version, Object.freeze(pin));
    while (pins.size > maxPins) pins.delete(pins.keys().next().value!);
    return pin;
  }
  async function pinFor(version: string): Promise<ProjectionPin> {
    validateVersion(version);
    const cached = pins.get(version);
    if (cached) {
      pins.delete(version);
      pins.set(version, cached);
      return cached;
    }
    const pending = pinWork.get(version);
    if (pending) return await pending;
    if (pinWork.size >= 64) {
      throw new ModelRepositoryError(
        "UPSTREAM_FAILURE",
        "Projection pin queue is full",
      );
    }
    const work = (async () => {
      const header = await repository.header(version);
      if (header.version !== version) mismatch(version, header.version);
      const descriptorReader = repository.buildDescriptor ??
        repository.descriptorAt;
      if (descriptorReader) {
        const descriptor = await descriptorReader.call(repository, version);
        if (!descriptor) {
          return retain({
            version,
            sourceDigest: header.sourceDigest,
            origin: "legacy",
          });
        }
        if (
          descriptor.repositoryId !== repositoryId ||
          descriptor.sourceDigest !== header.sourceDigest ||
          !/^[a-f0-9]{64}$/.test(descriptor.artifactDigest)
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Projection build descriptor does not match the immutable source snapshot",
          );
        }
        return retain({
          version,
          sourceDigest: header.sourceDigest,
          artifactDigest: descriptor.artifactDigest,
          origin: "descriptor",
        });
      }
      const revision = await repository.at(version);
      if (revision.version !== version) mismatch(version, revision.version);
      if (revision.sourceDigest !== header.sourceDigest) {
        throw new ModelRepositoryError(
          "INVALID_REPOSITORY",
          "Projection artifact does not match the immutable source snapshot",
        );
      }
      return retain({
        version,
        sourceDigest: header.sourceDigest,
        artifactDigest: await artifactDigest(revision),
        origin: "computed",
      });
    })();
    pinWork.set(version, work);
    try {
      return await work;
    } finally {
      pinWork.delete(version);
    }
  }
  // Params fit the registry's bounded contract. Hash arbitrary external names,
  // keeping normal source/repository/project identifiers inspectable in events.
  const paramNames = new Map<string, string>();
  async function param(value: string): Promise<string> {
    return value.length <= 512 ? value : `sha256:${await sha256(value)}`;
  }
  async function parameters(
    pin: ProjectionPin,
    viewId?: string,
  ): Promise<ProjectionParams> {
    const params = {
      repositoryId: await param(repositoryId),
      projectId: await param(projectId),
      sourceDigest: pin.sourceDigest,
      ...(viewId === undefined ? {} : { view: await param(viewId) }),
    };
    paramNames.set(`${pin.version}\n${viewId ?? ""}`, JSON.stringify(params));
    // This memo retains only strings, bounded independently of diagram count.
    while (paramNames.size > maxPins * 8) {
      paramNames.delete(paramNames.keys().next().value!);
    }
    return params;
  }
  async function raw(
    kind: CachedProjectionKind,
    version: string,
    viewId?: string,
  ): Promise<unknown> {
    switch (kind) {
      case "board":
        return await readers.board.read(version);
      case "authority-matrix":
        return await readers.authorityMatrix.read(version);
      case "views":
        return await readers.views.list(version);
      case "view-diagram":
        return await readers.views.diagram(version, viewId!);
      case "plantuml":
        return await readers.views.plantuml(version, viewId!);
    }
  }
  for (const kind of CACHED_PROJECTION_KINDS) {
    const baseVersion = options.projectorVersions?.[kind] ??
      DEFAULT_PROJECTOR_VERSIONS[kind];
    registry.register({
      kind,
      version: baseVersion +
        (kind !== "authority-matrix" && options.toolkitIdentity
          ? `+tk.${options.toolkitIdentity}`
          : ""),
      async compute(ctx) {
        const trigger = triggers.get(
          projectionKey(
            kind,
            ctx.projectorVersion,
            ctx.artifactDigest,
            ctx.params,
          ),
        );
        if (!trigger) {
          throw {
            code: "PROJECTION_INPUT_MISSING",
            message: "Read through the cached projection reader",
          };
        }
        const value = await raw(kind, trigger.version, trigger.viewId);
        if (kind === "authority-matrix") {
          const matrix = value as AuthorityMatrix;
          if (matrix.version !== trigger.version) {
            mismatch(trigger.version, matrix.version);
          }
          if (matrix.model.sourceDigest !== trigger.pin.sourceDigest) {
            throw new ModelRepositoryError(
              "INVALID_REPOSITORY",
              "Matrix source digest does not match projection pin",
            );
          }
          const { version: _version, digest: _digest, ...pure } = matrix;
          return pure;
        }
        if (
          kind === "board" &&
          (value as Awaited<ReturnType<ModelBoardReader["read"]>>).meta
              .sourceDigest !== trigger.pin.sourceDigest
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Board source digest does not match projection pin",
          );
        }
        return value;
      },
    });
  }
  registry.subscribe((status) => {
    const versions = [...pins.values()].filter((pin) =>
      pin.artifactDigest === status.artifactDigest &&
      pin.sourceDigest === status.params?.sourceDigest
    ).map((pin) => pin.version);
    for (const listener of listeners) {
      try {
        listener({ ...status, versions });
      } catch { /* Subscriber isolation. */ }
    }
  });

  async function read<T>(
    kind: CachedProjectionKind,
    version: string,
    viewId?: string,
  ): Promise<T> {
    validateVersion(version);
    if ((kind === "view-diagram" || kind === "plantuml") && !viewId) {
      throw new ModelRepositoryError(
        "INVALID_REQUEST",
        "Invalid model view id",
      );
    }
    const readKey = `${kind}\n${version}\n${viewId ?? ""}`;
    const pending = reads.get(readKey);
    if (pending) return structuredClone(await pending) as T;
    if (reads.size >= 128) {
      throw new ModelRepositoryError(
        "UPSTREAM_FAILURE",
        "Projection read queue is full",
      );
    }
    const work = (async () => {
      let pin: ProjectionPin;
      try {
        pin = await pinFor(version);
      } catch {
        return await raw(kind, version, viewId);
      }
      if (!pin.artifactDigest) return await raw(kind, version, viewId);
      const params = await parameters(pin, viewId);
      const key = projectionKey(
        kind,
        registry.projectorVersion(kind)!,
        pin.artifactDigest,
        params,
      );
      // The registry owns coalescing across commits sharing A/S. Its ephemeral
      // input must survive all joiners, so only its installing caller removes it.
      const ownsTrigger = !triggers.has(key);
      if (ownsTrigger) {
        if (triggers.size >= 64) {
          throw new ModelRepositoryError(
            "UPSTREAM_FAILURE",
            "Projection computation queue is full",
          );
        }
        triggers.set(key, { version, viewId, pin });
      }
      try {
        const value = await registry.get<unknown>(kind, pin.artifactDigest, {
          params,
        });
        if (kind === "authority-matrix") {
          const pure = value as PureMatrix;
          if (pure.model.sourceDigest !== pin.sourceDigest) {
            throw new ModelRepositoryError(
              "INVALID_REPOSITORY",
              "Cached matrix source digest mismatch",
            );
          }
          const body = { ...pure, version: parseModelRevisionId(version) };
          const { name: _name, ...identity } = pure.model;
          return {
            ...body,
            digest: await executionDigest({ ...body, model: identity }),
          };
        }
        if (
          kind === "board" &&
          (value as Awaited<ReturnType<ModelBoardReader["read"]>>).meta
              .sourceDigest !== pin.sourceDigest
        ) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Cached board source digest mismatch",
          );
        }
        return value;
      } catch (error) {
        // A coalesced computation may have been started by another commit
        // sharing A/S. Preserve the failure, but localize its requested version.
        const triggerVersion = triggers.get(key)?.version;
        if (error && typeof error === "object" && !(error instanceof Error)) {
          const failure = error as { context?: Record<string, unknown> };
          if (failure.context?.version === triggerVersion) {
            throw { ...failure, context: { ...failure.context, version } };
          }
        }
        throw error;
      } finally {
        if (ownsTrigger) triggers.delete(key);
      }
    })();
    reads.set(readKey, work);
    try {
      return structuredClone(await work) as T;
    } finally {
      reads.delete(readKey);
    }
  }
  const board: ModelBoardReader = { read: (version) => read("board", version) };
  const authorityMatrix: AuthorityMatrixReader = {
    read: (version) => read("authority-matrix", version),
  };
  const views: ModelViewsReader = {
    list: (version) => read("views", version),
    diagram: (version, viewId) => read("view-diagram", version, viewId),
    plantuml: (version, viewId) => read("plantuml", version, viewId),
  };
  function status(
    kind: CachedProjectionKind,
    version: string,
    view: ViewOptions = {},
  ): VersionProjectionStatus {
    const pin = pins.get(version);
    const memo = paramNames.get(`${version}\n${view.viewId ?? ""}`);
    const params = memo ? JSON.parse(memo) as ProjectionParams : undefined;
    return {
      version,
      projectorVersion: registry.projectorVersion(kind)!,
      state: "unrequested",
      ...(pin ? { pinOrigin: pin.origin } : {}),
      ...(pin?.artifactDigest ? { artifactDigest: pin.artifactDigest } : {}),
      ...(pin?.artifactDigest && params
        ? registry.status(kind, pin.artifactDigest, { params })
        : {}),
      kind,
    };
  }
  function current(
    kind: CachedProjectionKind,
    view: ViewOptions = {},
  ): CurrentVersionProjection {
    const pointer = pointers.get(`${kind}\n${view.viewId ?? ""}`);
    if (!pointer) return { kind, state: "unrequested" as const };
    const requested = status(kind, pointer.requestedVersion, view);
    const available = pointer.availableVersion
      ? pins.get(pointer.availableVersion)
      : undefined;
    return {
      ...requested,
      state: pointer.state,
      requestedVersion: pointer.requestedVersion,
      availableVersion: pointer.availableVersion,
      requestedArtifact: requested.artifactDigest,
      availableArtifact: available?.artifactDigest,
      ...(pointer.error ? { error: pointer.error } : {}),
    };
  }
  function requestCurrent(version: string): Promise<void> {
    validateVersion(version);
    head = version;
    const requestEpoch = ++epoch;
    for (const kind of ["board", "authority-matrix", "views"] as const) {
      const key = `${kind}\n`;
      const old = pointers.get(key);
      const pointer = {
        requestedVersion: version,
        availableVersion: old?.availableVersion,
        state: "pending" as ProjectionStatus["state"],
        error: undefined as ProjectionStatus["error"] | undefined,
      };
      pointers.set(key, pointer);
      void read(kind, version).then(() => {
        if (requestEpoch === epoch) {
          pointer.availableVersion = version;
          pointer.state = "ready";
          // Memory hits emit no registry event. Notify completion explicitly so
          // a newly requested commit sharing A/S cannot leave SSE pending.
          const pin = pins.get(version);
          const snapshot = status(kind, version);
          if (pin?.artifactDigest && snapshot.params) {
            const ready = registry.status(kind, pin.artifactDigest, {
              params: snapshot.params,
            });
            for (const listener of listeners) {
              try {
                listener({ ...ready, versions: [version] });
              } catch { /* Subscriber isolation. */ }
            }
          }
        }
      }, (error: unknown) => {
        if (requestEpoch === epoch) {
          pointer.state = "failed";
          pointer.error = {
            code: String(
              (error as { code?: string })?.code ?? "PROJECTION_FAILED",
            ),
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
    return Promise.resolve();
  }
  return {
    board,
    authorityMatrix,
    views,
    registry,
    pinFor,
    status,
    current,
    requestCurrent,
    currentVersion: () => head,
    subscribe(
      listener: (status: ProjectionStatus & { versions: string[] }) => void,
    ) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stats: () => ({
      pins: pins.size,
      heldRevisions: 0,
      triggers: triggers.size,
      registry: registry.stats(),
    }),
  };
}
