import type { CurrentProviderResourceReadout } from "../../../src/application/telemetry/current-provider-resources.ts";
import {
  type ObservedResourceAmount,
  type ProviderResourceUnit,
  tokenSummary,
} from "../../../src/application/telemetry/provider-resource-readout.ts";
import type { CaseRecord } from "../../lib/cases/cases.ts";
import type { PerformanceSelection } from "../../lib/system/performance/api.ts";

export const PERFORMANCE_VERSION = `commit:${"a".repeat(40)}`;
export function performanceReadout(
  selection: PerformanceSelection = { expectedVersion: PERFORMANCE_VERSION },
  calls = 3,
): CurrentProviderResourceReadout {
  const units = Object.fromEntries([
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cache_creation_5m_input_tokens",
    "cache_creation_1h_input_tokens",
    "web_search_requests",
    "web_fetch_requests",
  ].map((
    unit,
  ) => [unit, {
    observedSubtotal: null,
    presentCalls: 0,
    missingCalls: calls,
    state: "unknown",
  }])) as Record<ProviderResourceUnit, ObservedResourceAmount>;
  if (calls > 0) {
    const present = Math.min(2, calls);
    units.input_tokens = {
      observedSubtotal: 10,
      presentCalls: present,
      missingCalls: calls - present,
      state: present < calls ? "partial" : "known",
    };
    units.output_tokens = {
      observedSubtotal: 0,
      presentCalls: present,
      missingCalls: calls - present,
      state: present < calls ? "partial" : "known",
    };
  }
  return {
    schemaVersion: 1,
    execution: {
      kind: selection.caseId === undefined ? "main" : "case",
      ...(selection.caseId === undefined ? {} : { caseId: selection.caseId }),
      operatorId: "Assembly::Primary",
      runtimeRevision: 7,
      modelVersion: {
        digest: "b".repeat(64),
        repositoryVersion: selection.expectedVersion,
      },
    },
    resources: {
      schemaVersion: 1,
      selection: {
        projectId: "git:9f109fd4-fecb-4994-a2e4-3be47f07c931",
        systemId: "host-system",
        executionSpaceId: selection.caseId === undefined
          ? "main"
          : `space-${selection.caseId}`,
        ...(selection.caseId === undefined ? {} : { caseId: selection.caseId }),
        repositoryVersion: selection.expectedVersion,
        modelDigest: "b".repeat(64),
        endedThrough: "2026-10-30T00:00:00.000Z",
      },
      readAt: "2026-10-30T00:00:01.000Z",
      state: calls === 0 ? "observed-empty" : "observed",
      population: "retained-provider-observations",
      retainedPopulation: "complete",
      physicalCallCoverage: "unknown",
      calls,
      outcomes: { returned: calls, failed: 0, cancelled: 0, "timed-out": 0 },
      providerElapsedMs: {
        observedSubtotal: calls === 0 ? null : 12.5,
        presentCalls: calls,
        missingCalls: 0,
        state: calls === 0 ? "unknown" : "known",
      },
      units,
      tokenSummary: { total: null, meanPerCall: null, cacheReadShare: null },
    },
    ...(selection.caseId === undefined ? {} : {
      request: {
        durationMs: null,
        humanInterventions: { messages: 0, decisions: 0 },
      },
    }),
  };
}

/** A Request the person closed as accepted, 9 min 19 s after its opening. */
export const ACCEPTED_REQUEST: CaseRecord = {
  id: "request-one",
  number: 1,
  type: "request",
  objective: "Three short hooks",
  owner: "owner-op",
  status: "closed-done",
  verdict: "accepted",
  closedBy: "owner",
  createdAt: "2026-11-03T11:42:31.000Z",
  closedAt: "2026-11-03T11:51:50.000Z",
  openedFrom: { conversationId: "main" },
  modelPin: { digest: "b".repeat(64) },
};

/**
 * Request 1 of the 3 November rehearsal: 8 calls with every token unit known,
 * 1 message and 2 decisions. Operator groups, when given, repeat its units:
 * the view does not need them to partition the total.
 */
export function rehearsalReadout(
  operators?: readonly (readonly [string | null, number])[],
): CurrentProviderResourceReadout {
  const readout = performanceReadout({
    expectedVersion: PERFORMANCE_VERSION,
    caseId: ACCEPTED_REQUEST.id,
  }, 8);
  const units = { ...readout.resources.units };
  for (
    const [unit, value] of [
      ["input_tokens", 616],
      ["output_tokens", 3745],
      ["cache_creation_input_tokens", 50888],
      ["cache_read_input_tokens", 54129],
    ] as const
  ) {
    units[unit] = {
      observedSubtotal: value,
      presentCalls: 8,
      missingCalls: 0,
      state: "known",
    };
  }
  const resources = {
    ...readout.resources,
    units,
    tokenSummary: tokenSummary(units, 8),
  };
  return {
    ...readout,
    resources: operators
      ? {
        ...resources,
        operatorGroups: operators.map(([operatorId, calls]) => ({
          operatorId,
          calls,
          outcomes: resources.outcomes,
          providerElapsedMs: resources.providerElapsedMs,
          units,
          tokenSummary: tokenSummary(units, calls),
        })),
      }
      : resources,
    request: {
      durationMs: 559_000,
      humanInterventions: { messages: 1, decisions: 2 },
    },
  };
}
