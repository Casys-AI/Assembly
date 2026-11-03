import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  budgetState,
  WorkBudgetError,
  type WorkBudgetPolicy,
  type WorkBudgetRecord,
  type WorkBudgetView,
} from "../../../domain/work/policies/budget.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import { caseBudgetPolicy } from "../cases/runtime.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import type { BehaviorSettingsBudgetScope } from "./behavior-settings-validation.ts";
import { evolutionBudgetScopes } from "./evolution.ts";

/** A delegated scope is unbudgeted only when its captured context says so and
 * no retained binding, view or Case contradicts that absence. */
function explicitlyUnbudgetedDelegation(
  state: SystemRuntimeState,
  scope: BehaviorSettingsBudgetScope,
): boolean {
  const owner = state.executionModel?.identity.builderId;
  if (
    !owner || scope.pending ||
    state.designer?.budget?.scopeId === scope.scopeId ||
    state.cases?.some((record) => record.budget?.scopeId === scope.scopeId) ||
    state.workBudgetBinding?.scopeId === scope.scopeId ||
    state.workBudget?.scopeId === scope.scopeId ||
    Object.values(state.invocationContinuations ?? {}).some((saved) =>
      saved.workBudgetBinding?.scopeId === scope.scopeId ||
      saved.workBudget?.scopeId === scope.scopeId
    )
  ) return false;
  const invocations = [
    state.caseInvocation,
    ...Object.values(state.invocationContinuations ?? {}).map((saved) =>
      saved.invocation
    ),
  ];
  const matching = invocations.flatMap((invocation) => {
    if (invocation?.kind === "delegated-designer") {
      const context = invocation.work.designerContext;
      return context.scopeId === scope.scopeId &&
          context.ownerId === scope.ownerId
        ? [context.policy === undefined]
        : [];
    }
    if (invocation?.kind === "delegated") {
      const context = invocation.work.caseContext;
      const scopeId = context.budget?.scopeId ??
        context.record?.budget?.scopeId ?? context.caseId;
      const ownerId = context.budget?.ownerId ?? context.record?.owner ?? owner;
      return scopeId === scope.scopeId && ownerId === scope.ownerId
        ? [context.budget === undefined && context.record?.budget === undefined]
        : [];
    }
    return [];
  });
  return matching.length > 0 && matching.every(Boolean);
}

/** A fresh local scope binds its policy before its first agent reservation.
 * A declared-source refusal can reach await-input before budgetView adopts that
 * initial ledger. Only the active exact pending binding permits this absence;
 * an old scope or a cached view still requires its retained ledger. */
function pendingInitialLocalScope(
  state: SystemRuntimeState,
  scope: BehaviorSettingsBudgetScope,
  policies: readonly WorkBudgetPolicy[],
): boolean {
  const binding = state.workBudgetBinding;
  if (
    state.caseBudgetPending !== true || !binding || state.workBudget ||
    scope.ownerId !== state.executionModel?.identity.builderId ||
    binding.scopeId !== scope.scopeId ||
    !policies.every((policy) => policy.id === binding.budgetId) ||
    Object.values(state.invocationContinuations ?? {}).some((saved) =>
      saved.workBudget?.scopeId === scope.scopeId ||
      saved.workBudgetBinding?.scopeId === scope.scopeId
    )
  ) return false;
  const invocation = state.caseInvocation;
  const records = (state.cases ?? []).filter((record) =>
    record.budget?.scopeId === scope.scopeId
  );
  if (invocation?.kind === "designer") {
    return records.length === 0 &&
      invocation.scopeId === scope.scopeId &&
      state.designer?.scopeId === scope.scopeId &&
      canonical(state.designer.budget) === canonical(binding);
  }
  if (invocation?.kind !== "local" || records.length !== 1) return false;
  const record = records[0];
  return record.id === invocation.caseId && record.owner === scope.ownerId &&
    isOpenCase(record) && canonical(record.budget) === canonical(binding);
}

/** Resolve from the admitted owner or the exact captured delegated contract.
 * A workspace may supply the actual admitted owner model for other scopes. */
export function retainedBudgetPolicy(
  state: SystemRuntimeState,
  scope: BehaviorSettingsBudgetScope,
): WorkBudgetPolicy | undefined {
  const model = state.executionModel;
  if (!model) return undefined;
  if (scope.ownerId === model.identity.builderId) {
    return scope.designer
      ? model.workBudgetPolicy
      : caseBudgetPolicy(model, scope.caseTypeId, scope.ceiling);
  }
  const invocations = [
    state.caseInvocation,
    ...Object.values(state.invocationContinuations ?? {}).map((item) =>
      item.invocation
    ),
  ];
  const policies = invocations.flatMap((invocation) => {
    if (invocation?.kind === "delegated-designer") {
      const context = invocation.work.designerContext;
      return context.scopeId === scope.scopeId &&
          context.ownerId === scope.ownerId && context.policy
        ? [context.policy]
        : [];
    }
    if (invocation?.kind === "delegated") {
      const budget = invocation.work.caseContext.budget;
      return budget?.scopeId === scope.scopeId &&
          budget.ownerId === scope.ownerId
        ? [budget.policy]
        : [];
    }
    return [];
  });
  if (policies.some((policy) => canonical(policy) !== canonical(policies[0]))) {
    throw new Error("EVOLUTION_BUDGET_UNPROVEN: conflicting captured policies");
  }
  return policies[0];
}

/** Read every retained ledger, then project only derived views into a copy.
 * A projection is not a lock on direct budget writers; callers hold their
 * ordinary admission reservation and re-read before publication/adoption. */
export async function projectEvolutionBudgets(
  state: SystemRuntimeState,
  budget: WorkBudgetPort | undefined,
  policyFor: (
    scope: BehaviorSettingsBudgetScope,
  ) => readonly WorkBudgetPolicy[] = (scope) => {
    const policy = retainedBudgetPolicy(state, scope);
    return policy ? [policy] : [];
  },
): Promise<
  { state: SystemRuntimeState; reserved: BehaviorSettingsBudgetScope[] }
> {
  const scopes = evolutionBudgetScopes(state);
  const views = new Map<string, WorkBudgetView>();
  const pendingInitial = new Set<string>();
  const owners = new Map<string, string>();
  const reserved: BehaviorSettingsBudgetScope[] = [];
  for (const scope of scopes) {
    if (
      !scope.scopeId || !scope.ownerId ||
      owners.has(scope.scopeId) && owners.get(scope.scopeId) !== scope.ownerId
    ) {
      throw new Error("EVOLUTION_BUDGET_UNPROVEN: scope or owner is ambiguous");
    }
    owners.set(scope.scopeId, scope.ownerId);
    if (explicitlyUnbudgetedDelegation(state, scope)) continue;
    const policies = policyFor(scope);
    if (!policies.length || !budget?.readRecord) {
      throw new Error(
        `EVOLUTION_BUDGET_UNPROVEN: budget ${scope.scopeId} has no exact policy or ledger reader`,
      );
    }
    let record: WorkBudgetRecord;
    try {
      record = await budget.readRecord(scope.scopeId, scope.ownerId);
    } catch (error) {
      if (
        !(error instanceof WorkBudgetError) || error.code !== "missing-state" ||
        !pendingInitialLocalScope(state, scope, policies)
      ) throw error;
      // readRecord deliberately does not distinguish an absent row from a
      // foreign owner. The ordinary policy reader must confirm actual absence;
      // owner/policy conflicts and all other failures remain refusals.
      try {
        await budget.snapshot(scope.scopeId, scope.ownerId, policies[0]);
      } catch (missing) {
        if (
          missing instanceof WorkBudgetError && missing.code === "missing-state"
        ) {
          pendingInitial.add(scope.scopeId);
          continue;
        }
        throw missing;
      }
      throw new Error(
        "EVOLUTION_BUDGET_UNPROVEN: pending ledger changed during inspection",
      );
    }
    if (record.scopeId !== scope.scopeId || record.ownerId !== scope.ownerId) {
      throw new Error(
        "EVOLUTION_BUDGET_UNPROVEN: ledger owner or scope differs",
      );
    }
    const view = budgetState(record).view;
    let checked: WorkBudgetView | undefined;
    for (const policy of policies) {
      try {
        checked = await budget.snapshot(scope.scopeId, scope.ownerId, policy);
        break;
      } catch { /* Try only another explicitly admitted recovery policy. */ }
    }
    if (
      !checked || canonical(checked) !== canonical(view) ||
      view.scopeId !== scope.scopeId || !policies.some((policy) =>
        view.budgetId === policy.id
      )
    ) {
      throw new Error(
        `EVOLUTION_BUDGET_UNPROVEN: budget ${scope.scopeId} changed or has a different policy`,
      );
    }
    views.set(scope.scopeId, view);
    if (view.reserved) reserved.push(scope);
  }
  const next = structuredClone(state);
  const exactScope = (invocation: SystemRuntimeState["caseInvocation"]) => {
    if (!invocation) {
      return next.designer
        ? {
          scopeId: next.designer.scopeId,
          ownerId: next.executionModel!.identity.builderId,
        }
        : undefined;
    }
    if (invocation.kind === "designer") {
      return {
        scopeId: invocation.scopeId,
        ownerId: next.executionModel!.identity.builderId,
      };
    }
    if (invocation.kind === "delegated-designer") {
      return invocation.work.designerContext;
    }
    if (invocation.kind === "delegated") {
      const context = invocation.work.caseContext;
      return {
        scopeId: context.budget?.scopeId ?? context.caseId,
        ownerId: context.budget?.ownerId ?? context.record?.owner ??
          next.executionModel!.identity.builderId,
      };
    }
    const record = next.cases?.find((item) => item.id === invocation.caseId);
    return record
      ? { scopeId: record.budget?.scopeId ?? record.id, ownerId: record.owner }
      : undefined;
  };
  const replace = (
    cached: WorkBudgetView | undefined,
    binding: { scopeId: string; budgetId: string } | undefined,
    invocation: SystemRuntimeState["caseInvocation"],
  ) => {
    if (!cached && !binding) return cached;
    const scopeId = binding?.scopeId ?? cached!.scopeId;
    const view = views.get(scopeId);
    const exact = exactScope(invocation);
    if (
      !cached && binding && pendingInitial.has(scopeId) && exact &&
      exact.scopeId === scopeId && exact.ownerId === owners.get(scopeId)
    ) return undefined;
    if (
      !view || !exact || exact.scopeId !== scopeId ||
      exact.ownerId !== owners.get(scopeId) ||
      cached && cached.scopeId !== scopeId ||
      binding && view.budgetId !== binding.budgetId ||
      cached && view.budgetId !== cached.budgetId
    ) {
      throw new Error(
        `EVOLUTION_BUDGET_UNPROVEN: retained view ${scopeId} is not bound to its ledger`,
      );
    }
    return structuredClone(view);
  };
  next.workBudget = replace(
    next.workBudget,
    next.workBudgetBinding,
    next.caseInvocation,
  );
  for (const saved of Object.values(next.invocationContinuations ?? {})) {
    saved.workBudget = replace(
      saved.workBudget,
      saved.workBudgetBinding,
      saved.invocation,
    );
  }
  return { state: next, reserved };
}
