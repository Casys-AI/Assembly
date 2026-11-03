/** Bounded preparation lane, independent from the native query process.
 * Only descriptor/reference JSON enters this scheduler; RDF never does. */
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticIndexError } from "../../../application/model/semantic/index-service.ts";
import {
  type PreparedSemanticProjection,
  type SemanticProjectionPreparationInput,
  snapshotSemanticPreparationInput,
} from "./preparation.ts";
import {
  encodeSemanticPreparationControl,
  parseSemanticPreparationResponse,
  readSemanticPreparationControl,
  type SemanticPreparationFailure,
  type SemanticPreparationResponse,
} from "./protocol.ts";
import {
  createIsolatedWorkerRunner,
  type IsolatedWorkerEndpoint,
  type IsolatedWorkerRequest,
  ProjectionQueueUnavailable,
  SysmlToolkitTimeoutError,
  SysmlToolkitWorkerClosedError,
  SysmlToolkitWorkerError,
  validateToolkitTimeout,
} from "../sysml-toolkit/worker-client.ts";

export const SEMANTIC_PREPARATION_TIMEOUT_MS = 60_000;
export const SEMANTIC_PREPARATION_MAX_QUEUED = 3;
export const SEMANTIC_PREPARATION_HEAP_MIB = 2048;
const applicationDirectory = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const defaultProcessUrl = new URL(
  "./process.ts",
  import.meta.url,
);

export interface SemanticProjectionProcessObserver {
  onSpawn?(info: { pid: number; heapLimitMiB: number }): void;
  onExit?(info: { pid: number; code: number; signal: string | null }): void;
  onControl?(info: { direction: "request" | "response"; bytes: number }): void;
}
export interface SemanticProjectionProcessClientOptions {
  readonly cachePath: string;
  readonly vaultDirectory: string;
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
  readonly observer?: SemanticProjectionProcessObserver;
  /** Integration fixture seam; production uses the fixed process entry. */
  readonly processUrl?: URL;
  /** Unit fixture seam for the actual bounded scheduler. */
  readonly createWorker?: (url: URL) => IsolatedWorkerEndpoint;
}
interface QueuedPreparation {
  readonly input: SemanticProjectionPreparationInput;
}
interface ProcessConfiguration {
  readonly cachePath: string;
  readonly vaultDirectory: string;
  readonly observer?: SemanticProjectionProcessObserver;
}

function observe(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch { /* Observation cannot change process ownership. */ }
}

class SemanticPreparationProcessEndpoint extends EventEmitter
  implements IsolatedWorkerEndpoint {
  #child?: Deno.ChildProcess;
  #task?: Promise<void>;
  #terminated = false;
  constructor(
    private readonly entry: URL,
    private readonly configuration: ProcessConfiguration,
  ) {
    super();
  }
  ref() {
    this.#child?.ref();
  }
  unref() {
    this.#child?.unref();
  }
  postMessage(message: unknown): void {
    const request = message as IsolatedWorkerRequest<QueuedPreparation>;
    this.#task = this.#execute(request).catch((error) => {
      if (this.#terminated) return;
      this.emit("message", {
        id: request.id,
        kind: "result",
        ok: false,
        reusable: false,
        error: {
          code: "INDEX_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
          diagnostics: [],
        },
      });
    });
  }
  async #execute(
    request: IsolatedWorkerRequest<QueuedPreparation>,
  ): Promise<void> {
    if (this.#terminated) return;
    const payload = encodeSemanticPreparationControl({
      v: 1,
      id: request.id,
      input: request.request.input,
    });
    const { cachePath, vaultDirectory, observer } = this.configuration;
    const cacheDirectory = dirname(cachePath);
    const child = this.#child = new Deno.Command(Deno.execPath(), {
      cwd: applicationDirectory,
      env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
      args: [
        "run",
        "--no-prompt",
        "--quiet",
        "--cached-only",
        "--frozen",
        `--v8-flags=--max-old-space-size=${SEMANTIC_PREPARATION_HEAP_MIB}`,
        `--allow-read=${
          [applicationDirectory, cacheDirectory, vaultDirectory].join(",")
        }`,
        // Deno KV checks this exact database path and manages its SQLite/WAL
        // files internally. Granting the parent directory would expose the vault.
        `--allow-write=${cachePath}`,
        "--allow-env=READABLE_STREAM",
        "--unstable-kv",
        fileURLToPath(this.entry),
        cachePath,
        vaultDirectory,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    observe(() =>
      observer?.onSpawn?.({
        pid: child.pid,
        heapLimitMiB: SEMANTIC_PREPARATION_HEAP_MIB,
      })
    );
    this.emit("message", { id: request.id, kind: "started" });
    const output = readSemanticPreparationControl(child.stdout);
    const errors = readSemanticPreparationControl(child.stderr);
    // Observe stream failures immediately; Promise.all below kills and observes
    // the child if a control stream exceeds its bound or closes unexpectedly.
    const input = (async () => {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(payload);
        await writer.close();
        observe(() =>
          observer?.onControl?.({
            direction: "request",
            bytes: payload.byteLength,
          })
        );
      } finally {
        writer.releaseLock();
      }
    })();
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        output,
        errors,
        input,
      ]);
      if (this.#terminated) return;
      if (!status.success) {
        throw new Error(
          `Semantic preparation child exited ${status.code}${
            status.signal ? ` (${status.signal})` : ""
          }: ${stderr.slice(-1000)}`,
        );
      }
      const response = parseSemanticPreparationResponse(
        JSON.parse(stdout),
        request.id,
      );
      observe(() =>
        observer?.onControl?.({
          direction: "response",
          bytes: new TextEncoder().encode(stdout).byteLength,
        })
      );
      // The scheduler carries the complete coded result, so context/recovery
      // survive its Toolkit error flattening. Its lifetime remains bounded.
      this.emit("message", {
        id: request.id,
        kind: "result",
        ok: true,
        result: response,
        reusable: false,
      });
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* Already exited. */ }
      const status = await child.status;
      await Promise.allSettled([output, errors, input]);
      observe(() =>
        observer?.onExit?.({
          pid: child.pid,
          code: status.code,
          signal: status.signal,
        })
      );
    }
  }
  async terminate(): Promise<number> {
    this.#terminated = true;
    try {
      this.#child?.kill("SIGKILL");
    } catch { /* Already exited. */ }
    await this.#task;
    return this.#child ? (await this.#child.status).code : 0;
  }
}

/** Coded worker failure retains the existing error family, detail and recovery.
 * The constructor identity is intentionally local to this process boundary. */
export class SemanticProjectionProcessError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly recovery: string;
  constructor(failure: SemanticPreparationFailure) {
    super(failure.message);
    this.name = "SemanticProjectionProcessError";
    this.code = failure.code;
    this.context = failure.context;
    this.recovery = failure.recovery;
  }
}

export class SemanticProjectionProcessClient {
  readonly #run: ReturnType<
    typeof createIsolatedWorkerRunner<QueuedPreparation>
  >;
  readonly #timeoutMs: number;
  readonly #processUrl: URL;
  #closed = false;
  constructor(options: SemanticProjectionProcessClientOptions) {
    if (!options.cachePath || !options.vaultDirectory) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        {},
        "Semantic preparation requires host storage paths",
      );
    }
    this.#timeoutMs = options.timeoutMs ?? SEMANTIC_PREPARATION_TIMEOUT_MS;
    validateToolkitTimeout(this.#timeoutMs);
    const configuration: ProcessConfiguration = {
      cachePath: resolve(options.cachePath),
      vaultDirectory: resolve(options.vaultDirectory),
      observer: options.observer,
    };
    // Deno permission lists are comma-separated; reject ambiguous host paths.
    if (
      [
        configuration.cachePath,
        configuration.vaultDirectory,
        applicationDirectory,
      ].some((path) => /[,\0\r\n]/.test(path))
    ) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        {},
        "Storage paths cannot contain permission separators",
      );
    }
    this.#processUrl = options.processUrl ?? defaultProcessUrl;
    this.#run = createIsolatedWorkerRunner<QueuedPreparation>({
      isProjection: () => true,
      maxOperationsPerWorker: 1,
      maxQueued: options.maxQueued ?? SEMANTIC_PREPARATION_MAX_QUEUED,
      projectionExecutionMs: this.#timeoutMs,
      createWorker: options.createWorker ??
        ((url) => new SemanticPreparationProcessEndpoint(url, configuration)),
    });
  }
  async prepare(
    input: SemanticProjectionPreparationInput,
  ): Promise<PreparedSemanticProjection> {
    if (this.#closed) {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Semantic preparation is closed",
      );
    }
    const snapshot = snapshotSemanticPreparationInput(input);
    // Reject large descriptor strings before admission rather than retaining
    // an unbounded object in the waiting queue.
    encodeSemanticPreparationControl({ v: 1, id: 1, input: snapshot });
    try {
      const response = await this.#run<SemanticPreparationResponse>(
        applicationDirectory,
        { input: snapshot },
        this.#timeoutMs,
        this.#processUrl,
      );
      // The scheduler clears its active request before awaiting retirement.
      // close() during that interval must still defeat a previously received
      // success, while the runner retains ownership until actual exit.
      if (this.#closed) {
        throw new SemanticIndexError(
          "INDEX_UNAVAILABLE",
          {},
          "Semantic preparation is closed",
        );
      }
      if (!response.ok) {
        throw new SemanticProjectionProcessError(response.error);
      }
      if (
        response.projection.artifactDigest !== snapshot.build.artifactDigest ||
        response.projection.kind !== "rdf-quads"
      ) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          {},
          "Preparation response changed the pinned artifact",
        );
      }
      return { projection: response.projection };
    } catch (error) {
      if (error instanceof SysmlToolkitTimeoutError) {
        throw new SemanticIndexError("INDEX_TIMEOUT", {
          timeoutMs: error.timeoutMs,
          started: error.started,
        }, "Semantic preparation exceeded its total deadline");
      }
      if (error instanceof ProjectionQueueUnavailable) {
        throw new SemanticIndexError(
          "INDEX_BUSY",
          error.context,
          "Semantic preparation queue is full",
        );
      }
      if (
        error instanceof SysmlToolkitWorkerClosedError ||
        error instanceof SysmlToolkitWorkerError
      ) {
        throw new SemanticIndexError("INDEX_UNAVAILABLE", {}, error.message);
      }
      throw error;
    }
  }
  close(): Promise<void> {
    this.#closed = true;
    return this.#run.close();
  }
  stats() {
    return this.#run.stats();
  }
}
