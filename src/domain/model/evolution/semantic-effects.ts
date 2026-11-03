import { persistedOrder } from "../../primitives/persisted-order.ts";
/** A closed projection of the actual compiler digest inputs and native facts. */
import type { ExecutableModel } from "../execution/executable-model.ts";
import type { CompiledFlow } from "../execution/flow.ts";
import type { NativeBehaviorContract } from "../execution/native-contracts.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { type EvolutionCategory, requireEvolution } from "./policy.ts";

/** Validated declaration evidence, including non-callable disabled accesses.
 * This is not part of the executable catalog or its historical digest. */
export interface EvolutionBehaviorDeclaration extends NativeBehaviorContract {
  enabled: boolean;
}
export interface EvolutionCompilationEvidence {
  /** Every exact input, in order, from the base compiler through its wrappers. */
  digestInputs: Record<string, unknown>[];
  /** Complete native facts, including facts the compiler does not classify. */
  sourceFacts: Record<string, unknown>;
  /** Assigned only by the trusted native evidence adapter. Unknown facts stay protected. */
  sourceCategories: Record<string, EvolutionCategory>;
  behaviorDeclarations?: EvolutionBehaviorDeclaration[];
  templateFlow?: CompiledFlow;
  sourceFlowRoots?: Record<string, string[]>;
}
export interface ScopedExecutableModel {
  systemQualifiedName: string;
  model: ExecutableModel;
  evidence: EvolutionCompilationEvidence;
}
export interface EvolutionEffect {
  targetNativeId: string;
  systemQualifiedName: string;
  category: EvolutionCategory;
  before: unknown;
  after: unknown;
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
interface EvolutionSemanticProjection {
  protected: unknown;
  categories: Partial<Record<EvolutionCategory, unknown[]>>;
}
/** Also used for grant-bound evaluation; no field path supplied by an agent. */
function projectEvolutionSemantics(
  scope: ScopedExecutableModel,
): EvolutionSemanticProjection {
  const categories: Partial<Record<EvolutionCategory, unknown[]>> = {};
  const take = (
    owner: ObjectValue,
    key: string,
    category: EvolutionCategory,
    path: string,
  ) => {
    if (!Object.hasOwn(owner, key)) return;
    (categories[category] ??= []).push({
      path: `${path}.${key}`,
      value: owner[key],
    });
    owner[key] = { evolutionCategory: category };
  };
  const sourceIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sourceIds);
    if (!object(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map((
        [key, entry],
      ) => [
        key,
        key === "sourceIds" && Array.isArray(entry)
          ? entry.filter((id) =>
            typeof id !== "string" || !scope.evidence.sourceCategories[id]
          )
          : sourceIds(entry),
      ]),
    );
  };
  const visit = (value: unknown, path: string): void => {
    if (!object(value)) return;
    if (object(value.operator)) {
      take(value.operator, "instruction", "instructions", `${path}.operator`);
    }
    if (object(value.policy)) {
      for (
        const key of ["maxAgentDecisions", "maxToolProposals", "maxFlowSteps"]
      ) take(value.policy, key, "budgets", `${path}.policy`);
    }
    for (const key of ["flows", "caseFlows"]) {
      if (!object(value[key])) continue;
      for (const [name, flow] of Object.entries(value[key])) {
        if (object(flow)) {
          take(flow, "maxSteps", "budgets", `${path}.${key}.${name}`);
        }
      }
      take(value, key, "flow", path);
    }
    take(value, "allocations", "flow", path);
    if (object(value.operatorFlowTemplate)) {
      requireEvolution(
        scope.evidence.templateFlow,
        "Missing exact creator-template evidence",
      );
      // Independently reproduced by the trusted collector from templateFlow.
      // Its maxSteps changes are budget effects, as for ordinary flows.
      delete value.operatorFlowTemplate.digest;
      take(value, "operatorFlowTemplate", "flow", path);
    }
    if (object(value.workBudgetPolicy)) {
      take(
        value.workBudgetPolicy,
        "limit",
        "budgets",
        `${path}.workBudgetPolicy`,
      );
      take(
        value.workBudgetPolicy,
        "revision",
        "budgets",
        `${path}.workBudgetPolicy`,
      );
    }
    if (object(value.contextPolicy)) {
      for (
        const key of [
          "recentMessages",
          "maxMessageCharacters",
          "maxCollectionItems",
          "maxContextCharacters",
          "revision",
        ]
      ) take(value.contextPolicy, key, "context", `${path}.contextPolicy`);
    }
    if (object(value.memoryPolicy)) {
      for (
        const key of [
          "allowedScopes",
          "maxValidityMs",
          "requireSourceRefs",
          "requireKnownOutcome",
          "allowSelfAdmission",
          "revision",
        ]
      ) take(value.memoryPolicy, key, "memory", `${path}.memoryPolicy`);
    }
    for (const key of ["contracts", "behaviors", "workResultContracts"]) {
      take(value, key, "contracts", path);
    }
    if (Array.isArray(value.caseTypes)) {
      for (const entry of value.caseTypes) {
        if (!object(entry)) continue;
        take(
          entry,
          "maxInvocations",
          "budgets",
          `${path}.caseTypes.${String(entry.id)}`,
        );
        take(
          entry,
          "behaviorId",
          "flow",
          `${path}.caseTypes.${String(entry.id)}`,
        );
      }
    }
    if (object(value.information)) {
      visit(value.information, `${path}.information`);
    }
  };
  const rawInputs = structuredClone(scope.evidence.digestInputs);
  requireEvolution(rawInputs.length > 0, "Missing exact compiler evidence");
  const inputs: ObjectValue[] = [];
  let semanticInputIndex = 0;
  rawInputs.forEach((input, index) => {
    if (index > 0) {
      requireEvolution(
        typeof input.base === "string",
        "Missing compiler digest chain",
      );
      input.base = "verified-previous-digest";
    }
    // The compiler omits this exact wrapper when the last callable exposure is
    // disabled. Its complete original bytes were verified by the collector;
    // it carries only contracts, so absence does not alter protected settings.
    // Unknown wrapper fields remain protected and are never discarded here.
    if (
      index > 0 && Object.keys(input).sort().join(",") === "base,behaviors" &&
      Array.isArray(input.behaviors)
    ) {
      visit(input, "digest.behaviorCatalog");
      return;
    }
    visit(input, `digest.${semanticInputIndex++}`);
    inputs.push(input);
  });
  if (scope.evidence.templateFlow) {
    visit(
      { flows: { template: structuredClone(scope.evidence.templateFlow) } },
      "templateEvidence",
    );
  }
  // Compare the complete final model too: derived, non-hashed fields are not a loophole.
  const model = structuredClone(scope.model) as unknown as ObjectValue;
  model.behaviors ??= [];
  visit(model, "model");
  delete model.version;
  const facts: ObjectValue = {};
  for (const [id, fact] of Object.entries(scope.evidence.sourceFacts)) {
    const category = scope.evidence.sourceCategories[id];
    if (category) {
      (categories[category] ??= []).push({ path: `native.${id}`, value: fact });
    } else {
      const normalized = structuredClone(fact);
      if (object(normalized)) {
        // The native normalizer records whole-container source extents for
        // editing/readback. A child's admitted scalar edit changes these text
        // copies on its PartUsage and Package ancestors, including a shared
        // package used by an unaffected operator. Typed facts and separately
        // derived flags remain protected. Transition source text is deliberately
        // excluded: the native normalizer uses it to establish branch semantics.
        if (["PartUsage", "Package"].includes(String(normalized["@type"]))) {
          delete normalized["sysx:sourceText"];
        }
        for (
          const key of [
            "ownedMember",
            "ownedMembership",
            "ownedRelationship",
            "ownedFeature",
            "ownedFeatureMembership",
          ]
        ) {
          if (!Array.isArray(normalized[key])) continue;
          normalized[key] = normalized[key].filter((reference) => {
            const childId = typeof reference === "string"
              ? reference
              : object(reference)
              ? reference["@id"]
              : undefined;
            return typeof childId !== "string" ||
              !scope.evidence.sourceCategories[childId];
          });
        }
      }
      facts[id] = normalized;
    }
  }
  return { protected: sourceIds({ inputs, model, facts }), categories };
}

/** Preserve equal raw ownership lists when only their classification changed. */
export function projectEvolutionSemanticsPair(
  before: ScopedExecutableModel,
  after: ScopedExecutableModel,
): [EvolutionSemanticProjection, EvolutionSemanticProjection] {
  const a = projectEvolutionSemantics(before);
  const b = projectEvolutionSemantics(after);
  if (!object(a.protected) || !object(b.protected)) return [a, b];
  const aFacts = a.protected.facts, bFacts = b.protected.facts;
  if (!object(aFacts) || !object(bFacts)) return [a, b];
  for (const id of Object.keys(aFacts)) {
    const aFact = aFacts[id], bFact = bFacts[id];
    const aRaw = before.evidence.sourceFacts[id];
    const bRaw = after.evidence.sourceFacts[id];
    if (!object(aFact) || !object(bFact) || !object(aRaw) || !object(bRaw)) {
      continue;
    }
    for (
      const key of [
        "ownedMember",
        "ownedMembership",
        "ownedRelationship",
        "ownedFeature",
        "ownedFeatureMembership",
      ]
    ) {
      if (
        Object.hasOwn(aRaw, key) && Object.hasOwn(bRaw, key) &&
        Array.isArray(aRaw[key]) && Array.isArray(bRaw[key]) &&
        canonical(aRaw[key]) === canonical(bRaw[key])
      ) {
        aFact[key] = structuredClone(aRaw[key]);
        bFact[key] = structuredClone(bRaw[key]);
      }
    }
  }
  return [a, b];
}

/** Every consumer is compiled and compared; unidentified effects fail closed. */
export function classifyEvolutionEffects(
  before: readonly ScopedExecutableModel[],
  after: readonly ScopedExecutableModel[],
): EvolutionEffect[] {
  const map = (scopes: readonly ScopedExecutableModel[]) => {
    const result = new Map(
      scopes.map((scope) => [scope.model.identity.builderId, scope]),
    );
    requireEvolution(
      result.size === scopes.length && result.size > 0,
      "Ambiguous evolution target identities",
    );
    return result;
  };
  const previous = map(before), next = map(after);
  requireEvolution(
    previous.size === next.size &&
      [...previous.keys()].every((id) => next.has(id)),
    "Evolution cannot create, remove or replace an operator",
  );
  const effects: EvolutionEffect[] = [];
  for (const [targetNativeId, old] of previous) {
    const current = next.get(targetNativeId)!;
    requireEvolution(
      current.systemQualifiedName === old.systemQualifiedName,
      "Evolution cannot rename its target",
    );
    const [a, b] = projectEvolutionSemanticsPair(old, current);
    requireEvolution(
      canonical(a.protected) === canonical(b.protected),
      `Protected or unclassified executable effect on ${old.systemQualifiedName}`,
    );
    const categories = new Set(
      [
        ...Object.keys(a.categories),
        ...Object.keys(b.categories),
      ] as EvolutionCategory[],
    );
    for (const category of categories) {
      if (
        canonical(a.categories[category] ?? []) ===
          canonical(b.categories[category] ?? [])
      ) continue;
      effects.push({
        targetNativeId,
        systemQualifiedName: old.systemQualifiedName,
        category,
        before: a.categories[category] ?? [],
        after: b.categories[category] ?? [],
      });
    }
  }
  return effects.sort((a, b) =>
    persistedOrder(a.targetNativeId, b.targetNativeId) ||
    persistedOrder(a.category, b.category)
  );
}
