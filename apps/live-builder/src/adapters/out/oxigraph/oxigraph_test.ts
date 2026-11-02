import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  type BuildRef,
  buildRefKey,
  parseProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import { SemanticIndexError } from "../../../application/model/semantic/index-service.ts";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import {
  DenoChildProcessRequester,
  type DenoChildRequesterOptions,
  executeSemanticIndexWireOperation,
  InProcessSemanticIndexExecutor,
  loadSemanticIndexAddon,
  NATIVE_INDEX_PROTOCOL,
  NativeIndexFailure,
  type NativeIndexOperation,
  type NativeIndexResult,
  type NativeIndexWireOperation,
  type NativeProcessRequester,
  type NativeSemanticIndexExecutor,
  OxigraphNativeIndex,
  ProcessSemanticIndexExecutor,
  type SemanticChildProcess,
  type SemanticIndexAddonStore,
  semanticProcessCommandArgs,
} from "./oxigraph.ts";

import type { NativeAddonSnapshotFileSystem } from "../../../infrastructure/native/addon-snapshot.ts";
import {
  MAX_PRIVATE_PAYLOAD_BYTES,
  type PrivatePayloadDescriptor,
} from "../../../infrastructure/native/private-payload.ts";

function fakeSnapshotFiles() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const removed: string[] = [];
  const modes = new Map<string, number>();
  const fs: NativeAddonSnapshotFileSystem = {
    makeTempDir: ({ dir }) => Promise.resolve(`${dir}/private-random`),
    chmod: (path, mode) => {
      modes.set(path, mode);
      return Promise.resolve();
    },
    open: (path, options) => {
      equal(options.createNew, true);
      equal(options.mode, 0o600);
      return Promise.resolve({
        write: (bytes) => {
          files.set(path, bytes.slice());
          return Promise.resolve(bytes.length);
        },
        close() {},
      });
    },
    lstat: () => Promise.resolve({ isFile: true, isSymlink: false }),
    readFile: (path) => Promise.resolve(files.get(path)!.slice()),
    remove: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { fs, files, removed, modes };
}

Deno.test("semantic loader requires private verified A even when installation becomes B", async () => {
  const original = new Uint8Array([65, 65, 65]);
  const expected = await sha256(original);
  const { fs, files, removed, modes } = fakeSnapshotFiles();
  const create = fs.makeTempDir;
  fs.makeTempDir = (options) => {
    original.fill(66);
    return create(options);
  };
  const paths: string[] = [];
  const loaded = await loadSemanticIndexAddon(
    "/installation/addon.node",
    expected,
    {
      snapshotDirectory: "/private/semantic",
    },
    {
      reader: { readFile: () => Promise.resolve(original) },
      fs,
      requireAddon: (path) => {
        paths.push(path);
        deepStrictEqual(files.get(path), new Uint8Array([65, 65, 65]));
        equal(modes.get(path), 0o400);
        return { storeVersion: () => "0.1.0", oxigraphVersion: () => "0.4.11" };
      },
    },
  );
  deepStrictEqual(paths, ["/private/semantic/private-random/addon.node"]);
  equal(loaded.digest, expected);
  await loaded.close();
  await loaded.close();
  deepStrictEqual(removed, ["/private/semantic/private-random"]);
});

Deno.test("semantic loader refuses hash mismatch and snapshot failure without any require", async () => {
  const bytes = new Uint8Array([65]);
  const expected = await sha256(bytes);
  let requires = 0;
  const fake = fakeSnapshotFiles();
  const deps = {
    fs: fake.fs,
    reader: { readFile: () => Promise.resolve(bytes) },
    requireAddon: () => {
      requires++;
      throw new Error("must not execute");
    },
  };
  await rejects(
    () =>
      loadSemanticIndexAddon(
        "/installation/addon.node",
        "b".repeat(64),
        {},
        deps,
      ),
    SemanticIndexError,
  );
  fake.fs.makeTempDir = () => Promise.reject(new Error("read-only context"));
  await rejects(
    () =>
      loadSemanticIndexAddon(
        "/installation/addon.node",
        "invalid-digest",
        {},
        deps,
      ),
    SemanticIndexError,
  );
  await rejects(
    () =>
      loadSemanticIndexAddon("/installation/addon.node", expected, {}, deps),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.context.nativeCode === "NATIVE_ADDON_SNAPSHOT_UNAVAILABLE" &&
      error.context.recovery === "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY",
  );
  equal(requires, 0);
});

Deno.test("semantic child permissions constrain write and ffi to its private epoch directory", () => {
  const args = semanticProcessCommandArgs(
    {
      addonPath: "/installation/addon.node",
      expectedAddonSha256: "a".repeat(64),
    },
    "epoch",
    "/private/semantic",
  );
  equal(args.includes("--allow-read"), false);
  equal(args.includes("--allow-write"), false);
  equal(args.includes("--allow-ffi"), false);
  equal(args.includes("--allow-write=/private/semantic"), true);
  equal(args.includes("--allow-ffi=/private/semantic"), true);
  equal(args[args.length - 1], "/private/semantic");
  equal(
    args.some((arg) =>
      arg.startsWith("--allow-ffi=") && arg.includes("/installation")
    ),
    false,
  );
});

const digest = (char: string) => char.repeat(64);
const build: BuildRef = {
  repositoryId: "repo-one",
  sourceDigest: digest("1"),
  recipeDigest: digest("2"),
  buildKey: digest("3"),
  artifactDigest: digest("4"),
};
const projection = parseProjectionRef({
  kind: "rdf-quads",
  projectorVersion: "ase-rdf-quads-v1",
  artifactDigest: digest("4"),
  projectionDigest: digest("5"),
});
const quads = new TextEncoder().encode("<a> <b> <c> <g> .\n");
const limits = { maxResults: 10, maxBytes: 1024, timeoutMs: 1000 };

Deno.test("the port keys native stores by full BuildRef and maps results", async () => {
  const operations: NativeIndexOperation[] = [];
  const executor: NativeSemanticIndexExecutor = {
    execute(operation): Promise<NativeIndexResult> {
      operations.push(operation);
      switch (operation.op) {
        case "loadReference":
          throw new Error("This test uses the explicit byte seam");
        case "load":
          equal(operation.graphIri, `urn:ase:build:${digest("4")}`);
          equal(operation.expectedDigest, digest("5"));
          equal(operation.quads, quads);
          return Promise.resolve({ op: "load", quadCount: 1 });
        case "query":
          return Promise.resolve({
            op: "query" as const,
            result: { form: "boolean" as const, value: false },
          });
        case "has":
          return Promise.resolve({ op: "has" as const, loaded: true });
        case "release":
          return Promise.resolve({ op: "release" as const });
        case "close":
          return Promise.resolve({ op: "close" as const });
      }
    },
  };
  const index = new OxigraphNativeIndex(executor);
  deepStrictEqual(await index.load({ build, projection, quads }), {
    quadCount: 1,
  });
  // Cross-repository builds sharing A still get distinct store keys.
  const foreign: BuildRef = { ...build, repositoryId: "repo-two" };
  await index.load({ build: foreign, projection, quads });
  const keys = operations.map((op) =>
    "storeKey" in op ? op.storeKey : undefined
  );
  equal(keys[0], buildRefKey(build));
  equal(keys[1], buildRefKey(foreign));
  equal(keys[0] === keys[1], false);
  deepStrictEqual(await index.query({ build, sparql: "ASK {}", limits }), {
    form: "boolean",
    value: false,
  });
  equal(await index.isLoaded(build), true);
  await index.release(build);
});

Deno.test("native error codes map onto SemanticIndexError codes", async () => {
  const failing = (code: string): NativeSemanticIndexExecutor => ({
    execute() {
      return Promise.reject(
        new NativeIndexFailure(code, `${code}: detail`),
      );
    },
  });
  for (
    const [native, expected] of [
      ["QUERY_REFUSED", "INDEX_QUERY_REFUSED"],
      ["QUERY_LIMIT", "INDEX_QUERY_LIMIT"],
      ["GRAPH_NOT_FOUND", "INDEX_PROJECTION_MISSING"],
      ["INTEGRITY", "INDEX_PROJECTION_CORRUPT"],
      ["INVALID_INPUT", "INDEX_INVALID_INPUT"],
      ["STORE_FULL", "INDEX_BUSY"],
      ["NATIVE_PANIC", "INDEX_UNAVAILABLE"],
    ] as const
  ) {
    const index = new OxigraphNativeIndex(failing(native));
    await rejects(
      () => index.query({ build, sparql: "ASK {}", limits }),
      (error: unknown) =>
        error instanceof SemanticIndexError && error.code === expected,
    );
  }
});

Deno.test("a query timeout recycles the native worker", async () => {
  let recycled = "";
  const executor: NativeSemanticIndexExecutor = {
    execute() {
      return Promise.reject(
        new NativeIndexFailure("TIMEOUT", "TIMEOUT: exceeded"),
      );
    },
    recycle(reason) {
      recycled = reason;
      return Promise.resolve();
    },
  };
  const index = new OxigraphNativeIndex(executor);
  await rejects(
    () => index.query({ build, sparql: "ASK {}", limits }),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
  );
  equal(recycled, "query timeout");
});

Deno.test("the process executor speaks the versioned envelope", async () => {
  const sent: string[] = [];
  const requester: NativeProcessRequester = {
    request(line) {
      sent.push(line);
      const envelope = JSON.parse(line);
      equal(envelope.v, NATIVE_INDEX_PROTOCOL);
      return Promise.resolve(JSON.stringify({
        v: NATIVE_INDEX_PROTOCOL,
        requestId: envelope.requestId,
        ok: true,
        result: envelope.operation.op === "has"
          ? { op: "has", loaded: true }
          : { op: "release" },
      }));
    },
  };
  const executor = new ProcessSemanticIndexExecutor(requester);
  deepStrictEqual(
    await executor.execute({ op: "has", storeKey: "k" }, {
      timeoutMs: 100,
    }),
    { op: "has", loaded: true },
  );
  await executor.execute({ op: "release", storeKey: "k" }, {
    timeoutMs: 100,
  });
  const ids = sent.map((line) => JSON.parse(line).requestId);
  deepStrictEqual(ids, [1, 2]);
  // An error envelope keeps the native code; a mismatched id is refused.
  const erroring = new ProcessSemanticIndexExecutor({
    request(line) {
      const envelope = JSON.parse(line);
      return Promise.resolve(JSON.stringify({
        v: NATIVE_INDEX_PROTOCOL,
        requestId: envelope.requestId,
        ok: false,
        error: { code: "QUERY_REFUSED", message: "QUERY_REFUSED: SERVICE" },
      }));
    },
  });
  await rejects(
    () => erroring.execute({ op: "has", storeKey: "k" }, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure &&
      error.nativeCode === "QUERY_REFUSED",
  );
});

Deno.test("the in-process executor drives the addon contract shape", async () => {
  const graph = new Set<string>();
  const store: SemanticIndexAddonStore = {
    loadBuild(storeKey, graphIri, nquads, expectedDigest) {
      equal(graphIri, `urn:ase:build:${digest("4")}`);
      equal(expectedDigest, digest("5"));
      equal(new TextDecoder().decode(nquads), "<a> <b> <c> <g> .\n");
      graph.add(storeKey);
      return { quadCount: 1, bytes: nquads.length };
    },
    queryReadOnly(storeKey, sparql, limitsJson) {
      if (!graph.has(storeKey)) throw new Error("GRAPH_NOT_FOUND: no");
      equal(sparql, "ASK {}");
      deepStrictEqual(JSON.parse(limitsJson), limits);
      return JSON.stringify({ form: "boolean", value: true });
    },
    hasBuild: (storeKey) => graph.has(storeKey),
    releaseBuild: (storeKey) => void graph.delete(storeKey),
    loadedBuilds: () => [...graph],
    close() {},
    dispose() {},
  };
  const index = new OxigraphNativeIndex(
    new InProcessSemanticIndexExecutor(store),
  );
  await rejects(
    () => index.query({ build, sparql: "ASK {}", limits }),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_MISSING",
  );
  await index.load({ build, projection, quads });
  deepStrictEqual(await index.query({ build, sparql: "ASK {}", limits }), {
    form: "boolean",
    value: true,
  });
});

class FakeSemanticChild implements SemanticChildProcess {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => this.controller = controller,
  });
  finishStatus!: (
    value: { success: boolean; code: number; signal: string | null },
  ) => void;
  readonly status = new Promise<
    { success: boolean; code: number; signal: string | null }
  >((resolve) => this.finishStatus = resolve);
  readonly requests: Array<Record<string, unknown>> = [];
  kills = 0;
  ended = false;
  readonly stdin: WritableStream<Uint8Array>;
  onKill?: () => void;
  constructor(
    readonly act: (
      request: Record<string, unknown>,
      child: FakeSemanticChild,
    ) => void,
  ) {
    this.stdin = new WritableStream({
      write: (bytes) => {
        const request = JSON.parse(new TextDecoder().decode(bytes));
        this.requests.push(request);
        this.act(request, this);
      },
    });
  }
  answer(request: Record<string, unknown>, result: unknown, overrides = {}) {
    this.controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          v: NATIVE_INDEX_PROTOCOL,
          requestId: request.requestId,
          processEpoch: request.processEpoch,
          ok: true,
          result,
          ...overrides,
        }) + "\n",
      ),
    );
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    try {
      this.controller.close();
    } catch { /* reader cancelled */ }
    this.finishStatus({ success: true, code: 0, signal: null });
  }
  kill() {
    this.kills++;
    if (this.onKill) this.onKill();
    else this.finish();
  }
}

function childHarness(
  act: FakeSemanticChild["act"],
  options: Partial<DenoChildRequesterOptions> = {},
) {
  const children: FakeSemanticChild[] = [];
  const requester = new DenoChildProcessRequester({
    addonPath: "/fake/addon.node",
    expectedAddonSha256: digest("a"),
    ...options,
    spawnChild: () => {
      const child = new FakeSemanticChild(act);
      children.push(child);
      return child;
    },
  });
  return {
    requester,
    children,
    executor: new ProcessSemanticIndexExecutor(requester),
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("process queue has count and byte bounds and expires without later execution", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    if ((request.operation as { op: string }).op === "close") {
      child.answer(request, { op: "close" });
    }
  }, { maxQueuedRequests: 1, maxQueuedBytes: 2048 });
  const first = executor.execute({ op: "has", storeKey: "one" }, {
    timeoutMs: 500,
  });
  await pause(0);
  const queued = executor.execute({ op: "has", storeKey: "expired" }, {
    timeoutMs: 10,
  });
  await rejects(
    executor.execute({ op: "has", storeKey: "full" }, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "BUSY",
  );
  await rejects(
    queued,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  equal(children[0]!.requests.length, 1);
  children[0]!.answer(children[0]!.requests[0]!, { op: "has", loaded: true });
  await first;
  await requester.close();
  equal(children[0]!.requests.length, 2); // close, never expired
});

Deno.test("native timeout latches before kill, ignores late result and waits exit before respawn", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    if ((request.operation as { op: string }).op === "close") {
      child.answer(request, { op: "close" });
    }
  });
  const first = executor.execute({ op: "has", storeKey: "k" }, {
    timeoutMs: 10,
  });
  await pause(0);
  children[0]!.onKill = () => {
    children[0]!.answer(children[0]!.requests[0]!, { op: "has", loaded: true });
    setTimeout(() => children[0]!.finish(), 5);
  };
  await rejects(
    first,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  equal(children[0]!.ended, true);
  const next = executor.execute({ op: "has", storeKey: "next" }, {
    timeoutMs: 100,
  });
  await pause(0);
  equal(children.length, 2);
  equal(
    children[0]!.requests[0]!.processEpoch ===
      children[1]!.requests[0]!.processEpoch,
    false,
  );
  children[1]!.answer(children[1]!.requests[0]!, { op: "has", loaded: false });
  await next;
  await requester.close();
});

Deno.test("oversized unterminated output is rejected and kills its worker", async () => {
  const { requester, children, executor } = childHarness((_request, child) => {
    child.controller.enqueue(new Uint8Array(1025).fill(65));
  }, { maxMessageBytes: 1024 });
  await rejects(
    executor.execute({ op: "has", storeKey: "k" }, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure &&
      error.name === "NativeIndexFailure" &&
      error.message === "Semantic process message exceeds its size limit" &&
      error.nativeCode === "QUERY_LIMIT" && error.workerStopped === false &&
      error.context === undefined,
  );
  equal(children[0]!.kills, 1);
  await requester.close();
});

Deno.test("epoch and request mismatches poison transport; close acknowledgement is explicit", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    child.answer(request, { op: "has", loaded: true }, {
      processEpoch: "other",
    });
  });
  await rejects(
    executor.execute({ op: "has", storeKey: "k" }, { timeoutMs: 100 }),
  );
  equal(children[0]!.kills, 1);
  await requester.close();
  await rejects(
    executor.execute({ op: "has", storeKey: "k" }, { timeoutMs: 100 }),
  );
});

Deno.test("close sends native store close and waits for acknowledgement before exit", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    const op = (request.operation as { op: string }).op;
    child.answer(
      request,
      op === "close" ? { op: "close" } : { op: "has", loaded: true },
    );
  });
  await executor.execute({ op: "has", storeKey: "k" }, { timeoutMs: 100 });
  await executor.close();
  equal((children[0]!.requests[1]!.operation as { op: string }).op, "close");
  equal(children[0]!.ended, true);
  await requester.close();
  equal(children[0]!.requests.length, 2);
});

Deno.test("process options reject invalid sizes/deadlines and queue bytes are enforced", async () => {
  for (
    const option of [{ maxQueuedRequests: -1 }, { maxMessageBytes: 0 }, {
      closeTimeoutMs: NaN,
    }, { maxQueuedBytes: Infinity }]
  ) {
    throws(() => childHarness(() => {}, option));
  }
  const { requester, children, executor } = childHarness(() => {}, {
    maxQueuedBytes: 0,
  });
  const first = executor.execute({ op: "has", storeKey: "one" }, {
    timeoutMs: 100,
  });
  await pause(0);
  await rejects(
    executor.execute({ op: "has", storeKey: "two" }, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "BUSY",
  );
  children[0]!.answer(children[0]!.requests[0]!, { op: "has", loaded: true });
  await first;
  // Avoid an unresponsive fake close while still proving exit cleanup.
  await requester.recycle("test complete");
  await requester.close();
});

Deno.test("a timed-out requester does not recycle the replacement child a second time", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    if ((request.operation as { op: string }).op === "close") {
      child.answer(request, { op: "close" });
    }
  });
  const index = new OxigraphNativeIndex(executor);
  const first = index.query({
    build,
    sparql: "ASK {}",
    limits: { ...limits, timeoutMs: 10 },
  });
  await pause(0);
  const next = executor.execute({ op: "has", storeKey: "next" }, {
    timeoutMs: 100,
  });
  await rejects(
    first,
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
  );
  await pause(0);
  equal(children.length, 2);
  equal(children[1]!.kills, 0);
  children[1]!.answer(children[1]!.requests[0]!, { op: "has", loaded: false });
  await next;
  await requester.close();
});

Deno.test("native cooperative TIMEOUT is recycled before the next queued operation", async () => {
  const { requester, children, executor } = childHarness((request, child) => {
    const op = (request.operation as { op: string }).op;
    if (op === "query") {
      child.answer(request, undefined, {
        ok: false,
        error: { code: "TIMEOUT", message: "native expired" },
      });
    } else {child.answer(
        request,
        op === "close" ? { op: "close" } : { op: "has", loaded: false },
      );}
  });
  const index = new OxigraphNativeIndex(executor);
  const failed = rejects(
    index.query({ build, sparql: "ASK {}", limits }),
    (error: unknown) =>
      error instanceof SemanticIndexError && error.code === "INDEX_TIMEOUT",
  );
  const next = executor.execute({ op: "has", storeKey: "next" }, {
    timeoutMs: 100,
  });
  await failed;
  await next;
  equal(children.length, 2);
  equal(children[0]!.kills, 1);
  equal(children[1]!.kills, 0);
  await requester.close();
});

Deno.test("close remains bounded with a hung active request and a zero-sized query queue", async () => {
  const { requester, children, executor } = childHarness(() => {}, {
    maxQueuedRequests: 0,
    closeTimeoutMs: 10,
  });
  const first = executor.execute({ op: "has", storeKey: "hung" }, {
    timeoutMs: 1000,
  });
  const failed = rejects(first);
  await pause(0);
  await rejects(
    requester.close(),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  await failed;
  equal(children[0]!.kills, 1);
  equal(children[0]!.ended, true);
  await rejects(
    executor.execute({ op: "has", storeKey: "closed" }, { timeoutMs: 100 }),
  );
  equal(children.length, 1);
});

Deno.test("close before lazy spawn creates no process and cannot resurrect work", async () => {
  const { requester, children, executor } = childHarness(() => {});
  const first = executor.execute({ op: "has", storeKey: "k" }, {
    timeoutMs: 100,
  });
  const failed = rejects(first);
  await requester.close();
  await failed;
  equal(children.length, 0);
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(1);
  }
  throw new Error("Timed out waiting for semantic fake lifecycle");
}

Deno.test("semantic private snapshots survive kill signals until real child status", async () => {
  const removed: string[] = [];
  const { requester, executor, children } = childHarness((request, child) => {
    child.answer(request, { op: "has", loaded: false });
  }, {
    snapshotStorage: {
      create: (_root, epoch) => Promise.resolve(`/private/semantic/${epoch}`),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    },
  });
  await executor.execute({ op: "has", storeKey: "key" }, { timeoutMs: 100 });
  children[0]!.onKill = () => {};
  let settled = false;
  const stopping = requester.recycle("test").then(() => {
    settled = true;
  });
  await until(() => children[0]!.kills === 1);
  equal(settled, false);
  deepStrictEqual(removed, []);
  children[0]!.finish();
  await stopping;
  equal(removed.length, 1);
  equal(
    removed[0],
    `/private/semantic/${children[0]!.requests[0]!.processEpoch}`,
  );
  await requester.close();
  equal(removed.length, 1);
});

Deno.test("semantic staging pending at timeout cannot spawn an unowned late process", async () => {
  let provision!: (directory: string) => void;
  let preparing = false;
  const removed: string[] = [];
  const children: FakeSemanticChild[] = [];
  const requester = new DenoChildProcessRequester({
    addonPath: "/installation/addon.node",
    expectedAddonSha256: digest("a"),
    snapshotStorage: {
      create: () => {
        preparing = true;
        return new Promise((resolve) => provision = resolve);
      },
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    },
    spawnChild: () => {
      const child = new FakeSemanticChild(() => {
        throw new Error("expired request must not execute");
      });
      children.push(child);
      return child;
    },
  });
  const executor = new ProcessSemanticIndexExecutor(requester);
  const first = executor.execute({ op: "has", storeKey: "key" }, {
    timeoutMs: 10,
  });
  const failed = rejects(
    first,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  await until(() => preparing);
  await pause(20);
  equal(children.length, 0);
  deepStrictEqual(removed, []);
  provision("/private/pending-epoch");
  await failed;
  equal(children.length, 1);
  equal(children[0]!.kills, 1);
  equal(children[0]!.requests.length, 0);
  deepStrictEqual(removed, ["/private/pending-epoch"]);
  await requester.close();
});

Deno.test("semantic snapshot cleanup covers natural exit, spawn refusal and close during staging", async () => {
  const removed: string[] = [];
  const storage = {
    create: (_root: string, epoch: string) =>
      Promise.resolve(`/private/${epoch}`),
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  const { requester, children, executor } = childHarness((request, child) => {
    child.answer(request, { op: "has", loaded: false });
  }, { snapshotStorage: storage });
  await executor.execute({ op: "has", storeKey: "key" }, { timeoutMs: 100 });
  children[0]!.finish();
  await until(() => removed.length === 1);
  await requester.recycle();
  await requester.close();
  equal(removed.length, 1);

  const refused = new DenoChildProcessRequester({
    addonPath: "/installation/addon.node",
    expectedAddonSha256: digest("a"),
    snapshotStorage: storage,
    spawnChild: () => {
      throw new Error("spawn refused");
    },
  });
  await rejects(() =>
    refused.request(
      JSON.stringify({
        v: NATIVE_INDEX_PROTOCOL,
        requestId: 1,
        operation: { op: "has", storeKey: "key" },
      }),
      { timeoutMs: 100 },
    )
  );
  await refused.close();
  equal(removed.length, 2);

  let provision!: (directory: string) => void;
  let preparing = false;
  const lateChild = new FakeSemanticChild(() => {
    throw new Error("closed request must not execute");
  });
  const closing = new DenoChildProcessRequester({
    addonPath: "/installation/addon.node",
    expectedAddonSha256: digest("a"),
    snapshotStorage: {
      create: () => {
        preparing = true;
        return new Promise((resolve) => provision = resolve);
      },
      remove: storage.remove,
    },
    spawnChild: () => lateChild,
  });
  const active = closing.request(
    JSON.stringify({
      v: NATIVE_INDEX_PROTOCOL,
      requestId: 1,
      operation: { op: "has", storeKey: "key" },
    }),
    { timeoutMs: 100 },
  );
  const failure = rejects(active);
  await until(() => preparing);
  const close = closing.close();
  provision("/private/closed-during-staging");
  await close;
  await failure;
  equal(lateChild.kills, 1);
  equal(lateChild.requests.length, 0);
  equal(removed[2], "/private/closed-during-staging");
});

const PAYLOAD_NAME = "payload-00000000-0000-0000-0000-000000000001.bin";
const loadOperation = (bytes: Uint8Array) => ({
  op: "load" as const,
  storeKey: "store-key",
  graphIri: `urn:ase:build:${digest("4")}`,
  expectedDigest: digest("5"),
  quads: bytes,
});

Deno.test("process loads pass borrowed binary beside small JSON without base64 or numeric arrays", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  Object.defineProperty(bytes, "toJSON", {
    value: () => {
      throw new Error("binary must not be stringified");
    },
  });
  const executor = new ProcessSemanticIndexExecutor({
    request(line, options) {
      equal(options.binary, bytes);
      equal(line.length < 1024, true);
      const envelope = JSON.parse(line);
      equal(envelope.v, NATIVE_INDEX_PROTOCOL);
      equal("quads" in envelope.operation, false);
      equal("quadsBase64" in envelope.operation, false);
      return Promise.resolve(
        JSON.stringify({
          v: NATIVE_INDEX_PROTOCOL,
          requestId: envelope.requestId,
          ok: true,
          result: { op: "load", quadCount: 1 },
        }),
      );
    },
  });
  deepStrictEqual(
    await executor.execute(loadOperation(bytes), { timeoutMs: 100 }),
    { op: "load", quadCount: 1 },
  );
});

Deno.test("requester stages typed payload and deletes only after matching load success", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  const staged: Uint8Array[] = [];
  const removed: string[] = [];
  const { requester, executor, children } = childHarness((request, child) => {
    const operation = request.operation as {
      op: string;
      payload?: PrivatePayloadDescriptor;
    };
    if (operation.op === "load") {
      equal(JSON.stringify(request).length < 1024, true);
      equal(operation.payload!.fileName, PAYLOAD_NAME);
      equal(operation.payload!.bytes, bytes.length);
      equal(removed.length, 0);
      child.answer(request, { op: "load", quadCount: 2 });
    } else child.answer(request, { op: "close" });
  }, {
    payloadStorage: {
      stage: (_directory, input, digest) => {
        staged.push(input);
        return Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: input.byteLength,
          digest,
        });
      },
      remove: (_directory, descriptor) => {
        removed.push(descriptor.fileName);
        return Promise.resolve();
      },
    },
  });
  deepStrictEqual(
    await executor.execute(loadOperation(bytes), { timeoutMs: 100 }),
    { op: "load", quadCount: 2 },
  );
  equal(staged[0], bytes);
  deepStrictEqual(removed, [PAYLOAD_NAME]);
  equal(children[0]!.requests.length, 1);
  await requester.close();
});

Deno.test("binary queue budget includes the active on-disk projection after staging", async () => {
  const bytes = new Uint8Array(40 * 1024);
  let stages = 0;
  const { requester, executor, children } = childHarness(() => {}, {
    maxQueuedBytes: 64 * 1024,
    payloadStorage: {
      stage: (_directory, input, digest) => {
        stages++;
        return Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: input.byteLength,
          digest,
        });
      },
      remove: () => Promise.resolve(),
    },
  });
  const first = executor.execute(loadOperation(bytes), { timeoutMs: 1000 });
  await until(() => children[0]?.requests.length === 1);
  await rejects(
    () =>
      executor.execute(loadOperation(new Uint8Array(30 * 1024)), {
        timeoutMs: 100,
      }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "BUSY",
  );
  equal(stages, 1);
  children[0]!.answer(children[0]!.requests[0]!, { op: "load", quadCount: 1 });
  await first;
  await requester.recycle();
  await requester.close();

  const tooSmall = childHarness(() => {}, { maxQueuedBytes: 1024 });
  await rejects(
    () => tooSmall.executor.execute(loadOperation(bytes), { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "BUSY",
  );
  equal(tooSmall.children.length, 0);
  await tooSmall.requester.close();
});

Deno.test("payload staging timeout and close wait for writer settlement plus actual exit", async () => {
  for (const reason of ["timeout", "close"] as const) {
    let finishStage!: (descriptor: PrivatePayloadDescriptor) => void;
    let cancellation: (() => boolean) | undefined;
    let staging = false;
    const scopesRemoved: string[] = [];
    const filesRemoved: string[] = [];
    const { requester, executor, children } = childHarness(() => {
      throw new Error("late staged request must not execute");
    }, {
      snapshotStorage: {
        create: (_root, epoch) => Promise.resolve(`/private/${epoch}`),
        remove: (path) => {
          scopesRemoved.push(path);
          return Promise.resolve();
        },
      },
      payloadStorage: {
        stage: (_directory, _bytes, _digest, options) => {
          staging = true;
          cancellation = options?.isCancelled;
          return new Promise((resolve) => finishStage = resolve);
        },
        remove: (_directory, descriptor) => {
          filesRemoved.push(descriptor.fileName);
          return Promise.resolve();
        },
      },
    });
    const first = executor.execute(loadOperation(new Uint8Array(8)), {
      timeoutMs: reason === "timeout" ? 10 : 1000,
    });
    const failed = rejects(first);
    await until(() => staging);
    children[0]!.onKill = () => {};
    const closing = reason === "close" ? requester.close() : undefined;
    await until(() => children[0]!.kills === 1);
    equal(cancellation!(), true);
    deepStrictEqual(filesRemoved, []);
    deepStrictEqual(scopesRemoved, []);
    children[0]!.finish();
    await pause(0);
    // Status alone is insufficient while a stage writer is still pending.
    deepStrictEqual(scopesRemoved, []);
    finishStage({ fileName: PAYLOAD_NAME, bytes: 8, digest: digest("5") });
    await failed;
    await closing;
    equal(scopesRemoved.length, 1);
    equal(children[0]!.requests.length, 0);
    deepStrictEqual(filesRemoved, []);
    await requester.close();
  }
});

Deno.test("failed load acknowledgement retains payload until its child really exits", async () => {
  const filesRemoved: string[] = [];
  const scopesRemoved: string[] = [];
  const { requester, executor, children } = childHarness((request, child) => {
    child.onKill = () => {};
    child.answer(request, undefined, {
      ok: false,
      error: { code: "INTEGRITY", message: "bad projection" },
    });
  }, {
    snapshotStorage: {
      create: (_root, epoch) => Promise.resolve(`/private/${epoch}`),
      remove: (path) => {
        scopesRemoved.push(path);
        return Promise.resolve();
      },
    },
    payloadStorage: {
      stage: (_directory, bytes, digest) =>
        Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: bytes.byteLength,
          digest,
        }),
      remove: (_directory, descriptor) => {
        filesRemoved.push(descriptor.fileName);
        return Promise.resolve();
      },
    },
  });
  const loading = executor.execute(loadOperation(new Uint8Array(8)), {
    timeoutMs: 1000,
  });
  const failed = rejects(
    loading,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "INTEGRITY",
  );
  await until(() => children.length === 1);
  await until(() => children[0]!.kills === 1);
  deepStrictEqual(filesRemoved, []);
  deepStrictEqual(scopesRemoved, []);
  children[0]!.finish();
  await failed;
  equal(scopesRemoved.length, 1);
  deepStrictEqual(filesRemoved, []);
  await requester.close();
});

Deno.test("wire load validates descriptor and announced graph before passing the same bytes to Rust", async () => {
  const bytes = new Uint8Array([65, 66]);
  let reads = 0;
  let calls = 0;
  const operation = {
    op: "load" as const,
    storeKey: "key",
    graphIri: `urn:ase:build:${digest("4")}`,
    expectedDigest: digest("5"),
    payload: {
      fileName: PAYLOAD_NAME,
      bytes: bytes.length,
      digest: digest("5"),
    },
  };
  const executor: NativeSemanticIndexExecutor = {
    execute(input) {
      calls++;
      equal(input.op, "load");
      equal(
        (input as Extract<NativeIndexOperation, { op: "load" }>).quads,
        bytes,
      );
      return Promise.resolve({ op: "load", quadCount: 1 });
    },
  };
  const read = () => {
    reads++;
    return Promise.resolve(bytes);
  };
  await executeSemanticIndexWireOperation(
    operation,
    "/private/epoch",
    executor,
    read,
  );
  equal(calls, 1);
  for (
    const invalid of [
      { ...operation, graphIri: "urn:wrong" },
      { ...operation, payload: { ...operation.payload, digest: digest("6") } },
      { ...operation, quadsBase64: "AAAA" },
      { ...operation, quads: bytes },
    ]
  ) {
    await rejects(() =>
      executeSemanticIndexWireOperation(
        invalid,
        "/private/epoch",
        executor,
        read,
      )
    );
  }
  equal(reads, 1);
  equal(calls, 1);
  for (
    const payload of [
      { ...operation.payload, fileName: "../payload.bin" },
      { ...operation.payload, fileName: "/elsewhere/payload.bin" },
      { ...operation.payload, bytes: MAX_PRIVATE_PAYLOAD_BYTES + 1 },
    ]
  ) {
    await rejects(() =>
      executeSemanticIndexWireOperation(
        { ...operation, payload },
        "/private/epoch",
        executor,
      )
    );
  }
  equal(calls, 1);
});

Deno.test("queued binary bytes retain their deadline and never stage after expiration", async () => {
  let stages = 0;
  const { requester, executor, children } = childHarness((request, child) => {
    if ((request.operation as { op: string }).op === "close") {
      child.answer(request, { op: "close" });
    }
  }, {
    maxQueuedBytes: 64 * 1024,
    payloadStorage: {
      stage: (_directory, input, digest) => {
        stages++;
        return Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: input.byteLength,
          digest,
        });
      },
      remove: () => Promise.resolve(),
    },
  });
  const active = executor.execute({ op: "has", storeKey: "active" }, {
    timeoutMs: 1000,
  });
  await until(() => children[0]?.requests.length === 1);
  const queued = executor.execute(loadOperation(new Uint8Array(40 * 1024)), {
    timeoutMs: 10,
  });
  await rejects(
    () =>
      executor.execute(loadOperation(new Uint8Array(30 * 1024)), {
        timeoutMs: 100,
      }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "BUSY",
  );
  await rejects(
    queued,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  children[0]!.answer(children[0]!.requests[0]!, { op: "has", loaded: false });
  await active;
  equal(stages, 0);
  await requester.close();
});

Deno.test("legacy projection envelopes and oversized control metadata refuse before spawn", async () => {
  const { requester, children } = childHarness(() => {
    throw new Error("refused control cannot execute");
  });
  await rejects(
    () =>
      requester.request(
        JSON.stringify({
          v: 1,
          requestId: 1,
          operation: {
            ...loadOperation(new Uint8Array()),
            quads: undefined,
            quadsBase64: "AAAA",
          },
        }),
        { timeoutMs: 100 },
      ),
    (error: unknown) =>
      error instanceof NativeIndexFailure &&
      error.nativeCode === "INVALID_INPUT",
  );
  await rejects(
    () => requester.request("x".repeat(1024 * 1024 + 1), { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "QUERY_LIMIT",
  );
  equal(children.length, 0);
  await requester.close();
});

Deno.test("a deadline during successful payload unlink cannot return success before real exit", async () => {
  let finishRemoval!: () => void;
  let removing = false;
  const scopesRemoved: string[] = [];
  const { requester, executor, children } = childHarness((request, child) => {
    child.onKill = () => {};
    child.answer(request, { op: "load", quadCount: 1 });
  }, {
    snapshotStorage: {
      create: (_root, epoch) => Promise.resolve(`/private/${epoch}`),
      remove: (path) => {
        scopesRemoved.push(path);
        return Promise.resolve();
      },
    },
    payloadStorage: {
      stage: (_directory, bytes, digest) =>
        Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: bytes.byteLength,
          digest,
        }),
      remove: () => {
        removing = true;
        return new Promise((resolve) => finishRemoval = resolve);
      },
    },
  });
  let state = "pending";
  const loading = executor.execute(loadOperation(new Uint8Array(8)), {
    timeoutMs: 10,
  });
  void loading.then(() => state = "resolved", () => state = "rejected");
  const failed = rejects(
    loading,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  await until(() => removing);
  await until(() => children[0]!.kills === 1);
  finishRemoval();
  await pause(0);
  equal(state, "pending");
  deepStrictEqual(scopesRemoved, []);
  children[0]!.finish();
  await failed;
  equal(state, "rejected");
  equal(scopesRemoved.length, 1);
  await requester.close();
});

Deno.test("queued internal close accepts observed retirement without spawning a replacement", async () => {
  const { requester, executor, children } = childHarness(() => {}, {
    payloadStorage: {
      stage: (_directory, bytes, digest) =>
        Promise.resolve({
          fileName: PAYLOAD_NAME,
          bytes: bytes.byteLength,
          digest,
        }),
      remove: () => Promise.resolve(),
    },
  });
  const loading = executor.execute(loadOperation(new Uint8Array(8)), {
    timeoutMs: 1000,
  });
  const failed = rejects(
    loading,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "INTEGRITY",
  );
  await until(() => children[0]?.requests.length === 1);
  const closing = requester.close();
  children[0]!.answer(children[0]!.requests[0]!, undefined, {
    ok: false,
    error: { code: "INTEGRITY", message: "bad projection" },
  });
  await Promise.all([failed, closing]);
  equal(children.length, 1);
  equal(children[0]!.requests.length, 1);
  equal(children[0]!.kills, 1);
});

Deno.test("reference port sends only full immutable pins without binary staging", async () => {
  let calls = 0;
  const index = new OxigraphNativeIndex(
    new ProcessSemanticIndexExecutor({
      request(line, options) {
        calls++;
        equal(options.binary, undefined);
        equal(new TextEncoder().encode(line).byteLength < 1024, true);
        const envelope = JSON.parse(line);
        deepStrictEqual(envelope.operation, {
          op: "loadReference",
          build,
          projection,
        });
        return Promise.resolve(JSON.stringify({
          v: NATIVE_INDEX_PROTOCOL,
          requestId: envelope.requestId,
          ok: true,
          result: { op: "loadReference", quadCount: 7 },
        }));
      },
    }),
  );
  deepStrictEqual(await index.loadReference({ build, projection }), {
    quadCount: 7,
  });
  await rejects(
    () =>
      index.loadReference({
        build,
        projection: { ...projection, artifactDigest: digest("6") },
      }),
    (error: unknown) =>
      error instanceof SemanticIndexError &&
      error.code === "INDEX_PROJECTION_CORRUPT",
  );
  equal(calls, 1);
});

Deno.test("reference child permissions bind the exact initialized KV file", () => {
  const args = semanticProcessCommandArgs(
    {
      addonPath: "/installation/addon.node",
      expectedAddonSha256: digest("a"),
      buildCachePath: "/project/.ase/runtime/builds/cache.kv",
    },
    "epoch",
    "/private/semantic",
  );
  equal(
    args.includes(
      "--allow-write=/private/semantic,/project/.ase/runtime/builds/cache.kv",
    ),
    true,
  );
  equal(args.includes("--allow-ffi=/private/semantic"), true);
  equal(args.includes("--frozen"), true);
  equal(args.includes("--cached-only"), true);
  equal(args.includes("--unstable-kv"), true);
  equal(args[args.length - 1], "/project/.ase/runtime/builds/cache.kv");
  for (
    const buildCachePath of [
      "relative.kv",
      "/tmp/cache,/.kv",
      "/tmp/cache\n.kv",
    ]
  ) {
    throws(() =>
      semanticProcessCommandArgs(
        {
          addonPath: "/installation/addon.node",
          expectedAddonSha256: digest("a"),
          buildCachePath,
        },
        "epoch",
        "/private/semantic",
      ), NativeIndexFailure);
  }
});

Deno.test("wire reference verifies persisted bytes against the expected pin before native load", async () => {
  const bytes = new TextEncoder().encode("<a> <b> <c> <g> .\n");
  const verifiedProjection = {
    ...projection,
    projectionDigest: await sha256(bytes),
  };
  const operation = {
    op: "loadReference" as const,
    build,
    projection: verifiedProjection,
  };
  let reads = 0;
  let loads = 0;
  const executor: NativeSemanticIndexExecutor = {
    execute(input) {
      loads++;
      deepStrictEqual(input, {
        op: "load",
        storeKey: buildRefKey(build),
        graphIri: `urn:ase:build:${build.artifactDigest}`,
        quads: bytes,
        expectedDigest: verifiedProjection.projectionDigest,
      });
      return Promise.resolve({ op: "load", quadCount: 1 });
    },
  };
  const read = (ref: unknown) => {
    reads++;
    deepStrictEqual(ref, verifiedProjection);
    return Promise.resolve(bytes);
  };
  deepStrictEqual(
    await executeSemanticIndexWireOperation(
      operation,
      "/private/epoch",
      executor,
      undefined,
      read,
    ),
    { op: "loadReference", quadCount: 1 },
  );
  await rejects(
    () =>
      executeSemanticIndexWireOperation(
        {
          ...operation,
          projection: { ...verifiedProjection, projectionDigest: digest("0") },
        },
        "/private/epoch",
        executor,
        undefined,
        () => Promise.resolve(bytes),
      ),
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "INTEGRITY",
  );
  for (
    const invalid of [
      { ...operation, buildCachePath: "/untrusted/cache.kv" },
      { ...operation, payload: { fileName: "payload.bin" } },
      { ...operation, quads: bytes },
      { ...operation, projection: { ...verifiedProjection, kind: "other" } },
      {
        ...operation,
        projection: { ...verifiedProjection, artifactDigest: digest("6") },
      },
      { ...operation, build: { ...build, recipeDigest: "invalid" } },
    ]
  ) {
    await rejects(() =>
      executeSemanticIndexWireOperation(
        invalid as NativeIndexWireOperation,
        "/private/epoch",
        executor,
        undefined,
        read,
      )
    );
  }
  equal(reads, 1);
  equal(loads, 1);
  await rejects(() =>
    executeSemanticIndexWireOperation(operation, "/private/epoch", executor)
  );
  equal(loads, 1);
});

Deno.test("reference cache failures retain their storage code and context across the protocol", async () => {
  const context = { kind: "rdf-quads", stage: "meta" };
  const index = new OxigraphNativeIndex(
    new ProcessSemanticIndexExecutor({
      request(line) {
        return Promise.resolve(JSON.stringify({
          v: NATIVE_INDEX_PROTOCOL,
          requestId: JSON.parse(line).requestId,
          ok: false,
          error: {
            code: "BUILD_BLOB_CORRUPT",
            message: "Projection metadata is malformed",
            context,
          },
        }));
      },
    }),
  );
  await rejects(
    () => index.loadReference({ build, projection }),
    (error: unknown) => {
      equal(error instanceof BuildStoreError, true);
      const failure = error as BuildStoreError;
      equal(failure.code, "BUILD_BLOB_CORRUPT");
      deepStrictEqual(failure.context, context);
      equal(typeof failure.recovery, "string");
      return true;
    },
  );
});

Deno.test("reference requests never stage bytes and require host configuration before spawn", async () => {
  const operation = { op: "loadReference" as const, build, projection };
  const refused = childHarness(() => {
    throw new Error("must not spawn");
  });
  await rejects(
    () => refused.executor.execute(operation, { timeoutMs: 100 }),
    NativeIndexFailure,
  );
  equal(refused.children.length, 0);
  await refused.requester.close();
  const configured = childHarness((request, child) => {
    child.answer(
      request,
      (request.operation as { op: string }).op === "close"
        ? { op: "close" }
        : { op: "loadReference", quadCount: 3 },
    );
  }, {
    buildCachePath: "/project/builds/cache.kv",
    payloadStorage: {
      stage: () => {
        throw new Error("reference must not stage payload");
      },
      remove: () => {
        throw new Error("reference has no payload to remove");
      },
    },
  });
  deepStrictEqual(
    await configured.executor.execute(operation, { timeoutMs: 100 }),
    {
      op: "loadReference",
      quadCount: 3,
    },
  );
  deepStrictEqual(configured.children[0]!.requests[0]!.operation, operation);
  await configured.requester.close();
});

Deno.test("reference timeout waits for actual child exit and permits a fresh retry", async () => {
  const operation = { op: "loadReference" as const, build, projection };
  const { requester, executor, children } = childHarness((request, child) => {
    if ((request.operation as { op: string }).op === "close") {
      child.answer(request, { op: "close" });
    }
  }, { buildCachePath: "/project/builds/cache.kv" });
  let settled = false;
  const timed = executor.execute(operation, { timeoutMs: 10 });
  void timed.then(() => settled = true, () => settled = true);
  const failure = rejects(
    timed,
    (error: unknown) =>
      error instanceof NativeIndexFailure && error.nativeCode === "TIMEOUT",
  );
  await until(() => children[0]?.requests.length === 1);
  children[0]!.onKill = () => {};
  await until(() => children[0]!.kills === 1);
  children[0]!.answer(children[0]!.requests[0]!, {
    op: "loadReference",
    quadCount: 1,
  });
  await pause(0);
  equal(settled, false);
  children[0]!.finish();
  await failure;
  const retry = executor.execute(operation, { timeoutMs: 1000 });
  await until(() => children[1]?.requests.length === 1);
  children[1]!.answer(children[1]!.requests[0]!, {
    op: "loadReference",
    quadCount: 1,
  });
  deepStrictEqual(await retry, { op: "loadReference", quadCount: 1 });
  equal(children.length, 2);
  await requester.close();
});
