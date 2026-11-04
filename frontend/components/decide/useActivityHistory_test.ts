import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { modelFeed } from "../../test/support/model-feed.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { history as revisionHistory } from "../../test/support/revision-fixture.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { grant, operatorRoster } from "../../test/support/operator-fixture.ts";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { useActivityHistory } from "./useActivityHistory.ts";
import { settle as drain } from "../../test/support/settle.ts";

async function setup(
  run: (fixture: {
    state: ReturnType<typeof createWorkbenchState>;
    shown(): ReturnType<typeof useActivityHistory>;
    calls: string[];
    redraw(): Promise<void>;
    settle(): Promise<void>;
    failReleases(): void;
    addRelease(): void;
    announce(head?: string): void;
    blockRequests(): void;
    releaseRequests(): void;
    cacheRequests(count: number): void;
    blockMain(): void;
  }) => Promise<void>,
  cached = false,
) {
  const original = globalThis.fetch;
  const root = probeRoot();
  const calls: string[] = [];
  let failed = false, added = false, blocked = false, mainBlocked = false;
  let modelHead = revisionHistory().history.headVersion;
  const gate = Promise.withResolvers<Response>();
  const mainGate = Promise.withResolvers<Response>();
  const request = {
    systemId: "ui-fixture",
    cases: [
      caseRecord(1, {
        status: "closed-done",
        closedAt: "2026-11-03T10:00:00Z",
      }),
    ],
  };
  const roster = () =>
    operatorRoster([
      grant({
        status: "approved",
        decidedAt: "2026-11-03T09:00:00Z",
        // Older records omit caseId; the Request snapshot still supplies it.
        caseId: undefined,
      }),
    ]);
  const read = (path: string) => {
    calls.push(path);
    if (path === "/api/model-revisions") {
      return Response.json({
        ...revisionHistory().revisions,
        version: modelHead,
      });
    }
    if (path.startsWith("/api/model-history")) {
      return Response.json({
        ...revisionHistory().history,
        headVersion: modelHead,
      });
    }
    if (path === "/api/saved-systems/list") {
      return failed ? Response.json({}, { status: 503 }) : Response.json([
        { ...localSkillRelease(), status: "retained" },
        ...(added
          ? [{ ...localSkillRelease("new-release"), status: "retained" }]
          : []),
      ]);
    }
    if (path === "/api/saved-systems/list?space=requests") {
      return Response.json([]);
    }
    if (path.startsWith("/api/conversations?caseId=")) {
      return blocked
        ? gate.promise.then((response) => response.clone())
        : Response.json(roster());
    }
    if (path === "/api/cases?space=requests") return Response.json(request);
    if (path === "/api/cases") {
      return Response.json({ systemId: "ui-fixture", cases: [] });
    }
    if (path === "/api/conversations") {
      return mainBlocked ? mainGate.promise : Response.json(operatorRoster());
    }
    if (path === "/api/operator-tools") {
      return Response.json({
        systemId: "ui-fixture",
        version: "tools-1",
        tools: [],
      });
    }
    throw new Error(`Unexpected Activity read: ${path}`);
  };
  globalThis.fetch = (input) => Promise.resolve(read(String(input)));
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path) => Promise.resolve(read(path)),
  });
  state.requests.sessionReady.value = true;
  state.requests.cases.accept(request);
  if (cached) {
    state.requests.snapshots.value = new Map([[request.cases[0].id, roster()]]);
  }
  let shown!: ReturnType<typeof useActivityHistory>;
  const { live, tell } = modelFeed();
  function Probe() {
    shown = useActivityHistory(state, live);
    return null;
  }
  const redraw = () => root.show(Probe, {});
  const settle = async () => {
    await act(() => drain());
    equal(shown.loading, false);
  };
  try {
    await redraw();
    await settle();
    await run({
      state,
      shown: () => shown,
      calls,
      redraw,
      settle,
      addRelease: () => {
        added = true;
      },
      announce: (head = modelHead) => {
        modelHead = head;
        tell(head);
      },
      blockRequests: () => {
        blocked = true;
      },
      releaseRequests: () => {
        blocked = false;
        gate.resolve(Response.json(roster()));
      },
      cacheRequests: (count) => {
        request.cases = Array.from(
          { length: count },
          (_, i) =>
            caseRecord(i + 1, {
              status: "closed-done",
              closedAt: "2026-11-03T10:00:00Z",
            }),
        );
        state.requests.snapshots.value = new Map(
          request.cases.map((record) => [record.id, roster()]),
        );
        state.requests.cases.accept(request);
      },
      blockMain: () => {
        mainBlocked = true;
      },
      failReleases: () => {
        failed = true;
      },
    });
  } finally {
    gate.resolve(Response.json(roster()));
    mainGate.resolve(Response.json(operatorRoster()));
    await root.restore();
    state.dispose();
    globalThis.fetch = original;
  }
}

Deno.test("Activity reads closed Request conversations once on opening, without refetching on redraw", async () => {
  await setup(async ({ calls, shown, redraw }) => {
    ok(calls.includes("/api/conversations?caseId=ui-fixture%3Acase%3A1"));
    equal(
      shown().events.some((event) => event.kind === "release-created"),
      true,
    );
    const decision = shown().events.find((event) => event.kind === "decision");
    ok(decision);
    equal(
      decision.href,
      "/cases?case=ui-fixture%3Acase%3A1&agent=designer",
    );
    deepStrictEqual(decision.decision?.record, {
      caseId: "ui-fixture:case:1",
      agentId: "designer",
    });
    const count = calls.length;
    await redraw();
    await redraw();
    equal(calls.length, count);
  });
});

Deno.test("Activity exposes a failed half-catalogue and drops the previous session's releases immediately", async () => {
  await setup(async ({ state, shown, failReleases, settle, redraw }) => {
    failReleases();
    await act(() => shown().refresh());
    await settle();
    match(
      shown().notices.join(" "),
      /Partial catalogue: Main Releases could not be read/,
    );
    equal(
      shown().events.some((event) => event.kind === "release-created"),
      true,
      "known Release survives a partial read",
    );
    await act(() => {
      state.requests.sessionReady.value = false;
    });
    await redraw();
    equal(
      shown().events.some((event) => event.kind === "release-created"),
      false,
    );
    match(shown().notices.join(" "), /Connect to the system/);
  });
});

Deno.test("only a changed Main head rereads its history, without Request or Release reads", async () => {
  await setup(async ({ calls, announce, settle }) => {
    calls.length = 0;
    await act(() => announce());
    await settle();
    equal(calls.length, 0);
    await act(() => announce(`commit:${"f".repeat(40)}`));
    await settle();
    deepStrictEqual(calls, ["/api/model-history?limit=200"]);
  });
});

Deno.test("cached Request snapshots survive opening and status changes; new IDs alone are read, Read again rereads all", async () => {
  await setup(async ({ state, calls, shown, settle }) => {
    ok(!calls.some((path) => path.startsWith("/api/conversations?")));
    calls.length = 0;
    await act(() =>
      state.requests.cases.accept({
        systemId: "ui-fixture",
        cases: [caseRecord(1, { status: "closed-abandoned" })],
      })
    );
    await settle();
    equal(calls.length, 0);
    await act(() =>
      state.requests.cases.accept({
        systemId: "ui-fixture",
        cases: [caseRecord(1), caseRecord(2)],
      })
    );
    await settle();
    deepStrictEqual(calls, ["/api/conversations?caseId=ui-fixture%3Acase%3A2"]);
    calls.length = 0;
    await act(() => shown().refresh());
    await settle();
    // The reread catalogue contains only Request 1.
    deepStrictEqual(
      calls.filter((path) => path.startsWith("/api/conversations?")),
      ["/api/conversations?caseId=ui-fixture%3Acase%3A1"],
    );
  }, true);
});

Deno.test("Activity follows Release invalidation even at the same model head", async () => {
  await setup(async ({ state, shown, calls, addRelease, settle }) => {
    calls.length = 0;
    addRelease();
    await act(() => {
      state.releaseCatalogueGeneration.value++;
    });
    await settle();
    ok(shown().events.some((event) => event.id === "release:new-release"));
    deepStrictEqual(calls.sort(), [
      "/api/saved-systems/list",
      "/api/saved-systems/list?space=requests",
    ]);
  });
});

Deno.test("Read again recovers a failed Request catalogue", async () => {
  await setup(async ({ state, shown, settle }) => {
    await act(() => {
      state.requests.cases.snapshot.value = null;
      state.requests.cases.error.value = "Catalogue unavailable";
    });
    await act(() => shown().refresh());
    await settle();
    equal(state.requests.cases.error.value, "");
    ok(shown().events.some((event) => event.kind === "request-opened"));
  });
});

Deno.test("a stalled Request cannot withhold new Release events or disable rereading", async () => {
  await setup(
    async ({ shown, addRelease, blockRequests, settle }) => {
      addRelease();
      blockRequests();
      await act(() => shown().refresh());
      await settle();
      ok(shown().events.some((event) => event.id === "release:new-release"));
      equal(shown().requestsLoading, true);
      equal(shown().loading, false);
    },
  );
});

Deno.test("Read again retains queued cached Requests across catalogue changes", async () => {
  await setup(
    async (
      { cacheRequests, blockRequests, releaseRequests, calls, shown, settle },
    ) => {
      await act(() => cacheRequests(5));
      await settle();
      calls.length = 0;
      blockRequests();
      await act(() => shown().refresh());
      await settle();
      equal(
        calls.filter((path) => path.startsWith("/api/conversations?")).length,
        3,
      );
      await act(() => cacheRequests(6));
      await settle();
      await act(() => releaseRequests());
      await settle();
      deepStrictEqual(
        calls.filter((path) => path.startsWith("/api/conversations?")).sort(),
        [1, 2, 3, 4, 5].map((n) =>
          `/api/conversations?caseId=ui-fixture%3Acase%3A${n}`
        ),
      );
    },
    true,
  );
});

Deno.test("a stalled Main pending read cannot withhold explicit Request rereads", async () => {
  await setup(async ({ blockMain, calls, shown, settle }) => {
    calls.length = 0;
    blockMain();
    await act(() => shown().refresh());
    await settle();
    ok(calls.includes("/api/conversations?caseId=ui-fixture%3Acase%3A1"));
  }, true);
});
