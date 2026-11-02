import { deepStrictEqual, equal } from "node:assert/strict";
import { snapshot } from "../../test/support/workbench-fixture.ts";
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
