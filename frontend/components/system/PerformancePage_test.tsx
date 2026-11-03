import { options } from "preact";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import {
  PERFORMANCE_VERSION,
  performanceReadout,
} from "../../test/support/performance-fixture.ts";
import type { PerformanceState } from "../../lib/system/performance/store.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ModelLinkContext } from "../view/ModelContextLink.tsx";
import {
  ComponentObservations,
  PerformancePage,
  PerformanceSummary,
} from "./PerformancePage.tsx";

Deno.test("Performance describes unavailable collection without invented observations or controls", () => {
  const html = renderToString(<PerformancePage />);
  for (const label of ["Verified outcomes", "Elapsed time", "Resource usage"]) {
    match(html, new RegExp(`<dt>${label}</dt><dd>N/A</dd>`));
  }
  equal((html.match(/<dd>N\/A<\/dd>/g) ?? []).length, 3);
  equal(
    (html.match(/Measurements are not available for this scope\./g) ?? [])
      .length,
    1,
  );
  match(html, /data-state="unavailable"/);
  match(html, /Collection is not connected\./);
  match(
    html,
    /Attributed component observations are not available for this scope\./,
  );
  match(html, /Evaluation campaign evidence is not available for this scope\./);
  doesNotMatch(
    html,
    /<button|<input|<select|<table|<svg|<canvas|\b0%|No observations|No campaigns/,
  );
});

Deno.test("the summary's rendered Performance link retains exact Case, source and selected conversation", () => {
  const version = `commit:${"a".repeat(40)}`;
  for (const caseId of ["case-one", "case-two"]) {
    const html = renderToString(
      <ModelLinkContext.Provider
        value={`?caseBranch=${caseId}&agent=selected-child`}
      >
        <PerformanceSummary
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

Deno.test("Team keeps the accepted three-value summary and one scope line without measurement diagnostics", () => {
  for (const caseId of [undefined, "request-one"]) {
    const readout = performanceReadout({
      expectedVersion: PERFORMANCE_VERSION,
      ...(caseId ? { caseId } : {}),
    });
    const html = renderToString(
      <PerformanceSummary
        href="/system?page=performance"
        read={{ status: "ready", readout }}
      />,
    );
    equal((html.match(/<dt>/g) ?? []).length, 3);
    equal((html.match(/<p\b/g) ?? []).length, 2);
    match(html, /Observed resource measurements for this scope/);
    match(html, /3 retained calls/);
    match(html, caseId ? /Request execution/ : /Main primary execution/);
    if (caseId) doesNotMatch(html, /request-one/);
    match(html, new RegExp(`title="${PERFORMANCE_VERSION}"`));
    match(html, /Open Performance/);
    doesNotMatch(
      html,
      /Input tokens|calls reported|missing|Summed provider latency|Physical call outcomes|Provider events through|Measurement details|<details/,
    );
  }
});

Deno.test("Performance details are collapsed by default and retain every measurement and caveat below the summary", () => {
  const readout = performanceReadout();
  const html = renderToString(
    <PerformancePage read={{ status: "ready", readout }} />,
  );
  const disclosure = html.match(/<details[^>]*>.*?<\/details>/s)?.[0];
  match(disclosure ?? "", /<summary>Measurement details<\/summary>/);
  doesNotMatch(disclosure ?? "", /<details[^>]*\bopen(?:=|\s|>)/);
  for (
    const label of [
      "Input tokens",
      "Output tokens",
      "Cache creation tokens",
      "Cache read tokens",
      "Cache creation, 5 min tokens",
      "Cache creation, 1 h tokens",
      "Provider web searches",
      "Provider web fetches",
      "calls reported",
      "missing",
      "Physical call outcomes",
      "Summed provider latency",
      "physical-call coverage is unknown",
      "Missing usage is not zero",
      "Provider return does not establish a verified business result",
    ]
  ) {
    equal(disclosure?.includes(label), true, label);
  }
  equal(
    disclosure?.includes(readout.execution.modelVersion.repositoryVersion),
    true,
  );
  equal(disclosure?.includes(readout.execution.modelVersion.digest), true);
  equal(disclosure?.includes(readout.resources.selection.endedThrough), true);
  equal(disclosure?.includes(readout.resources.readAt), true);
  equal(
    html.indexOf("</details>") <
      html.indexOf('aria-label="Component observations"'),
    true,
  );
  equal(
    html.indexOf('aria-label="Component observations"') <
      html.indexOf('aria-label="Evaluation campaigns"'),
    true,
  );
});

Deno.test("Request summary names the execution while its Case identity remains in measurement details", () => {
  const caseId = "execution-case-f016c925";
  const html = renderToString(
    <PerformancePage
      read={{
        status: "ready",
        readout: performanceReadout({
          expectedVersion: PERFORMANCE_VERSION,
          caseId,
        }),
      }}
    />,
  );
  const detailsStart = html.indexOf("<details");
  match(html.slice(0, detailsStart), /Request execution/);
  doesNotMatch(html.slice(0, detailsStart), new RegExp(caseId));
  match(html.slice(detailsStart), /Request execution Case ID/);
  match(html.slice(detailsStart), new RegExp(caseId));
});

Deno.test("Performance populates only observed resources and labels provider timing/coverage separately", () => {
  const read: PerformanceState = {
    status: "ready",
    readout: performanceReadout(),
  };
  const html = renderToString(<PerformancePage read={read} />);
  match(html, /<dt>Verified outcomes<\/dt><dd>N\/A<\/dd>/);
  match(html, /<dt>Elapsed time<\/dt><dd>N\/A<\/dd>/);
  match(html, /3 retained calls/);
  match(html, /Input tokens: 10.*2 calls reported, 1 missing/s);
  match(html, /Output tokens: 0.*2 calls reported, 1 missing/s);
  match(html, /Cache creation tokens: N\/A.*0 calls reported, 3 missing/s);
  match(html, /Summed provider latency: 12.5 ms/);
  match(html, /workflow elapsed time is unavailable/);
  match(html, /physical-call coverage is unknown/);
  match(html, /Provider return does not establish a verified business result/);
  match(
    html,
    /Attributed component observations are not available for this scope/,
  );
  match(html, /Evaluation campaign evidence is not available for this scope/);
  match(html, new RegExp(`title="${PERFORMANCE_VERSION}"`));
  match(html, /Provider events through/);
  const overflow = JSON.parse(JSON.stringify(performanceReadout()));
  overflow.resources.units.input_tokens.observedSubtotal = null;
  overflow.resources.units.input_tokens.state = "overflow";
  match(
    renderToString(
      <PerformanceSummary
        detailed
        read={{ status: "ready", readout: overflow }}
      />,
    ),
    /Input tokens: N\/A \(overflow\)/,
  );
  doesNotMatch(
    html,
    /<button|<input|<select|<svg|<canvas|\bUSD\b|overall score|[0-9]%/,
  );
});

Deno.test("empty retained evidence has an honest zero count and unknown usage/time, never zero-resource claims", () => {
  const html = renderToString(
    <PerformanceSummary
      detailed
      read={{ status: "ready", readout: performanceReadout(undefined, 0) }}
    />,
  );
  match(html, /0 retained calls/);
  match(html, /Input tokens: N\/A/);
  match(html, /Summed provider latency: N\/A/);
  match(html, /physical-call coverage is unknown/);
  doesNotMatch(html, /Input tokens: 0|Summed provider latency: 0/);
});

Deno.test("authority, inspected-version and read failures never show stale totals", () => {
  for (
    const [status, expected] of [
      ["connection-required", /current authorized local session is required/],
      [
        "version-unavailable",
        /Measurements for this inspected version are unavailable/,
      ],
      ["unavailable", /Observed provider resources could not be read/],
    ] as const
  ) {
    const html = renderToString(
      <PerformancePage
        read={{ status, key: "selected", readout: performanceReadout() }}
      />,
    );
    match(html, expected);
    equal((html.match(/<dd>N\/A<\/dd>/g) ?? []).length, 3);
    doesNotMatch(
      html,
      /retained calls|Input tokens: 10|Summed provider latency: 12.5/,
    );
  }
});

Deno.test("component observations show collected identities and unknown, partial and empty values", () => {
  const readout = performanceReadout();
  const group = {
    operatorId: "Assembly::FormerOperator",
    calls: readout.resources.calls,
    outcomes: readout.resources.outcomes,
    providerElapsedMs: readout.resources.providerElapsedMs,
    units: readout.resources.units,
  };
  const groups = [group, { ...group, operatorId: null }];
  const html = renderToString(
    <PerformancePage
      read={{
        status: "ready",
        readout: {
          ...readout,
          resources: { ...readout.resources, operatorGroups: groups },
        },
      }}
    />,
  );
  match(html, /class="performance-components-scroll"/);
  match(html, /Assembly::FormerOperator/);
  match(html, /Unattributed operator/);
  match(html, /10 \(partial\)/);
  match(html, /N\/A/);
  match(html, /provider times may overlap/);
  match(html, /Cache creation, 5 min tokens/);
  match(html, /Cache creation, 1 h tokens/);
  match(html, /Provider web searches/);
  match(html, /Provider web fetches/);
  const empty = performanceReadout(undefined, 0);
  const emptyHtml = renderToString(
    <PerformancePage
      read={{
        status: "ready",
        readout: {
          ...empty,
          resources: { ...empty.resources, operatorGroups: [] },
        },
      }}
    />,
  );
  match(emptyHtml, /No retained provider observations for this scope/);
  doesNotMatch(emptyHtml, /<table/);
});
Deno.test("component observations paginate rather than truncate operator groups", () => {
  const readout = performanceReadout();
  const group = {
    calls: 1,
    outcomes: readout.resources.outcomes,
    providerElapsedMs: readout.resources.providerElapsedMs,
    units: readout.resources.units,
  };
  const groups = Array.from(
    { length: 21 },
    (_, i) => ({ ...group, operatorId: `operator-${i}` }),
  );
  const html = renderToString(
    <PerformancePage
      read={{
        status: "ready",
        readout: {
          ...readout,
          resources: { ...readout.resources, operatorGroups: groups },
        },
      }}
    />,
  );
  match(html, /Page 1 of 2/);
  match(html, />Next<\/button>/);
  doesNotMatch(html, /operator-20/);
});

Deno.test("long collected identity remains readable without a roster lookup", () => {
  const readout = performanceReadout();
  const id = `past::${"x".repeat(240)}`;
  const group = {
    operatorId: id,
    calls: readout.resources.calls,
    outcomes: readout.resources.outcomes,
    providerElapsedMs: readout.resources.providerElapsedMs,
    units: readout.resources.units,
  };
  const html = renderToString(
    <PerformancePage
      read={{
        status: "ready",
        readout: {
          ...readout,
          resources: { ...readout.resources, operatorGroups: [group] },
        },
      }}
    />,
  );
  match(html, /overflow-wrap:anywhere/);
  match(html, new RegExp(id));
});

Deno.test("operator pagination uses live Preact state for Next and Previous", async () => {
  const root = probeRoot();
  const readout = performanceReadout();
  const groups = Array.from({ length: 21 }, (_, i) => ({
    operatorId: `operator-${String(i + 1).padStart(2, "0")}`,
    calls: 1,
    outcomes: { returned: 1, failed: 0, cancelled: 0, "timed-out": 0 },
    providerElapsedMs: {
      observedSubtotal: i + 1,
      presentCalls: 1,
      missingCalls: 0,
      state: "known" as const,
    },
    units: {
      ...readout.resources.units,
      input_tokens: {
        observedSubtotal: i + 1,
        presentCalls: 1,
        missingCalls: 0,
        state: "known" as const,
      },
    },
  }));
  const read: PerformanceState = {
    status: "ready",
    readout: {
      ...readout,
      resources: { ...readout.resources, operatorGroups: groups },
    },
  };
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
      html = renderToString(ComponentObservations({ read }));
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
    match(html, />21<\/span>/);
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
