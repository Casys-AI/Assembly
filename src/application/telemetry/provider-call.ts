import { isPlainRecord as record } from "../../domain/primitives/is-plain-record.ts";
/** Physical provider calls, distinct from business attempts and verified effects.
 * Null correlation means unavailable; it never selects Main or a Case birth pin.
 * No prompts, replies, checkpoints, URLs or raw exceptions belong in this DTO. */
export interface ProviderCallCorrelation {
  readonly executionScope:
    | ProviderCallHostScope & { readonly executionSpaceId: string }
    | null;
  readonly scopeKind: "request" | "designer" | null;
  readonly scopeId: string | null;
  readonly caseId: string | null;
  readonly operatorId: string | null;
  readonly threadId: string | null;
  readonly runId: string | null;
  /** Native ExecutionEffect.effectKey, scoped by threadId. */
  readonly effectId: string | null;
  readonly nodeId: string | null;
  readonly modelDigest: string | null;
  readonly repositoryVersion: string | null;
  readonly budgetAttemptId: string | null;
  readonly budgetOperation: "decide" | "review" | "admit" | null;
}

export interface ProviderUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation?: Readonly<{
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  }>;
  readonly server_tool_use?: Readonly<{
    web_search_requests?: number;
    web_fetch_requests?: number;
  }>;
}

export interface ProviderCallObservation {
  readonly schemaVersion: 1;
  /** Allocated before this invocation; replay reuses these immutable bytes. */
  readonly observationId: string;
  readonly provider: "anthropic";
  readonly configuredModel: string;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Monotonic duration; wall clock adjustment must not change this value. */
  readonly elapsedMs: number;
  readonly outcome: "returned" | "failed" | "cancelled" | "timed-out";
  readonly correlation: ProviderCallCorrelation;
  /** Provider-returned references, when available; never the observation ID. */
  readonly id?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly usage?: ProviderUsage;
}

export interface ProviderCallHostScope {
  readonly projectId: string;
  readonly systemId: string;
}

export interface ProviderCallScope extends ProviderCallHostScope {
  /** Null explicitly selects calls whose durable execution space is unknown. */
  readonly executionSpaceId: string | null;
}

/** Each append owns a separate transaction, outside work fences/transactions. */
export interface ProviderCallObservationStore {
  append(
    scope: ProviderCallHostScope,
    observation: ProviderCallObservation,
  ): Promise<"inserted" | "duplicate">;
  list(
    scope: ProviderCallScope,
    limit?: number,
  ): Promise<readonly ProviderCallObservation[]>;
}

/** Application supplies genuine context; the edge implements async isolation. */
export interface ProviderCallContextPort {
  run<T>(
    correlation: Partial<ProviderCallCorrelation>,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export const UNKNOWN_PROVIDER_CALL_CORRELATION: ProviderCallCorrelation = Object
  .freeze({
    executionScope: null,
    scopeKind: null,
    scopeId: null,
    caseId: null,
    operatorId: null,
    threadId: null,
    runId: null,
    effectId: null,
    nodeId: null,
    modelDigest: null,
    repositoryVersion: null,
    budgetAttemptId: null,
    budgetOperation: null,
  });

const reference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  // deno-lint-ignore no-control-regex -- Persisted identifiers must exclude control characters.
  !/[\u0000-\u001f\u007f]/.test(value) && !value.includes("://");
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const stopReasons = new Set([
  "tool_use",
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

/** Copy the fixed allowlist, never traversing unknown/private fields. Invalid
 * evidence refuses instead of turning missing or malformed usage into zero. */
export function normalizeProviderCallObservation(
  value: unknown,
): ProviderCallObservation {
  function invalid(): never {
    throw new Error("Invalid provider call observation");
  }
  if (
    !record(value) || value.schemaVersion !== 1 ||
    typeof value.observationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value.observationId) ||
    value.provider !== "anthropic" || !reference(value.configuredModel) ||
    typeof value.startedAt !== "string" || value.startedAt.length !== 24 ||
    typeof value.endedAt !== "string" || value.endedAt.length !== 24 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.endedAt)) ||
    new Date(value.startedAt).toISOString() !== value.startedAt ||
    new Date(value.endedAt).toISOString() !== value.endedAt ||
    typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    !["returned", "failed", "cancelled", "timed-out"].includes(
      String(value.outcome),
    ) ||
    !record(value.correlation)
  ) invalid();
  const correlation: Record<string, unknown> = {};
  for (const key of Object.keys(UNKNOWN_PROVIDER_CALL_CORRELATION)) {
    const item = value.correlation[key];
    if (key === "executionScope") {
      if (item !== null) {
        if (
          !record(item) || !reference(item.projectId) ||
          !reference(item.systemId) ||
          !reference(item.executionSpaceId)
        ) invalid();
        correlation[key] = Object.freeze({
          projectId: item.projectId,
          systemId: item.systemId,
          executionSpaceId: item.executionSpaceId,
        });
        continue;
      }
    } else if (key === "scopeKind") {
      if (item !== null && item !== "request" && item !== "designer") invalid();
    } else if (key === "budgetOperation") {
      if (
        item !== null && item !== "decide" && item !== "review" &&
        item !== "admit"
      ) invalid();
    } else if (item !== null && !reference(item)) invalid();
    correlation[key] = item;
  }
  const optional: {
    id?: string;
    model?: string;
    stopReason?: string;
    usage?: ProviderUsage;
  } = {};
  for (const key of ["id", "model"] as const) {
    if (value[key] === undefined) continue;
    if (!reference(value[key])) invalid();
    optional[key] = value[key];
  }
  if (value.stopReason !== undefined) {
    if (
      typeof value.stopReason !== "string" || !stopReasons.has(value.stopReason)
    ) invalid();
    optional.stopReason = value.stopReason;
  }
  if (value.usage !== undefined) {
    if (!record(value.usage)) invalid();
    const usage: Record<string, unknown> = {};
    for (
      const key of [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ]
    ) {
      if (value.usage[key] === undefined) continue;
      if (!counter(value.usage[key])) invalid();
      usage[key] = value.usage[key];
    }
    for (
      const [key, fields] of [
        ["cache_creation", [
          "ephemeral_5m_input_tokens",
          "ephemeral_1h_input_tokens",
        ]],
        ["server_tool_use", ["web_search_requests", "web_fetch_requests"]],
      ] as const
    ) {
      const nested = value.usage[key];
      if (nested === undefined || nested === null) continue;
      if (!record(nested)) invalid();
      const units: Record<string, number> = {};
      for (const field of fields) {
        if (nested[field] === undefined) continue;
        if (!counter(nested[field])) invalid();
        units[field] = nested[field];
      }
      if (Object.keys(units).length) usage[key] = Object.freeze(units);
    }
    if (Object.keys(usage).length) optional.usage = Object.freeze(usage);
  }
  return Object.freeze({
    schemaVersion: 1,
    observationId: value.observationId,
    provider: "anthropic",
    configuredModel: value.configuredModel,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    elapsedMs: value.elapsedMs,
    outcome: value.outcome as ProviderCallObservation["outcome"],
    correlation: Object.freeze(
      correlation,
    ) as unknown as ProviderCallCorrelation,
    ...optional,
  });
}
