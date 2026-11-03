import type {
  ObservedResourceAmount,
  ProviderResourceUnit,
} from "../../../../src/application/telemetry/provider-resource-readout.ts";
import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  createPerformanceApi,
  parsePerformanceReadout,
  PerformanceReadError,
} from "./api.ts";
import {
  PERFORMANCE_VERSION,
  performanceReadout,
} from "../../../test/support/performance-fixture.ts";

Deno.test("performance transport sends only exact version and explicit Case with authenticated no-store GET", async () => {
  const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const controller = new AbortController();
  const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const api = createPerformanceApi({
    fetch: ((input, init) => {
      seen.push({ input, init });
      return Promise.resolve(Response.json(performanceReadout(selection)));
    }) as typeof fetch,
  });
  const answer = await api.read(selection, controller.signal);
  const url = new URL(String(seen[0].input), "http://host.invalid");
  equal(url.pathname, "/api/performance/provider-resources");
  deepStrictEqual([...url.searchParams.keys()].sort(), [
    "caseId",
    "expectedVersion",
  ]);
  equal(url.searchParams.get("caseId"), "caseA");
  equal(url.searchParams.get("expectedVersion"), PERFORMANCE_VERSION);
  equal(seen[0].init?.method, "GET");
  equal(seen[0].init?.credentials, "same-origin");
  equal(seen[0].init?.cache, "no-store");
  equal(seen[0].init?.signal, controller.signal);
  equal(
    answer.resources.selection.projectId,
    "git:9f109fd4-fecb-4994-a2e4-3be47f07c931",
  );
  equal(answer.execution.operatorId, "Assembly::Primary");
  equal(answer.resources.units.input_tokens.missingCalls, 1);
  equal(answer.resources.units.output_tokens.observedSubtotal, 0);
  let mainPath = "";
  const main = createPerformanceApi({
    fetch: ((input) => {
      mainPath = String(input);
      return Promise.resolve(Response.json(performanceReadout()));
    }) as typeof fetch,
  });
  await main.read({ expectedVersion: PERFORMANCE_VERSION });
  equal(
    new URL(mainPath, "http://host.invalid").searchParams.has("caseId"),
    false,
  );
});

Deno.test("performance transport maps authority/version failures without displaying response error bodies", async () => {
  for (
    const [status, state] of [[403, "connection-required"], [
      409,
      "version-unavailable",
    ], [503, "unavailable"]] as const
  ) {
    const api = createPerformanceApi({
      fetch: (() =>
        Promise.resolve(
          Response.json({ error: "private exception" }, { status }),
        )) as typeof fetch,
    });
    await rejects(
      () => api.read({ expectedVersion: PERFORMANCE_VERSION }),
      (error: unknown) =>
        error instanceof PerformanceReadError && error.state === state &&
        !error.message.includes("private"),
    );
  }
});

Deno.test("performance parser rejects other versions/Cases, contradictory counts, invented coverage and malformed units", () => {
  const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: "caseA" };
  const changes = [
    (value: ReturnType<typeof JSON.parse>) => {
      value.execution.kind = "main";
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.selection.caseId = "caseB";
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.execution.modelVersion.repositoryVersion = `commit:${
        "c".repeat(40)
      }`;
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.selection.modelDigest = "c".repeat(64);
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.physicalCallCoverage = "complete";
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.outcomes.returned = 999;
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.units.input_tokens.observedSubtotal = -1;
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.units.input_tokens.missingCalls = 2;
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.units.input_tokens.state = "known";
    },
    (value: ReturnType<typeof JSON.parse>) => {
      value.resources.readAt = "today";
    },
  ];
  for (const change of changes) {
    const value = JSON.parse(JSON.stringify(performanceReadout(selection)));
    change(value);
    throws(
      () => parsePerformanceReadout(value, selection),
      PerformanceReadError,
    );
  }
  const value = JSON.parse(JSON.stringify(performanceReadout(selection)));
  value.private = "private prompt";
  value.resources.money = "private price";
  equal(
    JSON.stringify(parsePerformanceReadout(value, selection)).includes(
      "private",
    ),
    false,
  );
  const overflow = JSON.parse(JSON.stringify(performanceReadout(selection)));
  overflow.resources.units.input_tokens.observedSubtotal = null;
  overflow.resources.units.input_tokens.state = "overflow";
  equal(
    parsePerformanceReadout(overflow, selection).resources.units.input_tokens
      .state,
    "overflow",
  );
  equal(
    parsePerformanceReadout(performanceReadout(selection, 0), selection)
      .resources.units.input_tokens.observedSubtotal,
    null,
  );
});

Deno.test("operator partition is exact, complete and rejects malformed or inconsistent groups", () => {
  const selection = { expectedVersion: PERFORMANCE_VERSION };
  const value = JSON.parse(JSON.stringify(performanceReadout()));
  value.resources.operatorGroups = [{
    operatorId: "Assembly::Worker",
    calls: value.resources.calls,
    outcomes: structuredClone(value.resources.outcomes),
    providerElapsedMs: structuredClone(value.resources.providerElapsedMs),
    units: structuredClone(value.resources.units),
  }];
  equal(
    parsePerformanceReadout(value, selection).resources.operatorGroups?.[0]
      .operatorId,
    "Assembly::Worker",
  );
  const variants = [
    (v: typeof value) => {
      v.resources.operatorGroups.push(
        structuredClone(v.resources.operatorGroups[0]),
      );
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].operatorId = "https://private";
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].extra = 1;
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].calls = 0;
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].outcomes.returned = 2;
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].units.input_tokens.observedSubtotal = 9;
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].units.input_tokens.missingCalls = 3;
    },
    (v: typeof value) => {
      v.resources.operatorGroups[0].providerElapsedMs.observedSubtotal = 13;
    },
    (v: typeof value) => {
      v.resources.operatorGroups = [];
    },
    (v: typeof value) => {
      v.resources.operatorGroups = null;
    },
  ];
  for (const change of variants) {
    const copy = structuredClone(value);
    change(copy);
    throws(
      () => parsePerformanceReadout(copy, selection),
      PerformanceReadError,
    );
  }
  const legacy = performanceReadout();
  equal(
    parsePerformanceReadout(legacy, selection).resources.operatorGroups,
    undefined,
  );
  const empty = JSON.parse(JSON.stringify(performanceReadout(undefined, 0)));
  empty.resources.operatorGroups = [];
  deepStrictEqual(
    parsePerformanceReadout(empty, selection).resources.operatorGroups,
    [],
  );
});

Deno.test("operator totals reconcile integers, overflow and floating point roundoff", () => {
  const selection = { expectedVersion: PERFORMANCE_VERSION };
  const value = JSON.parse(JSON.stringify(performanceReadout()));
  const make = (
    operatorId: string | null,
    calls: number,
    input: number,
    elapsed: number,
  ) => {
    const missing = (n: number): ObservedResourceAmount => ({
      observedSubtotal: null,
      presentCalls: 0,
      missingCalls: n,
      state: "unknown",
    });
    const units: Record<ProviderResourceUnit, ObservedResourceAmount> = {
      input_tokens: missing(calls),
      output_tokens: missing(calls),
      cache_creation_input_tokens: missing(calls),
      cache_read_input_tokens: missing(calls),
      cache_creation_5m_input_tokens: missing(calls),
      cache_creation_1h_input_tokens: missing(calls),
      web_search_requests: missing(calls),
      web_fetch_requests: missing(calls),
    };
    units.input_tokens = {
      observedSubtotal: input,
      presentCalls: 1,
      missingCalls: calls - 1,
      state: calls === 1 ? "known" : "partial",
    };
    units.output_tokens = {
      observedSubtotal: 0,
      presentCalls: 1,
      missingCalls: calls - 1,
      state: calls === 1 ? "known" : "partial",
    };
    return {
      operatorId,
      calls,
      outcomes: { returned: calls, failed: 0, cancelled: 0, "timed-out": 0 },
      providerElapsedMs: {
        observedSubtotal: elapsed,
        presentCalls: calls,
        missingCalls: 0,
        state: "known",
      },
      units,
    };
  };
  value.resources.operatorGroups = [
    make("a", 1, 4, 0.1),
    make(null, 2, 6, 12.4),
  ];
  equal(
    parsePerformanceReadout(value, selection).resources.operatorGroups?.length,
    2,
  );
  const wrong = structuredClone(value);
  wrong.resources.operatorGroups.reverse();
  throws(() => parsePerformanceReadout(wrong, selection), PerformanceReadError);
  const overflow = structuredClone(value);
  overflow.resources.operatorGroups[0].units.input_tokens = {
    observedSubtotal: null,
    presentCalls: 1,
    missingCalls: 0,
    state: "overflow",
  };
  overflow.resources.units.input_tokens.observedSubtotal = null;
  overflow.resources.units.input_tokens.state = "overflow";
  equal(
    parsePerformanceReadout(overflow, selection).resources.units.input_tokens
      .state,
    "overflow",
  );
  overflow.resources.units.input_tokens = value.resources.units.input_tokens;
  throws(
    () => parsePerformanceReadout(overflow, selection),
    PerformanceReadError,
  );
});
