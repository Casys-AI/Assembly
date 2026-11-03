/**
 * APE 3.6 Budget-Bounded Loop: control reservations and consumption before
 * continuation; the runtime supplies the exhaustion disposition.
 */
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  assertBudgetPolicy,
  budgetIdentity,
  budgetState,
  WorkBudgetError,
  type WorkBudgetEvent,
  type WorkBudgetPolicy,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import type {
  WorkBudgetAdoptInput,
  WorkBudgetReserveInput,
  WorkBudgetSettleInput,
} from "./commands/inputs.ts";
import type { WorkBudgetPort, WorkBudgetStorePort } from "./ports.ts";
export class WorkBudgetService implements WorkBudgetPort {
  constructor(private readonly store: WorkBudgetStorePort) {}
  async #change<T>(
    scopeId: string,
    ownerId: string,
    action: (
      record: WorkBudgetRecord | null,
    ) => { record?: WorkBudgetRecord; result: T },
  ): Promise<T> {
    if (!budgetIdentity(scopeId) || !budgetIdentity(ownerId)) {
      throw new WorkBudgetError("invalid", "Invalid budget scope");
    }
    for (let retry = 0; retry < 64; retry++) {
      const current = await this.store.load(scopeId);
      if (current) {
        budgetState(current);
        if (current.ownerId !== ownerId || current.scopeId !== scopeId) {
          throw new WorkBudgetError("conflict", "Budget owner differs");
        }
      }
      const next = action(current);
      if (!next.record) return next.result;
      budgetState(next.record);
      try {
        await this.store.save(next.record, current?.revision ?? null);
        return next.result;
      } catch (error) {
        if (!(error instanceof WorkBudgetError) || error.code !== "conflict") {
          throw error;
        }
      }
    }
    throw new WorkBudgetError("conflict", "Budget contention limit exceeded");
  }
  #policy(
    current: WorkBudgetRecord | null,
    policy: WorkBudgetPolicy | undefined,
  ): void {
    if (!policy) {
      if (current) {
        throw new WorkBudgetError(
          "missing-policy",
          "Durable budget requires its policy",
        );
      }
      return;
    }
    assertBudgetPolicy(policy);
    if (current && budgetState(current).view.budgetId !== policy.id) {
      throw new WorkBudgetError(
        "conflict",
        "Budget policy binding cannot change",
      );
    }
  }
  #append(
    current: WorkBudgetRecord | null,
    scopeId: string,
    ownerId: string,
    event: WorkBudgetEvent,
  ): WorkBudgetRecord {
    return structuredClone({
      scopeId,
      ownerId,
      revision: (current?.revision ?? 0) + 1,
      events: [...(current?.events ?? []), event],
    });
  }
  #active(current: WorkBudgetRecord): WorkBudgetPolicy {
    const event = current.events.findLast((e) =>
      e.kind === "policy" || e.kind === "reserve" || e.kind === "refused"
    )!;
    return (event as { policy: WorkBudgetPolicy }).policy;
  }
  #equal(a: WorkBudgetPolicy | undefined, b: WorkBudgetPolicy | undefined) {
    return canonical(a ?? null) === canonical(b ?? null);
  }
  adopt(input: WorkBudgetAdoptInput) {
    return this.#change(input.scopeId, input.ownerId, (current) => {
      if (!current && input.previousPolicy !== undefined) {
        throw new WorkBudgetError(
          "missing-state",
          "Previously bound budget ledger is missing",
        );
      }
      this.#policy(current, input.policy);
      if (!input.policy) return { result: undefined };
      const active = current ? this.#active(current) : undefined;
      if (this.#equal(active, input.policy)) {
        return { result: current ? budgetState(current).view : undefined };
      }
      if (!this.#equal(active, input.previousPolicy)) {
        throw new WorkBudgetError("conflict", "Previous budget policy differs");
      }
      if (
        !budgetIdentity(input.modelVersion.digest) ||
        (input.modelVersion.repositoryVersion !== undefined &&
          !budgetIdentity(input.modelVersion.repositoryVersion))
      ) throw new WorkBudgetError("invalid", "Invalid adoption model version");
      const record = this.#append(current, input.scopeId, input.ownerId, {
        kind: "policy",
        policy: input.policy,
        modelVersion: input.modelVersion,
      });
      return { record, result: budgetState(record).view };
    });
  }
  async readRecord(
    scopeId: string,
    ownerId: string,
  ): Promise<WorkBudgetRecord> {
    const record = await this.store.load(scopeId);
    if (!record || record.scopeId !== scopeId || record.ownerId !== ownerId) {
      throw new WorkBudgetError(
        "missing-state",
        "Exact budget ledger is unavailable",
      );
    }
    budgetState(record);
    return structuredClone(record);
  }
  async advanceCeiling(
    input: WorkBudgetAdoptInput & {
      transitionId: string;
      manifestDigest: string;
      expectedRevision: number;
      expectedDigest: string;
    },
  ): Promise<WorkBudgetRecord> {
    const current = await this.readRecord(input.scopeId, input.ownerId);
    const existing = current.events[input.expectedRevision];
    if (
      existing?.kind === "policy" &&
      existing.ceilingTransitionId === input.transitionId &&
      existing.ceilingManifestDigest === input.manifestDigest &&
      this.#equal(existing.policy, input.policy) &&
      canonical(existing.modelVersion) === canonical(input.modelVersion)
    ) {
      if (
        await executionDigest({
          ...current,
          revision: input.expectedRevision,
          events: current.events.slice(0, input.expectedRevision),
        }) !== input.expectedDigest
      ) {
        throw new WorkBudgetError(
          "conflict",
          "Budget transition origin differs",
        );
      }
      return current;
    }
    if (
      !input.transitionId || !input.manifestDigest ||
      current.revision !== input.expectedRevision ||
      await executionDigest(current) !== input.expectedDigest ||
      !this.#equal(this.#active(current), input.previousPolicy) ||
      !input.policy || !input.previousPolicy ||
      input.policy.id !== input.previousPolicy.id ||
      input.policy.limit <= input.previousPolicy.limit ||
      input.policy.revision <= input.previousPolicy.revision ||
      budgetState(current).view.reserved !== 0
    ) {
      throw new WorkBudgetError(
        "conflict",
        "Exact budget ceiling intention no longer matches",
      );
    }
    const { limit: _oldLimit, revision: _oldRevision, ...oldContract } =
      input.previousPolicy;
    const { limit: _newLimit, revision: _newRevision, ...newContract } =
      input.policy;
    if (canonical(oldContract) !== canonical(newContract)) {
      throw new WorkBudgetError(
        "conflict",
        "Budget ceiling changed another policy field",
      );
    }
    const next = this.#append(current, input.scopeId, input.ownerId, {
      kind: "policy",
      policy: input.policy,
      modelVersion: input.modelVersion,
      ceilingTransitionId: input.transitionId,
      ceilingManifestDigest: input.manifestDigest,
    });
    budgetState(next);
    await this.store.save(next, current.revision);
    return structuredClone(next);
  }
  snapshot(
    scopeId: string,
    ownerId: string,
    policy: WorkBudgetPolicy | undefined,
  ) {
    return this.#change(scopeId, ownerId, (current) => {
      this.#policy(current, policy);
      if (!policy) return { result: undefined };
      if (current) {
        if (!this.#equal(this.#active(current), policy)) {
          throw new WorkBudgetError("conflict", "Budget policy is stale");
        }
        return { result: budgetState(current).view };
      }
      throw new WorkBudgetError(
        "missing-state",
        "Budget requires an explicit initial adoption",
      );
    });
  }
  async reserve(input: WorkBudgetReserveInput) {
    const result = await this.#change(
      input.scopeId,
      input.ownerId,
      (current) => {
        this.#policy(current, input.policy);
        if (!input.policy) return { result: undefined };
        if (!current) {
          throw new WorkBudgetError(
            "missing-state",
            "Budget requires an explicit initial adoption",
          );
        }
        if (
          current && !this.#equal(this.#active(current), input.policy)
        ) throw new WorkBudgetError("conflict", "Budget policy is stale");
        if (input.ceilingTransition) {
          const origin =
            current.events[input.ceilingTransition.originRevision - 1];
          const policy = current.events[input.ceilingTransition.originRevision];
          if (
            origin?.kind !== "refused" || origin.reason !== "exhausted" ||
            origin.attemptId !== input.attemptId ||
            origin.attemptId !== input.ceilingTransition.refusedAttemptId ||
            origin.operation !== input.operation ||
            policy?.kind !== "policy" ||
            policy.ceilingTransitionId !== input.ceilingTransition.id ||
            policy.ceilingManifestDigest !==
              input.ceilingTransition.manifestDigest ||
            policy.policy.limit <= origin.policy.limit ||
            policy.policy.revision <= origin.policy.revision
          ) {
            throw new WorkBudgetError(
              "conflict",
              "Refused attempt lacks its exact ceiling transition",
            );
          }
        }
        if (
          current && budgetState(current).attempts.has(input.attemptId)
        ) throw new WorkBudgetError("conflict", "Attempt already reserved");
        const exhausted =
          (current
            ? budgetState(current).view.remaining
            : input.policy.limit) === 0;
        const record = this.#append(current, input.scopeId, input.ownerId, {
          ...(exhausted
            ? { kind: "refused" as const, reason: "exhausted" as const }
            : { kind: "reserve" as const }),
          policy: input.policy,
          attemptId: input.attemptId,
          operation: input.operation,
          modelVersion: input.modelVersion,
        });
        return {
          record,
          result: { ...budgetState(record).view, attemptId: input.attemptId },
        };
      },
    );
    if (result?.exhausted && result.suspended) {
      throw new WorkBudgetError(
        "exhausted",
        "Agent invocation budget exhausted",
      );
    }
    return result;
  }
  async settle(input: WorkBudgetSettleInput): Promise<void> {
    await this.#change(input.scopeId, input.ownerId, (current) => {
      if (!current) {
        throw new WorkBudgetError("conflict", "Unknown budget attempt");
      }
      const attempt = budgetState(current).attempts.get(input.attemptId);
      if (!attempt) {
        throw new WorkBudgetError("conflict", "Unknown budget attempt");
      }
      if (attempt.outcome) {
        if (attempt.outcome !== input.outcome) {
          throw new WorkBudgetError(
            "conflict",
            "Budget settlement outcome differs",
          );
        }
        return { result: undefined };
      }
      return {
        record: this.#append(current, input.scopeId, input.ownerId, {
          kind: "settle",
          attemptId: input.attemptId,
          outcome: input.outcome,
        }),
        result: undefined,
      };
    });
  }
}
