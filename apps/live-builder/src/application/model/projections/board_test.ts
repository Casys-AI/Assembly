import assert from "node:assert/strict";
import { ModelBoardService } from "./board.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";

const VERSION = `commit:${"a".repeat(40)}`;

function board(version: string): ModelBoard {
  return {
    schema: "ase.board/1",
    meta: {
      model: "test",
      mode: "ase",
      sourceDigest: `sources-${version}`,
      diagnostics: [],
      digest: `digest-${version}`,
    },
    columns: [],
    links: [],
    index: {},
  };
}

Deno.test("board reads share one computation across concurrent readers", async () => {
  let computations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ModelBoardService({
    async read(version) {
      computations++;
      await gate;
      return board(version);
    },
  });
  const reads = Array.from({ length: 8 }, () => service.read(VERSION));
  await Promise.resolve();
  assert.equal(computations, 1);
  release();
  const results = await Promise.all(reads);
  assert.equal(computations, 1);
  for (const result of results) {
    assert.equal(result.meta.digest, results[0].meta.digest);
  }
  assert.equal(
    (await service.read(VERSION)).meta.digest,
    results[0].meta.digest,
  );
  assert.equal(computations, 1);
});

Deno.test("a failed board computation evicts so the next read retries", async () => {
  let computations = 0;
  const service = new ModelBoardService({
    read(version) {
      computations++;
      return computations === 1
        ? Promise.reject(new Error("projector"))
        : Promise.resolve(board(version));
    },
  });
  const first = service.read(VERSION);
  const second = service.read(VERSION);
  await assert.rejects(() => first, /projector/);
  await assert.rejects(() => second, /projector/);
  assert.equal(computations, 1);
  assert.equal((await service.read(VERSION)).meta.digest, `digest-${VERSION}`);
  assert.equal(computations, 2);
});

Deno.test("the board cache holds 16 commits and evicts the oldest", async () => {
  let computations = 0;
  const service = new ModelBoardService({
    read(version) {
      computations++;
      return Promise.resolve(board(version));
    },
  });
  const versions = Array.from(
    { length: 17 },
    (_, index) => `commit:${index.toString(16).padStart(40, "0")}`,
  );
  for (const version of versions) await service.read(version);
  assert.equal(computations, 17);
  await service.read(versions[16]);
  assert.equal(computations, 17);
  await service.read(versions[0]);
  assert.equal(computations, 18);
});

Deno.test("board eviction drops the least recently read, not the oldest inserted", async () => {
  let computations = 0;
  const service = new ModelBoardService({
    read(version) {
      computations++;
      return Promise.resolve(board(version));
    },
  });
  const versions = Array.from(
    { length: 17 },
    (_, index) => `commit:${index.toString(16).padStart(40, "0")}`,
  );
  for (const version of versions.slice(0, 16)) await service.read(version);
  await service.read(versions[0]); // recent use protects versions[0]
  await service.read(versions[16]);
  assert.equal(computations, 17);
  await service.read(versions[0]);
  assert.equal(computations, 17, "recently read entry must survive");
  await service.read(versions[1]);
  assert.equal(computations, 18, "least recently read entry is evicted");
});

Deno.test("board grants retain canonical file bounds and report malformed values", async () => {
  const { readBoardGrants } = await import("./board.ts");
  const grants = [{ file: "a.sysml", qualifiedRoots: ["Example::A"] }];
  assert.deepEqual(
    readBoardGrants(JSON.stringify(grants), { element: "policy" }),
    {
      grants,
      diagnostics: [],
    },
  );
  for (
    const value of [
      '[{"qualifiedRoots":["Example"]}]',
      "[]",
      "invalid",
      '[{"file":"../a.sysml","qualifiedRoots":["A"]}]',
    ]
  ) {
    const result = readBoardGrants(value, { element: "policy" });
    assert.deepEqual(result.grants, []);
    assert.equal(result.diagnostics[0].code, "INVALID_MODEL_EDIT_GRANTS");
    assert.deepEqual(result.diagnostics[0].context, { element: "policy" });
  }
});

Deno.test("board service refuses mutable versions before invoking its reader", async () => {
  const service = new ModelBoardService({
    read() {
      throw new Error("reader must not run");
    },
  });
  await assert.rejects(service.read("branch:main"), {
    code: "INVALID_REQUEST",
  });
});

Deno.test("board grant projections are read-only through their qualified roots", async () => {
  const { readBoardGrants } = await import("./board.ts");
  const { grants } = readBoardGrants(
    '[{"file":"a.sysml","qualifiedRoots":["A"]}]',
    {},
  );
  assert.throws(() => {
    // @ts-expect-error The canonical grant projection has deeply readonly roots.
    grants[0].qualifiedRoots.push("B");
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error The grant itself is read-only too.
    grants[0].file = "b.sysml";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error The projected collection is read-only.
    grants.push(grants[0]);
  }, TypeError);
});
