import type { CurrentProviderResourceReadout } from "../../../src/application/telemetry/current-provider-resources.ts";
import type {
  ObservedResourceAmount,
  ProviderResourceUnit,
} from "../../../src/application/telemetry/provider-resource-readout.ts";
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
    },
  };
}
