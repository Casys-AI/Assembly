/**
 * APE 3.6 Budget-Bounded Loop: budget policy, reservations and persistent accounting
 * state for a bounded runtime assembly.
 */
import { canonical } from "../../primitives/canonical-json.ts";
/** Durable, cumulative agent-invocation accounting. */
export interface WorkBudgetPolicy {
  id: string;
  revision: number;
  unit: "agent-invocation";
  limit: number;
  onExhausted: "wait";
  exhaustionRecipient: "local-control";
}
export interface WorkBudgetView {
  budgetId: string;
  scopeId: string;
  unit: "agent-invocation";
  limit: number;
  consumed: number;
  reserved: number;
  remaining: number;
  exhausted: boolean;
  suspended: boolean;
  reason?: "exhausted";
  onExhausted: "wait";
  exhaustionRecipient: "local-control";
}
export interface WorkBudgetReservation extends WorkBudgetView {
  attemptId: string;
}
export type WorkBudgetOperation = "decide" | "review" | "admit";
/** Distinct from shared-kernel BehaviorModelVersion: repositoryVersion stays optional here. */
export interface WorkBudgetModelVersion {
  digest: string;
  repositoryVersion?: string;
}
export type WorkBudgetEvent =
  | {
    kind: "policy";
    /** Present only for an exact durable local-owner ceiling intention. */
    ceilingTransitionId?: string;
    ceilingManifestDigest?: string;
    policy: WorkBudgetPolicy;
    modelVersion: WorkBudgetModelVersion;
  }
  | {
    kind: "refused";
    policy: WorkBudgetPolicy;
    attemptId: string;
    operation: WorkBudgetOperation;
    modelVersion: WorkBudgetModelVersion;
    reason: "exhausted";
  }
  | {
    kind: "reserve";
    attemptId: string;
    operation: WorkBudgetOperation;
    modelVersion: WorkBudgetModelVersion;
    policy: WorkBudgetPolicy;
  }
  | { kind: "settle"; attemptId: string; outcome: "returned" | "failed" };
export interface WorkBudgetRecord {
  scopeId: string;
  ownerId: string;
  revision: number;
  events: WorkBudgetEvent[];
}
export class WorkBudgetError extends Error {
  constructor(
    public readonly code:
      | "exhausted"
      | "missing-policy"
      | "missing-state"
      | "conflict"
      | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkBudgetError";
  }
}
export function budgetIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 1024 &&
    Array.from(value).every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    );
}
function invalid(message: string): never {
  throw new WorkBudgetError("invalid", message);
}
export function assertBudgetPolicy(policy: WorkBudgetPolicy): void {
  if (
    !policy || !budgetIdentity(policy.id) ||
    (!Number.isSafeInteger(policy.revision) || policy.revision < 1) ||
    policy.unit !== "agent-invocation" || policy.onExhausted !== "wait" ||
    policy.exhaustionRecipient !== "local-control" ||
    !Number.isSafeInteger(policy.limit) || policy.limit < 0
  ) invalid("Invalid work budget policy");
}
export const MAX_WORK_BUDGET_EVENTS = 100_000;
/** Replay the audit log; counters are never accepted from storage. */
export function budgetState(
  record: WorkBudgetRecord,
): {
  view: WorkBudgetView;
  attempts: Map<string, { outcome?: "returned" | "failed" }>;
} {
  if (
    !record || !budgetIdentity(record.scopeId) ||
    !budgetIdentity(record.ownerId) || !Array.isArray(record.events) ||
    record.events.length < 1 || record.events.length > MAX_WORK_BUDGET_EVENTS ||
    record.revision !== record.events.length
  ) invalid("Invalid work budget record");
  if (record.events[0].kind !== "policy") {
    invalid("Budget requires an initial adoption event");
  }
  let policy: WorkBudgetPolicy | undefined;
  let consumed = 0;
  let suspended = false;
  const attempts = new Map<string, { outcome?: "returned" | "failed" }>();
  for (const event of record.events) {
    if (!event || typeof event !== "object") invalid("Invalid budget event");
    if (
      event.kind === "policy" || event.kind === "reserve" ||
      event.kind === "refused"
    ) {
      assertBudgetPolicy(event.policy);
      if (policy && policy.id !== event.policy.id) {
        throw new WorkBudgetError(
          "conflict",
          "Budget policy binding cannot change",
        );
      }
      if (event.kind === "policy") {
        if (
          !event.modelVersion || !budgetIdentity(event.modelVersion.digest) ||
          (event.modelVersion.repositoryVersion !== undefined &&
            !budgetIdentity(event.modelVersion.repositoryVersion))
        ) invalid("Invalid adoption provenance");
        if (event.policy.limit < attempts.size) {
          invalid("Adopted budget below committed usage");
        }
        suspended = false;
      } else if (
        policy && canonical(policy) !== canonical(event.policy)
      ) invalid("Reservation policy differs from active policy");
      policy = event.policy;
      if (event.kind === "refused") {
        if (
          event.reason !== "exhausted" || attempts.size < policy.limit ||
          !budgetIdentity(event.attemptId)
        ) invalid("Invalid budget refusal");
        suspended = true;
      }
      if (event.kind === "reserve" || event.kind === "refused") {
        if (
          !budgetIdentity(event.attemptId) ||
          !["decide", "review", "admit"].includes(event.operation) ||
          !event.modelVersion || !budgetIdentity(event.modelVersion.digest) ||
          (event.modelVersion.repositoryVersion !== undefined &&
            !budgetIdentity(event.modelVersion.repositoryVersion))
        ) invalid("Invalid budget reservation");
        if (event.kind === "refused") continue;
        if (attempts.has(event.attemptId)) {
          throw new WorkBudgetError(
            "conflict",
            "Budget attempt already reserved",
          );
        }
        if (attempts.size >= policy.limit) {
          throw new WorkBudgetError(
            "exhausted",
            "Provider-dispatch budget exhausted",
          );
        }
        attempts.set(event.attemptId, {});
      }
    } else if (event.kind === "settle") {
      const attempt = attempts.get(event.attemptId);
      if (
        !attempt || !["returned", "failed"].includes(event.outcome) ||
        attempt.outcome
      ) invalid("Invalid budget settlement history");
      attempt.outcome = event.outcome;
      consumed++;
    } else invalid("Unknown budget event");
  }
  if (!policy) invalid("Missing initial budget policy");
  const remaining = Math.max(0, policy.limit - attempts.size);
  return {
    view: {
      budgetId: policy.id,
      scopeId: record.scopeId,
      unit: policy.unit,
      limit: policy.limit,
      consumed,
      reserved: attempts.size - consumed,
      remaining,
      exhausted: remaining === 0,
      onExhausted: policy.onExhausted,
      exhaustionRecipient: policy.exhaustionRecipient,
      suspended,
      ...(suspended ? { reason: "exhausted" as const } : {}),
    },
    attempts,
  };
}
