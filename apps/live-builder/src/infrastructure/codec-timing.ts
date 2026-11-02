/** Optional diagnostic around synchronous codec and exact-byte copy together. */
export interface CodecTimingEvent {
  name: string;
  phase: "start" | "end" | "error";
  elapsedMs: number;
  pid: number;
  utc: string;
  inputBytes: number;
  outputBytes?: number;
}

export type CodecTimingObserver = (event: CodecTimingEvent) => void;

export function observeCodec<T extends ArrayBuffer | Uint8Array>(
  observer: CodecTimingObserver | undefined,
  name: string,
  inputBytes: number,
  operation: () => T,
): T {
  if (!observer) return operation();
  let started = 0;
  try {
    started = performance.now();
  } catch { /* Diagnostics are optional. */ }
  const report = (phase: CodecTimingEvent["phase"], outputBytes?: number) => {
    try {
      observer({
        name,
        phase,
        pid: Deno.pid,
        utc: new Date().toISOString(),
        elapsedMs: phase === "start" ? 0 : performance.now() - started,
        inputBytes,
        ...(outputBytes === undefined ? {} : { outputBytes }),
      });
    } catch { /* Observation cannot affect the codec. */ }
  };
  report("start");
  try {
    const result = operation();
    report("end", result.byteLength);
    return result;
  } catch (error) {
    report("error");
    throw error;
  }
}
