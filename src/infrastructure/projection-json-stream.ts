const CHUNK_BYTES = 32 * 1024;
const STRING_SEGMENT_CHARS = 2048;
const MAX_DEPTH = 256;

export interface ProjectionJsonOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxStringLength?: number;
  /** Work quantum, capped at four milliseconds even when a larger value is supplied. */
  quantumMs?: number;
}
export interface ProjectionJsonStats {
  bytes: number;
  yields: number;
  /** Accumulated work between explicit task yields, excluding write backpressure. */
  maxSliceMs: number;
}
export class ProjectionJsonInputError extends Error {
  readonly code = "INVALID_PROJECTION_INPUT";
  readonly recovery =
    "Provide a plain JSON projection artifact within the reported input limits.";
  constructor(readonly context: Record<string, unknown>) {
    super("Invalid projection JSON input");
    this.name = "ProjectionJsonInputError";
  }
}

type Frame =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "literal"; text: string }
  | { kind: "string"; value: string; offset: number; started: boolean }
  | { kind: "array"; value: unknown[]; index: number; depth: number }
  | {
    kind: "object";
    value: Record<string, unknown>;
    keys: Generator<string>;
    emitted: boolean;
    depth: number;
  };

function* ownEnumerableKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key;
  }
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionJsonInputError({
      reason: "invalid-option",
      option: name,
    });
  }
  return value;
}

/** Serialize a caller-owned immutable plain JSON graph incrementally. The
 * caller owns stream closure; this function releases its writer on every exit.
 * No full-artifact string, clone, or unbounded output chunk is constructed. */
export async function writeProjectionJson(
  stream: WritableStream<Uint8Array>,
  value: unknown,
  options: ProjectionJsonOptions = {},
): Promise<ProjectionJsonStats> {
  const maxBytes = limit(options.maxBytes ?? 32 * 1024 * 1024, "maxBytes");
  const maxStringLength = limit(
    options.maxStringLength ?? 1024 * 1024,
    "maxStringLength",
  );
  const requestedQuantum = options.quantumMs ?? 4;
  if (!Number.isFinite(requestedQuantum) || requestedQuantum <= 0) {
    throw new ProjectionJsonInputError({
      reason: "invalid-option",
      option: "quantumMs",
    });
  }
  const quantumMs = Math.min(4, requestedQuantum);
  const { signal } = options;
  signal?.throwIfAborted();
  const writer = stream.getWriter();
  const encoder = new TextEncoder();
  const ancestors = new Set<object>();
  const frames: Frame[] = [{ kind: "value", value, depth: 1 }];
  let buffer = new Uint8Array(CHUNK_BYTES), used = 0;
  let bytes = 0, yields = 0, maxSliceMs = 0;
  let workMs = 0, workStarted = performance.now();
  let scheduler: MessageChannel | undefined;
  let pendingYield: {
    resolve(): void;
    reject(reason: unknown): void;
  } | undefined;
  const abortYield = () => {
    pendingYield?.reject(signal?.reason);
    pendingYield = undefined;
  };
  signal?.addEventListener("abort", abortYield, { once: true });
  const yieldTask = (): Promise<void> => {
    if (!scheduler) {
      scheduler = new MessageChannel();
      scheduler.port1.onmessage = () => {
        const pending = pendingYield;
        pendingYield = undefined;
        pending?.resolve();
      };
    }
    const port = scheduler.port2;
    return new Promise<void>((resolve, reject) => {
      pendingYield = { resolve, reject };
      port.postMessage(null);
    });
  };

  const markWork = () => {
    const now = performance.now();
    workMs += now - workStarted;
    workStarted = now;
    maxSliceMs = Math.max(maxSliceMs, workMs);
  };
  const checkpoint = (): Promise<void> | undefined => {
    signal?.throwIfAborted();
    markWork();
    if (workMs < quantumMs) return undefined;
    yields++;
    // MessageChannel schedules a real task without timer-delay clamping.
    return yieldTask().then(() => {
      workMs = 0;
      workStarted = performance.now();
      signal?.throwIfAborted();
    });
  };
  const waitForWrite = (write: Promise<void>): Promise<void> => {
    if (!signal) return write;
    if (signal.aborted) {
      void write.catch(() => undefined);
      return Promise.reject(signal.reason);
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      write.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  };
  const flush = async () => {
    if (!used) return;
    signal?.throwIfAborted();
    const chunk = buffer.subarray(0, used);
    buffer = new Uint8Array(CHUNK_BYTES);
    used = 0;
    markWork();
    try {
      await waitForWrite(writer.write(chunk));
    } finally {
      // Backpressure is time outside the serializer's own work slice.
      workStarted = performance.now();
    }
  };
  const append = async (text: string) => {
    signal?.throwIfAborted();
    const encoded = encoder.encode(text);
    if (encoded.length > maxBytes - bytes) {
      throw new ProjectionJsonInputError({
        reason: "max-bytes",
        maxBytes,
        bytes: bytes + encoded.length,
      });
    }
    bytes += encoded.length;
    let offset = 0;
    while (offset < encoded.length) {
      const count = Math.min(CHUNK_BYTES - used, encoded.length - offset);
      buffer.set(encoded.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === CHUNK_BYTES) await flush();
    }
  };
  const stringFrame = (text: string): Frame => {
    if (text.length > maxStringLength) {
      throw new ProjectionJsonInputError({
        reason: "max-string-length",
        maxStringLength,
        length: text.length,
      });
    }
    return { kind: "string", value: text, offset: 0, started: false };
  };

  try {
    while (frames.length) {
      const pause = checkpoint();
      if (pause) await pause;
      const frame = frames.pop()!;
      if (frame.kind === "literal") {
        await append(frame.text);
      } else if (frame.kind === "string") {
        if (!frame.started) {
          await append('"');
          frame.started = true;
        }
        if (frame.offset < frame.value.length) {
          let end = Math.min(
            frame.value.length,
            frame.offset + STRING_SEGMENT_CHARS,
          );
          // JSON.stringify escapes lone surrogates. Keep actual pairs together
          // so segment boundaries do not turn them into two escaped code units.
          if (end < frame.value.length) {
            const last = frame.value.charCodeAt(end - 1),
              next = frame.value.charCodeAt(end);
            if (
              last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 &&
              next <= 0xdfff
            ) end--;
          }
          const encoded = JSON.stringify(frame.value.slice(frame.offset, end));
          await append(encoded.slice(1, -1));
          frame.offset = end;
          frames.push(frame);
        } else await append('"');
      } else if (frame.kind === "array") {
        if (frame.index === frame.value.length) {
          await append("]");
          ancestors.delete(frame.value);
        } else {
          if (frame.index) await append(",");
          const child = frame.value[frame.index++];
          frames.push(frame, {
            kind: "value",
            value: child,
            depth: frame.depth + 1,
          });
        }
      } else if (frame.kind === "object") {
        const key = frame.keys.next();
        if (key.done) {
          await append("}");
          ancestors.delete(frame.value);
        } else {
          const child = frame.value[key.value];
          if (child !== undefined) {
            if (frame.emitted) await append(",");
            frame.emitted = true;
            frames.push(
              frame,
              { kind: "value", value: child, depth: frame.depth + 1 },
              { kind: "literal", text: ":" },
              stringFrame(key.value),
            );
          } else frames.push(frame);
        }
      } else if (
        frame.value === null || frame.value === undefined && frame.depth > 1
      ) {
        await append("null");
      } else if (typeof frame.value === "string") {
        frames.push(stringFrame(frame.value));
      } else if (
        typeof frame.value === "number" || typeof frame.value === "boolean"
      ) {
        await append(JSON.stringify(frame.value));
      } else if (typeof frame.value === "object") {
        if (frame.depth > MAX_DEPTH) {
          throw new ProjectionJsonInputError({
            reason: "max-depth",
            maxDepth: MAX_DEPTH,
          });
        }
        if (ancestors.has(frame.value)) {
          throw new ProjectionJsonInputError({ reason: "cycle" });
        }
        const array = Array.isArray(frame.value);
        if (!array) {
          const prototype: unknown = Object.getPrototypeOf(frame.value);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new ProjectionJsonInputError({ reason: "non-plain-object" });
          }
        }
        ancestors.add(frame.value);
        if (Array.isArray(frame.value)) {
          await append("[");
          frames.push({
            kind: "array",
            value: frame.value,
            index: 0,
            depth: frame.depth,
          });
        } else {
          const object = frame.value as Record<string, unknown>;
          await append("{");
          frames.push({
            kind: "object",
            value: object,
            keys: ownEnumerableKeys(object),
            emitted: false,
            depth: frame.depth,
          });
        }
      } else {
        throw new ProjectionJsonInputError({
          reason: "non-json-value",
          type: typeof frame.value,
        });
      }
    }
    const pause = checkpoint();
    if (pause) await pause;
    await flush();
    signal?.throwIfAborted();
    markWork();
    return { bytes, yields, maxSliceMs };
  } finally {
    signal?.removeEventListener("abort", abortYield);
    scheduler?.port1.close();
    scheduler?.port2.close();
    writer.releaseLock();
  }
}
