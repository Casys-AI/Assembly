import assert from "node:assert/strict";
import {
  BOARD_HEAD_CACHE_MS,
  createModelBoardHeadReader,
} from "./board-reader.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const sources = { "version.sysml": "package Pinned;" };
const snapshot = {
  version: VERSION,
  sources,
  elements: [],
  documents: [],
  sourceDigest: "repository digest",
  semanticDigest: "semantic digest",
  provenanceDigest: "provenance digest",
  sourceHashes: {},
  engineVersion: "test",
};

Deno.test("board head uses lightweight metadata and publication invalidates its cached head", async () => {
  let version = VERSION;
  let calls = 0;
  const read = createModelBoardHeadReader({
    current: () =>
      Promise.reject(new Error("full compiled read is unnecessary")),
    headVersion() {
      calls++;
      return Promise.resolve(version);
    },
  }, () => 100);
  assert.equal(await read(), VERSION);
  version = `commit:${"c".repeat(40)}`;
  assert.equal(await read(), VERSION);
  read.invalidate();
  assert.equal(await read(), version);
  assert.equal(calls, 2);
});

Deno.test("a head completed after invalidation cannot replace the newer pending read", async () => {
  const releases: Array<(value: string) => void> = [];
  const read = createModelBoardHeadReader({
    current: () => Promise.reject(new Error("unexpected full read")),
    headVersion: () => new Promise<string>((resolve) => releases.push(resolve)),
  }, () => 100);
  const before = read();
  await Promise.resolve();
  read.invalidate();
  const after = read();
  await Promise.resolve();
  assert.equal(releases.length, 2);
  releases[0](VERSION);
  assert.equal(await before, VERSION);
  assert.strictEqual(
    read(),
    after,
    "old finally must not clear the newer pending operation",
  );
  const latest = `commit:${"d".repeat(40)}`;
  releases[1](latest);
  assert.equal(await after, latest);
  assert.equal(await read(), latest);
});

Deno.test("board head reader shares concurrent reads and serial reads until its one-second TTL", async () => {
  let now = 0;
  let calls = 0;
  let release!: (revision: typeof snapshot) => void;
  let next = new Promise<typeof snapshot>((resolve) => {
    release = resolve;
  });
  const head = createModelBoardHeadReader({
    current: () => {
      calls++;
      return next;
    },
  }, () => now);
  const pending = Array.from({ length: 30 }, () => head());
  await Promise.resolve();
  assert.equal(calls, 1, "in-flight repository.current is shared");
  release(snapshot);
  assert.deepEqual(await Promise.all(pending), Array(30).fill(VERSION));
  now = BOARD_HEAD_CACHE_MS - 1;
  for (let i = 0; i < 30; i++) assert.equal(await head(), VERSION);
  assert.equal(calls, 1, "serial reads use the cached head");
  const newer = `commit:${"c".repeat(40)}`;
  next = Promise.resolve({ ...snapshot, version: newer });
  now = BOARD_HEAD_CACHE_MS;
  assert.equal(await head(), newer);
  assert.equal(calls, 2, "TTL expires exactly at the boundary");
});

Deno.test("board head reader evicts failed lookups and never revives an expired head", async () => {
  let now = 0;
  let calls = 0;
  const failure = new Error("head unavailable");
  const head = createModelBoardHeadReader({
    current: () => {
      calls++;
      return calls === 1 || calls === 3
        ? Promise.reject(failure)
        : Promise.resolve(snapshot);
    },
  }, () => now);
  const first = [head(), head()];
  for (const pending of first) {
    await assert.rejects(() => pending, (error) => error === failure);
  }
  assert.equal(calls, 1);
  assert.equal(await head(), VERSION);
  assert.equal(calls, 2, "failed lookup is retried immediately");
  now = BOARD_HEAD_CACHE_MS;
  await assert.rejects(() => head(), (error) => error === failure);
  assert.equal(await head(), VERSION);
  assert.equal(calls, 4, "failure after TTL cannot extend the stale cache");
});
