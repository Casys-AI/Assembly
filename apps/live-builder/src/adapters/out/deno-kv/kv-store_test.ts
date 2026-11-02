import { deepStrictEqual, equal } from "node:assert/strict";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { set as setBlob } from "@kitsonk/kv-toolbox/blob";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import { isBusyError, KvModelBuildStore, retryBusy } from "./kv-store.ts";

// KV-backed cases run only when the test process may write (integration
// permissions); the deterministic Busy cases always run without a store.
const kvWritable =
  (await Deno.permissions.query({ name: "write" })).state === "granted";

const busyError = () => new Error("SQLite error: database is locked");

Deno.test("retryBusy retries locked errors with injected deterministic delays", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const value = await retryBusy(() => {
    attempts++;
    return attempts < 3 ? Promise.reject(busyError()) : Promise.resolve("ok");
  }, {
    maxAttempts: 5,
    delayMs: () => 7,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  equal(value, "ok");
  equal(attempts, 3);
  deepStrictEqual(sleeps, [7, 7]);
});

Deno.test("retryBusy never retries a non-busy error", async () => {
  let attempts = 0;
  const failure = new Error("boom");
  let thrown: unknown;
  try {
    await retryBusy(() => {
      attempts++;
      return Promise.reject(failure);
    }, { maxAttempts: 5, sleep: () => Promise.resolve() });
  } catch (error) {
    thrown = error;
  }
  equal(thrown, failure);
  equal(attempts, 1);
  equal(isBusyError(failure), false);
  equal(isBusyError(busyError()), true);
});

Deno.test("retryBusy exhausts to BUILD_STORE_BUSY with the attempt budget", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  let thrown: unknown;
  try {
    await retryBusy(() => {
      attempts++;
      return Promise.reject(busyError());
    }, {
      maxAttempts: 3,
      delayMs: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
  } catch (error) {
    thrown = error;
  }
  equal(attempts, 3);
  deepStrictEqual(sleeps, [0, 0]);
  if (!(thrown instanceof BuildStoreError)) throw thrown;
  equal(thrown.code, "BUILD_STORE_BUSY");
  equal(thrown.context.attempts, 3);
});

function patternBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

function compressLikeAdapter(bytes: Uint8Array): ArrayBuffer {
  const compressed = zstdCompressSync(bytes, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  return copy.buffer;
}

Deno.test({
  name: "kv concurrent repairs of one corrupt digest do not erase each other",
  ignore: !kvWritable,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "w2-repair-" });
    const path = `${directory}/cache.kv`;
    const bytes = patternBytes(4096, 3);
    const digest = await sha256Hex(bytes);
    const store = await KvModelBuildStore.open({ path });
    try {
      equal((await store.put(digest, bytes)).stored, true);
      // Raw corruption under the same complete entry: valid zstd of other bytes.
      const raw = await Deno.openKv(path);
      try {
        await setBlob(
          raw,
          ["build", "blob", digest],
          compressLikeAdapter(patternBytes(4096, 9)),
        );
      } finally {
        raw.close();
      }
      const results = await Promise.all([
        store.put(digest, bytes),
        store.put(digest, bytes),
        store.put(digest, bytes),
        store.put(digest, bytes),
      ]);
      equal(results.every((r) => r.digest === digest), true);
      deepStrictEqual(await store.get(digest), bytes);
    } finally {
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "kv putProjection repairs a tampered meta, readable conflicts still refuse",
  ignore: !kvWritable,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "w2-meta-" });
    const path = `${directory}/cache.kv`;
    const artifactKey = "a".repeat(64);
    const bytes = patternBytes(2048, 5);
    const other = patternBytes(2048, 6);
    const store = await KvModelBuildStore.open({ path });
    try {
      equal(
        (await store.putProjection("board", "1", artifactKey, bytes)).stored,
        true,
      );
      // Readable entry, different content under the same identity: conflict.
      let code = "";
      try {
        await store.putProjection("board", "1", artifactKey, other);
      } catch (error) {
        if (error instanceof BuildStoreError) code = error.code;
        else throw error;
      }
      equal(code, "BUILD_BLOB_CONFLICT");
      // Tamper only the meta sha: the old pre-read comparison made this an
      // irreparable conflict; now the entry is read first and repaired.
      const raw = await Deno.openKv(path);
      try {
        await raw.set(["proj-meta", "board", "1", artifactKey], {
          bytes: bytes.byteLength,
          sha256: "f".repeat(64),
          at: 0,
        });
      } finally {
        raw.close();
      }
      const repaired = await store.putProjection(
        "board",
        "1",
        artifactKey,
        bytes,
      );
      equal(repaired.stored, true);
      deepStrictEqual(
        await store.getProjection("board", "1", artifactKey),
        bytes,
      );
    } finally {
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
