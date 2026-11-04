import { deepStrictEqual, equal, match } from "node:assert/strict";
import type { CurrentProviderResourceReadout } from "../../../../src/application/telemetry/current-provider-resources.ts";
import {
  ACCEPTED_REQUEST,
  PERFORMANCE_VERSION,
  performanceReadout,
  rehearsalReadout,
} from "../../../test/support/performance-fixture.ts";
import { elapsed, performanceView } from "./kpis.ts";

const REQUEST = ACCEPTED_REQUEST;
const selection = { expectedVersion: PERFORMANCE_VERSION, caseId: REQUEST.id };
const ready = (
  readout: CurrentProviderResourceReadout = rehearsalReadout(),
) => ({
  status: "ready" as const,
  readout,
});

Deno.test("elapsed time reads in whole seconds, minutes and hours", () => {
  deepStrictEqual([42_400, 120_000, 559_000, 3_900_000].map(elapsed), [
    "42 s",
    "2 min",
    "9 min 19 s",
    "1 h 5 min",
  ]);
});

Deno.test("a closed Request shows its duration, tokens and the person's interventions", () => {
  const view = performanceView({
    read: ready(),
    scope: { kind: "request", record: REQUEST },
  });
  equal(view.duration?.text, "9 min 19 s");
  deepStrictEqual(
    [view.tokens?.text, view.tokens?.short, view.tokens?.sub],
    ["109,378", "109k", "8 calls · 13,672 per call"],
  );
  deepStrictEqual(view.facts.map((fact) => `${fact.text} ${fact.label}`), [
    "51% from cache",
    "0 failed calls",
    "1 your message",
    "2 your decisions",
  ]);
  equal(view.unavailable, undefined);
});

Deno.test("a defined KPI without its data says N/A with the reason, and an observed empty count stays zero", () => {
  const open = rehearsalReadout();
  const view = performanceView({
    read: ready({
      ...open,
      request: { ...open.request!, durationMs: null },
      resources: {
        ...open.resources,
        units: {
          ...open.resources.units,
          cache_read_input_tokens: {
            observedSubtotal: 54129,
            presentCalls: 6,
            missingCalls: 2,
            state: "partial",
          },
        },
        tokenSummary: { total: null, meanPerCall: null, cacheReadShare: null },
      },
    }),
    scope: { kind: "request", record: { ...REQUEST, status: "open" } },
  });
  deepStrictEqual([view.duration?.text, view.duration?.hint], [
    "N/A",
    "Measured at closing.",
  ]);
  deepStrictEqual([view.tokens?.text, view.tokens?.hint], [
    "N/A",
    "Usage missing for 2 of 8 calls.",
  ]);
  equal(view.facts[0].text, "N/A");
  const empty = performanceView({
    read: ready(performanceReadout(selection, 0)),
    scope: { kind: "request", record: REQUEST },
  });
  deepStrictEqual([empty.tokens?.text, empty.tokens?.sub], ["0", "no calls"]);
});

Deno.test("an unread Request shows one reason instead of its measurements", () => {
  for (
    const [status, text] of [
      ["loading", "Reading measurements…"],
      ["connection-required", "Measurements unavailable"],
      ["version-unavailable", "Measurements unavailable"],
      ["unavailable", "Measurements unavailable"],
    ] as const
  ) {
    const view = performanceView({
      read: { status },
      scope: { kind: "request", record: REQUEST },
    });
    equal(view.unavailable?.text, text);
    deepStrictEqual([view.duration, view.tokens, view.facts], [
      undefined,
      undefined,
      [],
    ]);
  }
});

Deno.test("Main shows only what it consumes: no duration or interventions", () => {
  const view = performanceView({
    read: ready(performanceReadout()),
    scope: { kind: "main" },
  });
  equal(view.duration, undefined);
  deepStrictEqual(view.facts.map((fact) => fact.label), [
    "from cache",
    "failed calls",
  ]);
  match(view.details!.note, /the Main/);
});

Deno.test("agents are named by the board, busiest first, and nameless operators say why", () => {
  const view = performanceView({
    read: ready(
      rehearsalReadout([["former-op", 1], ["owner-op", 6], [null, 1]]),
    ),
    scope: { kind: "request", record: REQUEST },
    agentOf: (id) =>
      id === "owner-op"
        ? { id: "owner-unit", name: "Lothvane Tyrolis" }
        : undefined,
  });
  deepStrictEqual(
    view.agents?.map((row) => [row.name, row.agentId, row.hint, row.calls]),
    [
      ["Lothvane Tyrolis", "owner-unit", undefined, 6],
      [
        "Former member",
        undefined,
        "Not in the team at this version · former-op",
        1,
      ],
      ["Unattributed", undefined, "Calls without an agent link.", 1],
    ],
  );
  const owner = view.agents![0];
  deepStrictEqual([owner.tokens.text, owner.perCall.text, owner.cache.text], [
    "109,378",
    "18,230",
    "51%",
  ]);
  equal(
    owner.tokens.hint,
    "Input 616 · Output 3,745 · Cache write 50,888 · Cache read 54,129",
  );
});
