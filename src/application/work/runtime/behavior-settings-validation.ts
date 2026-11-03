import { assembleCandidateDecisionContext } from "../conversation/decision-context.ts";
import {
  type CreationScope,
  mainCreationScope,
} from "../../../domain/governance/policies/operator-creation-policy.ts";
/** Read-only compatibility checks, run under the revision command reservation.
 * Authority, publication and adoption remain separate coordinator decisions.
 */
import type {
  EvolutionEffect,
  ScopedExecutableModel,
} from "../../../domain/model/evolution/semantic-effects.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { MemoryRecord } from "../../../domain/memory/entities/memory-record.ts";
import { memoryView } from "../../../domain/memory/governed-memory-promotion.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import {
  assertBudgetPolicy,
  WorkBudgetError,
} from "../../../domain/work/policies/budget.ts";
import { projectDecisionContext } from "../context/separation.ts";
import { caseBudgetPolicy, caseMessages } from "../cases/runtime.ts";

class BehaviorSettingsCompatibilityError extends Error {
  readonly code = "BEHAVIOR_SETTINGS_INCOMPATIBLE";
}
function requireCompatible(value: unknown, message: string): asserts value {
  if (!value) throw new BehaviorSettingsCompatibilityError(message);
}

/** Describes a real durable scope, never a proposed replacement ledger. */
export interface BehaviorSettingsBudgetScope {
  scopeId: string;
  ownerId: string;
  caseTypeId?: string;
  ceiling?: number;
  designer?: boolean;
  /** Only a not-yet-initially-adopted scope may have no durable ledger. */
  pending?: boolean;
}
export interface BehaviorSettingsValidationTarget {
  operatorNativeId: string;
  snapshot: SystemRuntimeState;
  /** Complete, unprojected next decision payload assembled by the real runtime.
   * A small synthetic context cannot establish retained-resource compatibility.
   */
  decisionContext?: ChatContext;
  /** Actual unprojected payload read using only the current admitted model.
   * Candidate executable fields are assembled read-only with the retained audit. */
  admittedDecisionContext?: ChatContext;
  /** The target runtime's stated creation scope; absent means a synthetic
   * main validation target (real runtimes always state theirs). */
  creationScope?: CreationScope;
  budget?: Pick<WorkBudgetPort, "snapshot">;
  /** Includes shared/delegated and saved scopes, with their actual ledger owner. */
  budgetScopes: readonly BehaviorSettingsBudgetScope[];
  /** Exact read-only store audit; changing policy never saves these records. */
  memoryRecords?: readonly MemoryRecord[];
  memoryAuditAt?: string;
}
interface BehaviorSettingsValidation {
  operators: string[];
  budgets: {
    scopeId: string;
    ownerId: string;
    consumed: number;
    reserved: number;
    nextLimit: number;
  }[];
  memory: {
    operatorNativeId: string;
    preservedNoteIds: string[];
    unavailableGuidanceIds: string[];
  }[];
  context: { operatorNativeId: string; projectedCharacters: number }[];
  affectedConsumers: string[];
}
export interface BehaviorSettingsValidationInput {
  before: readonly ScopedExecutableModel[];
  after: readonly ScopedExecutableModel[];
  effects: readonly EvolutionEffect[];
  affectedOperatorIds: readonly string[];
  targets: readonly BehaviorSettingsValidationTarget[];
}

function modelsById(models: readonly ScopedExecutableModel[]) {
  const result = new Map<string, ExecutableModel>();
  for (const { model } of models) {
    requireCompatible(
      !result.has(model.identity.builderId),
      "Duplicate scoped operator identity.",
    );
    result.set(model.identity.builderId, model);
  }
  return result;
}
function same(a: unknown, b: unknown) {
  return canonical(a ?? null) === canonical(b ?? null);
}
function policyFor(model: ExecutableModel, scope: BehaviorSettingsBudgetScope) {
  return scope.designer
    ? model.workBudgetPolicy
    : caseBudgetPolicy(model, scope.caseTypeId, scope.ceiling);
}

/** Enumerate existing typed consumers, rather than inferring new call rights. */
function affectedConsumers(
  before: readonly ScopedExecutableModel[],
  after: readonly ScopedExecutableModel[],
) {
  const changedTargets = new Set<string>();
  const changedTypes = new Set<string>();
  const old = modelsById(before);
  for (const { model } of after) {
    const previous = old.get(model.identity.builderId);
    if (!previous) continue;
    for (
      const behavior of [...previous.behaviors ?? [], ...model.behaviors ?? []]
    ) {
      const a = previous.behaviors?.find((item) => item.id === behavior.id);
      const b = model.behaviors?.find((item) => item.id === behavior.id);
      if (same(a, b)) continue;
      changedTargets.add(behavior.targetNativeId);
      changedTypes.add(behavior.inputTypeId);
    }
    for (
      const contract of [
        ...previous.workResultContracts ?? [],
        ...model.workResultContracts ?? [],
      ]
    ) {
      const a = previous.workResultContracts?.find((item) =>
        item.id === contract.id
      );
      const b = model.workResultContracts?.find((item) =>
        item.id === contract.id
      );
      if (same(a, b)) continue;
      changedTargets.add(contract.workBehaviorId);
      changedTargets.add(contract.observationBehaviorId);
      for (
        const type of [
          contract.input,
          contract.expected,
          contract.observed,
          contract.query,
        ]
      ) {
        if (type) changedTypes.add(type.typeId);
      }
    }
    if (
      !same(previous.contracts, model.contracts) ||
      !same(previous.operatorEntries, model.operatorEntries)
    ) {
      changedTargets.add(model.identity.builderId);
      for (
        const entry of [
          ...previous.operatorEntries ?? [],
          ...model.operatorEntries ?? [],
        ]
      ) changedTargets.add(entry.id);
    }
  }
  const consumers = new Set<string>();
  for (const { model } of [...before, ...after]) {
    if (changedTargets.has(model.identity.builderId)) {
      consumers.add(model.identity.builderId);
    }
    for (const behavior of model.behaviors ?? []) {
      if (
        changedTargets.has(behavior.targetNativeId) ||
        changedTypes.has(behavior.inputTypeId)
      ) {
        consumers.add(model.identity.builderId);
        consumers.add(behavior.callerNativeId);
      }
    }
    for (const contract of model.workResultContracts ?? []) {
      if (
        changedTargets.has(contract.workBehaviorId) ||
        changedTargets.has(contract.observationBehaviorId) ||
        [contract.input, contract.expected, contract.observed, contract.query]
          .some((type) => type && changedTypes.has(type.typeId))
      ) {
        consumers.add(model.identity.builderId);
        consumers.add(contract.callerNativeId);
      }
    }
  }
  return [...consumers].sort();
}

/** One native target/type has one supported compiled contract. Covering a
 * caller does not make an inconsistent partial type migration compatible.
 */
function requireConsistentContracts(models: readonly ScopedExecutableModel[]) {
  const types = new Map<string, unknown>();
  const targets = new Map<string, unknown>();
  const check = (entries: Map<string, unknown>, id: string, value: unknown) => {
    requireCompatible(
      !entries.has(id) || same(entries.get(id), value),
      `Incompatible executable consumers of native contract: ${id}`,
    );
    entries.set(id, value);
  };
  for (const { model } of models) {
    for (const behavior of model.behaviors ?? []) {
      check(types, behavior.inputTypeId, behavior.inputSchema);
      check(targets, behavior.targetNativeId, {
        targetTypeId: behavior.targetTypeId,
        inputTypeId: behavior.inputTypeId,
        inputSchema: behavior.inputSchema,
      });
    }
    for (const contract of model.workResultContracts ?? []) {
      for (
        const type of [
          contract.input,
          contract.expected,
          contract.observed,
          contract.query,
        ]
      ) {
        if (type) check(types, type.typeId, type.schema);
      }
    }
  }
}

export async function validateBehaviorSettingsChange(
  input: BehaviorSettingsValidationInput,
): Promise<BehaviorSettingsValidation> {
  // Freeze caller-provided observations before the first asynchronous store read.
  const before = structuredClone(input.before);
  const after = structuredClone(input.after);
  const effects = structuredClone(input.effects);
  const targets = input.targets.map((target) => ({
    ...target,
    snapshot: structuredClone(target.snapshot),
    decisionContext: structuredClone(target.decisionContext),
    admittedDecisionContext: structuredClone(target.admittedDecisionContext),
    budgetScopes: structuredClone(target.budgetScopes),
    memoryRecords: structuredClone(target.memoryRecords),
  }));
  const prior = modelsById(before), next = modelsById(after);
  const covered = new Set(input.affectedOperatorIds);
  requireCompatible(
    covered.size === input.affectedOperatorIds.length,
    "Duplicate affected operator.",
  );
  const required = new Set(effects.map((effect) => effect.targetNativeId));
  const consumers = affectedConsumers(before, after);
  for (const id of consumers) required.add(id);
  for (const id of required) {
    requireCompatible(
      covered.has(id),
      `Affected executable consumer is outside the coordinated scope: ${id}`,
    );
  }
  const result: BehaviorSettingsValidation = {
    operators: [...required].sort(),
    budgets: [],
    memory: [],
    context: [],
    affectedConsumers: consumers,
  };
  const checkedScopes = new Map<string, string>();
  for (const id of required) {
    requireCompatible(
      covered.has(id),
      `Affected executable consumer is outside the coordinated scope: ${id}`,
    );
    const previous = prior.get(id), candidate = next.get(id);
    const matches = targets.filter((target) => target.operatorNativeId === id);
    requireCompatible(
      previous && candidate && matches.length === 1,
      `Missing exact runtime validation target: ${id}`,
    );
    const target = matches[0]!;
    requireCompatible(
      target.snapshot.executionModel?.identity.builderId === id &&
        target.snapshot.executionModel.version.digest ===
          previous.version.digest &&
        target.snapshot.executionModel.version.repositoryVersion ===
          previous.version.repositoryVersion,
      `Runtime admission changed before settings validation: ${id}`,
    );
    const candidateContext = target.admittedDecisionContext
      ? assembleCandidateDecisionContext(
        target.admittedDecisionContext,
        target.snapshot.executionModel!,
        candidate,
        target.snapshot,
        target.creationScope ?? mainCreationScope(candidate.identity),
        {
          memoryRecords: target.memoryRecords,
          memoryAuditAt: target.memoryAuditAt,
        },
      )
      : target.decisionContext;
    const categories = new Set(
      effects.filter((effect) => effect.targetNativeId === id).map((effect) =>
        effect.category
      ),
    );
    if (categories.has("contracts")) {
      requireConsistentContracts(after);
      for (const contract of previous.contracts) {
        const changed = !same(
          contract,
          candidate.contracts.find((entry) =>
            entry.nativeId === contract.nativeId
          ),
        );
        requireCompatible(
          !changed ||
            !previous.catalog.some((entry) =>
              entry.contractId === contract.nativeId &&
              entry.status === "active"
            ),
          "An active tool needs requalification before its executable contract can change.",
        );
      }
    }
    requireCompatible(
      !categories.has("context") || candidate.contextPolicy,
      "Removing the admitted context policy is unsupported.",
    );
    if (categories.has("budgets")) {
      // A supplied list must include durable local bindings too; a caller cannot
      // evade preservation by leaving its current scope out of the list.
      const bindings = [
        target.snapshot.workBudgetBinding,
        target.snapshot.designer?.budget,
        ...(target.snapshot.cases ?? []).map((record) => record.budget),
      ].filter((binding) => binding !== undefined);
      for (const binding of bindings) {
        requireCompatible(
          target.budgetScopes.some((scope) =>
            scope.scopeId === binding.scopeId
          ),
          `Missing retained budget scope: ${binding.scopeId}`,
        );
      }
      for (const scope of target.budgetScopes) {
        const oldOwner = prior.get(scope.ownerId),
          newOwner = next.get(scope.ownerId);
        requireCompatible(
          oldOwner && newOwner,
          `Missing shared budget owner: ${scope.ownerId}`,
        );
        const oldPolicy = policyFor(oldOwner, scope),
          newPolicy = policyFor(newOwner, scope);
        const key = JSON.stringify([scope.scopeId, scope.ownerId]);
        const policies = canonical([oldPolicy ?? null, newPolicy ?? null]);
        requireCompatible(
          !checkedScopes.has(key) || checkedScopes.get(key) === policies,
          "Conflicting shared budget policies.",
        );
        if (checkedScopes.has(key)) continue;
        checkedScopes.set(key, policies);
        if (newPolicy) assertBudgetPolicy(newPolicy);
        requireCompatible(
          !oldPolicy || newPolicy?.id === oldPolicy.id,
          "A behavior revision cannot remove or replace a bound budget identity.",
        );
        if (scope.pending) {
          requireCompatible(
            target.snapshot.caseBudgetPending === true &&
              target.snapshot.workBudgetBinding?.scopeId === scope.scopeId,
            "Only the actual pending initial scope may lack its ledger.",
          );
        }
        if (!oldPolicy && !newPolicy) continue;
        requireCompatible(
          target.budget,
          "The retained budget requires its durable reader.",
        );
        // snapshot with the prior policy refuses a missing/stale ledger, without
        // appending an adoption event or changing consumption/reservations.
        let view;
        try {
          view = await target.budget.snapshot(
            scope.scopeId,
            scope.ownerId,
            oldPolicy,
          );
        } catch (error) {
          if (
            scope.pending && error instanceof WorkBudgetError &&
            error.code === "missing-state"
          ) continue;
          throw error;
        }
        requireCompatible(
          view && newPolicy && view.budgetId === newPolicy.id,
          "The retained budget ledger is missing or rebound.",
        );
        requireCompatible(
          newPolicy.limit >= view.consumed + view.reserved,
          "The proposed budget is below consumed and reserved work.",
        );
        result.budgets.push({
          scopeId: scope.scopeId,
          ownerId: scope.ownerId,
          consumed: view.consumed,
          reserved: view.reserved,
          nextLimit: newPolicy.limit,
        });
      }
    }
    if (categories.has("memory")) {
      requireCompatible(
        target.memoryRecords && target.memoryAuditAt,
        "Memory policy changes require the retained read-only note audit.",
      );
      requireCompatible(
        !previous.memoryPolicy ||
          candidate.memoryPolicy?.ownerId === previous.memoryPolicy.ownerId,
        "Memory policy owner and retained notes cannot be replaced.",
      );
      const unavailableGuidanceIds: string[] = [];
      for (const record of target.memoryRecords) {
        requireCompatible(
          record.ownerId === id,
          "The memory audit includes another operator's private notes.",
        );
        const policy = candidate.memoryPolicy;
        const view = memoryView(
          record,
          target.memoryAuditAt,
          policy
            ? {
              ...policy,
              modelVersion: {
                digest: candidate.version.digest,
                repositoryVersion: candidate.version.repositoryVersion ?? "",
              },
              permissions: {},
            }
            : undefined,
        );
        if (
          !policy || !view.usableAsGuidance ||
          target.admittedDecisionContext &&
            !candidateContext?.memoryGuidance?.some((guidance) =>
              guidance.id === record.id
            )
        ) {
          unavailableGuidanceIds.push(record.id);
        }
      }
      result.memory.push({
        operatorNativeId: id,
        preservedNoteIds: target.memoryRecords.map((record) => record.id),
        unavailableGuidanceIds,
      });
    }
    if (
      candidate.contextPolicy && (categories.size > 0 || consumers.includes(id))
    ) {
      const context = candidateContext;
      requireCompatible(
        context && !context.contextEvidence,
        "Compatibility requires the complete unprojected runtime decision payload.",
      );
      requireCompatible(
        same(context.messages, caseMessages(target.snapshot)),
        "The candidate payload must retain the complete current journal.",
      );
      requireCompatible(
        context.modelVersion?.digest === candidate.version.digest &&
          context.modelVersion.repositoryVersion ===
            candidate.version.repositoryVersion &&
          context.admittedModelVersion?.digest === candidate.version.digest &&
          context.admittedModelVersion.repositoryVersion ===
            candidate.version.repositoryVersion,
        "The complete candidate decision payload has another model pin.",
      );
      requireCompatible(
        same(context.executionPolicy, candidate.policy) &&
          same(context.contracts, candidate.contracts) &&
          context.operator?.instruction === candidate.operator?.instruction,
        "The candidate payload omits changed executable settings.",
      );
      const {
        kind,
        pattern,
        recentMessages,
        maxMessageCharacters,
        maxCollectionItems,
        maxContextCharacters,
      } = candidate.contextPolicy;
      const projected = await projectDecisionContext(context, {
        kind,
        pattern,
        recentMessages,
        maxMessageCharacters,
        maxCollectionItems,
        maxContextCharacters,
      });
      result.context.push({
        operatorNativeId: id,
        projectedCharacters: JSON.stringify(projected).length,
      });
    }
  }
  return result;
}
