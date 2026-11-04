import { options } from "preact";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import {
  ACCEPTED_REQUEST,
  performanceReadout,
  rehearsalReadout,
} from "../../test/support/performance-fixture.ts";
import {
  type PerformanceState,
  UNAVAILABLE_PERFORMANCE,
} from "../../lib/system/performance/store.ts";
import {
  type AgentOf,
  performanceView,
} from "../../lib/system/performance/kpis.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ModelLinkContext } from "../view/ModelContextLink.tsx";
import {
  AgentTable,
  PerformancePage,
  PerformanceSummary,
} from "./PerformancePage.tsx";

const requestView = (read: PerformanceState, agentOf?: AgentOf) =>
  performanceView({
    read,
    scope: { kind: "request", record: ACCEPTED_REQUEST },
    agentOf,
  });
const ready = (readout = rehearsalReadout()): PerformanceState => ({
  status: "ready",
  readout,
});

Deno.test("the summary's rendered Performance link retains exact Case, source and selected conversation", () => {
  const version = `commit:${"a".repeat(40)}`;
  for (const caseId of ["case-one", "case-two"]) {
    const html = renderToString(
      <ModelLinkContext.Provider
        value={`?caseBranch=${caseId}&agent=selected-child`}
      >
        <PerformanceSummary
          view={performanceView({
            read: UNAVAILABLE_PERFORMANCE,
            scope: { kind: "main" },
          })}
          href={`/system?page=performance&version=${
            encodeURIComponent(version)
          }`}
        />
      </ModelLinkContext.Provider>,
    );
    const href = html.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&");
    const url = new URL(href, "http://atelier.test");
    equal(url.pathname, "/system");
    equal(url.searchParams.get("page"), "performance");
    equal(url.searchParams.get("version"), version);
    equal(url.searchParams.get("caseBranch"), caseId);
    equal(url.searchParams.get("agent"), "selected-child");
    doesNotMatch(
      html,
      new RegExp(caseId === "case-one" ? "case-two" : "case-one"),
    );
  }
});

Deno.test("Team's summary shows the two axes in order, shortened, without the page's facts, agents or details", () => {
  const html = renderToString(
    <PerformanceSummary
      href="/system?page=performance"
      view={requestView(ready())}
    />,
  );
  equal(
    [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]).join(","),
    "Duration,Tokens",
  );
  match(html, /9 min 19 s/);
  match(html, />109k<\/dd>/);
  match(html, /title="109,378 tokens over 8 calls, 51% from cache\./);
  doesNotMatch(
    html,
    /performance-sub|class="stats"|<table|<details|System performance|retained/,
  );
  const main = renderToString(
    <PerformanceSummary
      view={performanceView({
        read: ready(performanceReadout()),
        scope: { kind: "main" },
      })}
    />,
  );
  equal(
    [...main.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]).join(","),
    "Tokens",
  );
});

Deno.test("Performance puts the facts, the agents and the collapsed details under the headline, and nothing it cannot compute", () => {
  const html = renderToString(
    <PerformancePage
      view={requestView(ready(rehearsalReadout([["owner-op", 8]])))}
    />,
  );
  match(html, /<dd class="performance-sub">8 calls · 13,672 per call<\/dd>/);
  match(html, /<b>51%<\/b><span>from cache<\/span>/);
  match(html, /<b>2<\/b><span>your decisions<\/span>/);
  const order = [
    'class="performance-metrics"',
    'class="stats"',
    'aria-label="By agent"',
    "<details",
  ]
    .map((marker) => html.indexOf(marker));
  equal(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
    true,
  );
  const disclosure = html.match(/<details[^>]*>.*?<\/details>/s)![0];
  doesNotMatch(disclosure, /<details[^>]*\bopen(?:=|\s|>)/);
  match(disclosure, /<summary>Details<\/summary>/);
  match(disclosure, /Totals are a minimum/);
  match(
    disclosure,
    /Input 616 · Output 3,745 · Cache write 50,888 · Cache read 54,129/,
  );
  doesNotMatch(
    html,
    /Verified outcomes|Elapsed time|Evaluation campaigns|Component observations|digest/,
  );
});

Deno.test("an unread Request shows one reason, never stale totals", () => {
  for (
    const [status, hint] of [
      ["connection-required", /current authorized local session is required/],
      ["version-unavailable", /inspected version are unavailable/],
      ["unavailable", /could not be read/],
    ] as const
  ) {
    const html = renderToString(
      <PerformancePage
        view={requestView({
          status,
          key: "selected",
          readout: rehearsalReadout(),
        })}
      />,
    );
    match(html, /role="status"[^>]*>Measurements unavailable</);
    match(html, hint);
    doesNotMatch(
      html,
      /<dt>Tokens|<dt>Duration|109,378|class="stats"|<details/,
    );
  }
});

Deno.test("agent rows name agents, lead to Team, and say why a nameless operator has no name", () => {
  const view = requestView(
    ready(rehearsalReadout([["former-op", 1], ["owner-op", 6], [null, 1]])),
    (id) =>
      id === "owner-op"
        ? { id: "owner-unit", name: "Lothvane Tyrolis" }
        : undefined,
  );
  const html = renderToString(
    <PerformancePage
      view={view}
      hrefOf={(agentId) => `/system?page=team&select=${agentId}`}
    />,
  );
  match(
    html,
    /aria-hidden="true">LT<\/span><a href="\/system\?page=team&amp;select=owner-unit">Lothvane Tyrolis<\/a>/,
  );
  match(
    html,
    /title="Not in the team at this version · former-op">.*?aria-hidden="true">\?<\/span>Former member/s,
  );
  match(html, /title="Calls without an agent link\.">.*?Unattributed/s);
  match(
    html,
    /title="Input 616 · Output 3,745 · Cache write 50,888 · Cache read 54,129"/,
  );
  doesNotMatch(html, /overflow-wrap|<code/);
});

function manyRows() {
  const operators = Array.from(
    { length: 21 },
    (_, i) => [`operator-${String(i + 1).padStart(2, "0")}`, 1] as const,
  );
  return requestView(ready(rehearsalReadout(operators))).agents!;
}

Deno.test("agent rows paginate rather than truncate", () => {
  const html = renderToString(<AgentTable rows={manyRows()} />);
  match(html, /Page 1 of 2/);
  match(html, />Next<\/button>/);
  doesNotMatch(html, /operator-21/);
});

Deno.test("agent pagination uses live Preact state for Next and Previous", async () => {
  const root = probeRoot();
  const rows = manyRows();
  let html = "", clicks: Array<() => void> = [];
  function Probe() {
    clicks = [];
    const previous = options.attr;
    options.attr = (name, value) => {
      if (name === "onclick" && typeof value === "function") {
        clicks.push(value as () => void);
        return `data-click="${clicks.length - 1}"`;
      }
      return previous?.(name, value);
    };
    try {
      html = renderToString(AgentTable({ rows }));
    } finally {
      options.attr = previous;
    }
    return null;
  }
  try {
    await root.show(Probe, {});
    match(html, /Page 1 of 2/);
    match(html, /operator-01/);
    doesNotMatch(html, /operator-21/);
    match(html, /<button[^>]*disabled[^>]*>Previous/);
    await act(() => clicks[1]());
    match(html, /Page 2 of 2/);
    match(html, /operator-21/);
    doesNotMatch(html, /operator-01/);
    match(html, /<button[^>]*disabled[^>]*>Next/);
    await act(() => clicks[0]());
    match(html, /Page 1 of 2/);
    match(html, /operator-01/);
    doesNotMatch(html, /operator-21/);
  } finally {
    await root.restore();
  }
});
