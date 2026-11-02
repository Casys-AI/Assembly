import assert from "node:assert/strict";
import {
  ModelRepositoryError,
  type ModelRepositoryPort,
} from "../../../application/model/repository.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";
import {
  BOARD_HEAD_CACHE_MS,
  BOARD_TIMEOUT_BACKOFF_MS,
  createModelBoardHeadReader,
  ToolkitModelBoardReader,
} from "./board-reader.ts";
import { SysmlToolkitError } from "../../out/sysml-toolkit/adapter.ts";
import { SysmlToolkitTimeoutError } from "../../out/sysml-toolkit/worker-client.ts";

const VERSION = `commit:${"b".repeat(40)}`;

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
const board: ModelBoard = {
  schema: "ase.board/1",
  meta: {
    model: "test",
    mode: "ase",
    sourceDigest: "projector digest",
    diagnostics: [],
    digest: "b".repeat(64),
  },
  columns: [],
  links: [],
  index: {},
};

Deno.test("board reader projects only the requested immutable snapshot and preserves projector metadata", async () => {
  const versions: string[] = [];
  const inputs: unknown[] = [];
  const reader = new ToolkitModelBoardReader({
    at(version) {
      versions.push(version);
      return Promise.resolve(snapshot);
    },
  }, {
    board(input) {
      inputs.push(structuredClone(input));
      return Promise.resolve(board);
    },
  });
  assert.strictEqual(await reader.read(VERSION), board);
  assert.deepEqual(versions, [VERSION]);
  assert.deepEqual(inputs, [sources]);
  assert.equal(board.meta.sourceDigest, "projector digest");
});

Deno.test("board reader maps active and queued Toolkit deadlines to bounded versioned errors", async () => {
  for (const started of [false, true]) {
    const reader = new ToolkitModelBoardReader({
      at: () => Promise.resolve(snapshot),
    }, {
      board: () => Promise.reject(new SysmlToolkitTimeoutError(1234, started)),
    }, () => 0);
    await assert.rejects(() => reader.read(VERSION), (error: unknown) => {
      const failure = error as {
        code: string;
        context: unknown;
        recovery: string;
      };
      assert.equal(failure.code, "TOOLKIT_TIMEOUT");
      assert.deepEqual(failure.context, {
        version: VERSION,
        timeoutMs: 1234,
        started,
        retryAfterMs: BOARD_TIMEOUT_BACKOFF_MS,
      });
      assert.ok(failure.recovery.length > 0);
      return true;
    });
  }
});

Deno.test("board reader preserves repository and ordinary projector failures without fallback", async () => {
  const repositoryFailure = new Error("immutable snapshot missing");
  const projectorFailure = new Error("projection failed");
  let calls = 0;
  const repository: Pick<ModelRepositoryPort, "at"> = {
    at: () => Promise.reject(repositoryFailure),
  };
  const reader = new ToolkitModelBoardReader(repository, {
    board() {
      calls++;
      return Promise.reject(projectorFailure);
    },
  });
  await assert.rejects(
    () => reader.read(VERSION),
    (error) => error === repositoryFailure,
  );
  assert.equal(calls, 0);
  repository.at = () => Promise.resolve(snapshot);
  await assert.rejects(
    () => reader.read(VERSION),
    (error) => error === projectorFailure,
  );
  assert.equal(calls, 1);
});

Deno.test("board reader suppresses thirty immediate timeout retries per version and retries at expiry", async () => {
  let now = 100;
  let repositoryCalls = 0;
  let toolkitCalls = 0;
  const reader = new ToolkitModelBoardReader({
    at: () => {
      repositoryCalls++;
      return Promise.resolve(snapshot);
    },
  }, {
    board: () => {
      toolkitCalls++;
      return Promise.reject(new SysmlToolkitTimeoutError(3000, true));
    },
  }, () => now);
  const timedOut = (version: string, retryAfterMs: number) =>
    assert.rejects(() => reader.read(version), (error) => {
      assert.deepEqual(error, {
        code: "TOOLKIT_TIMEOUT",
        context: { version, timeoutMs: 3000, started: true, retryAfterMs },
        recovery:
          "The board exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop.",
      });
      return true;
    });
  await timedOut(VERSION, BOARD_TIMEOUT_BACKOFF_MS);
  for (let i = 0; i < 30; i++) {
    await timedOut(VERSION, BOARD_TIMEOUT_BACKOFF_MS);
  }
  assert.equal(repositoryCalls, 1);
  assert.equal(toolkitCalls, 1);
  now += 250;
  await timedOut(VERSION, BOARD_TIMEOUT_BACKOFF_MS - 250);
  const other = `commit:${"c".repeat(40)}`;
  await timedOut(other, BOARD_TIMEOUT_BACKOFF_MS);
  assert.equal(toolkitCalls, 2, "a different version has its own budget");
  now = 100 + BOARD_TIMEOUT_BACKOFF_MS;
  await timedOut(VERSION, BOARD_TIMEOUT_BACKOFF_MS);
  assert.equal(repositoryCalls, 3);
  assert.equal(toolkitCalls, 3, "expiry permits a fresh Toolkit attempt");
});

Deno.test("board reader bounds retained timeout versions and evicts the oldest", async () => {
  let calls = 0;
  const reader = new ToolkitModelBoardReader({
    at: () => Promise.resolve(snapshot),
  }, {
    board: () => {
      calls++;
      return Promise.reject(new SysmlToolkitTimeoutError(3000, true));
    },
  }, () => 0);
  const versions = Array.from(
    { length: 17 },
    (_, i) => `commit:${i.toString(16).padStart(40, "0")}`,
  );
  for (const version of versions) {
    await assert.rejects(() => reader.read(version));
  }
  assert.equal(calls, 17);
  await assert.rejects(() => reader.read(versions[1]));
  assert.equal(calls, 17, "recent version retained without Toolkit work");
  await assert.rejects(() => reader.read(versions[0]));
  assert.equal(calls, 18, "oldest timeout evicted at the bounded capacity");
});

Deno.test("board reader preserves useful coded Toolkit and repository failures without caching them", async () => {
  const diagnostics = [{
    severity: "error" as const,
    code: "SEMANTIC_ERROR",
    message: "invalid type",
  }];
  for (const code of [undefined, "TOOLKIT_SEMANTIC_FAILURE"]) {
    let calls = 0;
    const reader = new ToolkitModelBoardReader({
      at: () => Promise.resolve(snapshot),
    }, {
      board: () => {
        calls++;
        return Promise.reject(
          new SysmlToolkitError(
            "deterministic projection error",
            diagnostics,
            code,
          ),
        );
      },
    });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => reader.read(VERSION), (error) => {
        assert.deepEqual(error, {
          code: code ?? "MODEL_BOARD_TOOLKIT_FAILED",
          context: {
            version: VERSION,
            message: "deterministic projection error",
            diagnostics,
          },
          recovery:
            "Correct the reported model or Toolkit problem; use a corrected commit if sources change.",
        });
        return true;
      });
    }
    assert.equal(calls, 2);
  }
  for (const code of ["NOT_FOUND", "INVALID_REPOSITORY"] as const) {
    const reader = new ToolkitModelBoardReader({
      at: () =>
        Promise.reject(new ModelRepositoryError(code, "snapshot unavailable")),
    }, {
      board: () => {
        throw new Error("must not project an unread snapshot");
      },
    });
    await assert.rejects(() => reader.read(VERSION), (error) => {
      assert.deepEqual(error, {
        code,
        context: { version: VERSION, message: "snapshot unavailable" },
        recovery: code === "NOT_FOUND"
          ? "Choose an existing commit from /api/model-history."
          : "Inspect the model repository and restore a valid snapshot before reading this version.",
      });
      return true;
    });
  }
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
