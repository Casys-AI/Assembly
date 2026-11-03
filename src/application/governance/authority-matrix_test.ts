import assert from "node:assert/strict";
import { AuthorityMatrixService } from "./authority-matrix.ts";
import {
  MATRIX_VERSION,
  matrixFixture,
} from "../../../test/support/authority-matrix-fixtures.ts";

Deno.test("matrix concurrent reads share one computation and cached result", async () => {
  let computations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const service = new AuthorityMatrixService({
    async read(version) {
      computations++;
      await gate;
      return matrixFixture(version);
    },
  });
  const reads = Array.from({ length: 12 }, () => service.read(MATRIX_VERSION));
  await Promise.resolve();
  assert.equal(computations, 1);
  release();
  const results = await Promise.all(reads);
  for (const result of results) assert.equal(result, results[0]);
  assert.equal(await service.read(MATRIX_VERSION), results[0]);
  assert.equal(computations, 1);
});

Deno.test("matrix rejected and synchronously thrown reads evict and retry", async () => {
  for (const synchronous of [false, true]) {
    let computations = 0;
    const service = new AuthorityMatrixService({
      read(version) {
        computations++;
        if (computations === 1) {
          if (synchronous) throw new Error("projection failed");
          return Promise.reject(new Error("projection failed"));
        }
        return Promise.resolve(matrixFixture(version));
      },
    });
    const reads = Array.from({ length: 8 }, () => service.read(MATRIX_VERSION));
    const results = await Promise.allSettled(reads);
    assert.equal(computations, 1);
    for (const result of results) assert.equal(result.status, "rejected");
    assert.equal((await service.read(MATRIX_VERSION)).version, MATRIX_VERSION);
    assert.equal(computations, 2);
  }
});

Deno.test("matrix caches 32 versions with LRU recency, not sourceDigest", async () => {
  const calls: string[] = [];
  const service = new AuthorityMatrixService({
    read(version) {
      calls.push(version);
      // All these fixtures deliberately share one sourceDigest.
      return Promise.resolve(matrixFixture(version));
    },
  });
  const versions = Array.from(
    { length: 33 },
    (_, n) => `commit:${n.toString(16).padStart(40, "0")}`,
  );
  for (const version of versions.slice(0, 32)) await service.read(version);
  await service.read(versions[0]);
  await service.read(versions[32]);
  await service.read(versions[0]);
  assert.equal(calls.length, 33);
  await service.read(versions[1]);
  assert.equal(calls.length, 34);
  assert.equal(calls.at(-1), versions[1]);
});

Deno.test("matrix invalid mutable versions never reach the reader", async () => {
  const service = new AuthorityMatrixService({
    read() {
      throw new Error("must not run");
    },
  });
  for (
    const version of [
      "",
      "branch:main",
      "commit:abc",
      `commit:${"A".repeat(40)}`,
    ]
  ) {
    await assert.rejects(service.read(version), { code: "INVALID_REQUEST" });
  }
});

Deno.test("completed LRU pressure never evicts a pending matrix version", async () => {
  let reject!: (reason: Error) => void;
  let calls = 0;
  const service = new AuthorityMatrixService({
    read(version) {
      calls++;
      if (calls === 1) return new Promise((_, no) => reject = no);
      return Promise.resolve(matrixFixture(version));
    },
  });
  const old = service.read(MATRIX_VERSION);
  const first = assert.rejects(old, /old failure/);
  for (let n = 0; n < 40; n++) {
    await service.read(`commit:${n.toString(16).padStart(40, "0")}`);
  }
  const second = assert.rejects(service.read(MATRIX_VERSION), /old failure/);
  assert.equal(
    calls,
    41,
    "same pending computation survived more than32 completed versions",
  );
  reject(new Error("old failure"));
  await Promise.all([first, second]);
  await service.read(MATRIX_VERSION);
  assert.equal(calls, 42);
});

Deno.test("matrix rejects a mismatched reply before caching and retries the requested version", async () => {
  const requested = `commit:${"b".repeat(40)}`;
  let calls = 0;
  const service = new AuthorityMatrixService({
    read(version) {
      calls++;
      return Promise.resolve(
        matrixFixture(calls === 1 ? MATRIX_VERSION : version),
      );
    },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => service.read(requested)),
  );
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.reason.code, "MODEL_VERSION_MISMATCH");
      assert.deepEqual(result.reason.context, {
        version: requested,
        receivedVersion: MATRIX_VERSION,
      });
      assert.ok(result.reason.recovery);
    }
  }
  assert.equal((await service.read(requested)).version, requested);
  await service.read(requested);
  assert.equal(calls, 2);
});
