import { matchesExactRevision } from "../../domain/shared-kernel/revision-id.ts";
import type {
  ProviderCallHostScope,
  ProviderCallObservation,
  ProviderUsage,
} from "./provider-call.ts";

/** Supplied by a trusted source resolver, never browser authority. */
export interface ProviderResourceQuery extends ProviderCallHostScope {
  readonly executionSpaceId: string;
  readonly repositoryVersion: string;
  readonly modelDigest: string;
  readonly endedThrough: string;
  /** Optional narrower Request selection inside an authorized execution space. */
  readonly caseId?: string;
}

export interface ObservedResourceAmount {
  readonly observedSubtotal: number | null;
  readonly presentCalls: number;
  readonly missingCalls: number;
  readonly state: "known" | "partial" | "unknown" | "overflow";
}

export type ProviderResourceUnit =
  | "input_tokens"
  | "output_tokens"
  | "cache_creation_input_tokens"
  | "cache_read_input_tokens"
  | "cache_creation_5m_input_tokens"
  | "cache_creation_1h_input_tokens"
  | "web_search_requests"
  | "web_fetch_requests";

/** Exact retained correlation; null means attribution is unavailable. */
interface ProviderOperatorResourceGroup {
  readonly operatorId: string | null;
  readonly calls: number;
  readonly outcomes: ProviderResourceReadout["outcomes"];
  readonly providerElapsedMs: ObservedResourceAmount;
  readonly units: ProviderResourceReadout["units"];
}

export interface ProviderResourceReadout {
  readonly schemaVersion: 1;
  readonly selection: ProviderResourceQuery;
  readonly readAt: string;
  readonly state: "observed" | "observed-empty";
  readonly population: "retained-provider-observations";
  readonly retainedPopulation: "complete";
  readonly physicalCallCoverage: "unknown";
  readonly calls: number;
  /** Physical provider outcomes, never verified business results. */
  readonly outcomes: Readonly<
    Record<ProviderCallObservation["outcome"], number>
  >;
  /** Sum of provider latencies; concurrent calls overlap in workflow time. */
  readonly providerElapsedMs: ObservedResourceAmount;
  /** Separate units; parent/cache breakdowns must not be added together. */
  readonly units: Readonly<
    Record<ProviderResourceUnit, ObservedResourceAmount>
  >;
  /** Absent only on older readouts. Present groups exhaust this same snapshot,
   * with exact string IDs in code-unit order and unattributed null last. */
  readonly operatorGroups?: readonly ProviderOperatorResourceGroup[];
}

export interface ProviderResourceReader {
  read(query: ProviderResourceQuery): Promise<ProviderResourceReadout>;
}

const identity = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 &&
  // deno-lint-ignore no-control-regex -- Persisted identifiers exclude control characters.
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) &&
  !value.includes("://");
const instant = (value: unknown): value is string =>
  typeof value === "string" && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function assertProviderResourceQuery(
  query: ProviderResourceQuery,
): void {
  if (
    !identity(query.projectId) || !identity(query.systemId) ||
    !identity(query.executionSpaceId) ||
    !matchesExactRevision(query.repositoryVersion) ||
    !/^[a-f0-9]{64}$/.test(query.modelDigest) || !instant(query.endedThrough) ||
    (query.caseId !== undefined && !identity(query.caseId))
  ) throw new Error("Invalid provider resource query");
}

/** Private mutable accumulator; checked counters never wrap or invent zero. */
class Amount {
  present = 0;
  total = 0;
  overflow = false;
  add(value: number | undefined, integer = true): void {
    if (value === undefined) return;
    if (
      !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isSafeInteger(value))
    ) throw new Error("Invalid observed resource amount");
    this.present = checkedIncrement(this.present);
    if (this.overflow) return;
    const next = this.total + value;
    if (
      !Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER ||
      (integer && !Number.isSafeInteger(next))
    ) this.overflow = true;
    else this.total = next;
  }
  read(calls: number): ObservedResourceAmount {
    return Object.freeze({
      observedSubtotal: this.overflow || this.present === 0 ? null : this.total,
      presentCalls: this.present,
      missingCalls: calls - this.present,
      state: this.overflow
        ? "overflow"
        : this.present === 0
        ? "unknown"
        : this.present < calls
        ? "partial"
        : "known",
    });
  }
}
function checkedIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Observed resource count overflow");
  }
  return value + 1;
}
const usageOf: Record<
  ProviderResourceUnit,
  (usage?: ProviderUsage) => number | undefined
> = {
  input_tokens: (usage) => usage?.input_tokens,
  output_tokens: (usage) => usage?.output_tokens,
  cache_creation_input_tokens: (usage) => usage?.cache_creation_input_tokens,
  cache_read_input_tokens: (usage) => usage?.cache_read_input_tokens,
  cache_creation_5m_input_tokens: (usage) =>
    usage?.cache_creation?.ephemeral_5m_input_tokens,
  cache_creation_1h_input_tokens: (usage) =>
    usage?.cache_creation?.ephemeral_1h_input_tokens,
  web_search_requests: (usage) => usage?.server_tool_use?.web_search_requests,
  web_fetch_requests: (usage) => usage?.server_tool_use?.web_fetch_requests,
};
const unitNames = Object.keys(usageOf) as ProviderResourceUnit[];

/** One calculation for totals and operator partitions, including missingness. */
class ResourceAccumulator {
  #calls = 0;
  readonly #outcomes = { returned: 0, failed: 0, cancelled: 0, "timed-out": 0 };
  readonly #elapsed = new Amount();
  readonly #units = Object.fromEntries(
    unitNames.map((unit) => [unit, new Amount()]),
  ) as Record<ProviderResourceUnit, Amount>;

  add(observation: ProviderCallObservation): void {
    this.#calls = checkedIncrement(this.#calls);
    this.#outcomes[observation.outcome] = checkedIncrement(
      this.#outcomes[observation.outcome],
    );
    this.#elapsed.add(observation.elapsedMs, false);
    for (const unit of unitNames) {
      this.#units[unit].add(usageOf[unit](observation.usage));
    }
  }

  finish(): Pick<
    ProviderResourceReadout,
    "calls" | "outcomes" | "providerElapsedMs" | "units"
  > {
    return Object.freeze({
      calls: this.#calls,
      outcomes: Object.freeze({ ...this.#outcomes }),
      providerElapsedMs: this.#elapsed.read(this.#calls),
      units: Object.freeze(Object.fromEntries(
        unitNames.map((unit) => [unit, this.#units[unit].read(this.#calls)]),
      )) as ProviderResourceReadout["units"],
    });
  }
}

/** One accumulator per database snapshot. Its input must be unique, decoded
 * canonical rows; source pagination, not this reducer, guarantees exhaustion. */
export class ProviderResourceAggregation {
  readonly #query: ProviderResourceQuery;
  readonly #total = new ResourceAccumulator();
  readonly #operators = new Map<string | null, ResourceAccumulator>();

  constructor(query: ProviderResourceQuery) {
    assertProviderResourceQuery(query);
    // Copy the closed allowlist; callers cannot change the selection mid-read.
    this.#query = Object.freeze({
      projectId: query.projectId,
      systemId: query.systemId,
      executionSpaceId: query.executionSpaceId,
      repositoryVersion: query.repositoryVersion,
      modelDigest: query.modelDigest,
      endedThrough: query.endedThrough,
      ...(query.caseId === undefined ? {} : { caseId: query.caseId }),
    });
  }

  get selection(): ProviderResourceQuery {
    return this.#query;
  }

  add(observation: ProviderCallObservation): void {
    const context = observation.correlation;
    const scope = context.executionScope;
    if (
      !scope || scope.projectId !== this.#query.projectId ||
      scope.systemId !== this.#query.systemId ||
      scope.executionSpaceId !== this.#query.executionSpaceId
    ) throw new Error("Provider resource observation scope mismatch");
    if (
      context.repositoryVersion !== this.#query.repositoryVersion ||
      context.modelDigest !== this.#query.modelDigest ||
      observation.endedAt > this.#query.endedThrough ||
      (this.#query.caseId !== undefined &&
        context.caseId !== this.#query.caseId)
    ) return;
    this.#total.add(observation);
    let operator = this.#operators.get(context.operatorId);
    if (!operator) {
      operator = new ResourceAccumulator();
      this.#operators.set(context.operatorId, operator);
    }
    operator.add(observation);
  }

  finish(readAt: string): ProviderResourceReadout {
    if (!instant(readAt)) {
      throw new Error("Invalid provider resource read time");
    }
    const total = this.#total.finish();
    const operatorGroups = Object.freeze(
      [...this.#operators.entries()].sort(
        ([a], [b]) =>
          a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1,
      ).map(([operatorId, aggregate]) =>
        Object.freeze({
          operatorId,
          ...aggregate.finish(),
        })
      ),
    );
    return Object.freeze({
      schemaVersion: 1,
      selection: this.#query,
      readAt,
      state: total.calls === 0 ? "observed-empty" : "observed",
      population: "retained-provider-observations",
      retainedPopulation: "complete",
      physicalCallCoverage: "unknown",
      ...total,
      operatorGroups,
    });
  }
}
