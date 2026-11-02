import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  ProviderResourceAggregation,
  type ProviderResourceQuery,
  type ProviderResourceUnit,
} from "./provider-resource-readout.ts";
import {
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "./provider-call.ts";

const query: ProviderResourceQuery = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "main",
  repositoryVersion: `commit:${"a".repeat(40)}`,
  modelDigest: "a".repeat(64),
  endedThrough: "2026-10-29T00:00:02.000Z",
};
const observation = (
  patch: Partial<ProviderCallObservation> = {},
): ProviderCallObservation => ({
  schemaVersion: 1,
  observationId: "00000000-0000-4000-8000-000000000001",
  provider: "anthropic",
  configuredModel: "model",
  startedAt: "2026-10-29T00:00:00.000Z",
  endedAt: "2026-10-29T00:00:01.000Z",
  elapsedMs: 0.5,
  outcome: "returned",
  correlation: {
    ...UNKNOWN_PROVIDER_CALL_CORRELATION,
    executionScope: {
      projectId: query.projectId,
      systemId: query.systemId,
      executionSpaceId: query.executionSpaceId,
    },
    repositoryVersion: query.repositoryVersion,
    modelDigest: query.modelDigest,
  },
  ...patch,
});

Deno.test("observed resources distinguish unknown, explicit zero, partial usage and physical outcomes", () => {
  const aggregate = new ProviderResourceAggregation(query);
  aggregate.add(
    observation({ usage: { input_tokens: 0 }, outcome: "returned" }),
  );
  aggregate.add(observation({
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 3 },
    },
    outcome: "failed",
  }));
  aggregate.add(observation({ outcome: "timed-out" }));
  const result = aggregate.finish(query.endedThrough);
  equal(result.calls, 3);
  equal(result.physicalCallCoverage, "unknown");
  deepStrictEqual(result.outcomes, {
    returned: 1,
    failed: 1,
    cancelled: 0,
    "timed-out": 1,
  });
  deepStrictEqual(result.units.input_tokens, {
    observedSubtotal: 10,
    presentCalls: 2,
    missingCalls: 1,
    state: "partial",
  });
  deepStrictEqual(result.units.output_tokens, {
    observedSubtotal: null,
    presentCalls: 0,
    missingCalls: 3,
    state: "unknown",
  });
  equal(result.units.cache_creation_input_tokens.observedSubtotal, 3);
  equal(result.units.cache_creation_5m_input_tokens.observedSubtotal, 3);
  equal(result.providerElapsedMs.observedSubtotal, 1.5);
  equal("businessSuccess" in result, false);
});

Deno.test("operator resources partition the same selected population with exact IDs, missing usage and unattributed calls", () => {
  const aggregate = new ProviderResourceAggregation(query);
  const add = (
    operatorId: string | null,
    patch: Partial<ProviderCallObservation>,
  ) =>
    aggregate.add(
      observation({
        ...patch,
        correlation: { ...observation().correlation, operatorId },
      }),
    );
  add("operator-a", {
    elapsedMs: 0.1,
    usage: {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 4,
      cache_creation: {
        ephemeral_5m_input_tokens: 4,
        ephemeral_1h_input_tokens: 0,
      },
      server_tool_use: { web_search_requests: 2 },
    },
  });
  add("operator-A", {
    elapsedMs: 0.2,
    outcome: "failed",
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 3,
      server_tool_use: { web_fetch_requests: 1 },
    },
  });
  add(null, { elapsedMs: 0.3, outcome: "cancelled" });
  add("operator-a", {
    elapsedMs: 0.4,
    outcome: "timed-out",
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
  });
  add("operator-A", { elapsedMs: 0 });
  const result = aggregate.finish(query.endedThrough);
  const groups = result.operatorGroups!;
  deepStrictEqual(groups.map((group) => group.operatorId), [
    "operator-A",
    "operator-a",
    null,
  ]);
  deepStrictEqual(groups.map((group) => group.calls), [2, 2, 1]);
  deepStrictEqual(groups[0].units.input_tokens, {
    observedSubtotal: 0,
    presentCalls: 1,
    missingCalls: 1,
    state: "partial",
  });
  deepStrictEqual(groups[1].units.input_tokens, {
    observedSubtotal: 30,
    presentCalls: 2,
    missingCalls: 0,
    state: "known",
  });
  deepStrictEqual(groups[2].units.input_tokens, {
    observedSubtotal: null,
    presentCalls: 0,
    missingCalls: 1,
    state: "unknown",
  });
  equal(groups[1].units.cache_creation_input_tokens.observedSubtotal, 4);
  equal(groups[1].units.cache_creation_5m_input_tokens.observedSubtotal, 4);
  equal(groups[1].units.cache_creation_1h_input_tokens.observedSubtotal, 0);
  equal(groups[0].units.cache_read_input_tokens.observedSubtotal, 3);
  equal(groups[0].units.web_fetch_requests.observedSubtotal, 1);
  equal(groups[1].units.web_search_requests.observedSubtotal, 2);
  equal(groups.reduce((sum, group) => sum + group.calls, 0), result.calls);
  for (
    const outcome of ["returned", "failed", "cancelled", "timed-out"] as const
  ) {
    equal(
      groups.reduce((sum, group) => sum + group.outcomes[outcome], 0),
      result.outcomes[outcome],
    );
  }
  for (const unit of Object.keys(result.units) as ProviderResourceUnit[]) {
    equal(
      groups.reduce((sum, group) => sum + group.units[unit].presentCalls, 0),
      result.units[unit].presentCalls,
    );
    equal(
      groups.reduce((sum, group) => sum + group.units[unit].missingCalls, 0),
      result.units[unit].missingCalls,
    );
    equal(
      groups.reduce(
        (sum, group) => sum + (group.units[unit].observedSubtotal ?? 0),
        0,
      ),
      result.units[unit].observedSubtotal,
    );
  }
  const elapsed = groups.reduce(
    (sum, group) => sum + group.providerElapsedMs.observedSubtotal!,
    0,
  );
  const tolerance = 8 * Number.EPSILON *
    Math.max(1, Math.abs(result.providerElapsedMs.observedSubtotal!), elapsed) *
    groups.length;
  equal(
    Math.abs(elapsed - result.providerElapsedMs.observedSubtotal!) <= tolerance,
    true,
  );
  equal("businessSuccess" in groups[0], false);
  equal(Object.isFrozen(groups), true);
  equal(Object.isFrozen(groups[0]), true);
});

Deno.test("explicit zero remains known in its operator group and later additions do not mutate an earlier snapshot", () => {
  const aggregate = new ProviderResourceAggregation(query);
  const call = observation({
    elapsedMs: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
  });
  aggregate.add({
    ...call,
    correlation: { ...call.correlation, operatorId: "removed-operator" },
  });
  const first = aggregate.finish(query.endedThrough);
  for (const unit of Object.values(first.operatorGroups![0].units)) {
    deepStrictEqual(unit, {
      observedSubtotal: 0,
      presentCalls: 1,
      missingCalls: 0,
      state: "known",
    });
  }
  equal(first.operatorGroups![0].providerElapsedMs.observedSubtotal, 0);
  aggregate.add(observation());
  equal(first.calls, 1);
  equal(first.operatorGroups!.length, 1);
  deepStrictEqual(
    aggregate.finish(query.endedThrough).operatorGroups!.map((group) =>
      group.operatorId
    ),
    ["removed-operator", null],
  );
});

Deno.test("resource projection retains exact actual version/digest/cutoff/Case selection", () => {
  const aggregate = new ProviderResourceAggregation({
    ...query,
    caseId: "case-a",
  });
  const call = observation();
  const matched = { ...call.correlation, caseId: "case-a" };
  for (
    const correlation of [
      { ...matched, repositoryVersion: null },
      { ...matched, modelDigest: null },
      { ...matched, repositoryVersion: `commit:${"b".repeat(40)}` },
      { ...matched, modelDigest: "b".repeat(64) },
      { ...matched, caseId: "case-b" },
    ]
  ) {
    aggregate.add(
      observation({
        correlation: { ...correlation, operatorId: "out-of-selection" },
      }),
    );
  }
  aggregate.add(
    observation({ correlation: matched, endedAt: "2026-10-29T00:00:02.001Z" }),
  );
  aggregate.add(
    observation({
      correlation: matched,
      endedAt: query.endedThrough,
      usage: { output_tokens: 0 },
    }),
  );
  const result = aggregate.finish(query.endedThrough);
  equal(result.calls, 1);
  equal(result.units.output_tokens.observedSubtotal, 0);
  equal(result.units.output_tokens.state, "known");
  deepStrictEqual(
    result.operatorGroups!.map((group) => [group.operatorId, group.calls]),
    [[null, 1]],
  );
  throws(() =>
    aggregate.add(observation({
      correlation: {
        ...matched,
        executionScope: {
          projectId: "project",
          systemId: "system",
          executionSpaceId: "foreign",
        },
      },
    })), /scope mismatch/);
  equal(aggregate.finish(query.endedThrough).operatorGroups!.length, 1);
});

Deno.test("empty observations remain unknown and resource overflow never rounds an integer total", () => {
  const empty = new ProviderResourceAggregation(query).finish(
    query.endedThrough,
  );
  equal(empty.state, "observed-empty");
  equal(empty.calls, 0);
  deepStrictEqual(empty.operatorGroups, []);
  equal(empty.providerElapsedMs.observedSubtotal, null);
  equal(empty.units.input_tokens.observedSubtotal, null);
  const aggregate = new ProviderResourceAggregation(query);
  aggregate.add(
    observation({ usage: { input_tokens: Number.MAX_SAFE_INTEGER } }),
  );
  aggregate.add(observation({ usage: { input_tokens: 1 } }));
  deepStrictEqual(aggregate.finish(query.endedThrough).units.input_tokens, {
    observedSubtotal: null,
    presentCalls: 2,
    missingCalls: 0,
    state: "overflow",
  });
  deepStrictEqual(
    aggregate.finish(query.endedThrough).operatorGroups![0].units.input_tokens,
    {
      observedSubtotal: null,
      presentCalls: 2,
      missingCalls: 0,
      state: "overflow",
    },
  );
  throws(
    () => aggregate.add(observation({ usage: { output_tokens: -1 } })),
    /Invalid observed resource amount/,
  );
});

Deno.test("operator overflow preserves known per-group values while whole-population totals refuse unsafe sums", () => {
  const aggregate = new ProviderResourceAggregation(query);
  const first = observation({
    elapsedMs: Number.MAX_SAFE_INTEGER,
    usage: { input_tokens: Number.MAX_SAFE_INTEGER },
  });
  aggregate.add({
    ...first,
    correlation: { ...first.correlation, operatorId: "operator-a" },
  });
  const second = observation({ elapsedMs: 1, usage: { input_tokens: 1 } });
  aggregate.add({
    ...second,
    correlation: { ...second.correlation, operatorId: "operator-b" },
  });
  const result = aggregate.finish(query.endedThrough);
  equal(result.units.input_tokens.state, "overflow");
  equal(result.units.input_tokens.observedSubtotal, null);
  equal(result.providerElapsedMs.state, "overflow");
  equal(
    result.operatorGroups![0].units.input_tokens.observedSubtotal,
    Number.MAX_SAFE_INTEGER,
  );
  equal(result.operatorGroups![1].units.input_tokens.observedSubtotal, 1);
  const missing = observation();
  aggregate.add({
    ...missing,
    correlation: { ...missing.correlation, operatorId: "operator-a" },
  });
  const changed = aggregate.finish(query.endedThrough);
  equal(changed.operatorGroups![0].units.input_tokens.state, "partial");
  equal(changed.operatorGroups![0].units.input_tokens.missingCalls, 1);
  equal(changed.units.input_tokens.presentCalls, 2);
  equal(changed.units.input_tokens.missingCalls, 1);
});

Deno.test("resource query requires exact immutable references and copies caller selection", () => {
  const mutable = { ...query };
  const aggregate = new ProviderResourceAggregation(mutable);
  mutable.modelDigest = "b".repeat(64);
  aggregate.add(observation());
  equal(aggregate.finish(query.endedThrough).calls, 1);
  for (
    const invalid of [
      { repositoryVersion: "HEAD" },
      { modelDigest: "board-projection-digest" },
      { executionSpaceId: "" },
      { endedThrough: "today" },
      { caseId: "https://private.invalid" },
    ]
  ) {
    throws(
      () => new ProviderResourceAggregation({ ...query, ...invalid }),
      /Invalid provider resource query/,
    );
  }
});
