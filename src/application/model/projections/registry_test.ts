import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  type BuildPutResult,
  BuildStoreError,
  type BuildStoreStats,
  type BuildSweepResult,
  type ModelBuildStore,
} from "../builds/ports/out/build-store.port.ts";
import { sha256HexOfBytes } from "../builds/service.ts";
import {
  ModelProjectionError,
  ModelProjectionRegistry,
  projectionArtifactKey,
  projectionKey,
  projectionParamsDigest,
  type ProjectionStatus,
} from "./cached-projections.ts";

const A1 = "a".repeat(64);
const A2 = "b".repeat(64);
const A3 = "c".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeProjectionStore implements ModelBuildStore {
  readonly projections = new Map<string, Uint8Array>();
  #key(kind: string, version: string, artifactKey: string) {
    return `${kind}/${version}/${artifactKey}`;
  }
  has(): Promise<boolean> {
    return Promise.resolve(false);
  }
  get(): Promise<Uint8Array> {
    return Promise.reject(
      new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
    );
  }
  put(digest: string, bytes: Uint8Array): Promise<BuildPutResult> {
    return Promise.resolve({
      stored: true,
      bytes: bytes.byteLength,
      digest,
    });
  }
  hasProjection(kind: string, version: string, artifactKey: string) {
    return Promise.resolve(
      this.projections.has(this.#key(kind, version, artifactKey)),
    );
  }
  getProjection(kind: string, version: string, artifactKey: string) {
    const bytes = this.projections.get(this.#key(kind, version, artifactKey));
    if (!bytes) {
      return Promise.reject(
        new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
      );
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Promise.resolve(copy);
  }
  async putProjection(
    kind: string,
    version: string,
    artifactKey: string,
    bytes: Uint8Array,
  ): Promise<BuildPutResult> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.projections.set(this.#key(kind, version, artifactKey), copy);
    return {
      stored: true,
      bytes: bytes.byteLength,
      digest: await sha256HexOfBytes(bytes),
    };
  }
  acquireLease(): Promise<boolean> {
    return Promise.resolve(true);
  }
  releaseLease(): Promise<void> {
    return Promise.resolve();
  }
  sweep(): Promise<BuildSweepResult> {
    return Promise.resolve({
      orphanChunkKeysRemoved: 0,
      orphanEntries: 0,
      expiredLeasesRemoved: 0,
    });
  }
  stats(): Promise<BuildStoreStats> {
    return Promise.resolve({
      blobCount: 0,
      projectionCount: this.projections.size,
      leaseCount: 0,
      uncompressedBytes: 0,
      quotaBytes: null,
      overQuota: false,
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("projections coalesce and isolate consumers by decoding fresh values", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1_000_000 });
  const shared = { items: [1, 2] };
  let computes = 0;
  registry.register({
    kind: "board",
    version: "1",
    compute: () => {
      computes++;
      return Promise.resolve(shared);
    },
  });
  const [one, two] = await Promise.all([
    registry.get<{ items: number[] }>("board", A1),
    registry.get<{ items: number[] }>("board", A1),
  ]);
  equal(computes, 1);
  one.items.push(99);
  shared.items.push(100);
  deepStrictEqual(two.items, [1, 2]);
  const three = await registry.get<{ items: number[] }>("board", A1);
  deepStrictEqual(three.items, [1, 2]);
  equal(computes, 1);
  equal(registry.status("board", A1).state, "ready");
});

Deno.test("projections key by parameters and projector version", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1_000_000 });
  let computes = 0;
  const define = (version: string) => ({
    kind: "view-diagram",
    version,
    compute: (ctx: { params?: Readonly<Record<string, string>> }) => {
      computes++;
      return Promise.resolve({ view: ctx.params?.view ?? "none", version });
    },
  });
  registry.register(define("1"));
  const x = await registry.get("view-diagram", A1, { params: { view: "x" } });
  const y = await registry.get("view-diagram", A1, { params: { view: "y" } });
  deepStrictEqual(x, { view: "x", version: "1" });
  deepStrictEqual(y, { view: "y", version: "1" });
  equal(computes, 2);
  registry.register(define("2"));
  const x2 = await registry.get("view-diagram", A1, { params: { view: "x" } });
  deepStrictEqual(x2, { view: "x", version: "2" });
  equal(computes, 3);
  equal(
    registry.status("view-diagram", A1, { params: { view: "x" } })
      .projectorVersion,
    "2",
  );
});

Deno.test("projections evict by encoded bytes, never a pending computation", async () => {
  const payload = "x".repeat(40);
  const registry = new ModelProjectionRegistry({ maxBytes: 100 });
  registry.register<string>({
    kind: "rdf-quads",
    version: "1",
    compute: () => Promise.resolve(payload),
  });
  await registry.get("rdf-quads", A1);
  await registry.get("rdf-quads", A2);
  await registry.get("rdf-quads", A1); // refresh A1
  await registry.get("rdf-quads", A3); // evicts A2 (40+40+40 > 100)
  equal(registry.peek("rdf-quads", A2), undefined);
  equal(registry.peek<string>("rdf-quads", A1), payload);
  equal(registry.stats().bytes <= 100, true);
  const gate = deferred<string>();
  const slow = new ModelProjectionRegistry({ maxBytes: 100 });
  slow.register<string>({
    kind: "board",
    version: "1",
    compute: () => gate.promise,
  });
  const pendingRead = slow.get<string>("board", A1);
  equal(slow.stats().pending, 1);
  equal(slow.status("board", A1).state, "pending");
  gate.resolve("done");
  equal(await pendingRead, "done");
  equal(slow.stats().pending, 0);
});

Deno.test("projections report failed without caching, then retry cleanly", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1_000 });
  const events: ProjectionStatus[] = [];
  registry.subscribe((s) => events.push(s));
  let shouldFail = true;
  registry.register({
    kind: "shacl-report",
    version: "1",
    compute: () =>
      shouldFail
        ? Promise.reject(new Error("shapes unavailable"))
        : Promise.resolve({ conforms: true }),
  });
  let code = "";
  try {
    await registry.get("shacl-report", A1);
  } catch (error) {
    if (error instanceof ModelProjectionError) code = error.code;
    else throw error;
  }
  equal(code, "PROJECTION_FAILED");
  equal(registry.status("shacl-report", A1).state, "failed");
  equal(registry.peek("shacl-report", A1), undefined);
  shouldFail = false;
  deepStrictEqual(await registry.get("shacl-report", A1), { conforms: true });
  deepStrictEqual(
    events.map((e) => e.state),
    ["pending", "failed", "pending", "ready"],
  );
});

Deno.test("projections persist through the store and reload without computing", async () => {
  const store = new FakeProjectionStore();
  const first = new ModelProjectionRegistry({ maxBytes: 1_000_000, store });
  first.register({
    kind: "board",
    version: "1",
    compute: (ctx) => Promise.resolve({ for: ctx.params?.view ?? "all" }),
  });
  await first.get("board", A1, { params: { view: "x" } });
  await first.get("board", A1, { params: { view: "y" } });
  equal(store.projections.size, 2);
  const second = new ModelProjectionRegistry({ maxBytes: 1_000_000, store });
  second.register({
    kind: "board",
    version: "1",
    compute: () => Promise.reject(new Error("must not compute")),
  });
  deepStrictEqual(
    await second.get("board", A1, { params: { view: "x" } }),
    { for: "x" },
  );
  deepStrictEqual(
    await second.get("board", A1, { params: { view: "y" } }),
    { for: "y" },
  );
});

Deno.test("projections refuse unregistered kinds and malformed artifacts", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1_000 });
  let code = "";
  try {
    await registry.get("board", A1);
  } catch (error) {
    if (error instanceof ModelProjectionError) code = error.code;
    else throw error;
  }
  equal(code, "PROJECTION_NOT_REGISTERED");
  registry.register({
    kind: "board",
    version: "1",
    compute: () => Promise.resolve({}),
  });
  code = "";
  try {
    await registry.get("board", "not-a-digest");
  } catch (error) {
    if (error instanceof ModelProjectionError) code = error.code;
    else throw error;
  }
  equal(code, "PROJECTION_INVALID_INPUT");
  equal(registry.status("board", A2).state, "unrequested");
});

Deno.test("empty projection parameters share compute, status and persisted identity", async () => {
  equal(projectionKey("board", "1", A1, {}), projectionKey("board", "1", A1));
  equal(await projectionArtifactKey(A1, {}), await projectionArtifactKey(A1));
  equal(await projectionParamsDigest({}), undefined);
  const store = new FakeProjectionStore();
  const registry = new ModelProjectionRegistry({ maxBytes: 1000, store });
  const gate = deferred<string>();
  let computes = 0;
  registry.register({
    kind: "board",
    version: "1",
    compute: (ctx) => {
      equal(ctx.params, undefined);
      computes++;
      return gate.promise;
    },
  });
  const one = registry.get("board", A1, { params: {} });
  const two = registry.get("board", A1);
  equal(registry.status("board", A1, { params: {} }).state, "pending");
  gate.resolve("true");
  deepStrictEqual(await Promise.all([one, two]), ["true", "true"]);
  equal(computes, 1);
  equal(store.projections.size, 1);
  equal(registry.peek("board", A1, { params: {} }), "true");
  equal(registry.status("board", A1).state, "ready");
  const restarted = new ModelProjectionRegistry({ maxBytes: 1000, store });
  restarted.register({
    kind: "board",
    version: "1",
    compute: () => Promise.reject("must not compute"),
  });
  equal(await restarted.get("board", A1, { params: {} }), "true");
});

Deno.test("projection persistence preserves payload form and digest across registry restarts", async () => {
  for (
    const value of [
      "true",
      '{"a":1}',
      "",
      new Uint8Array(),
      new Uint8Array([0, 255, 128]),
      { a: [1, true] },
      true,
    ]
  ) {
    const store = new FakeProjectionStore();
    const first = new ModelProjectionRegistry({ maxBytes: 1000, store });
    first.register({
      kind: "board",
      version: "1",
      compute: () => Promise.resolve(value),
    });
    const initial = await first.get("board", A1);
    const digest = first.status("board", A1).projectionDigest;
    const restarted = new ModelProjectionRegistry({ maxBytes: 1000, store });
    restarted.register({
      kind: "board",
      version: "1",
      compute: () => Promise.reject("must not compute"),
    });
    const restored = await restarted.get("board", A1);
    deepStrictEqual(restored, initial);
    equal(typeof restored, typeof initial);
    equal(restarted.status("board", A1).projectionDigest, digest);
    if (restored instanceof Uint8Array) {
      restored.fill(42);
      deepStrictEqual(await restarted.get("board", A1), value);
    }
  }
});

Deno.test("custom projection codecs survive restarts and legacy board JSON remains readable", async () => {
  const store = new FakeProjectionStore();
  const codec = {
    kind: "plantuml",
    version: "1",
    compute: () => Promise.resolve({ text: "true" }),
    encode: (value: { text: string }) => new TextEncoder().encode(value.text),
    decode: (bytes: Uint8Array) => ({ text: new TextDecoder().decode(bytes) }),
  };
  const first = new ModelProjectionRegistry({ maxBytes: 1000, store });
  first.register(codec);
  await first.get("plantuml", A1);
  const restarted = new ModelProjectionRegistry({ maxBytes: 1000, store });
  restarted.register({
    ...codec,
    compute: () => Promise.reject("must not compute"),
  });
  deepStrictEqual(await restarted.get("plantuml", A1), { text: "true" });
  await store.putProjection(
    "board",
    "1",
    A1,
    new TextEncoder().encode('{"legacy":true}'),
  );
  restarted.register({
    kind: "board",
    version: "1",
    compute: () => Promise.reject("must not compute"),
  });
  deepStrictEqual(await restarted.get("board", A1), { legacy: true });
});

Deno.test("new projector versions isolate ready and late pending results", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1000 });
  const old = deferred<string>();
  registry.register({
    kind: "board",
    version: "1",
    compute: (ctx) =>
      ctx.artifactDigest === A1 ? Promise.resolve("old-ready") : old.promise,
  });
  await registry.get("board", A1);
  const pendingOld = registry.get("board", A2);
  registry.register({
    kind: "board",
    version: "2",
    compute: () => Promise.resolve("new"),
  });
  deepStrictEqual(registry.status("board", A2), {
    kind: "board",
    projectorVersion: "2",
    artifactDigest: A2,
    state: "unrequested",
  });
  equal(registry.peek("board", A2), undefined);
  await registry.get("board", A2);
  old.resolve("old-late");
  equal(await pendingOld, "old-late");
  equal(registry.peek("board", A2), "new");
  equal(registry.status("board", A2).state, "ready");
});

Deno.test("immutable projector conflicts fail without memory admission while quota failures are advisory", async () => {
  for (
    const code of ["BUILD_BLOB_CONFLICT", "BUILD_STORE_QUOTA_EXCEEDED"] as const
  ) {
    const store = new FakeProjectionStore();
    store.putProjection = () =>
      Promise.reject(new BuildStoreError(code, {}, "injected write failure"));
    const registry = new ModelProjectionRegistry({ maxBytes: 1000, store });
    let computes = 0;
    registry.register({
      kind: "board",
      version: "1",
      compute: () => {
        computes++;
        return Promise.resolve({ x: 1 });
      },
    });
    if (code === "BUILD_BLOB_CONFLICT") {
      await rejects(() => registry.get("board", A1), { code });
      equal(registry.peek("board", A1), undefined);
      equal(registry.status("board", A1).state, "failed");
      await rejects(() => registry.get("board", A1), { code });
      equal(computes, 2);
    } else {
      deepStrictEqual(await registry.get("board", A1), { x: 1 });
      equal(registry.status("board", A1).state, "ready");
    }
  }
});

Deno.test("empty projection payloads cannot retain unbounded LRU entries", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 4 });
  registry.register({
    kind: "plantuml",
    version: "1",
    compute: () => Promise.resolve(""),
  });
  for (let i = 0; i < 20; i++) {
    await registry.get("plantuml", i.toString(16).padStart(64, "0"));
  }
  equal(registry.stats().entries, 4);
  equal(registry.stats().bytes, 4);
});

Deno.test("evicted projections are unrequested until a new read admits them", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 4 });
  let computes = 0;
  registry.register({
    kind: "plantuml",
    version: "1",
    persistent: false,
    compute: () => {
      computes++;
      return Promise.resolve("four");
    },
  });
  await registry.get("plantuml", A1);
  equal(registry.status("plantuml", A1).state, "ready");
  await registry.get("plantuml", A2);
  equal(registry.status("plantuml", A1).state, "unrequested");
  equal(registry.status("plantuml", A1).projectionDigest, undefined);
  equal(registry.peek("plantuml", A1), undefined);
  await registry.get("plantuml", A1);
  equal(registry.status("plantuml", A1).state, "ready");
  equal(registry.peek("plantuml", A1), "four");
  equal(computes, 3);
  registry.invalidate("plantuml", A1);
  equal(registry.status("plantuml", A1).state, "unrequested");
  equal(registry.peek("plantuml", A1), undefined);
});

Deno.test("oversize projections are served without advertising ready residency", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 4 });
  const events: ProjectionStatus[] = [];
  registry.subscribe((event) => events.push(event));
  registry.register({
    kind: "plantuml",
    version: "1",
    compute: () => Promise.resolve("oversize"),
  });
  equal(await registry.get("plantuml", A1), "oversize");
  equal(registry.status("plantuml", A1).state, "unrequested");
  equal(registry.peek("plantuml", A1), undefined);
  deepStrictEqual(events.map((event) => event.state), [
    "pending",
    "unrequested",
  ]);
});

Deno.test("pending reads retain only resident earlier values", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 4 });
  const gate = deferred<string>();
  registry.register({
    kind: "plantuml",
    version: "1",
    compute: (ctx) =>
      ctx.artifactDigest === A2 ? gate.promise : Promise.resolve("four"),
  });
  await registry.get("plantuml", A1);
  const next = registry.get("plantuml", A2);
  equal(registry.status("plantuml", A2).state, "pending");
  equal(registry.peek("plantuml", A1), "four");
  await registry.get("plantuml", A3); // evicts the fallback while A2 is pending
  equal(registry.status("plantuml", A2).state, "pending");
  equal(registry.peek("plantuml", A1), undefined);
  gate.resolve("oversize");
  await next;
  equal(registry.status("plantuml", A2).state, "unrequested");
});

Deno.test("persisted projections are not promised ready before verified readmission", async () => {
  const store = new FakeProjectionStore();
  const registry = new ModelProjectionRegistry({ maxBytes: 4, store });
  registry.register({
    kind: "plantuml",
    version: "1",
    compute: () => Promise.resolve("four"),
  });
  await registry.get("plantuml", A1);
  await registry.get("plantuml", A2);
  equal(registry.status("plantuml", A1).state, "unrequested");
  equal(registry.peek("plantuml", A1), undefined);
  await registry.get("plantuml", A1);
  equal(registry.status("plantuml", A1).state, "ready");
  equal(registry.peek("plantuml", A1), "four");
});

Deno.test("retry readmits a failed artifact without changing earlier cached values", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1000 });
  let fail = true;
  registry.register({
    kind: "board",
    version: "1",
    compute: (ctx) =>
      ctx.artifactDigest === A2 && fail
        ? Promise.reject(new Error("retryable"))
        : Promise.resolve(ctx.artifactDigest),
  });
  await registry.get("board", A1);
  await rejects(() => registry.get("board", A2));
  equal(registry.status("board", A2).state, "failed");
  equal(registry.peek("board", A1), A1);
  fail = false;
  await registry.get("board", A2);
  equal(registry.status("board", A2).state, "ready");
  equal(registry.peek("board", A2), A2);
});

Deno.test("projection failures are forgotten under sustained parameter churn", async () => {
  const registry = new ModelProjectionRegistry({ maxBytes: 1 });
  registry.register({
    kind: "view-diagram",
    version: "1",
    compute: () => Promise.reject(new Error("failed")),
  });
  for (let i = 0; i < 2000; i++) {
    await rejects(() =>
      registry.get("view-diagram", A1, { params: { view: String(i) } })
    );
  }
  equal(
    registry.status("view-diagram", A1, { params: { view: "0" } }).state,
    "unrequested",
  );
  equal(
    registry.status("view-diagram", A1, { params: { view: "1999" } }).state,
    "failed",
  );
});

Deno.test("completed projection metadata stays bounded independently of payload capacity", async () => {
  for (const maxBytes of [1, 1_000_000]) {
    const registry = new ModelProjectionRegistry({
      maxBytes,
      maxRetainedStates: 8,
    });
    registry.register({
      kind: "view-diagram",
      version: "1",
      compute: (ctx) =>
        ctx.params?.view?.startsWith("fail")
          ? Promise.reject(new Error("failure"))
          : Promise.resolve("four"),
    });
    for (let i = 0; i < 2000; i++) {
      const params = { view: `${i % 2 ? "fail" : "ready"}-${i}` };
      if (i % 2) {
        await rejects(() => registry.get("view-diagram", A1, { params }));
      } else await registry.get("view-diagram", A1, { params });
      equal(registry.stats().retainedStatuses <= 8, true);
    }
    equal(registry.stats().pending, 0);
    equal(
      registry.status("view-diagram", A1, { params: { view: "fail-1" } }).state,
      "unrequested",
    );
    equal(
      registry.status("view-diagram", A1, { params: { view: "fail-1999" } })
        .state,
      "failed",
    );
    // Ready is derived from residency independently of retained failure history.
    equal(
      registry.status("view-diagram", A1, { params: { view: "ready-0" } })
        .state,
      maxBytes === 1 ? "unrequested" : "ready",
    );
  }
  const evicting = new ModelProjectionRegistry({
    maxBytes: 4,
    maxRetainedStates: 8,
  });
  evicting.register({
    kind: "board",
    version: "1",
    compute: () => Promise.resolve("four"),
  });
  for (let i = 0; i < 2000; i++) {
    await evicting.get("board", A1, { params: { view: String(i) } });
  }
  equal(evicting.stats().entries, 1);
  equal(evicting.stats().retainedStatuses, 0);
  equal(
    evicting.status("board", A1, { params: { view: "0" } }).state,
    "unrequested",
  );
});

Deno.test("projection history pressure preserves pending reads and coalescing", async () => {
  const registry = new ModelProjectionRegistry({
    maxBytes: 100_000,
    maxRetainedStates: 2,
  });
  const gates = new Map<string, ReturnType<typeof deferred<string>>>();
  let computes = 0;
  registry.register({
    kind: "view-diagram",
    version: "1",
    compute: (ctx) => {
      computes++;
      if (ctx.artifactDigest === A1) return Promise.resolve("fallback");
      const gate = deferred<string>();
      gates.set(`${ctx.params?.view}/${ctx.artifactDigest}`, gate);
      return gate.promise;
    },
  });
  const params = { view: "live" };
  await registry.get("view-diagram", A1, { params });
  const older = registry.get("view-diagram", A2, { params });
  const newer = registry.get("view-diagram", A3, { params });
  const pending = Array.from(
    { length: 200 },
    (_, i) => registry.get("view-diagram", A2, { params: { view: String(i) } }),
  );
  equal(registry.stats().pending, 202);
  // Coalescing still works after exceeding the completed history budget.
  const joined = registry.get("view-diagram", A2, { params });
  equal(computes, 203);
  gates.get("live/" + A3)!.resolve("latest");
  equal(await newer, "latest");
  // Register rejection observers before releasing the batch.
  const settled = Promise.allSettled(pending);
  for (let i = 0; i < 200; i++) {
    const gate = gates.get(`${i}/${A2}`)!;
    if (i % 2) gate.reject(new Error("batch failure"));
    else gate.resolve("done");
  }
  const outcomes = await settled;
  equal(
    outcomes.filter((outcome) => outcome.status === "rejected").length,
    100,
  );
  gates.get("live/" + A2)!.resolve("late");
  deepStrictEqual(await Promise.all([older, joined]), ["late", "late"]);
  equal(registry.stats().pending, 0);
  equal(registry.stats().retainedStatuses, 2);
});

Deno.test("retained projection errors have bounded text without changing rejection or events", async () => {
  const registry = new ModelProjectionRegistry({
    maxBytes: 1,
    maxRetainedStates: 2,
  });
  const error = Object.assign(new Error("x".repeat(10_000)), {
    code: "C".repeat(1000),
  });
  const events: ProjectionStatus[] = [];
  registry.subscribe((event) => events.push(event));
  registry.register({
    kind: "board",
    version: "1",
    compute: () => Promise.reject(error),
  });
  await rejects(
    () => registry.get("board", A1),
    (caught) => caught === error,
  );
  equal(events.at(-1)?.error?.message, error.message);
  equal(events.at(-1)?.error?.code, error.code);
  equal(registry.status("board", A1).error?.message.length, 2048);
  equal(registry.status("board", A1).error?.code.length, 128);
  registry.invalidate("board", A1);
  equal(registry.stats().retainedStatuses, 0);
  equal(registry.status("board", A1).state, "unrequested");
});
