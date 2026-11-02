/** Subprocess driver for W2c robustness tests (plan W2, l.650-658).
 *
 * Standalone Deno program with explicit CLI arguments (no ambiguity) that
 * opens a `KvModelBuildStore` at a given path and performs one store
 * operation per invocation. The parent test spawns it with `Deno.Command`,
 * reads machine-readable events (one JSON object per stdout line), and may
 * SIGKILL it mid-`put` to exercise orphan sweep.
 *
 * Deterministic: same arguments yield the same bytes (explicit seed).
 * Store errors are copied verbatim (`code`, `context`, `recovery`).
 */

import {
  BuildStoreError,
  type BuildStoreErrorCode,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";

const EXIT_OK = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE: Record<BuildStoreErrorCode, number> = {
  BUILD_BLOB_MISSING: 3,
  BUILD_BLOB_CORRUPT: 4,
  BUILD_BLOB_CONFLICT: 5,
  BUILD_STORE_UNAVAILABLE: 6,
  BUILD_STORE_BUSY: 7,
  BUILD_STORE_QUOTA_EXCEEDED: 8,
  BUILD_STORE_INVALID_INPUT: 9,
};

type Command =
  | "put"
  | "put-file"
  | "get"
  | "has"
  | "lease"
  | "slow-put"
  | "loop-put"
  | "sweep"
  | "stats";

function usage(): string {
  return `kv-writer: drive a KvModelBuildStore from explicit CLI arguments.
Usage:
  kv-writer.ts --store <kv-path> [--quota-bytes <n>] <command> [args...]
Commands:
  put --seed <u32> --bytes <n> [--digest <hex64>]
  put-file --file <path> [--digest <hex64>]
  get --digest <hex64>
  has --digest <hex64>
  lease --key <k> --owner <o> --ttl-ms <n> [--hold-ms <n>] [--count <n>]
  slow-put --seed <u32> --bytes <n> [--digest <hex64>] [--lead-steps <n> [--lead-delay-ms <n>]]
  loop-put --seed <u32> --bytes <n> --count <n> [--delay-ms <n>]
  sweep
  stats
Stdout: one JSON object per line ({event:"open"|"progress"|"result"|"error", ...}).`;
}

function fail(message: string): never {
  console.error(`kv-writer usage: ${message}\n${usage()}`);
  Deno.exit(EXIT_USAGE);
}

function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (value === undefined || value === "") fail(`missing --${name}`);
  return value as string;
}

function optionalInt(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`--${name} must be an integer >= 0`);
  }
  return value;
}

function requiredInt(args: string[], name: string): number {
  const value = optionalInt(args, name);
  if (value === undefined) fail(`missing --${name}`);
  return value as number;
}

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function exitFor(error: unknown): never {
  if (error instanceof BuildStoreError) {
    emit({
      event: "error",
      code: error.code,
      context: error.context,
      recovery: error.recovery,
      message: error.message,
    });
    Deno.exit(EXIT_BY_CODE[error.code]);
  }
  emit({
    event: "error",
    code: "UNEXPECTED",
    context: { message: String(error) },
    recovery: "Inspect the subprocess stderr and arguments, then retry.",
    message: String(error),
  });
  Deno.exit(EXIT_UNEXPECTED);
}

/** Deterministic bytes from an explicit seed (xorshift32; seed 0 is remapped
 * so it still yields a non-degenerate stream). Same seed + size = same bytes. */
function deterministicBytes(seed: number, size: number): Uint8Array {
  let state = (seed >>> 0) || 0x243f6a88;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const raw = Deno.args.slice();
const storePath = required(raw, "store");
const quotaBytes = optionalInt(raw, "quota-bytes");
// Drop the two global flags (and their values) so only the command remains.
const rest: string[] = [];
for (let i = 0; i < raw.length; i++) {
  const arg = raw[i];
  const name = arg.startsWith("--") ? arg.slice(2).split("=", 1)[0] : "";
  if (name === "store" || name === "quota-bytes") {
    if (!arg.includes("=")) i++;
    continue;
  }
  rest.push(arg);
}
const command = rest[0] as Command | undefined;
const cmdArgs = rest.slice(1);
if (command === undefined) fail("missing command");
const KNOWN: ReadonlySet<string> = new Set([
  "put",
  "put-file",
  "get",
  "has",
  "lease",
  "slow-put",
  "loop-put",
  "sweep",
  "stats",
]);
if (!KNOWN.has(command)) fail(`unknown command: ${command}`);

const openOptions = quotaBytes === undefined
  ? { path: storePath }
  : { path: storePath, quotaBytes };

let store: KvModelBuildStore;
try {
  store = await KvModelBuildStore.open(openOptions);
} catch (error) {
  exitFor(error);
}
emit({ event: "open", store: storePath });

try {
  switch (command) {
    case "put":
    case "slow-put": {
      const seed = requiredInt(cmdArgs, "seed");
      const size = requiredInt(cmdArgs, "bytes");
      const bytes = deterministicBytes(seed, size);
      const digest = flag(cmdArgs, "digest") ?? await sha256Hex(bytes);
      if (command === "slow-put") {
        const steps = optionalInt(cmdArgs, "lead-steps") ?? 0;
        const delayMs = optionalInt(cmdArgs, "lead-delay-ms") ?? 0;
        for (let step = 1; step <= steps; step++) {
          emit({ event: "progress", command, step, steps, detail: "lead-in" });
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      emit({ event: "progress", command, step: "putting", detail: digest });
      const result = await store.put(digest, bytes);
      emit({ event: "result", command, ok: true, ...result });
      break;
    }
    case "put-file": {
      const path = required(cmdArgs, "file");
      const fileBytes = await Deno.readFile(path);
      const digest = flag(cmdArgs, "digest") ?? await sha256Hex(fileBytes);
      emit({ event: "progress", command, step: "putting", detail: digest });
      const result = await store.put(digest, fileBytes);
      emit({ event: "result", command, ok: true, ...result });
      break;
    }
    case "get": {
      const digest = required(cmdArgs, "digest");
      const bytes = await store.get(digest);
      const actual = await sha256Hex(bytes);
      emit({
        event: "result",
        command,
        ok: true,
        digest,
        bytes: bytes.byteLength,
        sha256: actual,
        match: actual === digest,
      });
      break;
    }
    case "has": {
      const digest = required(cmdArgs, "digest");
      emit({
        event: "result",
        command,
        ok: true,
        digest,
        present: await store.has(digest),
      });
      break;
    }
    case "lease": {
      const key = required(cmdArgs, "key");
      const owner = required(cmdArgs, "owner");
      const ttlMs = requiredInt(cmdArgs, "ttl-ms");
      if (ttlMs <= 0) fail("--ttl-ms must be > 0");
      const count = optionalInt(cmdArgs, "count") ?? 1;
      let successes = 0;
      let refusals = 0;
      let acquired = false;
      for (let i = 0; i < count; i++) {
        acquired = await store.acquireLease(key, owner, ttlMs);
        if (acquired) successes++;
        else refusals++;
      }
      emit({
        event: "result",
        command,
        ok: true,
        key,
        owner,
        acquired,
        successes,
        refusals,
      });
      const holdMs = optionalInt(cmdArgs, "hold-ms") ?? 0;
      if (count === 1 && acquired && holdMs > 0) {
        await sleep(holdMs);
        await store.releaseLease(key, owner);
        emit({
          event: "result",
          command: "lease-release",
          ok: true,
          key,
          owner,
        });
      }
      break;
    }
    case "loop-put": {
      // Repeated puts with one progress line per iteration so the parent can
      // SIGKILL at any point; iteration i stores sha256(seed, i) addressing.
      const seed = requiredInt(cmdArgs, "seed");
      const size = requiredInt(cmdArgs, "bytes");
      const count = requiredInt(cmdArgs, "count");
      const delayMs = optionalInt(cmdArgs, "delay-ms") ?? 0;
      for (let i = 0; i < count; i++) {
        const bytes = deterministicBytes(seed ^ (i * 0x9e3779b9), size);
        const digest = await sha256Hex(bytes);
        const result = await store.put(digest, bytes);
        emit({
          event: "progress",
          command,
          step: i + 1,
          steps: count,
          ...result,
        });
        if (delayMs > 0) await sleep(delayMs);
      }
      emit({ event: "result", command, ok: true, count });
      break;
    }
    case "sweep": {
      emit({ event: "result", command, ok: true, ...(await store.sweep()) });
      break;
    }
    case "stats": {
      emit({ event: "result", command, ok: true, ...(await store.stats()) });
      break;
    }
    default:
      fail(`unknown command: ${command}`);
  }
} catch (error) {
  exitFor(error);
} finally {
  await store.close();
}
Deno.exit(EXIT_OK);
