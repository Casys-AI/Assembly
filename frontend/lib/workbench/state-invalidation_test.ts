import { deepStrictEqual, equal } from "node:assert/strict";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { replaceGlobals } from "../../test/support/globals.ts";
import { createWorkbenchState, type WorkbenchEventSource } from "./state.ts";

class Events implements WorkbenchEventSource {
  readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, value?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
  close() {}
}

Deno.test("shared stream separates catalogue and provider invalidation and fences disposal", async () => {
  const events = new Events();
  let connections = 0;
  const current = snapshot();
  const store = createWorkbenchState({
    initialState: current,
    eventSourceFactory(path) {
      equal(path, "/api/events");
      connections++;
      return events;
    },
    fetch: () => Promise.resolve(Response.json(current)),
  });
  const generations = () => [
    store.releaseCatalogueGeneration.value,
    store.performanceGeneration.value,
  ];
  const stop = store.start();
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    deepStrictEqual(generations(), [0, 0]);
    events.emit("open");
    deepStrictEqual(generations(), [1, 1]);
    events.emit("release-catalogue-invalidated", { schemaVersion: 1 });
    deepStrictEqual(generations(), [2, 1]);
    for (
      const invalid of [null, {}, { schemaVersion: 2 }, {
        schemaVersion: 1,
        caseId: "foreign",
      }]
    ) events.emit("release-catalogue-invalidated", invalid);
    deepStrictEqual(generations(), [2, 1]);
    events.emit("provider-resources-invalidated", { schemaVersion: 1 });
    deepStrictEqual(generations(), [2, 2]);
    events.emit("state", current);
    events.emit("cases", { systemId: current.id, cases: [] });
    events.emit("conversations", {
      systemId: current.id,
      defaultAgentId: "main",
      version: "v",
      conversations: [],
    });
    events.emit("model-version", { version: "commit:" + "a".repeat(40) });
    deepStrictEqual(generations(), [2, 2]);
    events.emit("error");
    events.emit("open");
    deepStrictEqual(generations(), [3, 3]);
    equal(connections, 1);
    stop();
    events.emit("release-catalogue-invalidated", { schemaVersion: 1 });
    events.emit("state", current);
    events.emit("cases", { systemId: current.id, cases: [] });
    events.emit("conversations", {});
    events.emit("model-version", {});
    events.emit("open");
    deepStrictEqual(generations(), [3, 3]);
  } finally {
    stop();
  }
});

Deno.test("retrying failed stream construction replaces subscriptions and releases them on stop", async () => {
  const browser = new EventTarget();
  const listeners = new Set<EventListener>();
  const restore = replaceGlobals({
    addEventListener(type: string, listener: EventListener) {
      if (type === "online") listeners.add(listener);
      browser.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type === "online") listeners.delete(listener);
      browser.removeEventListener(type, listener);
    },
  });
  const current = snapshot(), events = new Events();
  let attempts = 0, reads = 0, followers = 0;
  const store = createWorkbenchState({
    initialState: current,
    eventSourceFactory() {
      if (++attempts === 1) throw new Error("Stream unavailable");
      return events;
    },
    fetch(path) {
      reads++;
      return Promise.resolve(Response.json(
        path === "/api/cases?space=requests"
          ? { systemId: current.id, cases: [] }
          : current,
      ));
    },
  });
  const generation = store.requests.sessionGeneration;
  const subscribe = generation.subscribe.bind(generation);
  generation.subscribe = (callback) => {
    followers++;
    const release = subscribe(callback);
    return () => {
      followers--;
      release();
    };
  };
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  try {
    store.requests.sessionReady.value = true;
    const firstStop = store.start();
    equal(store.connection.peek(), "reconnecting");
    equal(listeners.size, 1);
    equal(followers, 1);
    const stop = store.start();
    equal(attempts, 2);
    equal(listeners.size, 1);
    equal(followers, 1);
    firstStop();
    events.emit("open");
    await settle();
    equal(store.connection.peek(), "live");
    stop();
    equal(listeners.size, 0);
    equal(followers, 0);
    reads = 0;
    browser.dispatchEvent(new Event("online"));
    generation.value++;
    await settle();
    equal(reads, 0);
    equal(attempts, 2);
  } finally {
    store.dispose();
    restore();
  }
});

Deno.test("Request events validate identities, reconcile held readers on open and ignore replaced streams", async () => {
  const sources: Events[] = [];
  const reads: string[] = [];
  const state = snapshot();
  let revision = 0;
  const store = createWorkbenchState({
    initialState: state,
    eventSourceFactory() {
      const source = new Events();
      sources.push(source);
      return source;
    },
    fetch(path) {
      if (path === "/api/cases?space=requests") {
        reads.push(path);
        return Promise.resolve(
          Response.json({ systemId: state.id, cases: [] }),
        );
      }
      if (path.startsWith("/api/conversations?caseId=")) {
        reads.push(path);
        return Promise.resolve(Response.json({
          systemId: state.id,
          defaultAgentId: "owner",
          version: String(++revision),
          conversations: [],
        }));
      }
      return Promise.resolve(Response.json(state));
    },
  });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  store.requests.sessionReady.value = true;
  await store.requests.refresh("historical");
  const release = store.requests.retain("held");
  await store.requests.refresh("held");
  const stop = store.start();
  try {
    await settle();
    reads.length = 0;
    const events = sources[0];
    for (
      const invalid of [null, {}, { schemaVersion: 2, caseId: "held" }, {
        schemaVersion: 1,
        caseId: "held",
        content: "private",
      }, { schemaVersion: 1, caseId: "bad/id" }]
    ) {
      events.emit("request-conversations-invalidated", invalid);
    }
    deepStrictEqual(reads, []);
    events.emit("request-conversations-invalidated", {
      schemaVersion: 1,
      caseId: "held",
    });
    await settle();
    deepStrictEqual(reads.sort(), [
      "/api/cases?space=requests",
      "/api/conversations?caseId=held",
    ]);
    reads.length = 0;
    events.emit("request-conversations-invalidated", {
      schemaVersion: 1,
      caseId: "unknown",
    });
    await settle();
    deepStrictEqual(reads, ["/api/cases?space=requests"]);
    for (const reconnect of [false, true]) {
      reads.length = 0;
      if (reconnect) events.emit("error");
      events.emit("open");
      await settle();
      deepStrictEqual(reads.sort(), [
        "/api/cases?space=requests",
        "/api/conversations?caseId=held",
      ]);
    }
    store.requests.sessionGeneration.value++;
    equal(sources.length, 2);
    reads.length = 0;
    events.emit("request-conversations-invalidated", {
      schemaVersion: 1,
      caseId: "held",
    });
    events.emit("open");
    await settle();
    deepStrictEqual(reads, []);
    store.requests.sessionReady.value = false;
    sources[1].emit("request-conversations-invalidated", {
      schemaVersion: 1,
      caseId: "held",
    });
    await settle();
    deepStrictEqual(reads, []);
    stop();
    sources[1].emit("open");
    sources[1].emit("request-conversations-invalidated", {
      schemaVersion: 1,
      caseId: "held",
    });
    await settle();
    deepStrictEqual(reads, []);
  } finally {
    release();
    stop();
  }
});
