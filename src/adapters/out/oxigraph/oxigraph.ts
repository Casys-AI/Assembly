import { readBoundedLines } from "../../../infrastructure/native/process-client.ts";
import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
/** Native Oxigraph index adapter (W5): Rust Oxigraph via napi-rs only.
 *
 * No npm Oxigraph, no WASM anywhere on this path. Heavy calls run behind
 * an injected executor; the production shape is a killable child process
 * speaking the versioned JSON-Lines envelope below (the coordinator may
 * swap in the shared native-process-client through
 * `NativeProcessRequester`). The in-process executor exists for tests and
 * tools and must not be wired into the HTTP path: addon calls are
 * synchronous. The store grants no rights; datasets are pinned per build
 * (one native store entry per full `BuildRef`).
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY,
  materializeNativeAddonSnapshot,
  type NativeAddonSnapshot,
  NativeAddonSnapshotError,
  type NativeAddonSnapshotFileSystem,
} from "../../../infrastructure/native/addon-snapshot.ts";
import {
  MAX_PRIVATE_PAYLOAD_BYTES,
  type PrivatePayloadDescriptor,
  PrivatePayloadError,
  readPrivatePayload,
  removePrivatePayload,
  stagePrivatePayload,
} from "../../../infrastructure/native/private-payload.ts";

import {
  buildGraphIri,
  type BuildRef,
  buildRefKey,
  parseBuildRef,
  parseProjectionRef,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  BuildStoreError,
  type BuildStoreErrorCode,
} from "../../../application/model/builds/ports/out/build-store.port.ts";
import type { KvModelBuildStore } from "../deno-kv/kv-store.ts";
import {
  SemanticIndexError,
  type SemanticIndexErrorCode,
} from "../../../application/model/semantic/index-service.ts";
import type { NativeSemanticIndexPort } from "../../../application/model/semantic/ports/out/native-semantic-index.port.ts";
import type {
  SemanticQueryLimits,
  SemanticQueryResult,
} from "../../../application/model/semantic/queries/inputs.ts";

/** Native failure preserved across executor boundaries (`CODE: detail`). */
export class NativeIndexFailure extends Error {
  constructor(
    readonly nativeCode: string,
    message: string,
    readonly workerStopped = false,
    readonly context?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "NativeIndexFailure";
  }
}

const ERROR_MAP: Record<string, SemanticIndexErrorCode> = {
  QUERY_REFUSED: "INDEX_QUERY_REFUSED",
  QUERY_LIMIT: "INDEX_QUERY_LIMIT",
  GRAPH_NOT_FOUND: "INDEX_PROJECTION_MISSING",
  INTEGRITY: "INDEX_PROJECTION_CORRUPT",
  INVALID_INPUT: "INDEX_INVALID_INPUT",
  TIMEOUT: "INDEX_TIMEOUT",
  BUSY: "INDEX_BUSY",
  STORE_FULL: "INDEX_BUSY",
};

const BUILD_STORE_ERROR_CODES = new Set<BuildStoreErrorCode>([
  "BUILD_BLOB_CORRUPT",
  "BUILD_BLOB_MISSING",
  "BUILD_BLOB_CONFLICT",
  "BUILD_STORE_UNAVAILABLE",
  "BUILD_STORE_BUSY",
  "BUILD_STORE_QUOTA_EXCEEDED",
  "BUILD_STORE_INVALID_INPUT",
]);

export function toSemanticIndexError(
  error: unknown,
): SemanticIndexError | BuildStoreError {
  if (error instanceof SemanticIndexError) return error;
  if (error instanceof BuildStoreError) return error;
  const nativeCode = error instanceof NativeIndexFailure
    ? error.nativeCode
    : "INDEX_UNAVAILABLE";
  if (BUILD_STORE_ERROR_CODES.has(nativeCode as BuildStoreErrorCode)) {
    return new BuildStoreError(
      nativeCode as BuildStoreErrorCode,
      error instanceof NativeIndexFailure ? error.context ?? {} : {},
      error instanceof Error ? error.message : "Projection cache read failed",
    );
  }
  const code = ERROR_MAP[nativeCode] ?? "INDEX_UNAVAILABLE";
  return new SemanticIndexError(
    code,
    {
      reason: errorMessage(error),
      nativeCode,
      ...(nativeCode === "NATIVE_ADDON_SNAPSHOT_UNAVAILABLE"
        ? {
          recovery: "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY",
        }
        : {}),
    },
    error instanceof Error ? error.message : "Native semantic index failed",
  );
}

function parseNativeFailure(error: unknown): NativeIndexFailure {
  if (error instanceof NativeIndexFailure) return error;
  if (error instanceof BuildStoreError) {
    return new NativeIndexFailure(
      error.code,
      error.message,
      false,
      error.context,
    );
  }
  if (error instanceof NativeAddonSnapshotError) {
    return new NativeIndexFailure(error.code, error.message);
  }
  if (error instanceof PrivatePayloadError) {
    return new NativeIndexFailure(error.code, error.message);
  }
  const message = errorMessage(error);
  const match = /^([A-Z_]+): (.*)$/s.exec(message);
  return new NativeIndexFailure(match?.[1] ?? "OXIGRAPH_ERROR", message);
}

// --- Typed operations over any executor ---

export type NativeIndexOperation =
  | {
    readonly op: "loadReference";
    readonly build: BuildRef;
    readonly projection: ProjectionRef;
  }
  | {
    readonly op: "load";
    readonly storeKey: string;
    readonly graphIri: string;
    /** Borrowed until execute settles; the pinned SHA rejects caller mutation. */
    readonly quads: Uint8Array;
    readonly expectedDigest: string;
  }
  | {
    readonly op: "query";
    readonly storeKey: string;
    readonly sparql: string;
    readonly limits: SemanticQueryLimits;
  }
  | { readonly op: "release"; readonly storeKey: string }
  | { readonly op: "has"; readonly storeKey: string }
  | { readonly op: "close"; readonly storeKey: string };

export type NativeIndexResult =
  | { readonly op: "load"; readonly quadCount: number }
  | { readonly op: "loadReference"; readonly quadCount: number }
  | { readonly op: "query"; readonly result: SemanticQueryResult }
  | { readonly op: "release" }
  | { readonly op: "has"; readonly loaded: boolean }
  | { readonly op: "close" };

export interface NativeSemanticIndexExecutor {
  execute(
    operation: NativeIndexOperation,
    options: { readonly timeoutMs: number },
  ): Promise<NativeIndexResult>;
  /** Hard-stop the native side (process kill) after a timeout. */
  recycle?(reason: string): Promise<void>;
  close?(): Promise<void>;
}

// --- Versioned JSON-Lines envelope (process boundary) ---

export const NATIVE_INDEX_PROTOCOL = 2;
export type NativeIndexWireOperation =
  | Exclude<NativeIndexOperation, { op: "load" }>
  | {
    readonly op: "load";
    readonly storeKey: string;
    readonly graphIri: string;
    readonly expectedDigest: string;
    /** Absent only inside the parent before its requester stages the bytes. */
    readonly payload?: PrivatePayloadDescriptor;
  };
export interface NativeIndexEnvelope {
  readonly v: typeof NATIVE_INDEX_PROTOCOL;
  readonly requestId: number;
  readonly operation: NativeIndexWireOperation;
  readonly processEpoch?: string;
}
export type NativeIndexResponse =
  | {
    readonly v: typeof NATIVE_INDEX_PROTOCOL;
    readonly requestId: number;
    readonly ok: true;
    readonly result: NativeIndexResult;
  }
  | {
    readonly v: typeof NATIVE_INDEX_PROTOCOL;
    readonly requestId: number;
    readonly ok: false;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly workerStopped?: boolean;
      readonly context?: Readonly<Record<string, unknown>>;
    };
  };

/** Structural seam for the shared native-process-client (other owner):
 * one JSON line in, one JSON line out, killable on timeout. */
export interface NativeProcessRequester {
  request(
    line: string,
    options: NativeProcessRequestOptions,
  ): Promise<string>;
  recycle?(reason: string): Promise<void>;
  close?(): Promise<void>;
}

export interface NativeProcessRequestOptions {
  readonly timeoutMs: number;
  /** Side channel for load data; this buffer is never JSON-stringified. */
  readonly binary?: Uint8Array;
}

export class ProcessSemanticIndexExecutor
  implements NativeSemanticIndexExecutor {
  #nextRequestId = 1;
  constructor(private readonly requester: NativeProcessRequester) {}

  async execute(
    operation: NativeIndexOperation,
    options: { timeoutMs: number },
  ): Promise<NativeIndexResult> {
    const requestId = this.#nextRequestId++;
    const envelope: NativeIndexEnvelope = {
      v: NATIVE_INDEX_PROTOCOL,
      requestId,
      operation: operation.op === "load"
        ? {
          op: "load",
          storeKey: operation.storeKey,
          graphIri: operation.graphIri,
          expectedDigest: operation.expectedDigest,
        }
        : operation,
    };
    let line: string;
    try {
      line = await this.requester.request(JSON.stringify(envelope), {
        ...options,
        ...(operation.op === "load" ? { binary: operation.quads } : {}),
      });
    } catch (error) {
      throw parseNativeFailure(error);
    }
    let response: NativeIndexResponse;
    try {
      response = JSON.parse(line) as NativeIndexResponse;
    } catch {
      throw new NativeIndexFailure(
        "OXIGRAPH_ERROR",
        "Native index process returned a non-JSON line",
      );
    }
    if (
      !response || typeof response !== "object" ||
      typeof response.ok !== "boolean" || response.v !== NATIVE_INDEX_PROTOCOL
    ) {
      throw new NativeIndexFailure(
        "OXIGRAPH_ERROR",
        `Native index protocol mismatch: ${String(response?.v)}`,
      );
    }
    if (response.requestId !== requestId) {
      throw new NativeIndexFailure(
        "OXIGRAPH_ERROR",
        "Native index response does not match the request",
      );
    }
    if (!response.ok) {
      if (
        !response.error || typeof response.error.code !== "string" ||
        typeof response.error.message !== "string" ||
        (response.error.context !== undefined &&
          (!response.error.context ||
            typeof response.error.context !== "object" ||
            Array.isArray(response.error.context)))
      ) {
        await this.requester.recycle?.("malformed native error");
        throw new NativeIndexFailure(
          "OXIGRAPH_ERROR",
          "Malformed native error envelope",
        );
      }
      throw new NativeIndexFailure(
        response.error.code,
        response.error.message,
        response.error.workerStopped === true,
        response.error.context,
      );
    }
    if (!response.result || response.result.op !== operation.op) {
      throw new NativeIndexFailure(
        "OXIGRAPH_ERROR",
        "Native index answered a different operation",
      );
    }
    return response.result;
  }

  async recycle(reason: string): Promise<void> {
    await this.requester.recycle?.(reason);
  }
  async close(): Promise<void> {
    await this.requester.close?.();
  }
}

// --- In-process executor over the napi addon (tests/tools, host mode) ---

/** Structural view of `ase-semantic-index-napi` (see its API contract). */
export interface SemanticIndexAddonStore {
  loadBuild(
    storeKey: string,
    graphIri: string,
    nquads: Uint8Array,
    expectedDigest: string,
  ): { readonly quadCount: number; readonly bytes: number };
  queryReadOnly(
    storeKey: string,
    sparql: string,
    limitsJson: string,
  ): string;
  hasBuild(storeKey: string): boolean;
  releaseBuild(storeKey: string): void;
  loadedBuilds(): string[];
  close(): void;
  dispose(): void;
}
export interface SemanticIndexAddonModule {
  readonly SemanticIndexStore: new (
    optionsJson?: string | null,
  ) => SemanticIndexAddonStore;
  storeVersion(): string;
  oxigraphVersion(): string;
}

export interface SemanticAddonLoadOptions {
  readonly snapshotDirectory?: string;
  /** Process snapshots stay present until their parent observes child.status. */
  readonly snapshotCleanup?: "runtime" | "process";
}

export interface LoadedSemanticIndexAddon {
  readonly addon: SemanticIndexAddonModule;
  readonly digest: string;
  /** Direct callers close every store before releasing their owned snapshot. */
  close(): Promise<void>;
}

export async function loadSemanticIndexAddon(
  addonPath: string,
  expectedSha256: string,
  options: SemanticAddonLoadOptions = {},
  deps: {
    reader?: { readFile(path: string): Promise<Uint8Array<ArrayBuffer>> };
    fs?: NativeAddonSnapshotFileSystem;
    requireAddon?: (path: string) => unknown;
  } = {},
): Promise<LoadedSemanticIndexAddon> {
  options = { ...options };
  let snapshot: NativeAddonSnapshot | undefined;
  const ownsCleanup = options.snapshotCleanup !== "process";
  const cleanupOnExit = () => {
    try {
      snapshot?.removeSync?.();
    } catch { /* Explicit close is the deterministic cleanup contract. */ }
  };
  const cleanup = () => {
    if (!ownsCleanup) return Promise.resolve();
    globalThis.removeEventListener("unload", cleanupOnExit);
    return snapshot?.remove() ?? Promise.resolve();
  };
  try {
    if (!isAbsolute(addonPath) || !addonPath.endsWith(".node")) {
      throw new Error(
        "Expected an absolute .node addon path (no JS/WASI loader)",
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(expectedSha256)
    ) throw new Error("Expected installed semantic addon SHA-256");
    const bytes = (await (deps.reader ?? Deno).readFile(addonPath)).slice();
    if (
      await sha256(bytes) !== expectedSha256
    ) {
      throw new Error(
        "Semantic addon does not match its installed provenance hash",
      );
    }
    snapshot = await materializeNativeAddonSnapshot(
      bytes,
      expectedSha256,
      options.snapshotDirectory,
      deps.fs,
    );
    if (ownsCleanup && snapshot.removeSync) {
      globalThis.addEventListener("unload", cleanupOnExit);
    }
    const require = deps.requireAddon ?? createRequire(import.meta.url);
    const addon = require(snapshot.path) as SemanticIndexAddonModule;
    if (
      addon.storeVersion() !== "0.1.0" || addon.oxigraphVersion() !== "0.5.12"
    ) {
      throw new Error("Semantic addon version does not match pinned contract");
    }
    return { addon, digest: expectedSha256, close: cleanup };
  } catch (cause) {
    await cleanup();
    throw new SemanticIndexError(
      "INDEX_UNAVAILABLE",
      {
        reason: `Cannot load semantic-index addon: ${String(cause)}`,
        ...(cause instanceof NativeAddonSnapshotError
          ? {
            nativeCode: cause.code,
            recovery: cause.recovery,
          }
          : {}),
      },
      "Native semantic-index addon is not loadable",
    );
  }
}

export class InProcessSemanticIndexExecutor
  implements NativeSemanticIndexExecutor {
  constructor(private readonly store: SemanticIndexAddonStore) {}

  close(): Promise<void> {
    this.store.close();
    return Promise.resolve();
  }

  execute(operation: NativeIndexOperation): Promise<NativeIndexResult> {
    try {
      switch (operation.op) {
        case "loadReference":
          throw new NativeIndexFailure(
            "INVALID_INPUT",
            "Reference loads require the configured semantic process host",
          );
        case "load": {
          const report = this.store.loadBuild(
            operation.storeKey,
            operation.graphIri,
            operation.quads,
            operation.expectedDigest,
          );
          return Promise.resolve({
            op: "load" as const,
            quadCount: report.quadCount,
          });
        }
        case "query": {
          const text = this.store.queryReadOnly(
            operation.storeKey,
            operation.sparql,
            JSON.stringify(operation.limits),
          );
          return Promise.resolve({
            op: "query" as const,
            result: JSON.parse(text) as SemanticQueryResult,
          });
        }
        case "release":
          this.store.releaseBuild(operation.storeKey);
          return Promise.resolve({ op: "release" as const });
        case "close":
          this.store.close();
          return Promise.resolve({ op: "close" as const });
        case "has":
          return Promise.resolve({
            op: "has" as const,
            loaded: this.store.hasBuild(operation.storeKey),
          });
      }
    } catch (error) {
      return Promise.reject(parseNativeFailure(error));
    }
  }
}

// --- Port implementation ---

const LOAD_TIMEOUT_MS = 120_000;

export class OxigraphNativeIndex implements NativeSemanticIndexPort {
  constructor(private readonly executor: NativeSemanticIndexExecutor) {}
  async close(): Promise<void> {
    await this.executor.close?.();
  }

  async load(input: {
    build: BuildRef;
    projection: ProjectionRef;
    quads: Uint8Array;
  }): Promise<{ quadCount: number }> {
    try {
      const result = await this.executor.execute({
        op: "load",
        // Full BuildRef key: A/B and cross-repository isolation even
        // when two repositories share one artifact digest.
        storeKey: buildRefKey(input.build),
        graphIri: buildGraphIri(input.build),
        quads: input.quads,
        expectedDigest: input.projection.projectionDigest,
      }, { timeoutMs: LOAD_TIMEOUT_MS });
      if (result.op !== "load") throw new Error("unexpected native result");
      return { quadCount: result.quadCount };
    } catch (error) {
      throw toSemanticIndexError(error);
    }
  }

  async loadReference(input: {
    build: BuildRef;
    projection: ProjectionRef;
  }): Promise<{ quadCount: number }> {
    try {
      const operation = parseReferenceLoad({ op: "loadReference", ...input });
      const result = await this.executor.execute(operation, {
        timeoutMs: LOAD_TIMEOUT_MS,
      });
      if (
        result.op !== "loadReference" ||
        !Number.isSafeInteger(result.quadCount) || result.quadCount < 0
      ) throw new Error("Unexpected native reference load acknowledgement");
      return { quadCount: result.quadCount };
    } catch (error) {
      throw toSemanticIndexError(error);
    }
  }

  async query(input: {
    build: BuildRef;
    sparql: string;
    limits: SemanticQueryLimits;
  }): Promise<SemanticQueryResult> {
    try {
      const result = await this.executor.execute({
        op: "query",
        storeKey: buildRefKey(input.build),
        sparql: input.sparql,
        limits: input.limits,
      }, { timeoutMs: input.limits.timeoutMs });
      if (result.op !== "query") throw new Error("unexpected native result");
      return result.result;
    } catch (error) {
      const mapped = toSemanticIndexError(error);
      if (
        mapped.code === "INDEX_TIMEOUT" &&
        !(error instanceof NativeIndexFailure && error.workerStopped)
      ) {
        // A cooperative stop may not exist: hard-recycle the worker.
        await this.executor.recycle?.("query timeout").catch(() => {});
      }
      throw mapped;
    }
  }

  async release(build: BuildRef): Promise<void> {
    try {
      await this.executor.execute(
        { op: "release", storeKey: buildRefKey(build) },
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      throw toSemanticIndexError(error);
    }
  }

  async isLoaded(build: BuildRef): Promise<boolean> {
    try {
      const result = await this.executor.execute(
        { op: "has", storeKey: buildRefKey(build) },
        { timeoutMs: 10_000 },
      );
      return result.op === "has" && result.loaded;
    } catch {
      return false;
    }
  }
}

const semanticMessageSizeError = () =>
  new NativeIndexFailure(
    "QUERY_LIMIT",
    "Semantic process message exceeds its size limit",
  );

// --- Concrete killable child (Deno) + stdin/stdout host mode ---

/** Child seam used by deterministic tests; production uses Deno.Command. */
export interface SemanticChildProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly status: Promise<
    { success: boolean; code: number; signal: string | null }
  >;
  kill(signal?: Deno.Signal): void;
}
export interface DenoChildRequesterOptions {
  /** Installed exact binary and SHA from package/buildinfo.json. */
  readonly addonPath: string;
  readonly expectedAddonSha256: string;
  readonly hostModule?: string;
  readonly denoExecutable?: string;
  readonly maxMessageBytes?: number;
  readonly maxQueuedRequests?: number;
  readonly maxQueuedBytes?: number;
  readonly closeTimeoutMs?: number;
  /** Host-owned shared cache. Never accepted from a wire request. Deno KV
   * requires write permission on this SQLite path even for a read consumer. */
  readonly buildCachePath?: string;
  /** Parent staging root; a new private directory is provisioned per epoch. */
  readonly snapshotDirectory?: string;
  readonly snapshotStorage?: {
    create(root: string, epoch: string): Promise<string>;
    remove(directory: string): Promise<void>;
  };
  readonly payloadStorage?: {
    stage: typeof stagePrivatePayload;
    remove: typeof removePrivatePayload;
  };
  /** Tests only. The production path always verifies the installed binary. */
  readonly spawnChild?: (
    epoch: string,
    snapshotDirectory: string,
  ) => SemanticChildProcess | Promise<SemanticChildProcess>;
}

const SEMANTIC_APP_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);

function assertBuildCachePath(path: string | undefined): void {
  if (
    path !== undefined &&
    (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 ||
      /[\0\r\n,]/.test(path))
  ) {
    throw new NativeIndexFailure(
      "INVALID_INPUT",
      "Expected an absolute cache path",
    );
  }
}

const semanticSnapshotStorage = {
  async create(root: string, epoch: string): Promise<string> {
    let directory: string | undefined;
    try {
      directory = await Deno.makeTempDir({
        dir: root,
        prefix: `semantic-process-${epoch}-`,
      });
      await Deno.chmod(directory, 0o700);
      return directory;
    } catch (error) {
      if (directory) {
        await Deno.remove(directory, { recursive: true }).catch(() =>
          undefined
        );
      }
      throw new NativeAddonSnapshotError(error);
    }
  },
  remove: (directory: string) => Deno.remove(directory, { recursive: true }),
};

/** Pure command seam: no installation binary is authorized for native loading. */
export function semanticProcessCommandArgs(
  options: Pick<
    DenoChildRequesterOptions,
    "addonPath" | "expectedAddonSha256" | "hostModule" | "buildCachePath"
  >,
  epoch: string,
  snapshotDirectory: string,
  maxMessageBytes = SEMANTIC_MAX_MESSAGE_BYTES,
): string[] {
  const hostModule = options.hostModule ?? import.meta.url;
  const hostPath = hostModule.startsWith("file:")
    ? fileURLToPath(hostModule)
    : resolve(hostModule);
  assertBuildCachePath(options.buildCachePath);
  const cachePath = options.buildCachePath;
  return [
    "run",
    "--no-prompt",
    "--quiet",
    "--frozen",
    "--cached-only",
    `--config=${SEMANTIC_APP_ROOT}deno.json`,
    "--unstable-kv",
    `--allow-read=${SEMANTIC_APP_ROOT},${
      dirname(hostPath)
    },${options.addonPath},${snapshotDirectory}${
      cachePath === undefined ? "" : `,${cachePath}`
    }`,
    `--allow-write=${snapshotDirectory}${
      cachePath === undefined ? "" : `,${cachePath}`
    }`,
    `--allow-ffi=${snapshotDirectory}`,
    hostModule,
    options.addonPath,
    options.expectedAddonSha256,
    epoch,
    String(maxMessageBytes),
    snapshotDirectory,
    ...(options.buildCachePath === undefined ? [] : [options.buildCachePath]),
  ];
}

export const SEMANTIC_MAX_MESSAGE_BYTES = 384 * 1024 * 1024;
/** Outgoing control frames contain metadata/query text, never projection data. */
export const SEMANTIC_MAX_CONTROL_BYTES = 1024 * 1024;
interface PendingRequest {
  line: string;
  closing: boolean;
  binary?: Uint8Array;
  /** Retained even after staging releases its borrowed JS reference. */
  binaryBytes: number;
  bytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (line: string) => void;
  reject: (error: unknown) => void;
}

interface SemanticProcessScope {
  readonly directory: string;
  cancelled: boolean;
  staging?: Promise<PrivatePayloadDescriptor>;
}

/** Serial killable worker with bounded frames/queue and a total deadline.
 * A hard timeout is latched before kill, and the next request cannot use
 * a process until its exit has been observed. No late response can win. */
export class DenoChildProcessRequester implements NativeProcessRequester {
  #child: SemanticChildProcess | undefined;
  #spawning: Promise<SemanticChildProcess> | undefined;
  #exitObserved: Promise<unknown> | undefined;
  #scope: SemanticProcessScope | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #lines: AsyncIterator<string> | undefined;
  #epoch = "";
  #active: PendingRequest | undefined;
  #queue: PendingRequest[] = [];
  #queuedBytes = 0;
  #closed = false;
  #closing: Promise<void> | undefined;
  #recycling: Promise<void> | undefined;
  #retirement: Promise<void> | undefined;
  readonly #encoder = new TextEncoder();
  readonly #maxMessage: number;
  readonly #maxQueued: number;
  readonly #maxQueuedBytes: number;
  readonly #closeTimeout: number;

  constructor(private readonly options: DenoChildRequesterOptions) {
    this.options = { ...options };
    assertBuildCachePath(options.buildCachePath);
    this.#maxMessage = options.maxMessageBytes ?? SEMANTIC_MAX_MESSAGE_BYTES;
    this.#maxQueued = options.maxQueuedRequests ?? 32;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? SEMANTIC_MAX_MESSAGE_BYTES;
    this.#closeTimeout = options.closeTimeoutMs ?? 2_000;
    for (
      const [name, value, min] of [
        ["maxMessageBytes", this.#maxMessage, 1],
        ["maxQueuedRequests", this.#maxQueued, 0],
        ["maxQueuedBytes", this.#maxQueuedBytes, 0],
        ["closeTimeoutMs", this.#closeTimeout, 1],
      ] as const
    ) {
      if (
        !Number.isSafeInteger(value) || value < min || value > 2_147_483_647
      ) {
        throw new NativeIndexFailure("INVALID_INPUT", `Invalid ${name}`);
      }
    }
    if (
      !isAbsolute(options.addonPath) || !options.addonPath.endsWith(".node") ||
      !/^[0-9a-f]{64}$/.test(options.expectedAddonSha256)
    ) {
      throw new NativeIndexFailure(
        "INVALID_INPUT",
        "Expected installed .node path and SHA-256",
      );
    }
  }

  async #spawn(): Promise<void> {
    const epoch = this.#epoch = crypto.randomUUID();
    // Legacy injected children remain filesystem-free. Snapshot-specific tests
    // inject storage explicitly; production always provisions a real scope.
    const storage = this.options.snapshotStorage ?? (this.options.spawnChild
      ? {
        create: (_root: string, value: string) =>
          Promise.resolve(`/fake-native-snapshot/${value}`),
        remove: (_directory: string) => Promise.resolve(),
      }
      : semanticSnapshotStorage);
    const spawning = (async () => {
      const snapshotDirectory = await storage.create(
        this.options.snapshotDirectory ??
          DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY,
        epoch,
      );
      let child: SemanticChildProcess;
      const scope: SemanticProcessScope = {
        directory: snapshotDirectory,
        cancelled: false,
      };
      try {
        child = await (this.options.spawnChild?.(epoch, snapshotDirectory) ??
          new Deno.Command(
            this.options.denoExecutable ?? Deno.execPath(),
            {
              args: semanticProcessCommandArgs(
                this.options,
                epoch,
                snapshotDirectory,
                this.#maxMessage,
              ),
              stdin: "piped",
              stdout: "piped",
              stderr: "null",
            },
          ).spawn());
      } catch (error) {
        await storage.remove(snapshotDirectory);
        throw error;
      }
      this.#child = child;
      this.#scope = scope;
      this.#writer = child.stdin.getWriter();
      this.#lines = readBoundedLines(
        child.stdout,
        this.#maxMessage,
        semanticMessageSizeError,
      )
        [Symbol.asyncIterator]();
      this.#exitObserved = child.status.then(async (status) => {
        scope.cancelled = true;
        // The writer must finish closing before its owner removes the scope.
        // This also prevents a delayed stage from recreating data after exit.
        await scope.staging?.catch(() => undefined);
        await storage.remove(snapshotDirectory);
        return status;
      });
      // No unhandled rejection if the OS status/cleanup fails while idle.
      void this.#exitObserved.catch(() => undefined);
      return child;
    })();
    this.#spawning = spawning;
    try {
      await spawning;
    } finally {
      if (this.#spawning === spawning) this.#spawning = undefined;
    }
  }

  #kill(): Promise<void> {
    if (this.#recycling) return this.#recycling;
    const stopped = (async () => {
      // A timeout/close during private staging must also retire the child that
      // finishes spawning later; no unobserved orphan may outlive that owner.
      await this.#spawning?.catch(() => undefined);
      const child = this.#child;
      const writer = this.#writer;
      const lines = this.#lines;
      const exitObserved = this.#exitObserved;
      const scope = this.#scope;
      if (scope) scope.cancelled = true;
      this.#child = undefined;
      this.#writer = undefined;
      this.#lines = undefined;
      this.#exitObserved = undefined;
      this.#scope = undefined;
      this.#epoch = "";
      try {
        child?.kill("SIGKILL");
      } catch { /* already exited */ }
      let exitError: unknown;
      try {
        await (exitObserved ?? child?.status);
      } catch (error) {
        exitError = error;
      }
      try {
        await writer?.abort();
      } catch { /* closed pipe */ }
      try {
        writer?.releaseLock();
      } catch { /* closed pipe */ }
      try {
        await lines?.return?.();
      } catch { /* closed pipe */ }
      if (exitError) throw exitError;
    })().finally(() => {
      if (this.#recycling === stopped) this.#recycling = undefined;
    });
    this.#recycling = stopped;
    this.#retirement = stopped;
    return stopped;
  }

  request(line: string, options: NativeProcessRequestOptions): Promise<string> {
    if (this.#closed) {
      return Promise.reject(
        new NativeIndexFailure("INDEX_CLOSED", "Semantic process is closed"),
      );
    }
    return this.#enqueue(line, options.timeoutMs, false, options.binary);
  }

  #enqueue(
    line: string,
    timeoutMs: number,
    closing = false,
    binary?: Uint8Array,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 2_147_483_647 ||
      typeof line !== "string" || line.includes("\n")
    ) {
      return Promise.reject(
        new NativeIndexFailure(
          "INVALID_INPUT",
          "Invalid native request/deadline",
        ),
      );
    }
    if (line.length > Math.min(this.#maxMessage, SEMANTIC_MAX_CONTROL_BYTES)) {
      return Promise.reject(
        new NativeIndexFailure(
          "QUERY_LIMIT",
          "Native control metadata exceeds its size limit",
        ),
      );
    }
    // Epoch/framing overhead is bounded separately before the actual write.
    const bytes = this.#encoder.encode(line).byteLength;
    if (bytes > Math.min(this.#maxMessage, SEMANTIC_MAX_CONTROL_BYTES)) {
      return Promise.reject(
        new NativeIndexFailure("QUERY_LIMIT", "Native request is too large"),
      );
    }
    const binaryBytes = binary?.byteLength ?? 0;
    if (
      (binary !== undefined && !(binary instanceof Uint8Array)) ||
      binaryBytes > MAX_PRIVATE_PAYLOAD_BYTES
    ) {
      return Promise.reject(
        new NativeIndexFailure(
          "QUERY_LIMIT",
          "Native projection exceeds its binary byte limit",
        ),
      );
    }
    const weight = bytes + binaryBytes;
    const activeBinaryBytes = this.#active?.binaryBytes ?? 0;
    if (
      !closing &&
      ((this.#active && this.#queue.length >= this.#maxQueued) ||
        ((this.#active || binary !== undefined) &&
          activeBinaryBytes + this.#queuedBytes + weight >
            this.#maxQueuedBytes))
    ) {
      return Promise.reject(
        new NativeIndexFailure("BUSY", "Native request queue is full"),
      );
    }
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        line,
        closing,
        binary,
        binaryBytes,
        bytes: weight,
        deadline: performance.now() + timeoutMs,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            this.#queuedBytes -= weight;
            entry.binary = undefined;
            reject(
              new NativeIndexFailure(
                "TIMEOUT",
                "Native request expired in queue",
              ),
            );
          }
        }, timeoutMs),
      };
      this.#queue.push(entry);
      this.#queuedBytes += weight;
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    this.#queuedBytes -= entry.bytes;
    clearTimeout(entry.timer);
    this.#active = entry;
    void this.#run(entry).then(entry.resolve, entry.reject).finally(() => {
      this.#active = undefined;
      this.#pump();
    });
  }

  async #run(entry: PendingRequest): Promise<string> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () =>
      new NativeIndexFailure(
        "TIMEOUT",
        "Native request total deadline exceeded",
      );
    const remaining = entry.deadline - performance.now();
    if (remaining <= 0) throw timeoutError();
    const work = (async () => {
      const request = JSON.parse(entry.line) as NativeIndexEnvelope;
      if (
        request?.v !== NATIVE_INDEX_PROTOCOL ||
        !Number.isSafeInteger(request.requestId) || !request.operation ||
        !["load", "loadReference", "query", "has", "release", "close"].includes(
          request.operation.op,
        )
      ) {
        throw new NativeIndexFailure(
          "INVALID_INPUT",
          "Invalid native request protocol",
        );
      }
      const load = request.operation.op === "load"
        ? request.operation
        : undefined;
      if (request.operation.op === "loadReference") {
        parseReferenceLoad(request.operation);
        if (this.options.buildCachePath === undefined) {
          throw new NativeIndexFailure(
            "INDEX_UNAVAILABLE",
            "Semantic reference loading requires a host-configured build cache",
          );
        }
      }
      if (
        (load && (entry.binary === undefined || load.payload !== undefined ||
          "quadsBase64" in load || "quads" in load ||
          !/^urn:ase:build:[0-9a-f]{64}$/.test(load.graphIri) ||
          !/^[0-9a-f]{64}$/.test(load.expectedDigest))) ||
        (!load && entry.binary !== undefined)
      ) {
        throw new NativeIndexFailure(
          "INVALID_INPUT",
          "Native load requires typed bytes and private-file metadata",
        );
      }
      await this.#recycling;
      if (expired) throw timeoutError();
      if (entry.closing && !this.#child && !this.#spawning) {
        // The active request may already have retired this epoch. A queued
        // internal close never creates a replacement merely to close it.
        await this.#retirement;
        throw new NativeIndexFailure(
          "INDEX_CLOSED",
          "Semantic child was already retired",
          true,
        );
      }
      if (this.#closed && request.operation?.op !== "close") {
        throw new NativeIndexFailure(
          "INDEX_CLOSED",
          "Semantic process closed before request started",
        );
      }
      if (!this.#child) await this.#spawn();
      if (expired) throw timeoutError();
      if (this.#closed && request.operation?.op !== "close") {
        throw new NativeIndexFailure(
          "INDEX_CLOSED",
          "Semantic process closed while spawning",
        );
      }
      const scope = this.#scope;
      const epoch = this.#epoch;
      if (!scope || scope.cancelled) {
        throw new NativeIndexFailure(
          "INDEX_CLOSED",
          "Semantic process scope is closed",
        );
      }
      const storage = this.options.payloadStorage ?? {
        stage: stagePrivatePayload,
        remove: removePrivatePayload,
      };
      let staged: PrivatePayloadDescriptor | undefined;
      if (load) {
        if (entry.binary!.byteLength !== entry.binaryBytes) {
          throw new NativeIndexFailure(
            "INTEGRITY",
            "Projection size changed while queued",
          );
        }
        const staging = scope.staging = storage.stage(
          scope.directory,
          entry.binary!,
          load.expectedDigest,
          {
            isCancelled: () => expired || this.#closed || scope.cancelled,
          },
        );
        try {
          staged = await scope.staging;
        } finally {
          // The writer owns bounded chunks; retaining a second JS reference is
          // unnecessary once staging settles. Its byte reservation stays active.
          entry.binary = undefined;
          if (scope.staging === staging) scope.staging = undefined;
        }
        if (expired) throw timeoutError();
        if (
          this.#closed || scope.cancelled || this.#scope !== scope ||
          this.#epoch !== epoch
        ) {
          throw new NativeIndexFailure(
            "INDEX_CLOSED",
            "Semantic process closed while staging projection",
          );
        }
      }
      const payload = JSON.stringify({
        ...request,
        operation: load ? { ...load, payload: staged } : request.operation,
        processEpoch: epoch,
      });
      const encodedPayload = this.#encoder.encode(`${payload}\n`);
      if (
        encodedPayload.byteLength - 1 >
          Math.min(this.#maxMessage, SEMANTIC_MAX_CONTROL_BYTES)
      ) {
        throw new NativeIndexFailure(
          "QUERY_LIMIT",
          "Native frame exceeds byte limit",
        );
      }
      const writer = this.#writer!;
      const lines = this.#lines!;
      await writer.write(encodedPayload);
      const next = await lines.next();
      if (expired) throw timeoutError();
      if (next.done) {
        throw new NativeIndexFailure(
          "OXIGRAPH_ERROR",
          "Native process exited without answering",
        );
      }
      const response = JSON.parse(next.value);
      if (
        this.#epoch !== epoch || response?.processEpoch !== epoch ||
        response.v !== NATIVE_INDEX_PROTOCOL ||
        response.requestId !== request.requestId ||
        typeof response.ok !== "boolean" ||
        (response.ok === true &&
          response.result?.op !== request.operation?.op) ||
        (response.ok === false &&
          (typeof response.error?.code !== "string" ||
            typeof response.error?.message !== "string"))
      ) {
        throw new NativeIndexFailure(
          "OXIGRAPH_ERROR",
          "Native response protocol/epoch/request mismatch",
        );
      }
      if (
        !response.ok &&
        (staged !== undefined ||
          ["TIMEOUT", "NATIVE_PANIC", "INDEX_POISONED"].includes(
            response.error.code,
          ))
      ) {
        await this.#kill();
        response.error.workerStopped = true;
        return JSON.stringify(response);
      }
      if (staged && response.ok) {
        // A matching epoch/request success acknowledges that the child has
        // consumed these bytes. Failed/ambiguous loads instead retire the epoch.
        await storage.remove(scope.directory, staged);
        if (expired) throw timeoutError();
        if (scope.cancelled || this.#scope !== scope || this.#epoch !== epoch) {
          throw new NativeIndexFailure(
            "INDEX_CLOSED",
            "Semantic process retired while acknowledging projection",
          );
        }
      }
      return next.value;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true; // latch before kill; work can never win during kill
        void this.#kill().then(
          () =>
            reject(
              new NativeIndexFailure(
                "TIMEOUT",
                "Native request total deadline exceeded",
                true,
              ),
            ),
          () => reject(timeoutError()),
        );
      }, remaining);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      await this.#kill();
      if (expired) {
        throw new NativeIndexFailure(
          "TIMEOUT",
          "Native request total deadline exceeded",
          true,
        );
      }
      throw error instanceof NativeIndexFailure
        ? error
        : parseNativeFailure(error);
    } finally {
      clearTimeout(timer);
      entry.binary = undefined;
    }
  }

  async recycle(_reason?: string): Promise<void> {
    await this.#kill();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      clearTimeout(entry.timer);
      entry.binary = undefined;
      entry.reject(
        new NativeIndexFailure(
          "INDEX_CLOSED",
          "Semantic process closed while queued",
        ),
      );
    }
    this.#queuedBytes = 0;
    this.#closing = (async () => {
      try {
        if (this.#spawning || this.#scope?.staging) {
          await this.#kill();
          return;
        }
        if (this.#child) {
          // FIFO after active operation. A native hang is killed by its own
          // deadline; this close request is also bounded from enqueue time.
          const response = JSON.parse(
            await this.#enqueue(
              JSON.stringify({
                v: NATIVE_INDEX_PROTOCOL,
                requestId: 0,
                operation: { op: "close", storeKey: "" },
              }),
              this.#closeTimeout,
              true,
            ),
          );
          if (!response.ok || response.result?.op !== "close") {
            throw new NativeIndexFailure(
              "OXIGRAPH_ERROR",
              "Missing semantic close acknowledgement",
            );
          }
        }
      } catch (error) {
        // Observed process exit already releases every native store; it is a
        // valid close completion without inventing a native close response.
        if (
          !(error instanceof NativeIndexFailure &&
            error.nativeCode === "INDEX_CLOSED" && error.workerStopped)
        ) throw error;
      } finally {
        await this.#kill();
      }
    })();
    return this.#closing;
  }
}

function parseReferenceLoad(
  value: unknown,
): Extract<NativeIndexOperation, { op: "loadReference" }> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a reference operation");
    }
    const record = value as Record<string, unknown>;
    if (
      record.op !== "loadReference" ||
      Object.keys(record).sort().join(",") !== "build,op,projection"
    ) throw new Error("Reference load accepts only a build and projection pin");
    const build = parseBuildRef(record.build);
    const projection = parseProjectionRef(record.projection);
    if (projection.kind !== "rdf-quads") {
      throw new Error("Expected rdf-quads projection");
    }
    if (projection.artifactDigest !== build.artifactDigest) {
      throw new NativeIndexFailure(
        "INTEGRITY",
        "Projection artifact does not match the pinned build",
      );
    }
    return { op: "loadReference", build, projection };
  } catch (error) {
    if (error instanceof NativeIndexFailure) throw error;
    throw new NativeIndexFailure(
      "INVALID_INPUT",
      error instanceof Error ? error.message : "Malformed projection reference",
    );
  }
}

/** Decode only private data descriptors or immutable references; bytes never
 * cross NDJSON. A reference read is supplied by the configured child host,
 * never a requester-selected filesystem path. The
 * native loadBuild remains the authoritative graph-content parser and verifies
 * the graph/digest before publishing any store state. */
export async function executeSemanticIndexWireOperation(
  operation: NativeIndexWireOperation,
  snapshotDirectory: string,
  executor: NativeSemanticIndexExecutor,
  readPayload: typeof readPrivatePayload = readPrivatePayload,
  readProjection?: (projection: ProjectionRef) => Promise<Uint8Array>,
): Promise<NativeIndexResult> {
  if (operation.op === "loadReference") {
    const { build, projection } = parseReferenceLoad(operation);
    if (!readProjection) {
      throw new NativeIndexFailure(
        "INDEX_UNAVAILABLE",
        "Semantic host has no configured projection reader",
      );
    }
    const quads = await readProjection(projection);
    if (quads.byteLength > MAX_PRIVATE_PAYLOAD_BYTES) {
      throw new NativeIndexFailure(
        "QUERY_LIMIT",
        "Projection exceeds the load byte limit",
      );
    }
    if (await sha256(quads) !== projection.projectionDigest) {
      throw new NativeIndexFailure(
        "INTEGRITY",
        "Stored projection digest does not match the pinned reference",
      );
    }
    const result = await executor.execute({
      op: "load",
      storeKey: buildRefKey(build),
      graphIri: buildGraphIri(build),
      expectedDigest: projection.projectionDigest,
      quads,
    }, { timeoutMs: LOAD_TIMEOUT_MS });
    if (result.op !== "load") {
      throw new NativeIndexFailure(
        "OXIGRAPH_ERROR",
        "Unexpected native load result",
      );
    }
    return { op: "loadReference", quadCount: result.quadCount };
  }
  if (operation.op !== "load") {
    return await executor.execute(operation, { timeoutMs: LOAD_TIMEOUT_MS });
  }
  if (
    "quadsBase64" in operation || "quads" in operation || !operation.payload ||
    !/^urn:ase:build:[0-9a-f]{64}$/.test(operation.graphIri) ||
    !/^[0-9a-f]{64}$/.test(operation.expectedDigest) ||
    operation.payload.digest !== operation.expectedDigest
  ) {
    throw new NativeIndexFailure(
      "INVALID_INPUT",
      "Expected a pinned private projection descriptor",
    );
  }
  const quads = await readPayload(snapshotDirectory, operation.payload);
  return await executor.execute({
    op: "load",
    storeKey: operation.storeKey,
    graphIri: operation.graphIri,
    expectedDigest: operation.expectedDigest,
    quads,
  }, { timeoutMs: LOAD_TIMEOUT_MS });
}

/** Killable host. Only exact installed .node bytes are loaded. Both directions
 * use the shared linear byte-bounded reader and per-process epoch. */
export async function runSemanticIndexHost(
  addonPath: string,
  expectedSha256: string,
  processEpoch: string,
  maxMessageBytes = SEMANTIC_MAX_MESSAGE_BYTES,
  snapshotDirectory?: string,
  buildCachePath?: string,
): Promise<void> {
  if (
    !/^[0-9a-f]{64}$/.test(expectedSha256) || !processEpoch ||
    !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 ||
    maxMessageBytes > 2_147_483_647
  ) throw new Error("Invalid semantic host parameters");
  assertBuildCachePath(buildCachePath);
  if (!snapshotDirectory) {
    throw new NativeAddonSnapshotError(
      new Error("Semantic host requires its parent-owned snapshot directory"),
    );
  }
  const loaded = await loadSemanticIndexAddon(addonPath, expectedSha256, {
    snapshotDirectory,
    snapshotCleanup: "process",
  });
  const store = new loaded.addon.SemanticIndexStore();
  const executor = new InProcessSemanticIndexExecutor(store);
  const writable = Deno.stdout.writable.getWriter();
  const encoder = new TextEncoder();
  let projectionCache: Promise<KvModelBuildStore> | undefined;
  const readProjection = async (
    projection: ProjectionRef,
  ): Promise<Uint8Array> => {
    if (buildCachePath === undefined) {
      throw new NativeIndexFailure(
        "INDEX_UNAVAILABLE",
        "Semantic host requires its parent-configured build cache",
      );
    }
    // The child is a semantic read consumer: no put, lease, sweep or format
    // initialization. KV still needs SQLite filesystem write permission.
    const { KvModelBuildStore, KvModelBuildReadLimitError } = await import(
      "../deno-kv/kv-store.ts"
    );
    projectionCache ??= KvModelBuildStore.open({
      path: buildCachePath,
      existingOnly: true,
    });
    const opening = projectionCache;
    let cache: KvModelBuildStore;
    try {
      cache = await opening;
    } catch (error) {
      // An unavailable store must be retryable after host-owned restoration.
      if (projectionCache === opening) projectionCache = undefined;
      throw error;
    }
    try {
      return await cache.getProjectionBounded(
        projection.kind,
        projection.projectorVersion,
        projection.artifactDigest,
        {
          maxUncompressedBytes: MAX_PRIVATE_PAYLOAD_BYTES,
          maxCompressedBytes: MAX_PRIVATE_PAYLOAD_BYTES + 1024 * 1024,
        },
      );
    } catch (error) {
      if (error instanceof KvModelBuildReadLimitError) {
        throw new NativeIndexFailure(
          "QUERY_LIMIT",
          error.message,
          false,
          error.context,
        );
      }
      throw error;
    }
  };
  try {
    for await (
      const line of readBoundedLines(
        Deno.stdin.readable,
        Math.min(maxMessageBytes, SEMANTIC_MAX_CONTROL_BYTES),
        semanticMessageSizeError,
      )
    ) {
      const envelope = JSON.parse(line) as NativeIndexEnvelope;
      if (
        envelope.v !== NATIVE_INDEX_PROTOCOL ||
        envelope.processEpoch !== processEpoch ||
        !Number.isSafeInteger(envelope.requestId) || envelope.requestId < 0 ||
        !envelope.operation ||
        !["load", "loadReference", "query", "has", "release", "close"].includes(
          envelope.operation.op,
        )
      ) {
        throw new Error("Invalid semantic request envelope");
      }
      let response: NativeIndexResponse;
      try {
        const result = await executeSemanticIndexWireOperation(
          envelope.operation,
          snapshotDirectory,
          executor,
          readPrivatePayload,
          readProjection,
        );
        response = {
          v: NATIVE_INDEX_PROTOCOL,
          requestId: envelope.requestId,
          ok: true,
          result,
        };
      } catch (error) {
        const failure = parseNativeFailure(error);
        response = {
          v: NATIVE_INDEX_PROTOCOL,
          requestId: envelope.requestId,
          ok: false,
          error: {
            code: failure.nativeCode,
            message: failure.message,
            ...(failure.context === undefined
              ? {}
              : { context: failure.context }),
          },
        };
      }
      const payload = encoder.encode(
        `${JSON.stringify({ ...response, processEpoch })}\n`,
      );
      if (payload.byteLength > maxMessageBytes) {
        throw new Error("Semantic response exceeds frame limit");
      }
      await writable.write(payload);
      if (envelope.operation.op === "close") break;
    }
  } finally {
    try {
      store.close();
    } finally {
      try {
        await (await projectionCache?.catch(() => undefined))?.close();
      } finally {
        await loaded.close();
        writable.releaseLock();
      }
    }
  }
}

if (import.meta.main) {
  const [
    addonPath,
    expectedSha256,
    epoch,
    maxBytes,
    snapshotDirectory,
    buildCachePath,
  ] = Deno.args;
  if (!addonPath || !expectedSha256 || !epoch || !snapshotDirectory) {
    throw new Error(
      "Usage: deno run oxigraph-native.ts <addon.node> <sha256> <epoch> <maxBytes> <private-snapshot-directory> [build-cache-path]",
    );
  }
  await runSemanticIndexHost(
    addonPath,
    expectedSha256,
    epoch,
    maxBytes ? Number(maxBytes) : undefined,
    snapshotDirectory,
    buildCachePath,
  );
}
