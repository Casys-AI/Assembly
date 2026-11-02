/** Bounded child-process endpoint for the native Toolkit runtime.
 *
 * The parent (HTTP/SSE) never loads the .node addon. A Deno child process
 * hosts it and speaks versioned NDJSON request/response envelopes carrying a
 * per-spawn processEpoch. This endpoint presents the existing
 * IsolatedWorkerEndpoint shape to the shared scheduler: deadlines, lane
 * priorities, queue bounds and recycling stay the scheduler's business.
 * Termination is real: terminate() resolves only after the child status has
 * been observed, so a waited-out deadline is never confused with a finished
 * cancellation.
 */
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessEpoch } from "../../adapters/out/sysml-toolkit/runtime/native-addon.ts";
import type {
  IsolatedWorkerEndpoint,
  IsolatedWorkerRequest,
  ToolkitWorkerOperation,
  ToolkitWorkerResponse,
} from "../../adapters/out/sysml-toolkit/worker-client.ts";
import {
  type ToolkitBundlePin,
  ToolkitNativeSnapshotError,
} from "../../adapters/out/sysml-toolkit/runtime/loader.ts";
import type { ModelToolingDiagnostic } from "../../domain/model/editing/tooling.ts";

export const NATIVE_PROCESS_PROTOCOL_VERSION = 1;
export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const TERMINATE_GRACE_MS = 250;

export interface NativeProcessRequestEnvelope {
  v: typeof NATIVE_PROCESS_PROTOCOL_VERSION;
  kind: "request";
  id: number;
  processEpoch: string;
  packageDir: string;
  bundle?: ToolkitBundlePin;
  request: ToolkitWorkerOperation;
}

export type NativeProcessResponseEnvelope =
  | {
    v: typeof NATIVE_PROCESS_PROTOCOL_VERSION;
    kind: "hello";
    processEpoch: string;
    pid: number;
  }
  | {
    v: typeof NATIVE_PROCESS_PROTOCOL_VERSION;
    kind: "started";
    id: number;
    processEpoch: string;
  }
  | {
    v: typeof NATIVE_PROCESS_PROTOCOL_VERSION;
    kind: "result";
    id: number;
    processEpoch: string;
    ok: true;
    result: unknown;
    reusable?: boolean;
  }
  | {
    v: typeof NATIVE_PROCESS_PROTOCOL_VERSION;
    kind: "result";
    id: number;
    processEpoch: string;
    ok: false;
    reusable?: boolean;
    error: { message: string; code?: string; diagnostics: unknown[] };
  };

export interface NativeChildStatus {
  success: boolean;
  code: number;
  signal: string | null;
}

/** Minimal child seam; Deno.ChildProcess satisfies it. Tests inject fakes. */
export interface NativeProcessChild {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<NativeChildStatus>;
  kill(signo?: string): void;
  ref(): void;
  unref(): void;
}

export interface NativeChildSpawnInfo {
  entryPath: string;
  appRoot: string;
  packageDir: string;
  processEpoch: string;
  /** Parent-owned directory unique to this endpoint; never taken from NDJSON. */
  snapshotDirectory: string;
}

export type SpawnNativeChild = (
  info: NativeChildSpawnInfo,
) => Promise<NativeProcessChild> | NativeProcessChild;

export interface NativeProcessEndpointOptions {
  spawnChild?: SpawnNativeChild;
  maxMessageBytes?: number;
  terminateGraceMs?: number;
  /** Filesystem seam for process lifecycle tests, without granting test writes. */
  snapshotStorage?: {
    create(appRoot: string, processEpoch: string): Promise<string>;
    remove(directory: string): Promise<void>;
  };
}

function coded(error: Error, code: string): Error {
  return Object.assign(error, { code });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Incremental byte-bounded line reader shared by client and child host. */
export async function* readBoundedLines(
  stream: ReadableStream<Uint8Array>,
  maxLineBytes: number,
  sizeError: () => Error = () =>
    coded(
      new Error("Native toolkit process message exceeds its size limit"),
      "TOOLKIT_MESSAGE_TOO_LARGE",
    ),
): AsyncGenerator<string> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(Math.min(65_536, Math.max(1, maxLineBytes)));
  let buffered = 0;
  const append = (part: Uint8Array) => {
    const required = buffered + part.length;
    if (required > maxLineBytes) {
      throw sizeError();
    }
    if (required > buffer.length) {
      const grown = new Uint8Array(
        Math.min(maxLineBytes, Math.max(required, buffer.length * 2)),
      );
      grown.set(buffer.subarray(0, buffered));
      buffer = grown;
    }
    buffer.set(part, buffered);
    buffered = required;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (;;) {
        // Scan only the new chunk. Rejoining the whole pending frame on each
        // read made large compiled artifacts quadratic in bytes copied.
        const newline = value.indexOf(0x0a, start);
        if (newline === -1) {
          append(value.subarray(start));
          break;
        }
        append(value.subarray(start, newline));
        if (buffered > 0) yield decoder.decode(buffer.subarray(0, buffered));
        buffered = 0;
        start = newline + 1;
        if (start === value.length) break;
      }
    }
    if (buffered > 0) yield decoder.decode(buffer.subarray(0, buffered));
  } finally {
    try {
      await reader.cancel();
    } catch { /* Stream already closed. */ }
    reader.releaseLock();
  }
}

/** Permissions authorize the private copy, never the installation's .node. */
export function nativeProcessCommandArgs(
  info: NativeChildSpawnInfo,
  realPackage = resolve(info.packageDir),
): string[] {
  return [
    "run",
    "--no-prompt",
    "--quiet",
    `--allow-read=${info.appRoot},${
      resolve(info.packageDir)
    },${realPackage},${info.snapshotDirectory}`,
    `--allow-write=${info.snapshotDirectory}`,
    `--allow-ffi=${info.snapshotDirectory},${info.appRoot}/node_modules`,
    info.entryPath,
    `--epoch=${info.processEpoch}`,
    `--snapshot-dir=${info.snapshotDirectory}`,
  ];
}

const snapshotOwners = new Map<string, Deno.FsFile>();

async function sweepSnapshots(toolchains: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(toolchains)) {
      if (!entry.isDirectory || !entry.name.startsWith("toolkit-process-")) {
        continue;
      }
      const directory = `${toolchains}/${entry.name}`;
      let owner: Deno.FsFile | undefined;
      try {
        owner = await Deno.open(`${directory}/owner.lock`, {
          read: true,
          write: true,
        });
        if (owner.tryLockSync(true)) {
          await Deno.remove(directory, { recursive: true });
        }
      } catch {
        /* A concurrent cleanup or inaccessible copy is harmless. */
      } finally {
        owner?.close();
      }
    }
  } catch { /* Sweeping must not prevent a new snapshot. */ }
}

export const defaultSnapshotStorage = {
  async create(appRoot: string, processEpoch: string): Promise<string> {
    const toolchains = `${appRoot}/.data/toolchains`;
    await sweepSnapshots(toolchains);
    let directory: string | undefined;
    let owner: Deno.FsFile | undefined;
    let locked = false;
    try {
      for (;;) {
        directory = await Deno.makeTempDir({
          dir: toolchains,
          prefix: `toolkit-process-${processEpoch}-`,
        });
        try {
          owner = await Deno.open(`${directory}/owner.lock`, {
            create: true,
            read: true,
            write: true,
          });
          await owner.lock(true);
          locked = true;
          await Deno.stat(directory);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          owner?.close();
          owner = undefined;
          locked = false;
          continue;
        }
        await Deno.chmod(directory, 0o700);
        snapshotOwners.set(directory, owner);
        owner = undefined;
        return directory;
      }
    } catch (error) {
      if (directory) {
        try {
          await Deno.remove(directory, { recursive: true });
        } catch (cleanupError) {
          if (
            owner && locked && !(cleanupError instanceof Deno.errors.NotFound)
          ) {
            snapshotOwners.set(directory, owner);
            owner = undefined;
          }
        }
      }
      throw new ToolkitNativeSnapshotError(error);
    } finally {
      owner?.close();
    }
  },
  async remove(directory: string): Promise<void> {
    try {
      await Deno.remove(directory, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    snapshotOwners.get(directory)?.close();
    snapshotOwners.delete(directory);
  },
};

async function defaultSpawn(
  info: NativeChildSpawnInfo,
): Promise<NativeProcessChild> {
  let realPackage = resolve(info.packageDir);
  try {
    realPackage = await Deno.realPath(realPackage);
  } catch { /* The child loader reports a missing package in its own terms. */ }
  const child = new Deno.Command(Deno.execPath(), {
    cwd: info.appRoot,
    args: nativeProcessCommandArgs(info, realPackage),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return child as NativeProcessChild;
}

/** One spawned process per endpoint instance; it owns its native sessions. */
export class NativeProcessEndpoint extends EventEmitter
  implements IsolatedWorkerEndpoint {
  readonly processEpoch = createProcessEpoch();
  #child?: NativeProcessChild;
  #spawning?: Promise<NativeProcessChild>;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #helloSeen = false;
  #failed = false;
  #terminating?: Promise<number>;
  #unrefWhenSpawned = false;
  #stderrTail = "";
  #readTask?: Promise<void>;
  #snapshotCleanup?: Promise<void>;
  #exitObserved?: Promise<NativeChildStatus>;
  pid?: number;

  constructor(
    private readonly entryUrl: URL,
    private readonly options: NativeProcessEndpointOptions = {},
  ) {
    super();
  }

  ref(): this {
    this.#unrefWhenSpawned = false;
    this.#child?.ref();
    return this;
  }

  unref(): this {
    this.#unrefWhenSpawned = true;
    this.#child?.unref();
    return this;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  postMessage(value: unknown): void {
    if (this.#terminating || this.#failed) {
      throw coded(
        new Error("Native toolkit process endpoint is closed"),
        "TOOLKIT_WORKER_UNAVAILABLE",
      );
    }
    const message = value as IsolatedWorkerRequest<ToolkitWorkerOperation>;
    const envelope: NativeProcessRequestEnvelope = {
      v: NATIVE_PROCESS_PROTOCOL_VERSION,
      kind: "request",
      id: message.id,
      processEpoch: this.processEpoch,
      packageDir: message.packageDir,
      ...(message.bundle ? { bundle: message.bundle } : {}),
      request: message.request,
    };
    const line = `${JSON.stringify(envelope)}\n`;
    const bytes = encoder.encode(line);
    const limit = this.options.maxMessageBytes ?? MAX_NATIVE_MESSAGE_BYTES;
    if (bytes.length > limit) {
      throw coded(
        new Error("Native toolkit request exceeds its size limit"),
        "TOOLKIT_MESSAGE_TOO_LARGE",
      );
    }
    void this.#send(message.packageDir, bytes).catch((error) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async #send(packageDir: string, bytes: Uint8Array): Promise<void> {
    const child = await this.#ensureChild(packageDir);
    if (this.#terminating || this.#failed) return;
    this.#writer ??= child.stdin.getWriter();
    await this.#writer.write(bytes as Uint8Array<ArrayBuffer>);
  }

  #ensureChild(packageDir: string): Promise<NativeProcessChild> {
    if (this.#child) return Promise.resolve(this.#child);
    this.#spawning ??= (async () => {
      const spawn = this.options.spawnChild ?? defaultSpawn;
      const entryPath = fileURLToPath(this.entryUrl);
      const appRoot = fileURLToPath(new URL("../../../../", this.entryUrl));
      const storage = this.options.snapshotStorage ?? defaultSnapshotStorage;
      const snapshotDirectory = await storage.create(
        appRoot,
        this.processEpoch,
      );
      let child: NativeProcessChild;
      try {
        child = await spawn({
          entryPath,
          appRoot,
          packageDir,
          processEpoch: this.processEpoch,
          snapshotDirectory,
        });
      } catch (error) {
        await storage.remove(snapshotDirectory);
        throw error;
      }
      this.#child = child;
      this.pid = child.pid;
      if (this.#unrefWhenSpawned) child.unref();
      this.#readTask = this.#readLoop(child);
      this.#exitObserved = child.status.then(async (status) => {
        // Neither a signal nor a deadline proves exit. Retain even a hung
        // child's binary until the actual OS status acknowledges termination.
        this.#snapshotCleanup ??= storage.remove(snapshotDirectory);
        await this.#snapshotCleanup;
        if (!this.#failed) this.emit("exit");
        return status;
      });
      void this.#exitObserved.catch((error) => {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      });
      return child;
    })();
    return this.#spawning;
  }

  async #readLoop(child: NativeProcessChild): Promise<void> {
    const drainStderr = (async () => {
      const reader = child.stderr.getReader();
      const text = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.#stderrTail = (
            this.#stderrTail + text.decode(value, { stream: true })
          ).slice(-STDERR_TAIL_BYTES);
        }
      } catch {
        /* Diagnostics only. */
      } finally {
        reader.releaseLock();
      }
    })();
    try {
      const limit = this.options.maxMessageBytes ?? MAX_NATIVE_MESSAGE_BYTES;
      for await (const line of readBoundedLines(child.stdout, limit)) {
        if (this.#failed) return;
        this.#acceptLine(line);
        if (this.#failed) return;
      }
    } catch (error) {
      if (!this.#terminating) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      await drainStderr.catch(() => undefined);
    }
  }

  #acceptLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#fail(this.#protocolError("malformed JSON line"));
      return;
    }
    const record = parsed as Record<string, unknown> | null;
    if (
      !record || typeof record !== "object" ||
      record.v !== NATIVE_PROCESS_PROTOCOL_VERSION ||
      record.processEpoch !== this.processEpoch ||
      typeof record.kind !== "string"
    ) {
      // A response from another epoch (or an unversioned peer) is never
      // delivered to the scheduler; the process is retired instead.
      this.#fail(
        this.#protocolError("unexpected protocol version or process epoch"),
      );
      return;
    }
    if (!this.#helloSeen) {
      if (record.kind !== "hello" || !Number.isSafeInteger(record.pid)) {
        this.#fail(this.#protocolError("missing hello handshake"));
        return;
      }
      this.#helloSeen = true;
      this.pid = Number(record.pid);
      return;
    }
    if (record.kind === "started" && Number.isSafeInteger(record.id)) {
      const response: ToolkitWorkerResponse = {
        id: Number(record.id),
        kind: "started",
      };
      this.emit("message", response);
      return;
    }
    if (
      record.kind === "result" && Number.isSafeInteger(record.id) &&
      typeof record.ok === "boolean"
    ) {
      const response: ToolkitWorkerResponse = record.ok
        ? {
          id: Number(record.id),
          kind: "result",
          ok: true,
          result: record.result,
          ...(typeof record.reusable === "boolean"
            ? { reusable: record.reusable }
            : {}),
        }
        : {
          id: Number(record.id),
          kind: "result",
          ok: false,
          ...(typeof record.reusable === "boolean"
            ? { reusable: record.reusable }
            : {}),
          error: normalizeError(record.error),
        };
      this.emit("message", response);
      return;
    }
    this.#fail(this.#protocolError("unknown or malformed response envelope"));
  }

  #protocolError(detail: string): Error {
    const tail = this.#stderrTail.trim();
    return coded(
      new Error(
        `Native toolkit process protocol failure: ${detail}${
          tail ? `: ${tail.slice(-512)}` : ""
        }`,
      ),
      "TOOLKIT_WORKER_UNAVAILABLE",
    );
  }

  #fail(error: Error): void {
    if (this.#failed || this.#terminating) return;
    this.#failed = true;
    this.emit("error", error);
  }

  terminate(): Promise<number> {
    this.#terminating ??= this.#terminate();
    return this.#terminating;
  }

  async #terminate(): Promise<number> {
    let child = this.#child;
    if (!child && this.#spawning) {
      child = await this.#spawning.catch(() => undefined);
    }
    if (!child) return 0;
    // Closing queues behind pending writes, which can remain blocked if the
    // child stops reading stdin. Start pipe cleanup without delaying either
    // termination signal; only the observed child status acknowledges exit.
    void this.#writer?.close().catch(() => undefined);
    const grace = this.options.terminateGraceMs ?? TERMINATE_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const escalate = new Promise<undefined>((resolveTimer) => {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* Already exited. */ }
        resolveTimer(undefined);
      }, grace);
    });
    try {
      child.kill("SIGTERM");
    } catch { /* Already exited. */ }
    // The status observation is the termination acknowledgement; the grace
    // timer only escalates the signal, it never settles termination itself.
    let status: NativeChildStatus;
    try {
      status = await Promise.race([
        this.#exitObserved ?? child.status,
        escalate.then(() => this.#exitObserved ?? child.status),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await this.#readTask?.catch(() => undefined);
    return status.code;
  }
}

function normalizeError(value: unknown): {
  message: string;
  code?: string;
  diagnostics: ModelToolingDiagnostic[];
} {
  const record = value as Record<string, unknown> | null;
  return {
    message: typeof record?.message === "string"
      ? record.message
      : "Native toolkit process failed",
    ...(typeof record?.code === "string" ? { code: record.code } : {}),
    diagnostics: Array.isArray(record?.diagnostics)
      ? record.diagnostics as ModelToolingDiagnostic[]
      : [],
  };
}

export function createNativeProcessEndpoint(
  entryUrl: URL,
  options: NativeProcessEndpointOptions = {},
): NativeProcessEndpoint {
  return new NativeProcessEndpoint(entryUrl, options);
}
