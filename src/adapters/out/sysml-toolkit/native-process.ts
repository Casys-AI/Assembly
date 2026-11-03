/** Child-process host for the native Toolkit runtime.
 *
 * This process owns the loaded addon, its prepared library and every session
 * created for an operation. It speaks the versioned NDJSON protocol of
 * native-process-client.ts: hello first, then started/result per request.
 * A native panic marks the result non-reusable so the parent recycles this
 * whole process; sessions never outlive it. No native session reference,
 * generation or epoch is ever included in an operation result.
 */
import { prepareToolkitElements } from "./compilation/compiler.ts";
import { toolkitSourceTokens } from "./projections/source-tokens.ts";
import { SysmlToolkitAdapter } from "./adapter.ts";
import {
  loadSysmlToolkit,
  type ToolkitBundlePin,
  ToolkitNativeSnapshotError,
  type ToolkitRuntime,
} from "./runtime/loader.ts";
import { isNativeToolkitPanic } from "./runtime/native-addon.ts";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_PROCESS_PROTOCOL_VERSION,
  type NativeProcessRequestEnvelope,
  type NativeProcessResponseEnvelope,
  readBoundedLines,
} from "../../../infrastructure/native/process-client.ts";
import type { ToolkitWorkerOperation } from "./worker-client.ts";
import { technicalLogger } from "../../../infrastructure/logging.ts";

const log = technicalLogger("toolkit-worker");

export interface NativeRequestOutcome {
  ok: boolean;
  result?: unknown;
  reusable: boolean;
  error?: { message: string; code?: string; diagnostics: unknown[] };
}

export interface NativeProcessDeps {
  loadRuntime(
    packageDir: string,
    bundle?: ToolkitBundlePin,
  ): Promise<ToolkitRuntime>;
}

const defaultDeps: NativeProcessDeps = {
  loadRuntime: (packageDir, bundle) => loadSysmlToolkit(packageDir, bundle),
};

const OPERATIONS = new Set([
  "pin",
  "provenance",
  "tokens",
  "compile",
  "check",
  "board",
  "views",
  "diagram",
  "plantuml",
  "query",
  "describe",
  "reference-sites",
  "edit",
]);

function codedError(error: unknown): { code?: string } {
  return error && typeof error === "object" && "code" in error &&
      typeof (error as { code: unknown }).code === "string"
    ? { code: (error as { code: string }).code }
    : {};
}

function errorDiagnostics(error: unknown): unknown[] {
  return error && typeof error === "object" && "diagnostics" in error &&
      Array.isArray((error as { diagnostics: unknown }).diagnostics)
    ? (error as { diagnostics: unknown[] }).diagnostics
    : [];
}

/** Execute one operation against the process-owned runtime. */
export async function handleNativeToolkitRequest(
  packageDir: string,
  bundle: ToolkitBundlePin | undefined,
  request: ToolkitWorkerOperation,
  deps: NativeProcessDeps = defaultDeps,
): Promise<NativeRequestOutcome> {
  let loaded: ToolkitRuntime | undefined;
  let invalidated = false;
  try {
    if (
      !request || typeof request !== "object" ||
      !OPERATIONS.has(request.operation)
    ) {
      throw new Error("Unknown toolkit native operation");
    }
    // The loader rechecks all pinned bytes even when its runtime is cached.
    loaded = await deps.loadRuntime(packageDir, bundle);
    const runtime: ToolkitRuntime = {
      ...loaded,
      invalidate(error: unknown) {
        invalidated = true;
        loaded?.invalidate?.(error);
      },
    };
    const tooling = new SysmlToolkitAdapter({
      packageDir,
      // This process owns the runtime. The seam avoids a nested process.
      loadRuntime: () => Promise.resolve(runtime),
    });
    let result: unknown;
    switch (request.operation) {
      case "pin":
        if (!runtime.bundle) {
          throw new Error("Loaded toolkit pin is unavailable");
        }
        result = runtime.bundle;
        break;
      case "provenance": {
        if (!runtime.provenance) {
          throw new Error("Loaded toolkit provenance is unavailable");
        }
        result = await runtime.provenance();
        break;
      }
      case "tokens":
        result = toolkitSourceTokens(runtime, request.path, request.text);
        break;
      case "compile":
        result = await prepareToolkitElements(request.sources, runtime);
        break;
      case "check":
        result = await tooling.check(request.sources);
        break;
      case "board":
        result = await tooling.board(request.sources, request.options);
        break;
      case "views":
        result = await tooling.views(request.sources);
        break;
      case "diagram":
        result = await tooling.diagram(request.sources, request.view);
        break;
      case "plantuml":
        result = await tooling.plantuml(request.sources, request.view);
        break;
      case "query":
        result = await tooling.query(request.sources, request.expression);
        break;
      case "describe":
        result = await tooling.describe(request.sources, request.target);
        break;
      case "reference-sites":
        result = await tooling.referenceSites(request.sources, request.fromId);
        break;
      case "edit":
        result = await tooling.edit(request.sources, request.edits);
        break;
    }
    return { ok: true, result, reusable: !invalidated };
  } catch (error) {
    return {
      ok: false,
      // Only a process that loaded a verified runtime and finished without a
      // panic may keep its immutable library after an ordinary refusal.
      reusable: !!loaded && !invalidated && !isNativeToolkitPanic(error),
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...codedError(error),
        diagnostics: errorDiagnostics(error),
      },
    };
  }
}

export interface NativeProcessMainOptions {
  processEpoch: string;
  /** Provisioned by the parent CLI; request envelopes cannot select it. */
  snapshotDirectory?: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
  deps?: NativeProcessDeps;
  maxMessageBytes?: number;
  /** Protocol violations are fatal to this process by default. */
  onProtocolError?: (detail: string) => void;
}

function parseRequestLine(
  line: string,
  expectedEpoch: string,
): NativeProcessRequestEnvelope | { protocolError: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { protocolError: "malformed JSON line" };
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    record.v !== NATIVE_PROCESS_PROTOCOL_VERSION ||
    record.kind !== "request" ||
    record.processEpoch !== expectedEpoch ||
    !Number.isSafeInteger(record.id) ||
    typeof record.packageDir !== "string" || record.packageDir.length === 0 ||
    !record.request || typeof record.request !== "object"
  ) {
    return { protocolError: "unexpected request envelope, version or epoch" };
  }
  return record as unknown as NativeProcessRequestEnvelope;
}

/** Run the NDJSON loop until stdin ends or the parent kills this process. */
export async function runToolkitNativeProcess(
  options: NativeProcessMainOptions,
): Promise<void> {
  const stdin = options.stdin ?? Deno.stdin.readable;
  const stdout = options.stdout ?? Deno.stdout.writable;
  const snapshotDirectory = options.snapshotDirectory;
  const deps = options.deps ?? {
    loadRuntime: (packageDir: string, bundle?: ToolkitBundlePin) => {
      if (!snapshotDirectory) {
        throw new ToolkitNativeSnapshotError(
          new Error(
            "Native child requires its parent-owned snapshot directory",
          ),
        );
      }
      return loadSysmlToolkit(packageDir, bundle, {
        snapshotDirectory,
        snapshotCleanup: "process",
      });
    },
  };
  const limit = options.maxMessageBytes ?? MAX_NATIVE_MESSAGE_BYTES;
  const writer = stdout.getWriter();
  const write = async (envelope: NativeProcessResponseEnvelope) => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
    if (bytes.length - 1 > limit) {
      throw new Error("Native toolkit response exceeds its size limit");
    }
    await writer.write(bytes as Uint8Array<ArrayBuffer>);
  };
  const protocol = (detail: string): void => {
    if (options.onProtocolError) options.onProtocolError(detail);
    else {
      log.error(`Native toolkit process protocol failure: ${detail}`);
      Deno.exit(2);
    }
  };
  try {
    await write({
      v: NATIVE_PROCESS_PROTOCOL_VERSION,
      kind: "hello",
      processEpoch: options.processEpoch,
      pid: Deno.pid,
    });
    for await (const line of readBoundedLines(stdin, limit)) {
      const parsed = parseRequestLine(line, options.processEpoch);
      if ("protocolError" in parsed) {
        protocol(parsed.protocolError);
        return;
      }
      await write({
        v: NATIVE_PROCESS_PROTOCOL_VERSION,
        kind: "started",
        id: parsed.id,
        processEpoch: options.processEpoch,
      });
      const outcome = await handleNativeToolkitRequest(
        parsed.packageDir,
        parsed.bundle,
        parsed.request,
        deps,
      );
      await write(
        outcome.ok
          ? {
            v: NATIVE_PROCESS_PROTOCOL_VERSION,
            kind: "result",
            id: parsed.id,
            processEpoch: options.processEpoch,
            ok: true,
            result: outcome.result,
            reusable: outcome.reusable,
          }
          : {
            v: NATIVE_PROCESS_PROTOCOL_VERSION,
            kind: "result",
            id: parsed.id,
            processEpoch: options.processEpoch,
            ok: false,
            reusable: outcome.reusable,
            error: outcome.error ?? {
              message: "Native toolkit operation failed",
              diagnostics: [],
            },
          },
      );
    }
  } catch (error) {
    // An oversized line or a broken stdout leaves no trustworthy channel:
    // fail the process so the parent observes an exit and recycles it.
    protocol(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      writer.releaseLock();
    } catch { /* Already released. */ }
  }
}

/** Epoch from the `--epoch=<value>` argument the client always passes. */
export function processEpochFromArgs(
  args: readonly string[] = Deno.args,
): string {
  for (const arg of args) {
    if (arg.startsWith("--epoch=") && arg.length > "--epoch=".length) {
      return arg.slice("--epoch=".length);
    }
  }
  throw new Error("Native toolkit process requires --epoch=<value>");
}

export function snapshotDirectoryFromArgs(
  args: readonly string[] = Deno.args,
): string {
  const prefix = "--snapshot-dir=";
  const argument = args.find((arg) => arg.startsWith(prefix));
  if (argument && argument.length > prefix.length) {
    return argument.slice(prefix.length);
  }
  throw new ToolkitNativeSnapshotError(
    new Error(
      "Native toolkit process requires --snapshot-dir=<private-directory>",
    ),
  );
}
