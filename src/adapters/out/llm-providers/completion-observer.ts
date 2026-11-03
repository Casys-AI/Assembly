import { isPlainRecord as record } from "../../../domain/primitives/is-plain-record.ts";
import {
  normalizeProviderCallObservation,
  type ProviderCallObservation,
  type ProviderUsage,
} from "../../../application/telemetry/provider-call.ts";

/** Process-local collection health for attempted Anthropic SDK invocations.
 * Missing/dropped observations remain outside this coverage; these counters
 * are neither a business-success denominator nor canonical usage accounting.
 * Crash loss remains possible. A timed-out write may still reach the sink.
 */
export const MAX_COMPLETION_OBSERVATIONS = 64;
export const MAX_COMPLETION_METADATA_BYTES = 4096;
export const COMPLETION_OBSERVER_DEADLINE_MS = 1000;

const stopReasons = new Set([
  "tool_use",
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);
const usageFields = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;
const nestedUsageFields = {
  cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
  server_tool_use: ["web_search_requests", "web_fetch_requests"],
} as const;

type Usage = ProviderUsage;

export interface CompletionMetadata extends Partial<ProviderCallObservation> {
  readonly id?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly usage?: Usage;
}

export type CompletionSink = (
  metadata: CompletionMetadata,
) => void | Promise<void>;

export type CompletionDropReason =
  | "invalid"
  | "oversize"
  | "saturated"
  | "sinkFailure"
  | "closed"
  | "disabled";

export interface CompletionObserverStatus {
  supported: true;
  coverage: "anthropic-physical-calls";
  enabled: boolean;
  received: number;
  written: number;
  /** All retained observations, including the one in flight. */
  pending: number;
  inFlight: boolean;
  dropped: Record<CompletionDropReason, number>;
  stalled: boolean;
  closed: boolean;
}

export interface CompletionFlushResult {
  status: CompletionObserverStatus;
  timedOut: boolean;
  /** Unconfirmed at this snapshot, not evidence that bytes were never written. */
  unconfirmedPending: number;
}

export interface CompletionObservationControl {
  status(): CompletionObserverStatus;
  flush(deadlineMs?: number): Promise<CompletionFlushResult>;
  close(deadlineMs?: number): Promise<CompletionFlushResult>;
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedDuration(value = COMPLETION_OBSERVER_DEADLINE_MS): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1000) {
    throw new Error("Invalid completion observer deadline");
  }
  return value;
}

function allowlisted(value: unknown): CompletionMetadata | undefined {
  if (record(value) && value.schemaVersion !== undefined) {
    return normalizeProviderCallObservation(value);
  }
  if (
    !record(value) || typeof value.stopReason !== "string" ||
    !stopReasons.has(value.stopReason)
  ) return undefined;
  const metadata: {
    id?: string;
    model?: string;
    stopReason: string;
    usage?: Usage;
  } = { stopReason: value.stopReason };
  for (const key of ["id", "model"] as const) {
    if (value[key] === undefined) continue;
    if (
      typeof value[key] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value[key])
    ) {
      return undefined;
    }
    metadata[key] = value[key];
  }
  if (value.usage !== undefined) {
    if (!record(value.usage)) return undefined;
    const usage: Record<string, number | Readonly<Record<string, number>>> = {};
    for (const key of usageFields) {
      const counter = value.usage[key];
      if (counter === undefined) continue;
      if (!unit(counter)) return undefined;
      usage[key] = counter;
    }
    for (const key of ["cache_creation", "server_tool_use"] as const) {
      const source = value.usage[key];
      if (source === undefined || source === null) continue;
      if (!record(source)) return undefined;
      const counters: Record<string, number> = {};
      for (const field of nestedUsageFields[key]) {
        const counter = source[field];
        if (counter === undefined) continue;
        if (!unit(counter)) return undefined;
        counters[field] = counter;
      }
      if (Object.keys(counters).length) usage[key] = Object.freeze(counters);
    }
    if (Object.keys(usage).length) metadata.usage = Object.freeze(usage);
  }
  return Object.freeze(metadata);
}

/** One bounded serial drain per provider instance. Publication schedules host
 * code after enqueue; it never invokes or awaits the sink on the business path.
 * The sink is trusted: this cannot preempt CPU-bound synchronous host code or
 * cancel an uncooperative promise. Stalls never start a competing drain.
 */
export class CompletionObserver implements CompletionObservationControl {
  private readonly queue: CompletionMetadata[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly stallMs: number;
  private readonly dropped: Record<CompletionDropReason, number> = {
    invalid: 0,
    oversize: 0,
    saturated: 0,
    sinkFailure: 0,
    closed: 0,
    disabled: 0,
  };
  private received = 0;
  private written = 0;
  private active = false;
  private scheduled = false;
  private stalled = false;
  private closed = false;

  constructor(
    private readonly sink?: CompletionSink,
    options: { stallMs?: number } = {},
  ) {
    this.stallMs = boundedDuration(options.stallMs);
  }

  publish(value: unknown): void {
    this.received++;
    if (this.closed) {
      this.dropped.closed++;
      return;
    }
    if (!this.sink) {
      this.dropped.disabled++;
      return;
    }
    if (
      this.queue.length + Number(this.active) >= MAX_COMPLETION_OBSERVATIONS
    ) {
      this.dropped.saturated++;
      return;
    }
    let metadata: CompletionMetadata | undefined;
    try {
      // Bound normalization work before regex/JSON encoding as well as the
      // retained result. Unknown/private fields are never traversed.
      if (record(value)) {
        for (const key of ["id", "model", "stopReason"] as const) {
          const field = value[key];
          if (
            typeof field === "string" &&
            field.length > MAX_COMPLETION_METADATA_BYTES
          ) {
            this.dropped.oversize++;
            return;
          }
        }
      }
      metadata = allowlisted(value);
      if (!metadata) {
        this.dropped.invalid++;
        return;
      }
      if (
        new TextEncoder().encode(JSON.stringify(metadata)).byteLength >
          MAX_COMPLETION_METADATA_BYTES
      ) {
        this.dropped.oversize++;
        return;
      }
    } catch {
      this.dropped.invalid++;
      return;
    }
    this.queue.push(metadata);
    this.schedule();
  }

  status(): CompletionObserverStatus {
    return {
      supported: true,
      coverage: "anthropic-physical-calls",
      enabled: this.sink !== undefined,
      received: this.received,
      written: this.written,
      pending: this.queue.length + Number(this.active),
      inFlight: this.active,
      dropped: { ...this.dropped },
      stalled: this.stalled,
      closed: this.closed,
    };
  }

  async flush(deadlineMs?: number): Promise<CompletionFlushResult> {
    const duration = boundedDuration(deadlineMs);
    let timedOut = false;
    if (this.status().pending) {
      await new Promise<void>((resolve) => {
        const complete = () => {
          clearTimeout(timer);
          this.waiters.delete(complete);
          resolve();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          complete();
        }, duration);
        this.waiters.add(complete);
      });
    }
    const status = this.status();
    return { status, timedOut, unconfirmedPending: status.pending };
  }

  close(deadlineMs?: number): Promise<CompletionFlushResult> {
    // Validate before changing state. Queued work keeps its sole drain even
    // after the deadline; late writes are confirmed only on settlement.
    boundedDuration(deadlineMs);
    this.closed = true;
    return this.flush(deadlineMs);
  }

  private schedule(): void {
    if (this.active || this.scheduled || !this.queue.length) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active || !this.sink) return;
    const metadata = this.queue.shift();
    if (!metadata) return;
    this.active = true;
    const timer = setTimeout(() => {
      this.stalled = true;
    }, this.stallMs);
    try {
      await this.sink(metadata);
      this.written++;
    } catch {
      // Host errors may contain secrets; retain only a fixed health counter.
      this.dropped.sinkFailure++;
    } finally {
      clearTimeout(timer);
      this.active = false;
      this.stalled = false;
      if (this.queue.length) this.schedule();
      else for (const complete of [...this.waiters]) complete();
    }
  }
}
