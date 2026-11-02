/** Opt-in diagnostic of the calling test isolate; no listener or launcher flags. */
import { fileURLToPath } from "node:url";

const profileDirectory = new URL(
  "../../.data/request-opening-profiles/",
  import.meta.url,
);

export interface CapturedTestCpuProfile {
  id: string;
  pid: number;
  phase: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  outcome: "returned" | "threw";
  profilePath: string;
  metadataPath: string;
}

export async function withTestCpuProfile<T>(
  operation: () => Promise<T>,
  options: {
    enabled: boolean;
    phase: string;
    onCaptured?: (capture: CapturedTestCpuProfile) => void;
  },
): Promise<T> {
  if (!options.enabled) return await operation();
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  const id = crypto.randomUUID();
  const stem = `${Deno.pid}-${id}`;
  const profilePath = fileURLToPath(
    new URL(`${stem}.cpuprofile`, profileDirectory),
  );
  const metadataPath = fileURLToPath(new URL(`${stem}.json`, profileDirectory));
  try {
    await Deno.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await Deno.chmod(profileDirectory, 0o700);
    // connect(), unlike connectToMainThread(), profiles this test's isolate.
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1000 });
    await session.post("Profiler.start");
  } catch (cause) {
    try {
      session.disconnect();
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Test CPU profile setup and cleanup failed",
        { cause },
      );
    }
    throw new Error("Test CPU profile setup failed", { cause });
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  let value!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const elapsedMs = performance.now() - started;
  const endedAt = new Date().toISOString();
  let diagnosticFailed = false;
  let diagnosticError: unknown;
  try {
    const { profile } = await session.post("Profiler.stop");
    if (!profile || !Array.isArray(profile.nodes) || !profile.nodes.length) {
      throw new Error("The inspector returned no CPU profile");
    }
    const capture: CapturedTestCpuProfile = {
      id,
      pid: Deno.pid,
      phase: options.phase,
      startedAt,
      endedAt,
      elapsedMs,
      outcome: operationFailed ? "threw" : "returned",
      profilePath,
      metadataPath,
    };
    await Deno.writeTextFile(profilePath, JSON.stringify(profile), {
      createNew: true,
      mode: 0o600,
    });
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify(capture, null, 2) + "\n",
      { createNew: true, mode: 0o600 },
    );
    options.onCaptured?.(capture);
    console.log("Test CPU profile captured", {
      id,
      pid: Deno.pid,
      phase: options.phase,
      elapsedMs,
      metadataPath,
    });
  } catch (error) {
    diagnosticFailed = true;
    diagnosticError = error;
  } finally {
    try {
      session.disconnect();
    } catch (error) {
      diagnosticFailed = true;
      diagnosticError = diagnosticError === undefined
        ? error
        : new AggregateError(
          [diagnosticError, error],
          "CPU profile cleanup failed",
        );
    }
  }
  if (diagnosticFailed) {
    const failure = new Error("Test CPU profile capture failed", {
      cause: diagnosticError,
    });
    if (operationFailed) {
      throw new AggregateError(
        [operationError, failure],
        "Test operation failed and its CPU diagnostic also failed",
        { cause: operationError },
      );
    }
    throw failure;
  }
  if (operationFailed) throw operationError;
  return value;
}
