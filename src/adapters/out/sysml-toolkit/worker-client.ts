/** A deadline is enforced by terminating the computing process/worker and
 * waiting for that termination, not just by rejecting a promise. Production
 * Toolkit work runs in a bounded native child process (see
 * native-process-client.ts); the node Worker transport remains only as the
 * integration-fixture seam. */
import type { ModelToolingDiagnostic } from "../../../application/model/tooling.ts";
import type {
  ModelToolingTarget,
  ResolvedModelEdit,
} from "../../../domain/model/editing/tooling.ts";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createNativeProcessEndpoint } from "../../../infrastructure/native/process-client.ts";
import type { ToolkitBundlePin } from "./runtime/loader.ts";
import type { ModelViewSummary } from "../../../domain/model/records/diagram-views.ts";

export const SYSML_TOOLKIT_TIMEOUT_MS = 15_000;
/** A read projection cannot occupy the authoring worker for its whole deadline. */
export const SYSML_TOOLKIT_PROJECTION_EXECUTION_MS = 3_000;
/** Compatibility name for the board; all read projections share this ceiling. */
export const SYSML_TOOLKIT_BOARD_EXECUTION_MS =
  SYSML_TOOLKIT_PROJECTION_EXECUTION_MS;

export type ToolkitWorkerOperation =
  | { operation: "pin" }
  | { operation: "provenance" }
  | { operation: "tokens"; path: string; text: string }
  | { operation: "compile"; sources: Record<string, string> }
  | { operation: "check"; sources: Record<string, string> }
  | {
    operation: "board";
    sources: Record<string, string>;
    options?: { mode?: "ase" | "generic"; model?: string };
  }
  | { operation: "query"; sources: Record<string, string>; expression: string }
  | {
    operation: "reference-sites";
    sources: Record<string, string>;
    fromId: string;
  }
  | { operation: "views"; sources: Record<string, string> }
  | {
    operation: "diagram" | "plantuml";
    sources: Record<string, string>;
    view: ModelViewSummary;
  }
  | {
    operation: "describe";
    sources: Record<string, string>;
    target: ModelToolingTarget;
  }
  | {
    operation: "edit";
    sources: Record<string, string>;
    edits: readonly ResolvedModelEdit[];
  };

export interface IsolatedWorkerRequest<Operation> {
  id: number;
  packageDir: string;
  bundle?: ToolkitBundlePin;
  request: Operation;
}

export type ToolkitWorkerRequest = IsolatedWorkerRequest<
  ToolkitWorkerOperation
>;

export type ToolkitWorkerResponse =
  | { id: number; kind: "started" }
  | {
    id: number;
    kind: "result";
    ok: true;
    result: unknown;
    reusable?: boolean;
  }
  | {
    id: number;
    kind: "result";
    ok: false;
    reusable?: boolean;
    error: {
      message: string;
      diagnostics: ModelToolingDiagnostic[];
      code?: string;
    };
  };

export class SysmlToolkitTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly started: boolean) {
    super(
      `sysml-toolkit operation exceeded ${timeoutMs} ms; worker terminated`,
    );
    this.name = "SysmlToolkitTimeoutError";
  }
}

export class SysmlToolkitWorkerError extends Error {
  constructor(
    message: string,
    readonly diagnostics: ModelToolingDiagnostic[] = [],
    readonly code?: string,
  ) {
    super(message);
    this.name = "SysmlToolkitWorkerError";
  }
}

export class SysmlToolkitWorkerClosedError extends SysmlToolkitWorkerError {
  constructor() {
    super("Toolkit worker scheduler is closed", [], "TOOLKIT_WORKER_CLOSED");
    this.name = "SysmlToolkitWorkerClosedError";
  }
}

const productionWorker = new URL("./worker.ts", import.meta.url);
// Survives worker replacement. A configured path is bound once for this host's
// lifetime, shared by startup provenance, compiler and authoring adapters.
const startupBundles = new Map<string, Promise<ToolkitBundlePin>>();

export interface IsolatedWorkerEndpoint {
  on(
    event: "message",
    listener: (response: ToolkitWorkerResponse) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "messageerror" | "exit", listener: () => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  ref(): unknown;
  unref(): unknown;
}

export class ProjectionQueueUnavailable extends Error {
  readonly code = "PROJECTION_QUEUE_UNAVAILABLE";
  readonly recovery =
    "Projection capacity is occupied. Retry after context.retryAfterMs.";
  readonly context: { retryAfterMs: number; queued: number; limit: number };
  constructor(queued: number, limit: number) {
    super("Projection queue is full");
    this.context = { retryAfterMs: 1000, queued, limit };
  }
}

export interface OperationDeadline {
  timeoutMs: number;
  expiresAt: number;
}

export function validateToolkitTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new SysmlToolkitWorkerError("Toolkit timeout must be 1–60000 ms");
  }
}

const runToolkitWorker = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
  isProjection: (operation) =>
    operation.operation === "board" || operation.operation === "views" ||
    operation.operation === "diagram" || operation.operation === "plantuml" ||
    operation.operation === "tokens",
  // Production runs in the native child process; any other URL is the
  // integration-fixture seam and keeps a real node Worker, exactly as before.
  createWorker: (url) =>
    url.href === productionWorker.href
      ? createNativeProcessEndpoint(url)
      : new Worker(url) as unknown as IsolatedWorkerEndpoint,
});
let toolkitWorkersClosing: Promise<void> | undefined;

/** Final host shutdown only: a closed shared scheduler cannot be reopened. */
export function closeSysmlToolkitWorkers(): Promise<void> {
  if (!toolkitWorkersClosing) {
    startupBundles.clear();
    toolkitWorkersClosing = runToolkitWorker.close();
  }
  return toolkitWorkersClosing;
}

/** workerUrl is an integration-test fixture seam; the adapter never overrides it. */
export function runSysmlToolkitWorker<T>(
  packageDir: string,
  request: ToolkitWorkerOperation,
  timeoutMs = SYSML_TOOLKIT_TIMEOUT_MS,
  workerUrl = productionWorker,
): Promise<T> {
  if (toolkitWorkersClosing) {
    return Promise.reject(new SysmlToolkitWorkerClosedError());
  }
  validateToolkitTimeout(timeoutMs);
  const deadline = { timeoutMs, expiresAt: performance.now() + timeoutMs };
  const operation = structuredClone(request);
  // Only the preemption-test fixture replaces the production worker.
  if (workerUrl.href !== productionWorker.href) {
    return runToolkitWorker(packageDir, operation, deadline, workerUrl);
  }
  const key = resolve(packageDir);
  let bundle = startupBundles.get(key);
  if (!bundle) {
    bundle = runToolkitWorker<ToolkitBundlePin>(
      key,
      { operation: "pin" },
      deadline,
      productionWorker,
    ).catch((error) => {
      // Queue expiry and transient startup failures have not established a pin.
      // A verified integrity refusal remains closed for this configured path.
      if (
        !(error instanceof SysmlToolkitWorkerError &&
          error.code === "TOOLKIT_BUNDLE_DRIFT") &&
        startupBundles.get(key) === bundle
      ) startupBundles.delete(key);
      throw error;
    });
    startupBundles.set(key, bundle);
  } else {
    bundle = waitForBundle(bundle, deadline);
  }
  return bundle.then((pin) => {
    if (toolkitWorkersClosing) throw new SysmlToolkitWorkerClosedError();
    if (performance.now() >= deadline.expiresAt) {
      throw new SysmlToolkitTimeoutError(timeoutMs, false);
    }
    if (operation.operation === "pin") return pin as T;
    if (operation.operation === "provenance") {
      return { version: pin.version, digest: pin.digest } as T;
    }
    return runToolkitWorker<T>(key, operation, deadline, productionWorker, pin);
  });
}

function waitForBundle(
  bundle: Promise<ToolkitBundlePin>,
  deadline: OperationDeadline,
): Promise<ToolkitBundlePin> {
  return new Promise((resolve, reject) => {
    // A caller waiting on another caller's startup has its own total budget.
    // Its timeout must not cancel the shared startup or enqueue work afterward.
    const remaining = deadline.expiresAt - performance.now();
    const timeout = () =>
      reject(new SysmlToolkitTimeoutError(deadline.timeoutMs, false));
    const timer = setTimeout(timeout, Math.max(0, remaining));
    bundle.then((pin) => {
      clearTimeout(timer);
      if (performance.now() >= deadline.expiresAt) timeout();
      else resolve(pin);
    }, (error) => {
      clearTimeout(timer);
      if (performance.now() >= deadline.expiresAt) timeout();
      else reject(error);
    });
  });
}

interface PendingOperation<Operation> {
  id: number;
  packageDir: string;
  request: Operation;
  deadline: OperationDeadline;
  workerUrl: URL;
  bundle?: ToolkitBundlePin;
  started: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** Each factory call owns an independent bounded priority/FIFO lane. Requests
 * must be caller-owned immutable snapshots until dispatch, as for the Toolkit
 * wrapper below. OS RSS reclamation may lag behind termination acknowledgement. */
export function createIsolatedWorkerRunner<Operation>(options: {
  isProjection(operation: Operation): boolean;
  maxOperationsPerWorker?: number;
  maxQueued?: number;
  /** Execution ceiling of a projection once dispatched; defaults to the Toolkit
   * read-projection ceiling. A lane that owns a disposable process can need more. */
  projectionExecutionMs?: number;
  createWorker?: (url: URL) => IsolatedWorkerEndpoint;
}) {
  const projectionExecutionMs = options.projectionExecutionMs ??
    SYSML_TOOLKIT_PROJECTION_EXECUTION_MS;
  validateToolkitTimeout(projectionExecutionMs);
  if (
    options.maxOperationsPerWorker !== undefined &&
    (!Number.isSafeInteger(options.maxOperationsPerWorker) ||
      options.maxOperationsPerWorker < 1)
  ) {
    throw new SysmlToolkitWorkerError(
      "Worker recycle limit must be a positive integer",
    );
  }
  if (
    options.maxQueued !== undefined &&
    (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0)
  ) {
    throw new SysmlToolkitWorkerError(
      "Worker queue capacity must be a non-negative integer",
    );
  }
  // Only one operation runs at a time, including callers using different package
  // paths. Mutable sessions never cross operation boundaries. OS reclamation of
  // retired workers may lag behind the host's termination acknowledgement.
  const queued: PendingOperation<Operation>[] = [];
  let nextId = 0;
  let active: PendingOperation<Operation> | undefined;
  let worker: IsolatedWorkerEndpoint | undefined;
  let workerKey: string | undefined;
  let retiring: Promise<void> | undefined;
  let completedOperations = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let retirementFailure: Error | undefined;

  function retireWorker(): Promise<void> {
    if (retiring) return retiring;
    const previous = worker;
    worker = undefined;
    workerKey = undefined;
    completedOperations = 0;
    if (!previous) return Promise.resolve();
    // Wait for the host termination API before dispatching another runtime.
    // This acknowledgement is not an RSS/OS-thread reclamation barrier.
    retiring = Promise.resolve().then(() => previous.terminate()).then(
      () => undefined,
      (error) => {
        retirementFailure = error instanceof Error
          ? error
          : new SysmlToolkitWorkerError(String(error));
      },
    )
      .finally(() => {
        retiring = undefined;
        if (!closed) dispatchNext();
      });
    return retiring;
  }

  function finish(
    entry: PendingOperation<Operation>,
    error?: Error,
    result?: unknown,
    retire = false,
    completedResponse = false,
  ): void {
    if (entry.settled) return;
    if (performance.now() >= entry.deadline.expiresAt) {
      error = new SysmlToolkitTimeoutError(
        entry.deadline.timeoutMs,
        entry.started,
      );
      retire = true;
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    let retirement: Promise<void> | undefined;
    if (active === entry) {
      active = undefined;
      if (completedResponse) completedOperations++;
      const recycle = options.maxOperationsPerWorker !== undefined &&
        completedOperations >= options.maxOperationsPerWorker;
      if (retire || recycle) {
        const terminated = retireWorker();
        // Recyclable lanes settle only after termination acknowledges release of
        // this worker. Unlimited Toolkit lanes preserve their existing timing.
        if (options.maxOperationsPerWorker !== undefined) {
          retirement = terminated;
        }
      } else worker?.unref();
    } else {
      const index = queued.indexOf(entry);
      if (index !== -1) queued.splice(index, 1);
    }
    let responseSettled = false;
    const settle = (failure = error) => {
      if (responseSettled) return;
      responseSettled = true;
      clearTimeout(entry.timer);
      if (failure) entry.reject(failure);
      else entry.resolve(result);
      dispatchNext();
    };
    if (retirement) {
      const timeout = () =>
        settle(
          new SysmlToolkitTimeoutError(
            entry.deadline.timeoutMs,
            entry.started,
          ),
        );
      // The response budget includes retirement. A timeout settles this caller
      // but leaves the lane blocked until the termination acknowledgment.
      entry.timer = setTimeout(
        timeout,
        Math.max(0, entry.deadline.expiresAt - performance.now()),
      );
      void retirement.then(() => {
        if (performance.now() >= entry.deadline.expiresAt) timeout();
        else settle();
      });
    } else settle();
  }

  function dispatchNext(): void {
    if (closed || active || retiring || !queued.length) return;
    // Preserve FIFO within each class. Authoring/checking work overtakes queued
    // projections, while every waiter still has its original total deadline.
    const entry =
      queued.find((pending) => !options.isProjection(pending.request)) ??
        queued[0];
    if (performance.now() >= entry.deadline.expiresAt) {
      finish(
        entry,
        new SysmlToolkitTimeoutError(entry.deadline.timeoutMs, false),
      );
      return;
    }
    const key = `${entry.workerUrl.href}\n${resolve(entry.packageDir)}`;
    if (worker && workerKey !== key) {
      retireWorker();
      return;
    }
    queued.splice(queued.indexOf(entry), 1);
    active = entry;
    if (options.isProjection(entry.request)) {
      const expiresAt = performance.now() + projectionExecutionMs;
      if (expiresAt < entry.deadline.expiresAt) {
        entry.deadline = {
          timeoutMs: projectionExecutionMs,
          expiresAt,
        };
        armDeadline(entry);
      }
    }
    try {
      if (!worker) {
        const created = options.createWorker?.(entry.workerUrl) ??
          new Worker(entry.workerUrl) as unknown as IsolatedWorkerEndpoint;
        worker = created;
        workerKey = key;
        created.on("message", (response: ToolkitWorkerResponse) => {
          if (worker !== created) return;
          const pending = active;
          if (!pending || response?.id !== pending.id) {
            if (pending) {
              finish(
                pending,
                new SysmlToolkitWorkerError("Invalid toolkit worker response"),
                undefined,
                true,
              );
            } else retireWorker();
            return;
          }
          if (performance.now() >= pending.deadline.expiresAt) {
            finish(
              pending,
              new SysmlToolkitTimeoutError(
                pending.deadline.timeoutMs,
                pending.started,
              ),
              undefined,
              true,
            );
            return;
          }
          if (response.kind === "started") {
            pending.started = true;
            return;
          }
          if (response.kind !== "result" || typeof response.ok !== "boolean") {
            finish(
              pending,
              new SysmlToolkitWorkerError("Invalid toolkit worker response"),
              undefined,
              true,
            );
          } else if (response.ok) {
            finish(
              pending,
              undefined,
              response.result,
              response.reusable === false,
              true,
            );
          } else {
            // Only a worker that loaded a verified runtime and completed without
            // a trap may keep its immutable library after an ordinary refusal.
            finish(
              pending,
              new SysmlToolkitWorkerError(
                String(response.error?.message ?? "Toolkit worker failed"),
                Array.isArray(response.error?.diagnostics)
                  ? response.error.diagnostics
                  : [],
                response.error?.code,
              ),
              undefined,
              response.reusable !== true,
              true,
            );
          }
        });
        const failed = (error: Error) => {
          if (worker !== created) return;
          if (active) finish(active, error, undefined, true);
          else retireWorker();
        };
        created.on(
          "error",
          (error) =>
            failed(
              new SysmlToolkitWorkerError(
                error.message,
                [],
                "TOOLKIT_WORKER_UNAVAILABLE",
              ),
            ),
        );
        created.on("messageerror", () =>
          failed(
            new SysmlToolkitWorkerError(
              "Toolkit worker result could not be decoded",
              [],
              "TOOLKIT_WORKER_UNAVAILABLE",
            ),
          ));
        created.on(
          "exit",
          () =>
            failed(
              new SysmlToolkitWorkerError(
                "Toolkit worker exited unexpectedly",
                [],
                "TOOLKIT_WORKER_UNAVAILABLE",
              ),
            ),
        );
      }
      worker.ref();
      worker.postMessage(
        {
          id: entry.id,
          packageDir: entry.packageDir,
          request: entry.request,
          bundle: entry.bundle,
        } satisfies IsolatedWorkerRequest<Operation>,
      );
    } catch (error) {
      finish(
        entry,
        error instanceof Error
          ? error
          : new SysmlToolkitWorkerError(String(error)),
        undefined,
        true,
      );
    }
  }

  function runWorker<T>(
    packageDir: string,
    request: Operation,
    timeout: number | OperationDeadline,
    workerUrl: URL,
    bundle?: ToolkitBundlePin,
  ): Promise<T> {
    if (closed) return Promise.reject(new SysmlToolkitWorkerClosedError());
    const deadline = typeof timeout === "number"
      ? { timeoutMs: timeout, expiresAt: performance.now() + timeout }
      : timeout;
    validateToolkitTimeout(deadline.timeoutMs);
    if (!Number.isFinite(deadline.expiresAt)) {
      throw new SysmlToolkitWorkerError("Invalid worker deadline");
    }
    if (
      options.maxQueued !== undefined && (active || retiring) &&
      queued.length >= options.maxQueued
    ) {
      return Promise.reject(
        new ProjectionQueueUnavailable(queued.length, options.maxQueued),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: PendingOperation<Operation> = {
        id: ++nextId,
        packageDir,
        request,
        deadline,
        workerUrl,
        bundle,
        started: false,
        settled: false,
        resolve: (result) => resolve(result as T),
        reject,
      };
      queued.push(entry);
      // Queueing and execution share one deadline. finish only retires a worker
      // when this entry owns it, so an expired waiter cannot interrupt its peer.
      armDeadline(entry);
      dispatchNext();
    });
  }

  function armDeadline(entry: PendingOperation<Operation>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () =>
        finish(
          entry,
          new SysmlToolkitTimeoutError(entry.deadline.timeoutMs, entry.started),
          undefined,
          true,
        ),
      Math.max(0, entry.deadline.expiresAt - performance.now()),
    );
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    // Stop dispatch before settling waiters. Their promise continuations and a
    // pending retirement must never resurrect work during shutdown.
    const pending = active ? [active, ...queued] : [...queued];
    active = undefined;
    queued.length = 0;
    for (const entry of pending) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.reject(new SysmlToolkitWorkerClosedError());
    }
    closing = retireWorker().then(() => {
      if (retirementFailure) throw retirementFailure;
    });
    return closing;
  }

  return Object.assign(runWorker, {
    close,
    stats: () => ({
      active: active ? 1 : 0,
      queued: queued.length,
      retiring: retiring ? 1 : 0,
    }),
  });
}
