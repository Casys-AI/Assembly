import assert from "node:assert/strict";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { set as setBlob } from "@kitsonk/kv-toolbox/blob";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { BuildStoreError } from "../../src/application/model/builds/ports/out/build-store.port.ts";

const ARTIFACT = "a".repeat(64);

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function digest(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(
    new Uint8Array(hash),
    (n) => n.toString(16).padStart(2, "0"),
  )
    .join("");
}

async function withTwoHandles(
  quotaBytes: number | undefined,
  run: (
    a: KvModelBuildStore,
    b: KvModelBuildStore,
    path: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "kv-build-race-" });
  const path = `${dir}/cache.kv`;
  let a: KvModelBuildStore | undefined;
  let b: KvModelBuildStore | undefined;
  try {
    a = await KvModelBuildStore.open({ path, quotaBytes });
    b = await KvModelBuildStore.open({ path, quotaBytes });
    await run(a, b, path);
  } finally {
    await b?.close();
    await a?.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function outcomes<T>(results: PromiseSettledResult<T>[]) {
  return {
    successes: results.filter((r): r is PromiseFulfilledResult<T> =>
      r.status === "fulfilled"
    ),
    failures: results.filter((r): r is PromiseRejectedResult =>
      r.status === "rejected"
    ),
  };
}

function assertCode(error: unknown, code: string): void {
  assert.ok(error instanceof BuildStoreError, String(error));
  assert.equal(error.code, code);
}

Deno.test("KV projection: competing bytes have one winner, preserved after reopen", async () => {
  await withTwoHandles(undefined, async (a, b, path) => {
    const first = bytes(40_000, 1);
    const second = bytes(40_000, 2);
    const results = await Promise.allSettled([
      a.putProjection("board", "v1", ARTIFACT, first),
      b.putProjection("board", "v1", ARTIFACT, second),
    ]);
    const { successes, failures } = outcomes(results);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assertCode(failures[0].reason, "BUILD_BLOB_CONFLICT");
    const winner = results[0].status === "fulfilled" ? first : second;
    assert.equal(successes[0].value.stored, true);
    assert.deepEqual(await a.getProjection("board", "v1", ARTIFACT), winner);
    await b.sweep();
    assert.deepEqual(await a.getProjection("board", "v1", ARTIFACT), winner);

    const reopened = await KvModelBuildStore.open({ path });
    try {
      assert.deepEqual(
        await reopened.getProjection("board", "v1", ARTIFACT),
        winner,
      );
      assert.equal((await reopened.stats()).projectionCount, 1);
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("KV put snapshots caller bytes before its first await", async () => {
  await withTwoHandles(undefined, async (store, other) => {
    const buildOriginal = bytes(40_000, 16);
    const buildCaller = new Uint8Array(buildOriginal);
    const buildDigest = await digest(buildOriginal);
    const buildPut = store.put(buildDigest, buildCaller);
    buildCaller.fill(0);
    assert.equal((await buildPut).stored, true);
    assert.deepEqual(await other.get(buildDigest), buildOriginal);

    const projectionOriginal = bytes(40_000, 17);
    const projectionCaller = new Uint8Array(projectionOriginal);
    const projectionPut = store.putProjection(
      "board",
      "v1",
      ARTIFACT,
      projectionCaller,
    );
    projectionCaller.fill(0);
    assert.equal((await projectionPut).stored, true);
    assert.deepEqual(
      await other.getProjection("board", "v1", ARTIFACT),
      projectionOriginal,
    );
  });
});

Deno.test("KV projection: concurrent identical puts are idempotent", async () => {
  await withTwoHandles(undefined, async (a, b) => {
    const value = bytes(40_000, 3);
    const results = await Promise.all([
      a.putProjection("board", "v1", ARTIFACT, value),
      b.putProjection("board", "v1", ARTIFACT, value),
    ]);
    assert.ok(results.some((r) => r.stored));
    assert.ok(results.filter((r) => r.stored).length <= 1);
    assert.deepEqual(await b.getProjection("board", "v1", ARTIFACT), value);
    assert.equal((await a.stats()).projectionCount, 1);
  });
});

Deno.test("KV projection: concurrent repair of corrupt logical meta preserves winner", async () => {
  await withTwoHandles(undefined, async (a, b, path) => {
    const original = bytes(40_000, 4);
    await a.putProjection("board", "v1", ARTIFACT, original);
    const raw = await Deno.openKv(path);
    try {
      const key = ["proj-meta", "board", "v1", ARTIFACT] as const;
      const meta = await raw.get<{ bytes: number; sha256: string; at: number }>(
        key,
      );
      assert.ok(meta.value);
      await raw.set(key, { ...meta.value, sha256: "0".repeat(64) });
    } finally {
      raw.close();
    }

    const first = bytes(40_000, 5);
    const second = bytes(40_000, 6);
    const results = await Promise.allSettled([
      a.putProjection("board", "v1", ARTIFACT, first),
      b.putProjection("board", "v1", ARTIFACT, second),
    ]);
    const { successes, failures } = outcomes(results);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assertCode(failures[0].reason, "BUILD_BLOB_CONFLICT");
    const winner = results[0].status === "fulfilled" ? first : second;
    assert.deepEqual(await b.getProjection("board", "v1", ARTIFACT), winner);
    const reopened = await KvModelBuildStore.open({ path });
    try {
      assert.deepEqual(
        await reopened.getProjection("board", "v1", ARTIFACT),
        winner,
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("KV quota: two build puts of 60 bytes cannot exceed 100", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const first = bytes(60, 7);
    const second = bytes(60, 8);
    const keys = await Promise.all([digest(first), digest(second)]);
    const results = await Promise.allSettled([
      a.put(keys[0], first),
      b.put(keys[1], second),
    ]);
    const { successes, failures } = outcomes(results);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assertCode(failures[0].reason, "BUILD_STORE_QUOTA_EXCEEDED");
    const reopened = await KvModelBuildStore.open({ path, quotaBytes: 100 });
    try {
      const stats = await reopened.stats();
      assert.ok(stats.uncompressedBytes <= 100, JSON.stringify(stats));
      const winner = results[0].status === "fulfilled" ? 0 : 1;
      assert.deepEqual(
        await reopened.get(keys[winner]),
        winner === 0 ? first : second,
      );
      assert.equal(await reopened.has(keys[1 - winner]), false);
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("KV quota: build and projection compete for one 100-byte allowance", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const build = bytes(60, 9);
    const projection = bytes(60, 10);
    const key = await digest(build);
    const results = await Promise.allSettled([
      a.put(key, build),
      b.putProjection("board", "v1", ARTIFACT, projection),
    ]);
    const { successes, failures } = outcomes(results);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assertCode(failures[0].reason, "BUILD_STORE_QUOTA_EXCEEDED");
    const reopened = await KvModelBuildStore.open({ path, quotaBytes: 100 });
    try {
      const stats = await reopened.stats();
      assert.ok(stats.uncompressedBytes <= 100, JSON.stringify(stats));
      if (results[0].status === "fulfilled") {
        assert.deepEqual(await reopened.get(key), build);
        assert.equal(
          await reopened.hasProjection("board", "v1", ARTIFACT),
          false,
        );
      } else {
        assert.deepEqual(
          await reopened.getProjection("board", "v1", ARTIFACT),
          projection,
        );
        assert.equal(await reopened.has(key), false);
      }
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("KV quota: two distinct projections of 60 bytes cannot exceed 100", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const first = bytes(60, 12);
    const second = bytes(60, 13);
    const otherArtifact = "b".repeat(64);
    const results = await Promise.allSettled([
      a.putProjection("board", "v1", ARTIFACT, first),
      b.putProjection("board", "v1", otherArtifact, second),
    ]);
    const { successes, failures } = outcomes(results);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assertCode(failures[0].reason, "BUILD_STORE_QUOTA_EXCEEDED");
    const reopened = await KvModelBuildStore.open({ path, quotaBytes: 100 });
    try {
      const stats = await reopened.stats();
      assert.equal(stats.projectionCount, 1);
      assert.ok(stats.uncompressedBytes <= 100, JSON.stringify(stats));
      const winner = results[0].status === "fulfilled"
        ? ARTIFACT
        : otherArtifact;
      assert.deepEqual(
        await reopened.getProjection("board", "v1", winner),
        winner === ARTIFACT ? first : second,
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test("KV quota: a durable unfinished build reservation remains charged", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const unfinished = bytes(60, 14);
    const reservedDigest = await digest(unfinished);
    const raw = await Deno.openKv(path);
    try {
      // Simulate a crash after accounting publication but before blob write.
      await raw.set(["use", reservedDigest], {
        at: Date.now(),
        bytes: 60,
        class: "build",
      });
    } finally {
      raw.close();
    }
    const next = bytes(60, 15);
    assertCode(
      await b.put(await digest(next), next).then(() => null, (e) => e),
      "BUILD_STORE_QUOTA_EXCEEDED",
    );
    assert.equal(await a.has(reservedDigest), false);
    assert.equal((await a.stats()).uncompressedBytes, 60);
  });
});

Deno.test("KV quota: malformed prior projection bytes cannot bypass accounting", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const originalProjection = bytes(40, 18);
    const build = bytes(60, 19);
    const buildDigest = await digest(build);
    await a.putProjection("board", "v1", ARTIFACT, originalProjection);
    await b.put(buildDigest, build);

    const raw = await Deno.openKv(path);
    const key = ["proj-meta", "board", "v1", ARTIFACT] as const;
    let corrupted: unknown;
    try {
      const entry = await raw.get<Record<string, unknown>>(key);
      assert.ok(entry.value);
      corrupted = { ...entry.value, bytes: "broken" };
      await raw.set(key, corrupted);
    } finally {
      raw.close();
    }

    const replacement = bytes(60, 20);
    assertCode(
      await a.putProjection("board", "v1", ARTIFACT, replacement).then(
        () => null,
        (error) => error,
      ),
      "BUILD_BLOB_CORRUPT",
    );
    const check = await Deno.openKv(path);
    try {
      assert.deepEqual((await check.get(key)).value, corrupted);
    } finally {
      check.close();
    }
    assert.deepEqual(await b.get(buildDigest), build);
  });
});

Deno.test("KV quota: full store refuses projection before creating physical bytes", async () => {
  await withTwoHandles(100, async (a, b, path) => {
    const full = bytes(100, 21);
    await a.put(await digest(full), full);
    const physicalCount = async (): Promise<number> => {
      const raw = await Deno.openKv(path);
      try {
        let count = 0;
        for await (const _ of raw.list({ prefix: ["proj-bytes"] })) count++;
        return count;
      } finally {
        raw.close();
      }
    };
    const before = await physicalCount();
    for (const [index, artifact] of ["b", "c", "d"].entries()) {
      const candidate = bytes(60, index + 22);
      assertCode(
        await b.putProjection("board", "v1", artifact.repeat(64), candidate)
          .then(() => null, (error) => error),
        "BUILD_STORE_QUOTA_EXCEEDED",
      );
      assert.equal(await physicalCount(), before);
    }
    assert.equal((await a.stats()).uncompressedBytes, 100);
  });
});

Deno.test("KV quota: separate processes cannot publish two 60-byte projections", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kv-build-process-race-" });
  const path = `${dir}/cache.kv`;
  const barrier = `${dir}/release`;
  const script = `${dir}/writer.ts`;
  const adapterUrl = new URL(
    "../../src/adapters/out/deno-kv/kv-store.ts",
    import.meta.url,
  ).href;
  const configPath = fileURLToPath(new URL("../../deno.json", import.meta.url));
  const worker = `
    import { KvModelBuildStore } from ${JSON.stringify(adapterUrl)};
    const [path, barrier, id] = Deno.args;
    const store = await KvModelBuildStore.open({ path, quotaBytes: 100 });
    await Deno.writeTextFile(barrier + "." + id, "ready");
    while (true) {
      try { await Deno.stat(barrier); break; }
      catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    try {
      const value = new Uint8Array(60).fill(Number(id) + 1);
      const result = await store.putProjection("board", "v1", id.repeat(64), value);
      console.log(JSON.stringify({ ok: true, stored: result.stored }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code ?? String(e) }));
    } finally { await store.close(); }
  `;
  const children: Deno.ChildProcess[] = [];
  try {
    await Deno.writeTextFile(script, worker);
    for (const id of ["a", "b"]) {
      children.push(new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          `--config=${configPath}`,
          script,
          path,
          barrier,
          id,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn());
    }
    const deadline = Date.now() + 5_000;
    while (true) {
      const ready = await Promise.all(["a", "b"].map(async (id) => {
        try {
          await Deno.stat(`${barrier}.${id}`);
          return true;
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) return false;
          throw e;
        }
      }));
      if (ready.every(Boolean)) break;
      assert.ok(
        Date.now() < deadline,
        "workers did not reach the start barrier",
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Deno.writeTextFile(barrier, "go");
    const outputs = await Promise.all(children.map((child) => child.output()));
    const decoder = new TextDecoder();
    const results = outputs.map((output) => {
      assert.equal(output.code, 0, decoder.decode(output.stderr));
      return JSON.parse(decoder.decode(output.stdout).trim()) as {
        ok: boolean;
        stored?: boolean;
        code?: string;
      };
    });
    assert.equal(
      results.filter((r) => r.ok && r.stored).length,
      1,
      JSON.stringify(results),
    );
    assert.deepEqual(
      results.filter((r) => !r.ok).map((r) => r.code),
      ["BUILD_STORE_QUOTA_EXCEEDED"],
    );
    const reopened = await KvModelBuildStore.open({ path, quotaBytes: 100 });
    try {
      const stats = await reopened.stats();
      assert.equal(stats.projectionCount, 1);
      assert.ok(stats.uncompressedBytes <= 100, JSON.stringify(stats));
    } finally {
      await reopened.close();
    }
  } finally {
    for (const child of children) {
      try {
        child.kill();
      } catch { /* already exited */ }
    }
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("KV projection: legacy physical key remains readable", async () => {
  await withTwoHandles(undefined, async (store, _other, path) => {
    const value = bytes(256, 11);
    const hash = await digest(value);
    const compressed = zstdCompressSync(value, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: 3,
        [zlibConstants.ZSTD_c_checksumFlag]: 1,
      },
    });
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    const raw = await Deno.openKv(path);
    try {
      await setBlob(raw, ["proj", "board", "v1", ARTIFACT], copy.buffer);
      await raw.set(["proj-meta", "board", "v1", ARTIFACT], {
        bytes: value.byteLength,
        sha256: hash,
        at: Date.now(),
      });
    } finally {
      raw.close();
    }
    assert.equal(await store.hasProjection("board", "v1", ARTIFACT), true);
    assert.deepEqual(
      await store.getProjection("board", "v1", ARTIFACT),
      value,
    );
  });
});
