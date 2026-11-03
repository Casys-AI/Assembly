import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { ModelRepositoryPort } from "../../../../../application/model/repository.ts";
import type {
  ModelRevision,
  ModelRevisionHeader,
} from "../../../../../domain/model/records/revision.ts";
import type { AuthorityMatrix } from "../../../../../domain/governance/records/authority-matrix.ts";
import type {
  AuthorityMatrixArtifact,
  AuthorityMatrixProjectionInput,
} from "./projection.ts";
import {
  createIsolatedWorkerRunner,
  type IsolatedWorkerEndpoint,
  type IsolatedWorkerRequest,
  SYSML_TOOLKIT_TIMEOUT_MS,
  SysmlToolkitWorkerError,
} from "../../worker-client.ts";
import {
  ProjectionJsonInputError,
  writeProjectionJson,
} from "../../../../../infrastructure/projection-json-stream.ts";

export const MATRIX_WORKER_MAX_OPERATIONS = 1;
export const MATRIX_PROCESS_HEAP_MIB = 512;
export const MATRIX_MAX_QUEUED = 3;
/** The lane owns a disposable OS process, so a slow projection cannot delay
 * authoring work. Measured wall time per projection (child start, executable
 * validation, projection): 0.7-1.9 s for the initial model, about 3.1 s for the
 * three-unit commercial-watch example under moderate load. The 3 s Toolkit
 * read-projection ceiling would time out ordinary models; stay under the 15 s
 * total budget. */
export const MATRIX_EXECUTION_MS = 10_000;
/** Independent identity read from the immutable source blobs by header(), never
 * an artifact echo. The sources themselves stay out of the process input. */
export type AuthorityMatrixArtifactPin = Pick<
  ModelRevisionHeader,
  "version" | "sourceDigest"
>;
export interface AuthorityMatrixProcessInput {
  revision: AuthorityMatrixArtifact;
  projectId: string;
  pin: AuthorityMatrixArtifactPin;
  units?: AuthorityMatrixProjectionInput["units"];
  name?: string;
}
export type AuthorityMatrixWorkerOperation = AuthorityMatrixProcessInput & {
  operation: "authority-matrix";
};
export interface MatrixProcessObserver {
  onSpawn?(info: { pid: number; heapLimitMiB: number }): void;
  onExit?(info: { pid: number; code: number; signal: string | null }): void;
  onPrepared?(
    stats: { bytes: number; yields: number; maxSliceMs: number },
  ): void;
  onUsage?(
    usage: {
      pid: number;
      heapSizeLimit: number;
      maxRssBytes: number;
      samples: { phase: string; rss: number; heapUsed: number }[];
    },
  ): void;
}
interface QueuedProjection {
  operation: "authority-matrix";
  version: string;
  load(signal?: AbortSignal): Promise<AuthorityMatrixProcessInput>;
  observer?: MatrixProcessObserver;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.length;
      if (bytes > limit) {
        throw new Error("Projection process output exceeds limit");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** After a failed artifact write the child may still be running (it closed its
 * input early) or may already be gone. Give it this long to report its own exit
 * before it is killed. */
const CHILD_EXIT_GRACE_MS = 1_000;

/** One mapping from a thrown value to the runner's coded failure, shared by the
 * endpoint and by the caller that restores the original load error. */
function codedFailure(error: unknown): { code: string; message: string } {
  return {
    code: error && typeof error === "object" && "code" in error &&
        typeof error.code === "string"
      ? error.code
      : "PROJECTION_PROCESS_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The existing bounded scheduler owns this process endpoint exactly like its
 * Toolkit worker. Only tiny version/load closures are queued. All preparation
 * is incremental, after dispatch; the child owns parse/validation/projection. */
class MatrixProcessEndpoint extends EventEmitter
  implements IsolatedWorkerEndpoint {
  #child?: Deno.ChildProcess;
  #task?: Promise<void>;
  #abort = new AbortController();
  constructor(private readonly url: URL) {
    super();
  }
  ref() {
    this.#child?.ref();
  }
  unref() {
    this.#child?.unref();
  }
  postMessage(value: unknown): void {
    const message = value as IsolatedWorkerRequest<QueuedProjection>;
    this.emit("message", { id: message.id, kind: "started" });
    this.#task = this.execute(message).catch((error) => {
      if (!this.#abort.signal.aborted) {
        this.emit("message", {
          id: message.id,
          kind: "result",
          ok: false,
          reusable: false,
          error: { ...codedFailure(error), diagnostics: [] },
        });
      }
    });
  }
  async execute(
    { id, packageDir, request }: IsolatedWorkerRequest<QueuedProjection>,
  ): Promise<void> {
    const signal = this.#abort.signal;
    let stopLoad!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      stopLoad = () => reject(signal.reason);
      signal.addEventListener("abort", stopLoad, { once: true });
    });
    let job: AuthorityMatrixProcessInput | undefined;
    try {
      job = await Promise.race([request.load(signal), aborted]);
    } finally {
      signal.removeEventListener("abort", stopLoad);
    }
    if (this.#abort.signal.aborted) return;
    if (job.revision.elements.length > 20_000) {
      this.emit("message", {
        id,
        kind: "result",
        ok: false,
        reusable: false,
        error: {
          code: "INVALID_PROJECTION_INPUT",
          message: "Artifact exceeds 20000 elements",
          diagnostics: [],
        },
      });
      return;
    }
    const child = this.#child = new Deno.Command(Deno.execPath(), {
      // The application directory holds deno.json: the child resolves its
      // imports from there whatever the host's working directory is.
      cwd: packageDir,
      // The legacy executable validator hashes transient lists with default ICU
      // collation. Keep that dependency deterministic without modifying it.
      env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
      args: [
        "run",
        "--no-prompt",
        "--quiet",
        `--v8-flags=--max-old-space-size=${MATRIX_PROCESS_HEAP_MIB}`,
        "--allow-read",
        "--allow-env",
        fileURLToPath(this.url),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    request.observer?.onSpawn?.({
      pid: child.pid,
      heapLimitMiB: MATRIX_PROCESS_HEAP_MIB,
    });
    const output = readBounded(child.stdout, 8 * 1024 * 1024);
    const errors = readBounded(child.stderr, 64 * 1024);
    // Attach rejection handlers now, before asynchronous input production.
    void output.catch(() => undefined);
    void errors.catch(() => undefined);
    let preparationError: unknown;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const {
        version,
        sourceDigest,
        engineVersion,
        provenanceDigest,
        provider,
        sources,
        elements,
      } = job.revision;
      const stats = await writeProjectionJson(child.stdin, {
        ...job,
        revision: {
          version,
          sourceDigest,
          engineVersion,
          provenanceDigest,
          provider,
          sources,
          elements,
        },
      }, { signal: this.#abort.signal });
      request.observer?.onPrepared?.(stats);
      await child.stdin.close();
    } catch (error) {
      preparationError = error;
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch { /* Already exited. */ }
      };
      if (error instanceof ProjectionJsonInputError || signal.aborted) {
        // The artifact itself was refused, or the deadline fired: nothing the
        // child could say matters.
        kill();
      } else {
        // An I/O failure (EPIPE) usually means the child died before reading its
        // input. Its exit status and stderr explain why; keep them.
        graceTimer = setTimeout(kill, CHILD_EXIT_GRACE_MS);
      }
    }
    // Release the artifact reference before collecting the result.
    job = undefined;
    const status = await child.status;
    clearTimeout(graceTimer);
    request.observer?.onExit?.({
      pid: child.pid,
      code: status.code,
      signal: status.signal,
    });
    const [stdout, stderr] = await Promise.all([output, errors]);
    if (this.#abort.signal.aborted) return;
    if (preparationError instanceof ProjectionJsonInputError) {
      this.emit("message", {
        id,
        kind: "result",
        ok: false,
        reusable: false,
        error: { ...codedFailure(preparationError), diagnostics: [] },
      });
      return;
    }
    if (preparationError || !status.success) {
      // The same code and detail whatever the payload size: exit status, signal
      // and stderr tail, plus the write failure when the child never read its
      // input.
      const exit = `Projection child exited ${status.code}${
        status.signal ? ` (${status.signal})` : ""
      }`;
      this.emit("message", {
        id,
        kind: "result",
        ok: false,
        reusable: false,
        error: {
          code: "PROJECTION_PROCESS_UNAVAILABLE",
          message: `${exit}${
            preparationError
              ? ` before reading the artifact (${
                codedFailure(preparationError).message
              })`
              : ""
          }: ${stderr.slice(-1000)}`,
          diagnostics: [],
        },
      });
      return;
    }
    const result = JSON.parse(stdout);
    request.observer?.onUsage?.(result.usage);
    this.emit(
      "message",
      result.ok
        ? {
          id,
          kind: "result",
          ok: true,
          result: result.matrix,
          reusable: false,
        }
        : {
          id,
          kind: "result",
          ok: false,
          reusable: false,
          error: { ...result.error, diagnostics: [] },
        },
    );
  }
  async terminate(): Promise<number> {
    this.#abort.abort();
    try {
      this.#child?.kill("SIGKILL");
    } catch { /* Own process already exited. */ }
    await this.#task;
    return this.#child ? (await this.#child.status).code : 0;
  }
}

const runProjection = createIsolatedWorkerRunner<QueuedProjection>({
  isProjection: () => true,
  maxOperationsPerWorker: 1,
  maxQueued: MATRIX_MAX_QUEUED,
  projectionExecutionMs: MATRIX_EXECUTION_MS,
  createWorker: (url) => new MatrixProcessEndpoint(url),
});
const processUrl = new URL("./process.ts", import.meta.url);
const applicationDirectory = fileURLToPath(
  new URL("../../../../../../", import.meta.url),
);
export const authorityMatrixProcessStats = () => runProjection.stats();

/** entry is an integration-test fixture seam; production never overrides it.
 *
 * A failure of `load` crosses the shared runner as a flattened coded error
 * (message and code only). The caller needs the original, whose type decides the
 * recovery (a repository NOT_FOUND must keep "choose an existing commit"), so the
 * original is kept and rethrown in place of its flattened copy. */
export async function scheduleAuthorityMatrix(
  version: string,
  load: (signal?: AbortSignal) => Promise<AuthorityMatrixProcessInput>,
  timeoutMs = SYSML_TOOLKIT_TIMEOUT_MS,
  observer?: MatrixProcessObserver,
  entry: URL = processUrl,
): Promise<AuthorityMatrix> {
  let loadFailure: { error: unknown } | undefined;
  const guardedLoad = async (signal?: AbortSignal) => {
    try {
      return await load(signal);
    } catch (error) {
      loadFailure = { error };
      throw error;
    }
  };
  try {
    return await runProjection<AuthorityMatrix>(
      applicationDirectory,
      {
        operation: "authority-matrix",
        version,
        load: guardedLoad,
        observer,
      },
      timeoutMs,
      entry,
    );
  } catch (error) {
    if (loadFailure && error instanceof SysmlToolkitWorkerError) {
      const flattened = codedFailure(loadFailure.error);
      if (
        error.code === flattened.code && error.message === flattened.message
      ) throw loadFailure.error;
    }
    throw error;
  }
}

/** Already-loaded artifact seam; production readers enqueue only a version. */
export function projectAuthorityMatrixWorker(
  input: AuthorityMatrixProcessInput,
  timeoutMs = SYSML_TOOLKIT_TIMEOUT_MS,
  observer?: MatrixProcessObserver,
): Promise<AuthorityMatrix> {
  return scheduleAuthorityMatrix(
    input.revision.version,
    () => Promise.resolve(input),
    timeoutMs,
    observer,
  );
}

export async function loadAuthorityMatrixInput(
  repository: Pick<ModelRepositoryPort, "at" | "header">,
  version: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<AuthorityMatrixProcessInput> {
  signal?.throwIfAborted();
  const header = await repository.header(version, signal);
  const pin = { version: header.version, sourceDigest: header.sourceDigest };
  signal?.throwIfAborted();
  const revision = await repository.at(version, signal);
  signal?.throwIfAborted();
  return { revision, projectId, pin, name: projectId };
}

export type AuthorityMatrixProjection = (
  revision: ModelRevision,
  projectId: string,
  pin: AuthorityMatrixArtifactPin,
) => Promise<AuthorityMatrix>;
