import { settle } from "../support/settle.ts";
import { act } from "preact/test-utils";
import { equal } from "node:assert/strict";
import { broadcastSse } from "../../../src/infrastructure/http/sse.ts";
import {
  createRetainedProviderCallSink,
  PROVIDER_RESOURCE_INVALIDATION,
  PROVIDER_RESOURCES_INVALIDATED,
} from "../../../src/application/telemetry/provider-resource-notifications.ts";
import {
  normalizeProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../src/application/telemetry/provider-call.ts";
import {
  createWorkbenchState,
  type WorkbenchEventSource,
} from "../../lib/workbench/state.ts";
import {
  createPerformanceStore,
  type PerformanceState,
} from "../../lib/system/performance/store.ts";
import { usePerformance } from "../../components/system/performance/usePerformance.ts";
import { probeRoot } from "../support/hook-probe.ts";
import {
  PERFORMANCE_VERSION,
  performanceReadout,
} from "../support/performance-fixture.ts";

Deno.test("committed retention broadcasts through Workbench generation into the active performance hook", async () => {
  const listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  const emit = (name: string, data?: string) => {
    for (const listener of listeners.get(name) ?? []) listener({ data });
  };
  const source: WorkbenchEventSource = {
    addEventListener(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    close() {},
  };
  let connections = 0;
  const workbench = createWorkbenchState({
    fetch: () => Promise.resolve(Response.json(null)),
    eventSourceFactory() {
      connections++;
      return source;
    },
  });
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.add(controller);
    },
  });
  const reader = stream.getReader();
  const commit = Promise.withResolvers<"inserted" | "duplicate">();
  let retained = 0, reads = 0, notifications = 0;
  const sink = createRetainedProviderCallSink(
    {
      async append() {
        const result = await commit.promise;
        if (result === "inserted") retained++;
        return result;
      },
    },
    () => ({ projectId: "p", systemId: "s" }),
    () => {
      notifications++;
      broadcastSse(
        clients,
        PROVIDER_RESOURCES_INVALIDATED,
        PROVIDER_RESOURCE_INVALIDATION,
      );
    },
  );
  const performance = createPerformanceStore({
    api: {
      read(selection) {
        equal(selection.caseId, "caseA");
        reads++;
        return Promise.resolve(performanceReadout(selection, retained));
      },
    },
  });
  const seen: { read?: PerformanceState } = {};
  function Probe() {
    seen.read = usePerformance({
      store: performance,
      page: "performance",
      version: PERFORMANCE_VERSION,
      caseId: "caseA",
      sessionReady: true,
      refreshGeneration: workbench.performanceGeneration.value,
    });
    return null;
  }
  const probe = probeRoot();
  const stop = workbench.start();
  try {
    await probe.show(Probe, {});
    await settle(1);
    equal(reads, 1);
    equal(seen.read?.readout?.resources.calls, 0);
    const pending = sink(normalizeProviderCallObservation({
      schemaVersion: 1,
      observationId: "a6609ebc-6218-4d71-a2ae-893b875b8482",
      provider: "anthropic",
      configuredModel: "sonnet",
      startedAt: "2026-10-29T00:00:00.000Z",
      endedAt: "2026-10-29T00:00:00.005Z",
      elapsedMs: 5,
      outcome: "returned",
      correlation: UNKNOWN_PROVIDER_CALL_CORRELATION,
    }));
    equal(notifications, 0);
    equal(reads, 1);
    commit.resolve("inserted");
    await pending;
    const frame = new TextDecoder().decode((await reader.read()).value);
    equal(
      frame,
      'event: provider-resources-invalidated\ndata: {"schemaVersion":1}\n\n',
    );
    const [event, data] = frame.trim().split("\n");
    await act(() => {
      emit(event.slice("event: ".length), data.slice("data: ".length));
    });
    equal(workbench.performanceGeneration.value, 1);
    await settle(1);
    equal(reads, 2);
    equal(seen.read?.readout?.resources.calls, 1);
    retained = 2; // A missed notification is reconciled by the next stream open.
    await act(() => emit("open"));
    equal(workbench.performanceGeneration.value, 2);
    await settle(1);
    equal(connections, 1);
    equal(reads, 3);
    equal(seen.read?.readout?.resources.calls, 2);
  } finally {
    stop();
    await probe.restore();
    performance.dispose();
    await reader.cancel();
    reader.releaseLock();
  }
});
