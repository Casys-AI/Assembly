import { settle } from "../../../test/support/settle.ts";
import { equal } from "node:assert/strict";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import {
  PERFORMANCE_VERSION,
  performanceReadout,
} from "../../../test/support/performance-fixture.ts";
import {
  createPerformanceStore,
  type PerformanceState,
} from "../../../lib/system/performance/store.ts";
import { usePerformance } from "./usePerformance.ts";
import { createBoardApi } from "../../../lib/system/board/api.ts";
import { caseModelFetch } from "../../../lib/case-model-scope.ts";
import { initialBoard } from "../../../test/support/board-fixture.ts";

type PerformanceProps = Parameters<typeof usePerformance>[0];

Deno.test("the shared performance hook waits for resolved board scope and does not refetch between Team and Performance", async () => {
  const probe = probeRoot();
  let calls = 0;
  const seen: { read?: PerformanceState; history: PerformanceState[] } = {
    history: [],
  };
  const store = createPerformanceStore({
    api: {
      read(selection) {
        return new Promise<ReturnType<typeof performanceReadout>>((resolve) => {
          calls++;
          resolve(performanceReadout(selection));
        });
      },
    },
  });
  function Probe(props: PerformanceProps) {
    seen.read = usePerformance(props);
    seen.history.push(seen.read);
    return null;
  }
  try {
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "team",
      sessionReady: false,
    });
    await settle(1);
    equal(calls, 0);
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "team",
      version: PERFORMANCE_VERSION,
      sessionReady: false,
    });
    await settle(1);
    equal(calls, 1);
    equal(seen.read?.status, "ready");
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "performance",
      version: PERFORMANCE_VERSION,
      sessionReady: false,
    });
    await settle(1);
    equal(calls, 1);
    const board = await createBoardApi({
      fetch: caseModelFetch(
        "caseA",
        ((input: Request) => {
          const url = new URL(input.url);
          equal(url.pathname, "/api/case-model/caseA/api/model/board");
          equal(url.search, "");
          return Promise.resolve(Response.json(initialBoard(), {
            headers: { "x-model-version": PERFORMANCE_VERSION },
          }));
        }) as typeof fetch,
      ),
    }).read();
    const beforeCase = seen.history.length;
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "performance",
      version: board.version,
      caseId: "caseA",
      sessionReady: false,
    });
    await settle(1);
    equal(calls, 2);
    equal(seen.history[beforeCase].status, "loading");
    equal(seen.history[beforeCase].readout, undefined);
    equal(seen.read?.readout?.execution.caseId, "caseA");
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "team",
      version: board.version,
      caseId: "caseA",
      sessionReady: false,
    });
    await settle(1);
    equal(calls, 2);
    equal(seen.read?.status, "ready");
    equal(seen.read?.readout?.execution.caseId, "caseA");
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "performance",
      version: PERFORMANCE_VERSION,
      caseId: "caseA",
      sessionReady: true,
    });
    await settle(1);
    equal(calls, 3);
    await probe.show<PerformanceProps>(Probe, {
      store,
      page: "rights",
      version: PERFORMANCE_VERSION,
      sessionReady: true,
    });
    await settle(1);
    equal(seen.read?.readout, undefined);
    equal(calls, 3);
  } finally {
    store.dispose();
    await probe.restore();
  }
});

Deno.test("resource generations refresh only active surfaces and remount with a fresh authorized read", async () => {
  const probe = probeRoot();
  const seen: { read?: PerformanceState } = {};
  let calls = 0;
  const store = createPerformanceStore({
    api: {
      read(selection) {
        calls++;
        return Promise.resolve(performanceReadout(selection));
      },
    },
  });
  function Probe(props: PerformanceProps) {
    seen.read = usePerformance(props);
    return null;
  }
  const selected: PerformanceProps = {
    store,
    page: "performance",
    version: PERFORMANCE_VERSION,
    caseId: "caseA",
    sessionReady: true,
    refreshGeneration: 1,
  };
  try {
    await probe.show<PerformanceProps>(Probe, selected);
    await settle(1);
    equal(calls, 1);
    await probe.show<PerformanceProps>(Probe, {
      ...selected,
      refreshGeneration: 2,
    });
    await settle(1);
    equal(calls, 2);
    equal(seen.read?.readout?.execution.caseId, "caseA");
    // Closing the Request reads it again, once.
    for (const _ of [1, 2]) {
      await probe.show<PerformanceProps>(Probe, {
        ...selected,
        refreshGeneration: 2,
        closedAt: "2026-11-03T11:51:50.000Z",
      });
      await settle(1);
    }
    equal(calls, 3);
    await probe.show<PerformanceProps>(Probe, {
      ...selected,
      page: "rights",
      refreshGeneration: 3,
    });
    await settle(1);
    await probe.show<PerformanceProps>(Probe, {
      ...selected,
      page: "rights",
      refreshGeneration: 4,
    });
    await settle(1);
    equal(calls, 3);
    equal(seen.read?.readout, undefined);
    await probe.show<PerformanceProps>(Probe, {
      ...selected,
      refreshGeneration: 4,
    });
    await settle(1);
    equal(calls, 4);
  } finally {
    store.dispose();
    await probe.restore();
  }
});

Deno.test("borrowed live store survives actual hook unmount and ignores dirty late work on remount", async () => {
  const probe = probeRoot();
  const late = Promise.withResolvers<ReturnType<typeof performanceReadout>>();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const seen: { read?: PerformanceState } = {};
  const store = createPerformanceStore({
    api: {
      read(selection, signal) {
        signals.push(signal!);
        return ++calls === 1
          ? late.promise
          : Promise.resolve(performanceReadout(selection, 9));
      },
    },
  });
  function Probe(props: PerformanceProps) {
    seen.read = usePerformance(props);
    return null;
  }
  const props: PerformanceProps = {
    store,
    page: "performance",
    version: PERFORMANCE_VERSION,
    caseId: "caseA",
    sessionReady: true,
    sessionGeneration: 1,
    refreshGeneration: 1,
  };
  try {
    await probe.show<PerformanceProps>(Probe, props);
    await probe.show<PerformanceProps>(Probe, {
      ...props,
      refreshGeneration: 2,
    });
    equal(calls, 1);
    await probe.unmount();
    equal(signals[0].aborted, true);
    equal(store.state.peek().readout, undefined);
    await probe.show<PerformanceProps>(Probe, props);
    await settle(1);
    equal(calls, 2);
    late.resolve(
      performanceReadout({
        expectedVersion: PERFORMANCE_VERSION,
        caseId: "caseA",
      }, 1),
    );
    await settle(1);
    equal(calls, 2);
    equal(seen.read?.readout?.resources.calls, 9);
    await probe.show<PerformanceProps>(Probe, {
      ...props,
      sessionGeneration: 2,
    });
    await settle(1);
    equal(calls, 3);
  } finally {
    store.dispose();
    await probe.restore();
  }
});
