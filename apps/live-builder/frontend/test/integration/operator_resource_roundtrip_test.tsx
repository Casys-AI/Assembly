import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  throws,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import {
  ProviderResourceAggregation,
  type ProviderResourceQuery,
} from "../../../src/application/telemetry/provider-resource-readout.ts";
import {
  normalizeProviderCallObservation,
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../src/application/telemetry/provider-call.ts";
import { parsePerformanceReadout } from "../../lib/system/performance/api.ts";
import { PerformancePage } from "../../components/system/PerformancePage.tsx";

Deno.test("actual selected resource aggregation survives strict parsing and renders operator attribution without foreign rows", () => {
  const query: ProviderResourceQuery = {
    projectId: "project",
    systemId: "system",
    executionSpaceId: "request-space",
    caseId: "request-a",
    repositoryVersion: `commit:${"a".repeat(40)}`,
    modelDigest: "b".repeat(64),
    endedThrough: "2026-10-30T00:00:02.000Z",
  };
  const aggregate = new ProviderResourceAggregation(query);
  function row(
    id: number,
    operatorId: string | null,
    changes: Partial<ProviderCallObservation> = {},
  ): ProviderCallObservation {
    return normalizeProviderCallObservation({
      schemaVersion: 1,
      observationId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      provider: "anthropic",
      configuredModel: "model",
      startedAt: "2026-10-30T00:00:00.000Z",
      endedAt: "2026-10-30T00:00:01.000Z",
      elapsedMs: 0.25,
      outcome: "returned",
      correlation: {
        ...UNKNOWN_PROVIDER_CALL_CORRELATION,
        executionScope: {
          projectId: query.projectId,
          systemId: query.systemId,
          executionSpaceId: query.executionSpaceId,
        },
        caseId: query.caseId,
        operatorId,
        repositoryVersion: query.repositoryVersion,
        modelDigest: query.modelDigest,
      },
      ...changes,
    });
  }
  aggregate.add(row(1, "Assembly::ObservedOperator", {
    usage: { input_tokens: 10, output_tokens: 0 },
  }));
  aggregate.add(row(2, "Assembly::ObservedOperator", { outcome: "failed" }));
  aggregate.add(row(3, null));
  const wrongVersion = row(4, "Assembly::ForeignVersion");
  aggregate.add({
    ...wrongVersion,
    correlation: {
      ...wrongVersion.correlation,
      repositoryVersion: `commit:${"c".repeat(40)}`,
    },
  });
  const wrongCase = row(5, "Assembly::ForeignCase");
  aggregate.add({
    ...wrongCase,
    correlation: { ...wrongCase.correlation, caseId: "request-b" },
  });
  aggregate.add(
    row(6, "Assembly::AfterCutoff", { endedAt: "2026-10-30T00:00:03.000Z" }),
  );

  const selection = {
    expectedVersion: query.repositoryVersion,
    caseId: query.caseId,
  };
  const wire = JSON.parse(JSON.stringify({
    schemaVersion: 1,
    execution: {
      kind: "case",
      caseId: query.caseId,
      operatorId: "Assembly::CurrentOwner",
      runtimeRevision: 7,
      modelVersion: {
        digest: query.modelDigest,
        repositoryVersion: query.repositoryVersion,
      },
    },
    resources: aggregate.finish("2026-10-30T00:00:04.000Z"),
  }));
  const readout = parsePerformanceReadout(wire, selection);
  equal(readout.resources.calls, 3);
  deepStrictEqual(
    readout.resources.operatorGroups?.map((
      group,
    ) => [group.operatorId, group.calls]),
    [
      ["Assembly::ObservedOperator", 2],
      [null, 1],
    ],
  );
  deepStrictEqual(readout.resources.units.input_tokens, {
    observedSubtotal: 10,
    presentCalls: 1,
    missingCalls: 2,
    state: "partial",
  });
  const html = renderToString(
    <PerformancePage read={{ status: "ready", readout }} />,
  );
  match(html, /3 retained calls/);
  match(html, /Assembly::ObservedOperator/);
  match(html, /Unattributed operator/);
  match(html, /10 \(partial\)/);
  match(html, /1 calls reported, 2 missing/);
  match(html, /Physical call outcomes: 2 returned, 1 failed/);
  match(html, /<dt>Verified outcomes<\/dt><dd>N\/A<\/dd>/);
  doesNotMatch(
    html,
    /Assembly::ForeignVersion|Assembly::ForeignCase|Assembly::AfterCutoff/,
  );
  doesNotMatch(html, /Assembly::CurrentOwner/);
  const corrupt = structuredClone(wire);
  corrupt.resources.operatorGroups[0].calls++;
  throws(() => parsePerformanceReadout(corrupt, selection));
});

function actualLatencyWire(
  rows: readonly { operatorId: string; elapsedMs: number }[],
) {
  const query: ProviderResourceQuery = {
    projectId: "project",
    systemId: "system",
    executionSpaceId: "request-space",
    caseId: "request-a",
    repositoryVersion: `commit:${"a".repeat(40)}`,
    modelDigest: "b".repeat(64),
    endedThrough: "2026-10-30T00:00:02.000Z",
  };
  const aggregate = new ProviderResourceAggregation(query);
  rows.forEach((row, index) =>
    aggregate.add(normalizeProviderCallObservation({
      schemaVersion: 1,
      observationId: `00000000-0000-4000-8000-${
        String(index + 1).padStart(12, "0")
      }`,
      provider: "anthropic",
      configuredModel: "model",
      startedAt: "2026-10-30T00:00:00.000Z",
      endedAt: "2026-10-30T00:00:01.000Z",
      elapsedMs: row.elapsedMs,
      outcome: "returned",
      correlation: {
        ...UNKNOWN_PROVIDER_CALL_CORRELATION,
        executionScope: {
          projectId: query.projectId,
          systemId: query.systemId,
          executionSpaceId: query.executionSpaceId,
        },
        caseId: query.caseId,
        operatorId: row.operatorId,
        repositoryVersion: query.repositoryVersion,
        modelDigest: query.modelDigest,
      },
    }))
  );
  return {
    selection: {
      expectedVersion: query.repositoryVersion,
      caseId: query.caseId,
    },
    wire: JSON.parse(JSON.stringify({
      schemaVersion: 1,
      execution: {
        kind: "case",
        caseId: query.caseId,
        operatorId: "Assembly::CurrentOwner",
        runtimeRevision: 7,
        modelVersion: {
          digest: query.modelDigest,
          repositoryVersion: query.repositoryVersion,
        },
      },
      resources: aggregate.finish("2026-10-30T00:00:04.000Z"),
    })),
  };
}

Deno.test("production latency aggregation roundtrips fractional summation across many calls and two operators", () => {
  const { wire, selection } = actualLatencyWire(
    Array.from({ length: 1_000 }, (_, index) => ({
      operatorId: index % 2 === 0 ? "operator-a" : "operator-b",
      elapsedMs: 0.1,
    })),
  );
  const total = wire.resources.providerElapsedMs.observedSubtotal;
  const regrouped = wire.resources.operatorGroups.reduce(
    (sum: number, group: { providerElapsedMs: { observedSubtotal: number } }) =>
      sum + group.providerElapsedMs.observedSubtotal,
    0,
  );
  equal(
    total === regrouped,
    false,
    "the witness must exercise actual rounding-order divergence",
  );
  const parsed = parsePerformanceReadout(wire, selection);
  equal(parsed.resources.calls, 1_000);
  equal(parsed.resources.providerElapsedMs.observedSubtotal, total);
  deepStrictEqual(
    parsed.resources.operatorGroups?.map((group) => group.calls),
    [500, 500],
  );
});

Deno.test("production latency near MAX retains original known state when regrouping rounds across the threshold", () => {
  const { wire, selection } = actualLatencyWire([
    { operatorId: "operator-a", elapsedMs: Number.MAX_SAFE_INTEGER },
    { operatorId: "operator-b", elapsedMs: 0.4 },
    { operatorId: "operator-b", elapsedMs: 0.4 },
    { operatorId: "operator-b", elapsedMs: 0.4 },
  ]);
  equal(wire.resources.providerElapsedMs.state, "known");
  equal(
    wire.resources.providerElapsedMs.observedSubtotal,
    Number.MAX_SAFE_INTEGER,
  );
  const regrouped = wire.resources.operatorGroups.reduce(
    (sum: number, group: { providerElapsedMs: { observedSubtotal: number } }) =>
      sum + group.providerElapsedMs.observedSubtotal,
    0,
  );
  equal(regrouped > Number.MAX_SAFE_INTEGER, true);
  const parsed = parsePerformanceReadout(wire, selection);
  equal(parsed.resources.providerElapsedMs.state, "known");
  equal(
    parsed.resources.providerElapsedMs.observedSubtotal,
    Number.MAX_SAFE_INTEGER,
  );
  equal(parsed.resources.calls, 4);
});

Deno.test("persisted opaque whitespace operator identities remain distinct through aggregation and strict parsing", () => {
  const { wire, selection } = actualLatencyWire([
    { operatorId: " ", elapsedMs: 1 },
    { operatorId: "  ", elapsedMs: 2 },
    { operatorId: " a ", elapsedMs: 3 },
  ]);
  const readout = parsePerformanceReadout(wire, selection);
  deepStrictEqual(
    readout.resources.operatorGroups?.map((
      group,
    ) => [group.operatorId, group.calls]),
    [
      [" ", 1],
      ["  ", 1],
      [" a ", 1],
    ],
  );
  equal(readout.resources.calls, 3);
  const html = renderToString(
    <PerformancePage read={{ status: "ready", readout }} />,
  );
  match(html, /title=" "/);
  match(html, /title=" {2}"/);
  match(html, />(?:&quot;|") (?:&quot;|")<\/code>/);
  match(html, />(?:&quot;|") {2}(?:&quot;|")<\/code>/);
  match(html, />(?:&quot;|") a (?:&quot;|")<\/code>/);
  match(html, /white-space:pre-wrap/);
});
