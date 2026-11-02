import { ModelRepositoryError } from "../../../../application/model/repository.ts";
import { SysmlToolkitError } from "../adapter.ts";
import {
  SysmlToolkitTimeoutError,
  SysmlToolkitWorkerError,
} from "../worker-client.ts";

export const TOOLKIT_PROJECTION_BACKOFF_MS = 30_000;

interface ProjectionTimeout {
  expiresAt: number;
  timeoutMs: number;
  started: boolean;
}

function timeoutFailure(
  version: string,
  timeout: ProjectionTimeout,
  now: number,
  name: string,
) {
  return {
    code: "TOOLKIT_TIMEOUT",
    context: {
      version,
      timeoutMs: timeout.timeoutMs,
      started: timeout.started,
      retryAfterMs: Math.min(
        TOOLKIT_PROJECTION_BACKOFF_MS,
        Math.max(0, Math.ceil(timeout.expiresAt - now)),
      ),
    },
    recovery:
      `The ${name} exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop.`,
  };
}

/** Shared bounded timeout retention and error translation for Toolkit projections. */
export class ToolkitVersionedReader<T> {
  // A completed timeout is distinct from a transient in-flight computation.
  // Bound retained versions and use lazy expiry, without timers or workers.
  #timeouts = new Map<string, ProjectionTimeout>();

  constructor(
    private readonly projectVersion: (version: string) => Promise<T>,
    private readonly name: string,
    private readonly failureCode: string,
    private readonly now: () => number = () => performance.now(),
    private readonly cacheQueuedTimeouts = true,
  ) {}

  async read(version: string): Promise<T> {
    const cached = this.#timeouts.get(version);
    if (cached && this.now() < cached.expiresAt) {
      throw timeoutFailure(version, cached, this.now(), this.name);
    }
    this.#timeouts.delete(version);
    try {
      return await this.projectVersion(version);
    } catch (error) {
      if (error instanceof SysmlToolkitTimeoutError) {
        if (!error.started && !this.cacheQueuedTimeouts) {
          throw {
            code: "TOOLKIT_TIMEOUT",
            context: {
              version,
              timeoutMs: error.timeoutMs,
              started: false,
              retryAfterMs: 1000,
            },
            recovery:
              "The projection did not start. Retry after one second; no per-version execution cooldown applies.",
          };
        }
        const now = this.now();
        const timeout = {
          expiresAt: now + TOOLKIT_PROJECTION_BACKOFF_MS,
          timeoutMs: error.timeoutMs,
          started: error.started,
        };
        for (const [key, failure] of this.#timeouts) {
          if (failure.expiresAt <= now) this.#timeouts.delete(key);
        }
        this.#timeouts.set(version, timeout);
        if (this.#timeouts.size > 16) {
          this.#timeouts.delete(this.#timeouts.keys().next().value!);
        }
        throw timeoutFailure(version, timeout, now, this.name);
      }
      if (error instanceof SysmlToolkitError) {
        throw {
          code: error.code ?? this.failureCode,
          context: {
            version,
            message: error.message,
            diagnostics: error.diagnostics,
          },
          recovery:
            "Correct the reported model or Toolkit problem; use a corrected commit if sources change.",
        };
      }
      if (error instanceof SysmlToolkitWorkerError) {
        // A projection lane that reports its own failures (the authority matrix
        // process). *_UNAVAILABLE is infrastructure, not a fault of the model.
        const code = error.code ?? this.failureCode;
        throw {
          code,
          context: {
            version,
            message: error.message,
            ...(error.diagnostics.length
              ? { diagnostics: error.diagnostics }
              : {}),
          },
          recovery: code.endsWith("_UNAVAILABLE")
            ? `Restore the ${this.name} runtime reported in context.message, then request this version again; the model version itself is not at fault.`
            : "Correct the reported model or Toolkit problem; use a corrected commit if sources change.",
        };
      }
      if (error instanceof ModelRepositoryError) {
        throw {
          code: error.code,
          context: { version, message: error.message },
          recovery: error.code === "NOT_FOUND"
            ? "Choose an existing commit from /api/model-history."
            : "Inspect the model repository and restore a valid snapshot before reading this version.",
        };
      }
      throw error;
    }
  }
}
