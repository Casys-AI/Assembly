import type { CurrentProviderResourceReadout } from "../../../../src/application/telemetry/current-provider-resources.ts";
import type {
  ObservedResourceAmount,
  ProviderResourceUnit,
} from "../../../../src/application/telemetry/provider-resource-readout.ts";

export interface PerformanceSelection {
  readonly expectedVersion: string;
  readonly caseId?: string;
}
export type PerformanceFailure =
  | "connection-required"
  | "version-unavailable"
  | "unavailable";
export class PerformanceReadError extends Error {
  constructor(readonly state: PerformanceFailure) {
    super("Observed provider resources are unavailable.");
    this.name = "PerformanceReadError";
  }
}
export const RESOURCE_UNITS: readonly ProviderResourceUnit[] = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation_5m_input_tokens",
  "cache_creation_1h_input_tokens",
  "web_search_requests",
  "web_fetch_requests",
];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exact = (value: unknown): value is string =>
  typeof value === "string" && /^commit:[a-f0-9]{40}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const caseIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const reference = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 &&
  value.length <= 1024 &&
  // deno-lint-ignore no-control-regex -- Read identities exclude private URLs/control characters.
  !/[\u0000-\u001f\u007f]/.test(value) && !value.includes("://");
/** Provider correlation stores opaque, nonempty identifiers without trimming. */
const operatorReference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  // deno-lint-ignore no-control-regex -- Match persisted correlation identifiers.
  !/[\u0000-\u001f\u007f]/.test(value) && !value.includes("://");
const instant = (value: unknown): value is string =>
  typeof value === "string" && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = (): never => {
  throw new PerformanceReadError("unavailable");
};

function amount(
  value: unknown,
  calls: number,
  integer: boolean,
): ObservedResourceAmount {
  if (
    !object(value) || !counter(value.presentCalls) ||
    !counter(value.missingCalls) ||
    value.presentCalls + value.missingCalls !== calls
  ) return invalid();
  const { observedSubtotal, presentCalls, missingCalls, state } = value;
  if (state === "unknown") {
    if (observedSubtotal !== null || presentCalls !== 0) return invalid();
  } else if (state === "overflow") {
    if (observedSubtotal !== null || presentCalls === 0) return invalid();
  } else if (state === "known" || state === "partial") {
    if (
      typeof observedSubtotal !== "number" ||
      !Number.isFinite(observedSubtotal) || observedSubtotal < 0 ||
      observedSubtotal > Number.MAX_SAFE_INTEGER ||
      (integer && !Number.isSafeInteger(observedSubtotal)) ||
      presentCalls === 0 ||
      (state === "known" ? missingCalls !== 0 : missingCalls === 0)
    ) return invalid();
  } else return invalid();
  return {
    observedSubtotal: observedSubtotal as number | null,
    presentCalls,
    missingCalls,
    state,
  };
}

const OUTCOMES = ["returned", "failed", "cancelled", "timed-out"] as const;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Reconcile the complete partition without interpreting unknown as an observation. */
function reconcileAmount(
  parent: ObservedResourceAmount,
  groups: readonly ObservedResourceAmount[],
  integer: boolean,
): void {
  let present = 0, missing = 0, sum = 0;
  let groupOverflow = false, integerSumOverflow = false;
  for (const item of groups) {
    present += item.presentCalls;
    missing += item.missingCalls;
    if (!Number.isSafeInteger(present) || !Number.isSafeInteger(missing)) {
      invalid();
    }
    if (item.state === "overflow") groupOverflow = true;
    if (item.observedSubtotal !== null) {
      sum += item.observedSubtotal;
      if (integer && !Number.isSafeInteger(sum)) integerSumOverflow = true;
    }
  }
  if (present !== parent.presentCalls || missing !== parent.missingCalls) {
    invalid();
  }
  if (groupOverflow || integerSumOverflow) {
    if (parent.state !== "overflow") invalid();
    return;
  }
  if (integer) {
    if (parent.state === "overflow") invalid();
    if (present === 0) {
      if (parent.state !== "unknown") invalid();
      return;
    }
    if (parent.observedSubtotal !== sum) invalid();
    return;
  }
  // Both parent and partition sums add the same nonnegative observations in
  // different orders. Standard floating-point gamma_n bounds each n-addition
  // sum; comparing the two requires 2*gamma_n/(1-gamma_n) times their scale.
  // At enormous n this bound ceases to constrain the result, so retain only
  // the structural/missingness and per-group overflow guarantees above.
  const nu = present * (Number.EPSILON / 2);
  const gamma = nu < 1 ? nu / (1 - nu) : Infinity;
  const scale = Math.max(
    1,
    Math.abs(parent.observedSubtotal ?? 0),
    Math.abs(sum),
  );
  const tolerance = gamma < 1
    ? (2 * gamma / (1 - gamma) + 8 * Number.EPSILON) * scale
    : Infinity;
  if (parent.state === "overflow") {
    if (sum < Number.MAX_SAFE_INTEGER - tolerance) invalid();
    return;
  }
  if (present === 0) {
    if (parent.state !== "unknown") invalid();
    return;
  }
  if (
    parent.observedSubtotal === null ||
    Math.abs(parent.observedSubtotal - sum) > tolerance
  ) invalid();
}
function operatorGroups(
  value: unknown,
  calls: number,
  outcomes: Record<typeof OUTCOMES[number], number>,
  elapsed: ObservedResourceAmount,
  units: Record<ProviderResourceUnit, ObservedResourceAmount>,
) {
  if (!Array.isArray(value)) return invalid();
  const seen = new Set<string | null>();
  let total = 0, previous: string | null | undefined;
  const sums = { returned: 0, failed: 0, cancelled: 0, "timed-out": 0 };
  const groups = value.map((entry) => {
    if (
      !object(entry) ||
      !sameKeys(entry, [
        "operatorId",
        "calls",
        "outcomes",
        "providerElapsedMs",
        "units",
      ]) ||
      !(entry.operatorId === null || operatorReference(entry.operatorId)) ||
      !counter(entry.calls) || entry.calls === 0 ||
      seen.has(entry.operatorId) || previous === null ||
      (previous !== undefined && entry.operatorId !== null &&
        previous >= entry.operatorId) ||
      !object(entry.outcomes) || !sameKeys(entry.outcomes, OUTCOMES) ||
      !object(entry.units) || !sameKeys(entry.units, RESOURCE_UNITS) ||
      !object(entry.providerElapsedMs) ||
      !sameKeys(entry.providerElapsedMs, [
        "observedSubtotal",
        "presentCalls",
        "missingCalls",
        "state",
      ])
    ) return invalid();
    seen.add(entry.operatorId);
    previous = entry.operatorId;
    total += entry.calls;
    if (!Number.isSafeInteger(total)) return invalid();
    const groupOutcomes = {
      returned: 0,
      failed: 0,
      cancelled: 0,
      "timed-out": 0,
    };
    let groupTotal = 0;
    for (const name of OUTCOMES) {
      const n = entry.outcomes[name];
      if (
        !counter(n) || !Number.isSafeInteger(groupTotal + n) ||
        !Number.isSafeInteger(sums[name] + n)
      ) return invalid();
      groupOutcomes[name] = n;
      groupTotal += n;
      sums[name] += n;
    }
    if (groupTotal !== entry.calls) return invalid();
    const groupElapsed = amount(entry.providerElapsedMs, entry.calls, false);
    if (
      groupElapsed.presentCalls !== entry.calls ||
      groupElapsed.missingCalls !== 0
    ) return invalid();
    const rawUnits = entry.units;
    const groupUnits = Object.fromEntries(RESOURCE_UNITS.map((unit) => {
      const raw = rawUnits[unit];
      if (
        !object(raw) ||
        !sameKeys(raw, [
          "observedSubtotal",
          "presentCalls",
          "missingCalls",
          "state",
        ])
      ) return invalid();
      return [unit, amount(raw, entry.calls as number, true)];
    })) as Record<ProviderResourceUnit, ObservedResourceAmount>;
    return {
      operatorId: entry.operatorId,
      calls: entry.calls,
      outcomes: groupOutcomes,
      providerElapsedMs: groupElapsed,
      units: groupUnits,
    };
  });
  if (
    total !== calls || OUTCOMES.some((name) => sums[name] !== outcomes[name])
  ) return invalid();
  reconcileAmount(
    elapsed,
    groups.map((group) => group.providerElapsedMs),
    false,
  );
  for (const unit of RESOURCE_UNITS) {
    reconcileAmount(
      units[unit],
      groups.map((group) => group.units[unit]),
      true,
    );
  }
  return groups;
}

/** Closed response reader: reject mismatched pin/counts; never display a raw
 * body or trust its additional fields as metrics. Types alone are not validation. */
export function parsePerformanceReadout(
  value: unknown,
  requested: PerformanceSelection,
): CurrentProviderResourceReadout {
  if (
    !exact(requested.expectedVersion) ||
    (requested.caseId !== undefined && !caseIdentity(requested.caseId))
  ) return invalid();
  if (
    !object(value) || value.schemaVersion !== 1 || !object(value.execution) ||
    !object(value.resources)
  ) return invalid();
  const execution = value.execution, resources = value.resources;
  const kind = requested.caseId === undefined ? "main" : "case";
  if (
    execution.kind !== kind || execution.caseId !== requested.caseId ||
    !reference(execution.operatorId) || !counter(execution.runtimeRevision) ||
    !object(execution.modelVersion) || !digest(execution.modelVersion.digest) ||
    execution.modelVersion.repositoryVersion !== requested.expectedVersion
  ) return invalid();
  if (
    resources.schemaVersion !== 1 || !object(resources.selection) ||
    !instant(resources.readAt) ||
    resources.population !== "retained-provider-observations" ||
    resources.retainedPopulation !== "complete" ||
    resources.physicalCallCoverage !== "unknown" || !counter(resources.calls) ||
    resources.state !==
      (resources.calls === 0 ? "observed-empty" : "observed") ||
    !object(resources.outcomes) || !object(resources.units)
  ) return invalid();
  const selection = resources.selection;
  if (
    !reference(selection.projectId) || !reference(selection.systemId) ||
    !reference(selection.executionSpaceId) ||
    selection.repositoryVersion !== requested.expectedVersion ||
    selection.modelDigest !== execution.modelVersion.digest ||
    selection.caseId !== requested.caseId || !instant(selection.endedThrough)
  ) return invalid();
  const outcomeNames = OUTCOMES;
  const outcomes = { returned: 0, failed: 0, cancelled: 0, "timed-out": 0 };
  let total = 0;
  for (const name of outcomeNames) {
    const count = resources.outcomes[name];
    if (!counter(count) || !Number.isSafeInteger(total + count)) {
      return invalid();
    }
    outcomes[name] = count;
    total += count;
  }
  if (total !== resources.calls) return invalid();
  const rawUnits = resources.units, calls = resources.calls;
  const units = Object.fromEntries(
    RESOURCE_UNITS.map((unit) => [unit, amount(rawUnits[unit], calls, true)]),
  ) as Record<ProviderResourceUnit, ObservedResourceAmount>;
  const providerElapsedMs = amount(
    resources.providerElapsedMs,
    resources.calls,
    false,
  );
  if (
    providerElapsedMs.presentCalls !== resources.calls ||
    providerElapsedMs.missingCalls !== 0
  ) return invalid();
  const groups = "operatorGroups" in resources
    ? operatorGroups(
      resources.operatorGroups,
      calls,
      outcomes,
      providerElapsedMs,
      units,
    )
    : undefined;
  return {
    schemaVersion: 1,
    execution: {
      kind,
      ...(requested.caseId === undefined ? {} : { caseId: requested.caseId }),
      operatorId: execution.operatorId,
      runtimeRevision: execution.runtimeRevision,
      modelVersion: {
        digest: execution.modelVersion.digest,
        repositoryVersion: requested.expectedVersion,
      },
    },
    resources: {
      schemaVersion: 1,
      selection: {
        projectId: selection.projectId,
        systemId: selection.systemId,
        executionSpaceId: selection.executionSpaceId,
        repositoryVersion: requested.expectedVersion,
        modelDigest: execution.modelVersion.digest,
        endedThrough: selection.endedThrough,
        ...(requested.caseId === undefined ? {} : { caseId: requested.caseId }),
      },
      readAt: resources.readAt,
      state: calls === 0 ? "observed-empty" : "observed",
      population: "retained-provider-observations",
      retainedPopulation: "complete",
      physicalCallCoverage: "unknown",
      calls: resources.calls,
      outcomes,
      providerElapsedMs,
      units,
      ...(groups === undefined ? {} : { operatorGroups: groups }),
    },
  };
}

export function createPerformanceApi(options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async read(
      selection: PerformanceSelection,
      signal?: AbortSignal,
    ): Promise<CurrentProviderResourceReadout> {
      if (
        !exact(selection.expectedVersion) ||
        (selection.caseId !== undefined && !caseIdentity(selection.caseId))
      ) return invalid();
      const params = new URLSearchParams({
        expectedVersion: selection.expectedVersion,
      });
      if (selection.caseId !== undefined) {
        params.set("caseId", selection.caseId);
      }
      const response = await request(
        `/api/performance/provider-resources?${params}`,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok) {
        throw new PerformanceReadError(
          response.status === 403
            ? "connection-required"
            : response.status === 409
            ? "version-unavailable"
            : "unavailable",
        );
      }
      return parsePerformanceReadout(await response.json(), selection);
    },
  };
}
export type PerformanceApi = ReturnType<typeof createPerformanceApi>;
