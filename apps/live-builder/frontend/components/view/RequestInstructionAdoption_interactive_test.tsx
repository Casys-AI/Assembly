import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { h } from "preact";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { useRequestInstructionAdoption } from "./RequestInstructionAdoption.tsx";
import type { CaseModelScope } from "../../lib/case-model-scope.ts";

const r0 = `commit:${"a".repeat(40)}`, a1 = `commit:${"b".repeat(40)}`;
const before = { version: r0, digest: "c".repeat(64) },
  target = { version: a1, digest: "d".repeat(64) };
const scope = (caseId = "caseA", viewed = r0): CaseModelScope => ({
  caseId,
  branchId: `branch-${caseId}`,
  executionSpaceId: `space-${caseId}`,
  branchVersion: a1,
  executionVersion: r0,
  version: viewed,
  release: null,
  readOnly: true,
});
const storageKey = (s: CaseModelScope) =>
  `assembly.request-adoption.v1:${
    JSON.stringify([s.caseId, s.branchId, s.executionSpaceId])
  }`;
const selectionKey = (s: CaseModelScope, generation: number) =>
  JSON.stringify([
    s.caseId,
    s.branchId,
    s.executionSpaceId,
    s.version,
    s.branchVersion,
    s.executionVersion,
    true,
    generation,
  ]);
const eligibility = (caseId: string) => ({
  caseId,
  eligible: true,
  executing: before,
  admitted: target,
  blockers: [],
});
const receipt = {
  commandId: `request-adoption:${"a".repeat(64)}`,
  receiptDigest: "e".repeat(64),
  committedRuntimeRevision: 3,
  journalRevision: 3,
  journalDigest: "f".repeat(64),
  recordedAt: "2026-10-30T00:00:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let n = 0; n < 8; n++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failReadback = false;
  failRemove = false;
  ignoreRemove = false;
  failAfterRemove = false;
  removed = false;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    if (this.failAfterRemove && this.removed) {
      throw new Error("Owned storage read failed after removal");
    }
    return this.failReadback ? null : this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    if (this.failRemove) throw new Error("Owned storage removal failed");
    if (!this.ignoreRemove) this.values.delete(key);
    this.removed = true;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
type Controller = ReturnType<typeof useRequestInstructionAdoption>;
class MemoryLocks {
  private tails = new Map<string, Promise<void>>();
  names: string[] = [];
  request<T>(
    name: string,
    _options: unknown,
    run: () => T | Promise<T>,
  ): Promise<T> {
    this.names.push(name);
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(run);
    this.tails.set(name, result.then(() => {}, () => {}));
    return result;
  }
}
function harness(
  fetcher: typeof fetch,
  shared: {
    storage?: MemoryStorage;
    legacy?: MemoryStorage;
    locks?: MemoryLocks | null;
  } = {},
) {
  const root = probeRoot(),
    storage = shared.storage ?? new MemoryStorage(),
    legacy = shared.legacy ?? new MemoryStorage();
  const locks = shared.locks === undefined ? new MemoryLocks() : shared.locks;
  const oldFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetcher,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: legacy,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  let current!: Controller;
  function ControllerProbe(
    props: { scope: CaseModelScope; onAdopted?: (id: string) => void },
  ) {
    current = useRequestInstructionAdoption({
      scope: props.scope,
      sessionReady: true,
      onAdopted: props.onAdopted,
    });
    return null;
  }
  function Selection(
    props: {
      scope: CaseModelScope;
      generation: number;
      onAdopted?: (id: string) => void;
    },
  ) {
    return h(ControllerProbe, {
      key: selectionKey(props.scope, props.generation),
      scope: props.scope,
      onAdopted: props.onAdopted,
    });
  }
  return {
    storage,
    legacy,
    get current() {
      return current;
    },
    async show(
      value: CaseModelScope,
      generation = 1,
      onAdopted?: (id: string) => void,
    ) {
      await root.show(Selection, { scope: value, generation, onAdopted });
      await settle();
    },
    async start() {
      await act(() => current.start());
      await settle();
    },
    async apply(action: "prepare" | "status" | "resume") {
      ok(current.intent);
      await act(async () => {
        await current.apply(action, current.intent!);
      });
      await settle();
    },
    async retryEligibility() {
      await act(async () => {
        await current.retryEligibility();
      });
      await settle();
    },
    async acknowledge() {
      await act(async () => {
        await current.acknowledge();
      });
      await settle();
    },
    async unmount() {
      await root.unmount();
    },
    async close() {
      await root.restore();
      oldFetch
        ? Object.defineProperty(globalThis, "fetch", oldFetch)
        : Reflect.deleteProperty(globalThis, "fetch");
      oldStorage
        ? Object.defineProperty(globalThis, "sessionStorage", oldStorage)
        : Reflect.deleteProperty(globalThis, "sessionStorage");
      oldLocal
        ? Object.defineProperty(globalThis, "localStorage", oldLocal)
        : Reflect.deleteProperty(globalThis, "localStorage");
      oldNavigator
        ? Object.defineProperty(globalThis, "navigator", oldNavigator)
        : Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}
const action = (input: RequestInfo | URL) => String(input).split("/").at(-1);
Deno.test("adoption persists and reads back the original intent before prepare; lost ACK recovers the same key", async () => {
  const requests: {
    action: string | undefined;
    body: Record<string, string>;
  }[] = [];
  const selected = scope();
  const fetcher: typeof fetch = (input, init) => {
    const name = action(input), body = JSON.parse(String(init?.body));
    requests.push({ action: name, body });
    if (name === "eligibility") {
      return Promise.resolve(Response.json(eligibility(body.caseId)));
    }
    const stored = JSON.parse(h.storage.getItem(storageKey(selected))!);
    equal(stored.adoptionKey, body.adoptionKey);
    deepStrictEqual(stored.before, before);
    deepStrictEqual(stored.target, target);
    if (name === "prepare") throw new Error("ACK lost after commit");
    if (name === "status") {
      return Promise.resolve(Response.json({
        caseId: selected.caseId,
        adoptionKey: stored.adoptionKey,
        status: "adopted",
        before,
        target,
        blockers: [],
        receipt,
      }));
    }
    throw new Error("Unexpected command");
  };
  const h = harness(fetcher);
  try {
    await h.show(selected);
    equal(h.current.eligible?.eligible, true);
    await h.start();
    const saved = JSON.parse(h.storage.getItem(storageKey(selected))!);
    match(saved.adoptionKey, /^adoption-/);
    equal(h.current.status, null);
    await h.unmount();
    await h.show(selected);
    if (!requests.some((entry) => entry.action === "status")) {
      await h.apply("status");
    }
    const checks = requests.filter((entry) => entry.action === "status");
    ok(checks.length >= 1);
    equal(checks[0].body.adoptionKey, saved.adoptionKey);
    equal(requests.filter((entry) => entry.action === "prepare").length, 1);
    equal((() => h.current)().status?.status, "adopted");
  } finally {
    await h.close();
  }
});
Deno.test("failed durable readback prevents prepare", async () => {
  const calls: string[] = [];
  const h = harness((input) => {
    calls.push(action(input)!);
    return Promise.resolve(Response.json(eligibility("caseA")));
  });
  try {
    await h.show(scope());
    h.storage.failReadback = true;
    await h.start();
    equal(calls.includes("prepare"), false);
    match(h.current.message!, /could not be retained/i);
  } finally {
    await h.close();
  }
});
Deno.test("old Case, session or version eligibility cannot authorize a newer selection", async () => {
  for (const changed of ["case", "session", "version"] as const) {
    const old = deferred<Response>(), fresh = deferred<Response>();
    let count = 0;
    const h = harness(async () =>
      ++count === 1 ? await old.promise : await fresh.promise
    );
    try {
      await h.show(scope());
      const next = changed === "case"
        ? scope("caseB")
        : changed === "version"
        ? scope("caseA", a1)
        : scope();
      await h.show(next, changed === "session" ? 2 : 1);
      old.resolve(Response.json(eligibility("caseA")));
      await settle();
      equal(h.current.eligible, null);
      equal(count, 2);
      await h.start();
      equal(h.current.intent, null);
      fresh.resolve(
        Response.json(eligibility(changed === "case" ? "caseB" : "caseA")),
      );
      await settle();
      if (changed === "version") {
        await h.start();
        equal(h.current.intent, null);
      }
    } finally {
      await h.close();
    }
  }
});

const savedIntent = (selected = scope()) => ({
  v: 1,
  caseId: selected.caseId,
  branchId: selected.branchId,
  executionSpaceId: selected.executionSpaceId,
  adoptionKey: "adoption-original",
  before,
  target,
});
const terminalResult = (
  intent: ReturnType<typeof savedIntent>,
  status = "adopted",
) => ({
  caseId: intent.caseId,
  adoptionKey: intent.adoptionKey,
  before: intent.before,
  target: intent.target,
  status,
  blockers: [],
  ...(status === "adopted" ? { receipt } : {}),
});
Deno.test("shared-tab allocation serializes one exact slot and cannot replace the first key", async () => {
  const storage = new MemoryStorage(),
    legacy = new MemoryStorage(),
    locks = new MemoryLocks();
  const selected = scope(), prepares: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (action(input) === "eligibility") {
      return Promise.resolve(Response.json(eligibility(selected.caseId)));
    }
    prepares.push(body.adoptionKey);
    return Promise.resolve(
      Response.json(
        terminalResult(
          JSON.parse(storage.getItem(storageKey(selected))!),
          "prepared",
        ),
      ),
    );
  };
  const first = harness(fetcher, { storage, legacy, locks }),
    second = harness(fetcher, { storage, legacy, locks });
  try {
    await first.show(selected);
    await second.show(selected);
    const left = first.current.start(), right = second.current.start();
    await Promise.all([left, right]);
    await settle();
    equal(prepares.length, 1);
    equal(
      JSON.parse(storage.getItem(storageKey(selected))!).adoptionKey,
      prepares[0],
    );
    match(second.current.message!, /identity already exists/);
    ok(locks.names.every((name) => name === storageKey(selected)));
  } finally {
    await second.close();
    await first.close();
  }
});
Deno.test("interleaved legacy promotions preserve the winning durable key and refuse a conflicting tab identity", async () => {
  const selected = scope(),
    storage = new MemoryStorage(),
    locks = new MemoryLocks();
  const legacyA = new MemoryStorage(), legacyB = new MemoryStorage();
  const a = savedIntent(selected), b = { ...a, adoptionKey: "other-tab-key" };
  legacyA.setItem(storageKey(selected), JSON.stringify(a));
  legacyB.setItem(storageKey(selected), JSON.stringify(b));
  const release = deferred<void>();
  const held = locks.request(storageKey(selected), {}, () => release.promise);
  let reads = 0;
  const fetcher: typeof fetch = () => {
    reads++;
    return Promise.resolve(Response.json(terminalResult(a, "prepared")));
  };
  const first = harness(fetcher, { storage, legacy: legacyA, locks });
  let second: ReturnType<typeof harness> | undefined;
  try {
    await first.show(selected);
    second = harness(fetcher, { storage, legacy: legacyB, locks });
    await second.show(selected);
    release.resolve();
    await held;
    await settle();
    equal(storage.getItem(storageKey(selected)), JSON.stringify(a));
    equal(legacyA.getItem(storageKey(selected)), null);
    equal(legacyB.getItem(storageKey(selected)), JSON.stringify(b));
    equal(reads, 1);
    match(second.current.message!, /Conflicting saved/);
  } finally {
    release.resolve();
    await second?.close();
    await first.close();
  }
});
Deno.test("two acknowledgers cannot retire a later allocation and no slot lock spans a status request", async () => {
  const selected = scope(), original = savedIntent(selected);
  const storage = new MemoryStorage(),
    legacy = new MemoryStorage(),
    locks = new MemoryLocks();
  storage.setItem(storageKey(selected), JSON.stringify(original));
  const delayed = deferred<Response>(), entered = deferred<void>();
  let delayNext = false;
  let pins = eligibility(selected.caseId);
  const fetcher: typeof fetch = (input) => {
    if (action(input) === "eligibility") {
      return Promise.resolve(Response.json(pins));
    }
    if (action(input) === "prepare") {
      return Promise.resolve(
        Response.json(
          terminalResult(
            JSON.parse(storage.getItem(storageKey(selected))!),
            "prepared",
          ),
        ),
      );
    }
    if (delayNext) {
      delayNext = false;
      entered.resolve();
      return delayed.promise;
    }
    return Promise.resolve(Response.json(terminalResult(original)));
  };
  const first = harness(fetcher, { storage, legacy, locks }),
    second = harness(fetcher, { storage, legacy, locks });
  let third: ReturnType<typeof harness> | undefined;
  try {
    await first.show(selected);
    await second.show(selected);
    delayNext = true;
    const oldAcknowledgement = second.current.acknowledge();
    await entered.promise;
    await first.acknowledge();
    equal(storage.getItem(storageKey(selected)), null);
    const next = {
      version: `commit:${"f".repeat(40)}`,
      digest: "1".repeat(64),
    };
    pins = { ...pins, executing: target, admitted: next };
    third = harness(fetcher, { storage, legacy, locks });
    await third.show({
      ...selected,
      version: a1,
      executionVersion: a1,
      branchVersion: next.version,
    });
    await third.start();
    const fresh = storage.getItem(storageKey(selected));
    ok(fresh);
    ok(JSON.parse(fresh).adoptionKey !== original.adoptionKey);
    delayed.resolve(Response.json(terminalResult(original)));
    await oldAcknowledgement;
    await settle();
    equal(storage.getItem(storageKey(selected)), fresh);
    match(second.current.message!, /identity changed/);
  } finally {
    delayed.resolve(Response.json(terminalResult(original)));
    await third?.close();
    await second.close();
    await first.close();
  }
});
Deno.test("late lock acquisition cannot allocate after selection changes; unavailable locks preserve read recovery", async () => {
  const selected = scope(),
    locks = new MemoryLocks(),
    release = deferred<void>();
  const h = harness(
    (_input, init) =>
      Promise.resolve(
        Response.json(eligibility(JSON.parse(String(init?.body)).caseId)),
      ),
    { locks },
  );
  try {
    await h.show(selected);
    const held = locks.request(storageKey(selected), {}, () => release.promise);
    const starting = h.current.start();
    await h.show(scope("caseB"));
    release.resolve();
    await held;
    await starting;
    await settle();
    equal(h.storage.getItem(storageKey(selected)), null);
  } finally {
    release.resolve();
    await h.close();
  }
  const original = savedIntent(selected), calls: string[] = [];
  const without = harness((input) => {
    calls.push(action(input)!);
    return Promise.resolve(
      Response.json(
        action(input) === "eligibility"
          ? eligibility(selected.caseId)
          : terminalResult(original, "prepared"),
      ),
    );
  }, { locks: null });
  try {
    await without.show(selected);
    await without.start();
    match(without.current.message!, /Safe browser locking is unavailable/);
    equal(without.storage.getItem(storageKey(selected)), null);
    without.storage.setItem(storageKey(selected), JSON.stringify(original));
    await without.show(selected, 2);
    await without.apply("resume");
    await without.apply("status");
    deepStrictEqual(calls, ["eligibility", "status", "status"]);
    equal(
      without.storage.getItem(storageKey(selected)),
      JSON.stringify(original),
    );
  } finally {
    await without.close();
  }
});
Deno.test("eligibility maps the preserved admission-denial alias without unknown-mutation wording", async () => {
  const h = harness(() =>
    Promise.resolve(
      Response.json({ code: "ADMISSION_REFUSED", error: "private stack" }, {
        status: 403,
      }),
    )
  );
  try {
    await h.show(scope());
    match(h.current.message!, /Current control or execution permission/);
    ok(!h.current.message!.includes("unknown"));
  } finally {
    await h.close();
  }
});
Deno.test("pre-send prepare failure survives tab close and explicitly retries the original expectations and key", async () => {
  const calls: { action: string; body: Record<string, string> }[] = [];
  let attempts = 0;
  const selected = scope();
  const h = harness((input, init) => {
    const name = action(input)!, body = JSON.parse(String(init?.body));
    calls.push({ action: name, body });
    if (name === "eligibility") {
      return Promise.resolve(Response.json(eligibility(selected.caseId)));
    }
    if (name === "status") {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (++attempts === 1) {
      return Promise.reject(new TypeError("Network unavailable before send"));
    }
    const original = JSON.parse(h.storage.getItem(storageKey(selected))!);
    return Promise.resolve(Response.json(terminalResult(original, "prepared")));
  });
  try {
    await h.show(selected);
    await h.start();
    const encoded = h.storage.getItem(storageKey(selected))!;
    ok(encoded);
    equal(h.legacy.getItem(storageKey(selected)), null);
    await h.unmount();
    h.legacy.clear();
    await h.show(selected);
    equal(h.current.status, null);
    equal(attempts, 1, "restore reads status without sending a mutation");
    await h.apply("prepare");
    const prepares = calls.filter((call) => call.action === "prepare");
    deepStrictEqual(prepares[1].body, prepares[0].body);
    equal(h.storage.getItem(storageKey(selected)), encoded);
    equal((() => h.current)().status?.status, "prepared");
  } finally {
    await h.close();
  }
});
Deno.test("legacy intent is safely promoted once and conflicting durable identity refuses every action", async () => {
  for (const conflict of [false, true]) {
    const selected = scope(),
      original = savedIntent(selected),
      calls: string[] = [];
    const encoded = JSON.stringify(original);
    const h = harness((input) => {
      calls.push(action(input)!);
      return Promise.resolve(
        Response.json(terminalResult(original, "prepared")),
      );
    });
    try {
      h.legacy.setItem(storageKey(selected), encoded);
      if (conflict) {
        h.storage.setItem(
          storageKey(selected),
          JSON.stringify({ ...original, adoptionKey: "other-key" }),
        );
      }
      await h.show(selected);
      if (conflict) {
        deepStrictEqual(calls, []);
        equal(h.current.intent, null);
        match(h.current.message!, /Conflicting saved/);
        await h.start();
        await h.retryEligibility();
        deepStrictEqual(calls, []);
        equal(h.legacy.getItem(storageKey(selected)), encoded);
      } else {
        equal(h.storage.getItem(storageKey(selected)), encoded);
        equal(h.legacy.getItem(storageKey(selected)), null);
        deepStrictEqual(calls, ["status"]);
        await h.unmount();
        h.legacy.clear();
        await h.show(selected);
        deepStrictEqual(calls, ["status", "status"]);
      }
    } finally {
      await h.close();
    }
  }
});
Deno.test("restored committed status invalidates a stale before pin once per mount and leaves corrected or newer execution alone", async () => {
  const selected = scope(), original = savedIntent(selected);
  let invalidations = 0;
  const h = harness(() =>
    Promise.resolve(Response.json(terminalResult(original)))
  );
  const notify = () => {
    invalidations++;
  };
  try {
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected, 1, notify);
    equal(invalidations, 1);
    await h.apply("status");
    equal(invalidations, 1, "repeated reads in this selection do not loop");
    await h.unmount();
    await h.show(selected, 2, notify);
    equal(
      invalidations,
      2,
      "a genuinely stale remount is allowed to refresh its before pin again",
    );
    await h.show({ ...selected, executionVersion: a1, version: a1 }, 3, notify);
    equal(invalidations, 2, "corrected R1 needs no further invalidation");
    const r2 = `commit:${"f".repeat(40)}`;
    await h.show({ ...selected, executionVersion: r2, version: r2 }, 4, notify);
    equal(invalidations, 2, "old R1 receipt cannot move a newer R2 selection");
    await h.acknowledge();
    equal(invalidations, 2);
  } finally {
    await h.close();
  }
});
Deno.test("legacy promotion storage failure preserves the original tab key and sends no request", async () => {
  const selected = scope(), encoded = JSON.stringify(savedIntent(selected));
  let calls = 0;
  const h = harness(() => {
    calls++;
    return Promise.resolve(Response.json({}));
  });
  try {
    h.legacy.setItem(storageKey(selected), encoded);
    h.storage.failReadback = true;
    await h.show(selected);
    match(h.current.message!, /could not be retained/);
    equal(h.legacy.getItem(storageKey(selected)), encoded);
    equal(calls, 0);
    await h.start();
    equal(calls, 0);
  } finally {
    await h.close();
  }
});
Deno.test("historical inspection reads status but cannot prepare or resume an original intent", async () => {
  const selected = scope("caseA", a1),
    original = savedIntent(selected),
    calls: string[] = [];
  const h = harness((input) => {
    calls.push(action(input)!);
    return Promise.resolve(Response.json(terminalResult(original, "prepared")));
  });
  try {
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected);
    await h.apply("prepare");
    await h.apply("resume");
    await h.apply("status");
    deepStrictEqual(calls, ["status", "status"]);
  } finally {
    await h.close();
  }
});
Deno.test("explicit eligibility retry stays read-only and accepts server blocker boundaries", async () => {
  for (const changed of ["valid", "count", "text"]) {
    let checks = 0;
    const h = harness((input) => {
      equal(action(input), "eligibility");
      if (++checks === 1) {
        return Promise.resolve(
          Response.json({ code: "UNAVAILABLE", error: "private stack" }, {
            status: 503,
          }),
        );
      }
      return Promise.resolve(Response.json({
        ...eligibility("caseA"),
        eligible: false,
        blockers: Array.from(
          { length: changed === "count" ? 257 : 256 },
          () => ({
            code: "c".repeat(2048),
            detail: "d".repeat(changed === "text" ? 2049 : 2048),
          }),
        ),
      }));
    });
    try {
      await h.show(scope());
      match(h.current.message!, /eligibility is unavailable/);
      ok(!h.current.message!.includes("private stack"));
      await h.retryEligibility();
      equal(checks, 2);
      equal(h.current.intent, null);
      if (changed === "valid") {
        equal(h.current.eligible?.blockers.length, 256);
        equal(h.current.message, null);
      } else {
        equal(h.current.eligible, null);
        match(h.current.message!, /no longer matches/);
      }
    } finally {
      await h.close();
    }
  }
});
Deno.test("current admitted instruction needs no fresh eligibility while saved intent recovery remains exact", async () => {
  const selected = {
    ...scope(),
    executionVersion: a1,
    version: a1,
  };
  const calls: string[] = [], original = savedIntent(selected);
  const h = harness((input) => {
    const name = action(input)!;
    calls.push(name);
    if (name !== "status") throw new Error("No fresh adoption target exists");
    return Promise.resolve(Response.json(terminalResult(original)));
  });
  try {
    await h.show(selected);
    deepStrictEqual(calls, []);
    equal(h.current.message, null);
    equal(h.current.eligible, null);
    await h.start();
    deepStrictEqual(calls, []);
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected, 2);
    deepStrictEqual(calls, ["status"]);
    equal(h.current.status?.status, "adopted");
    await h.acknowledge();
    deepStrictEqual(calls, ["status", "status"]);
    equal(h.storage.getItem(storageKey(selected)), null);
    equal(h.current.message, null);
  } finally {
    await h.close();
  }
});
Deno.test("different admitted instruction retains eligibility errors and equal pins retain unknown saved outcomes", async () => {
  const calls: string[] = [];
  const h = harness((input) => {
    calls.push(action(input)!);
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  try {
    await h.show(scope());
    deepStrictEqual(calls, ["eligibility"]);
    match(h.current.message!, /eligibility is unavailable/);
    const selected = { ...scope(), executionVersion: a1, version: a1 };
    const original = savedIntent(selected);
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected, 2);
    deepStrictEqual(calls, ["eligibility", "status"]);
    equal(h.current.status, null);
    match(h.current.message!, /No verified result/);
    equal(h.storage.getItem(storageKey(selected)), JSON.stringify(original));
  } finally {
    await h.close();
  }
});
Deno.test("explicit fresh acknowledgement permits the next same-Case instruction only after a separate start", async () => {
  const next = { version: `commit:${"f".repeat(40)}`, digest: "1".repeat(64) };
  const selected = {
    ...scope(),
    version: a1,
    executionVersion: a1,
    branchVersion: next.version,
  };
  const original = savedIntent(selected),
    calls: { name: string; body: Record<string, string> }[] = [];
  const h = harness((input, init) => {
    const name = action(input)!, body = JSON.parse(String(init?.body));
    calls.push({ name, body });
    if (name === "status") {
      return Promise.resolve(Response.json(terminalResult(original)));
    }
    if (name === "eligibility") {
      return Promise.resolve(
        Response.json({
          caseId: selected.caseId,
          eligible: true,
          executing: target,
          admitted: next,
          blockers: [],
        }),
      );
    }
    if (name === "prepare") {
      const stored = JSON.parse(h.storage.getItem(storageKey(selected))!);
      return Promise.resolve(Response.json({
        ...terminalResult(stored),
        receipt: {
          ...receipt,
          commandId: `request-adoption:${"b".repeat(64)}`,
          receiptDigest: "2".repeat(64),
          committedRuntimeRevision: 5,
          journalRevision: 5,
        },
      }));
    }
    throw new Error("Unexpected command");
  });
  try {
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected);
    equal(h.current.status?.status, "adopted");
    equal(calls.filter((c) => c.name === "eligibility").length, 0);
    await h.acknowledge();
    equal(
      calls.filter((c) => c.name === "status").length,
      2,
      "acknowledgement rechecks the original key freshly",
    );
    equal(h.storage.getItem(storageKey(selected)), null);
    equal(h.current.intent, null);
    deepStrictEqual(h.current.eligible?.executing, target);
    deepStrictEqual(h.current.eligible?.admitted, next);
    equal(calls.filter((c) => c.name === "prepare").length, 0);
    await h.start();
    const subsequent = JSON.parse(h.storage.getItem(storageKey(selected))!);
    ok(subsequent.adoptionKey !== original.adoptionKey);
    deepStrictEqual(subsequent.before, target);
    deepStrictEqual(subsequent.target, next);
    equal(calls.filter((c) => c.name === "prepare").length, 1);
  } finally {
    await h.close();
  }
});
Deno.test("cancelled and refused results need fresh same-key proof before explicit retirement", async () => {
  for (const terminal of ["cancelled", "refused"]) {
    const selected = scope(),
      original = savedIntent(selected),
      calls: string[] = [];
    const h = harness((input) => {
      const name = action(input)!;
      calls.push(name);
      return Promise.resolve(
        Response.json(
          name === "status"
            ? terminalResult(original, terminal)
            : eligibility(selected.caseId),
        ),
      );
    });
    try {
      h.storage.setItem(storageKey(selected), JSON.stringify(original));
      await h.show(selected);
      equal(h.current.status?.status, terminal);
      await h.acknowledge();
      deepStrictEqual(calls, ["status", "status", "eligibility"]);
      equal(h.current.intent, null);
      equal(h.storage.getItem(storageKey(selected)), null);
    } finally {
      await h.close();
    }
  }
});
Deno.test("prepared, armed, missing and mismatched status never retire the original key", async () => {
  for (const state of ["prepared", "armed", "missing", "mismatch"]) {
    const selected = scope(),
      original = savedIntent(selected),
      encoded = JSON.stringify(original);
    const calls: string[] = [];
    const h = harness((input) => {
      calls.push(action(input)!);
      return Promise.resolve(
        state === "missing"
          ? new Response(null, { status: 404 })
          : Response.json({
            ...terminalResult(
              original,
              state === "mismatch" ? "adopted" : state,
            ),
            ...(state === "mismatch" ? { adoptionKey: "foreign-key" } : {}),
          }),
      );
    });
    try {
      h.storage.setItem(storageKey(selected), encoded);
      await h.show(selected);
      await h.acknowledge();
      deepStrictEqual(calls, ["status"]);
      equal(h.storage.getItem(storageKey(selected)), encoded);
      equal(h.current.intent?.adoptionKey, original.adoptionKey);
    } finally {
      await h.close();
    }
  }
});
Deno.test("acknowledgement preserves recovery on fresh 404, mismatched receipt or terminal downgrade", async () => {
  for (const failure of ["missing", "receipt", "prepared"]) {
    const selected = scope(),
      original = savedIntent(selected),
      encoded = JSON.stringify(original);
    let checks = 0;
    const calls: string[] = [];
    const h = harness((input) => {
      calls.push(action(input)!);
      if (++checks === 1) {
        return Promise.resolve(Response.json(terminalResult(original)));
      }
      return Promise.resolve(
        failure === "missing"
          ? new Response(null, { status: 404 })
          : Response.json(
            failure === "prepared" ? terminalResult(original, "prepared") : {
              ...terminalResult(original),
              receipt: { ...receipt, receiptDigest: "9".repeat(64) },
            },
          ),
      );
    });
    try {
      h.storage.setItem(storageKey(selected), encoded);
      await h.show(selected);
      await h.acknowledge();
      equal(h.current.intent?.adoptionKey, original.adoptionKey);
      equal(h.storage.getItem(storageKey(selected)), encoded);
      deepStrictEqual(calls, ["status", "status"]);
      ok(h.current.message);
    } finally {
      await h.close();
    }
  }
});
Deno.test("storage removal, readback and exact-active-slot conflicts never request next eligibility", async () => {
  for (
    const failure of ["remove", "readback", "throw-after-remove", "conflict"]
  ) {
    const selected = scope(),
      original = savedIntent(selected),
      encoded = JSON.stringify(original),
      calls: string[] = [];
    const h = harness((input) => {
      calls.push(action(input)!);
      return Promise.resolve(Response.json(terminalResult(original)));
    });
    try {
      h.storage.setItem(storageKey(selected), encoded);
      await h.show(selected);
      if (failure === "remove") h.storage.failRemove = true;
      if (failure === "readback") h.storage.ignoreRemove = true;
      if (failure === "throw-after-remove") h.storage.failAfterRemove = true;
      const conflicting = JSON.stringify({
        ...original,
        adoptionKey: "another-active-key",
      });
      if (failure === "conflict") {
        h.storage.setItem(storageKey(selected), conflicting);
      }
      await h.acknowledge();
      equal(h.current.intent?.adoptionKey, original.adoptionKey);
      ok(h.current.message);
      deepStrictEqual(calls, ["status", "status"]);
      if (failure !== "throw-after-remove") {
        equal(
          h.storage.getItem(storageKey(selected)),
          failure === "conflict" ? conflicting : encoded,
        );
      }
      // If removal succeeded before readback threw, recovery stays conservative
      // in memory; no claim that a failed read proved the durable slot remained.
    } finally {
      await h.close();
    }
  }
});
Deno.test("late automatic status cannot replace a newer explicit terminal check", async () => {
  const old = deferred<Response>(),
    selected = scope(),
    original = savedIntent(selected);
  let checks = 0;
  const h = harness(() =>
    ++checks === 1
      ? old.promise
      : Promise.resolve(Response.json(terminalResult(original)))
  );
  try {
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected);
    await h.apply("status");
    equal(h.current.status?.status, "adopted");
    old.resolve(Response.json(terminalResult(original, "prepared")));
    await settle();
    equal(h.current.status?.status, "adopted");
  } finally {
    await h.close();
  }
});
Deno.test("late terminal acknowledgement cannot clear an old Case/session/version identity or authorize the new selection", async () => {
  for (const changed of ["case", "session", "version"]) {
    const pending = deferred<Response>(),
      selected = scope(),
      original = savedIntent(selected),
      encoded = JSON.stringify(original);
    let statusCalls = 0, notifications = 0;
    const h = harness((input, init) => {
      const body = JSON.parse(String(init?.body));
      if (action(input) === "eligibility") {
        return Promise.resolve(Response.json(eligibility(body.caseId)));
      }
      return ++statusCalls === 2
        ? pending.promise
        : Promise.resolve(Response.json(terminalResult(original)));
    });
    try {
      h.storage.setItem(storageKey(selected), encoded);
      await h.show(selected, 1, () => {
        notifications++;
      });
      await act(() => {
        void h.current.acknowledge();
      });
      await h.show(
        changed === "case"
          ? scope("caseB")
          : changed === "version"
          ? { ...scope(), branchVersion: `commit:${"f".repeat(40)}` }
          : selected,
        changed === "session" ? 2 : 1,
      );
      pending.resolve(Response.json(terminalResult(original)));
      await settle();
      equal(h.storage.getItem(storageKey(selected)), encoded);
      equal(
        notifications,
        1,
        "only the earlier verified restored receipt invalidates its selection",
      );
      if (changed !== "case") {
        equal(h.current.intent?.adoptionKey, original.adoptionKey);
      }
    } finally {
      await h.close();
    }
  }
});
Deno.test("acknowledging adopted R1 while the scope still displays R0 refuses stale eligibility and refreshes context", async () => {
  const selected = scope(),
    original = savedIntent(selected),
    calls: string[] = [];
  let refreshes = 0;
  const h = harness((input) => {
    calls.push(action(input)!);
    return Promise.resolve(Response.json(
      action(input) === "eligibility"
        ? {
          caseId: selected.caseId,
          eligible: true,
          executing: target,
          admitted: target,
          blockers: [],
        }
        : terminalResult(original),
    ));
  });
  try {
    h.storage.setItem(storageKey(selected), JSON.stringify(original));
    await h.show(selected, 1, () => {
      refreshes++;
    });
    await h.acknowledge();
    deepStrictEqual(calls, ["status", "status", "eligibility"]);
    equal(h.current.eligible, null);
    equal(refreshes, 1);
    match(h.current.message!, /Eligibility no longer matches/);
  } finally {
    await h.close();
  }
});

Deno.test("a historical terminal intent cannot force a newer current Request back to its old before or target pin", async () => {
  for (const terminal of ["adopted", "cancelled", "refused"]) {
    const r2 = { version: `commit:${"f".repeat(40)}`, digest: "1".repeat(64) };
    const a3 = { version: `commit:${"9".repeat(40)}`, digest: "2".repeat(64) };
    const selected = {
      ...scope(),
      version: r2.version,
      executionVersion: r2.version,
      branchVersion: a3.version,
    };
    const original = savedIntent(selected), calls: string[] = [];
    const h = harness((input) => {
      calls.push(action(input)!);
      return Promise.resolve(
        Response.json(
          action(input) === "eligibility"
            ? {
              caseId: selected.caseId,
              eligible: true,
              executing: r2,
              admitted: a3,
              blockers: [],
            }
            : terminalResult(original, terminal),
        ),
      );
    });
    try {
      h.storage.setItem(storageKey(selected), JSON.stringify(original));
      await h.show(selected);
      await h.acknowledge();
      deepStrictEqual(calls, ["status", "status", "eligibility"]);
      deepStrictEqual(h.current.eligible?.executing, r2);
      deepStrictEqual(h.current.eligible?.admitted, a3);
      equal(h.current.intent, null);
      equal(h.current.message, null);
    } finally {
      await h.close();
    }
  }
});
