import { sourcePublicationError } from "./request-source-publication-diagnostics.ts";

/** Deadline-driven polling for asynchronous effects a test cannot await. */
export interface EventuallyOptions {
  /** Total budget before failing, in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Delay between reads, in milliseconds. Default 25. */
  pollMs?: number;
  /** Names the awaited effect in the failure message. */
  label?: string;
  /** Extra state appended to the failure message as JSON. */
  diagnose?: () => unknown;
}

/** Read until a value other than `undefined` arrives or the deadline passes.
 * The read runs at least once, even with a zero budget. */
export async function eventually<T>(
  read: () => T | undefined | Promise<T | undefined>,
  options: EventuallyOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  let diagnosis = "";
  if (options.diagnose) {
    try {
      diagnosis = `: ${JSON.stringify(await options.diagnose())}`;
    } catch (error) {
      diagnosis = `: ${
        JSON.stringify({ diagnosticError: sourcePublicationError(error) })
      }`;
    }
  }
  throw new Error(
    `${
      options.label ?? "Awaited effect"
    } did not settle within ${timeoutMs} ms${diagnosis}`,
  );
}
