/** Trusted evidence collection; this does not alter any executable digest. */
import type { ExecutableModel } from "../../../../../../../domain/model/execution/executable-model.ts";
import type { EvolutionCompilationEvidence } from "../../../../../../../domain/model/evolution/semantic-effects.ts";
import {
  type EvolutionCategory,
  requireEvolution,
} from "../../../../../../../domain/model/evolution/policy.ts";
import { executionDigest } from "../../../../../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../../../../../domain/primitives/canonical-json.ts";
import { compileBehaviorDeclarationProvenance } from "../../../work/behavior-catalog.ts";
import { projectSourceGraph } from "../../../../../../../domain/model/projections/source-graph.ts";
import { sourceValues } from "../../../../graph/values/source-values.ts";
import {
  sourceLiterals,
  sourceRefs,
  sourceSnapshot,
} from "../../../../../../../domain/model/projections/source-facts.ts";
import {
  compileSelectedOperatorFlow,
  operatorFlowSemantics,
  resolveNativeActionBaseIds,
} from "../../../work/operator-flow.ts";

export async function createEvolutionCompilationEvidence(
  model: ExecutableModel,
  digestInputs: Record<string, unknown>[],
  elements: Record<string, unknown>[],
): Promise<EvolutionCompilationEvidence> {
  requireEvolution(
    digestInputs.length > 0,
    "Missing base compiler digest evidence",
  );
  let digest: string | undefined;
  for (const [index, input] of digestInputs.entries()) {
    requireEvolution(
      index === 0 || input.base === digest,
      "Incomplete compiler digest evidence chain",
    );
    digest = await executionDigest(input);
  }
  requireEvolution(
    digest === model.version.digest,
    "Compiler evidence does not reproduce admitted digest",
  );
  const snapshot = sourceSnapshot(elements, model.identity.rootId);
  const raw = new Map(
    elements.map((element) => [String(element["@id"]), element]),
  );
  requireEvolution(
    raw.size === elements.length,
    "Duplicate source evidence identity",
  );
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const literals = sourceLiterals(elements), values = sourceValues(elements);
  const categories: Record<string, EvolutionCategory> = {};
  const sourceFlowRoots: Record<string, string[]> = {};
  let activeFlowRoot: string | undefined;
  const templateFlow = model.operatorFlowTemplate
    ? compileSelectedOperatorFlow(
      snapshot,
      projectSourceGraph(elements, model.identity),
      literals,
      model.identity.systemId,
      "operatorFlowTemplate",
      model.policy.maxFlowSteps,
      resolveNativeActionBaseIds(elements),
    ).flow
    : undefined;
  if (templateFlow) {
    requireEvolution(
      await executionDigest(
        operatorFlowSemantics({ template: templateFlow }),
      ) === model.operatorFlowTemplate!.digest,
      "Creator template graph differs from its admitted digest",
    );
  }
  // Index every owner once per collection. A fact can have multiple owners;
  // duplicate references must not duplicate that child within an owner's list.
  const childrenByOwner = new Map<string, string[]>();
  for (const element of elements) {
    const childId = String(element["@id"]);
    for (const owner of new Set(sourceRefs(element.owner))) {
      const children = childrenByOwner.get(owner);
      if (children) children.push(childId);
      else childrenByOwner.set(owner, [childId]);
    }
  }
  const ids = new Set(model.version.sourceIds);
  const includeDescendants = (root: string) => {
    const pending = [root], seen = new Set<string>();
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const id = pending[cursor]!;
      if (seen.has(id)) continue;
      seen.add(id);
      const element = byId.get(id);
      if (
        id !== root &&
        element?.typeIds.some((typeId) =>
          byId.get(typeId)?.qualifiedName ===
            "AssemblyLiveBuilder::ConversationSystem"
        )
      ) continue;
      ids.add(id);
      for (const childId of childrenByOwner.get(id) ?? []) {
        pending.push(childId);
      }
    }
  };
  includeDescendants(model.identity.systemId);
  const assign = (id: string, category: EvolutionCategory) => {
    if (!raw.has(id)) return;
    requireEvolution(
      !categories[id] || categories[id] === category,
      "Ambiguous native evolution category",
    );
    categories[id] = category;
    if (category === "flow" && activeFlowRoot) {
      sourceFlowRoots[id] = [
        ...new Set([...(sourceFlowRoots[id] ?? []), activeFlowRoot]),
      ].sort();
    }
    ids.add(id);
  };
  // Scalar ownership is exact. Types, holder, issuer and mandate bindings stay protected.
  const scalars = (
    owner: string | undefined,
    names: readonly string[],
    category: EvolutionCategory,
  ) => {
    if (!owner) return;
    for (
      const literal of literals.filter((literal) =>
        literal.owner === owner && names.includes(literal.name)
      )
    ) {
      assign(literal.attributeId, category);
      assign(literal.literalId, category);
      for (
        const ref of sourceRefs(raw.get(literal.attributeId)?.featureValue)
      ) {
        const expression = raw.get(ref);
        // Only the value wrapper, never an arbitrary referred native feature.
        if (expression?.["@type"] === "FeatureValue") assign(ref, category);
      }
    }
    for (
      const value of values.filter((value) =>
        value.owner === owner && names.includes(value.name)
      )
    ) {
      for (
        const id of [value.featureId, value.expressionId, value.featureValueId]
      ) if (id) assign(id, category);
    }
  };
  scalars(model.identity.systemId, ["operatorInstruction"], "instructions");
  activeFlowRoot = templateFlow?.rootNativeId;
  scalars(model.identity.systemId, ["operatorFlowTemplateRevision"], "flow");
  activeFlowRoot = undefined;
  const policyOwner = snapshot.elements.find((element) =>
    element.name === "executionPolicy" &&
    element.ownerId === model.flows.conversation.rootNativeId
  )?.id;
  scalars(policyOwner, [
    "maxAgentDecisions",
    "maxToolProposals",
    "maxFlowSteps",
  ], "budgets");
  scalars(model.workBudgetPolicy?.elementId, ["limit", "revision"], "budgets");
  scalars(model.contextPolicy?.elementId, [
    "recentMessages",
    "maxMessageCharacters",
    "maxCollectionItems",
    "maxContextCharacters",
    "revision",
  ], "context");
  scalars(model.memoryPolicy?.elementId, [
    "allowedScopes",
    "maxValidityMs",
    "requireSourceRefs",
    "requireKnownOutcome",
    "allowSelfAdmission",
    "revision",
  ], "memory");
  const behaviorReferences: { id: string; root: string }[] = [];
  for (const type of model.caseTypes ?? []) {
    scalars(type.id, ["maxInvocations"], "budgets");
    // Case identity and scheduling do not follow a flow grant.
    const behavior = snapshot.elements.find((element) =>
      element.ownerId === type.id && element.name === "behavior"
    );
    if (behavior) {
      activeFlowRoot = type.behaviorId;
      assign(behavior.id, "flow");
      for (
        const value of values.filter((value) =>
          value.owner === type.id && value.name === "behavior"
        )
      ) {
        for (
          const id of [
            value.featureId,
            value.expressionId,
            value.featureValueId,
          ]
        ) {
          if (id) {
            assign(id, "flow");
            behaviorReferences.push({ id, root: type.behaviorId });
          }
        }
      }
      activeFlowRoot = undefined;
    }
  }
  const subtree = (
    root: string,
    category: EvolutionCategory,
    allowed?: Set<string>,
  ) => {
    const queue = [root], seen = new Set<string>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]!;
      if (seen.has(id)) continue;
      seen.add(id);
      const element = raw.get(id);
      if (!element || allowed && !allowed.has(String(element["@type"]))) {
        continue;
      }
      // The execution policy is independently categorized, including its value wrappers.
      if (byId.get(id)?.name === "executionPolicy") continue;
      assign(id, category);
      for (const childId of childrenByOwner.get(id) ?? []) {
        queue.push(childId);
      }
    }
    return seen;
  };
  const flowKinds = new Set([
    "ActionDefinition",
    "PerformActionUsage",
    "ActionUsage",
    "DecisionNode",
    "MergeNode",
    "ReferenceUsage",
    "SuccessionAsUsage",
    "SuccessionUsage",
    "BindingConnectorAsUsage",
    "AllocationUsage",
    "AllocationDefinition",
    "AllocationUsage",
    "FeatureMembership",
    "OwningMembership",
    "ParameterMembership",
    "EndFeatureMembership",
    "ReturnParameterMembership",
    "FeatureValue",
    "AttributeUsage",
    "ItemUsage",
    "LiteralBoolean",
    "LiteralInteger",
    "LiteralString",
    "OperatorExpression",
    "FeatureReferenceExpression",
    "InvocationExpression",
    "FeatureChainExpression",
    "ConstraintUsage",
    "AssertConstraintUsage",
    "FlowConnectionUsage",
    "ItemFlowEnd",
    "ItemFlowFeature",
    "ReferenceSubsetting",
    "FeatureTyping",
    "Subclassification",
    "Redefinition",
    "FeatureChaining",
  ]);
  // These synthetic supports are flow facts only underneath an exact compiled
  // behavior expression or action allocation end. Never follow their reference
  // targets into performer declarations, mandates, policies or unrelated parts.
  const flowReferenceKinds = new Set([
    "FeatureReferenceExpression",
    "BindingConnector",
    "ReferenceUsage",
    "Feature",
    "FeatureChaining",
    "ReferenceSubsetting",
    "FeatureTyping",
    "Subsetting",
    "OwningMembership",
    "FeatureMembership",
    "EndFeatureMembership",
  ]);
  for (const reference of behaviorReferences) {
    activeFlowRoot = reference.root;
    subtree(reference.id, "flow", flowReferenceKinds);
    activeFlowRoot = undefined;
  }
  for (
    const flow of [
      ...Object.values(model.flows),
      ...Object.values(model.caseFlows ?? {}),
      ...(templateFlow ? [templateFlow] : []),
    ]
  ) {
    activeFlowRoot = flow.rootNativeId;
    subtree(flow.rootNativeId, "flow", flowKinds);
    for (const typeId of byId.get(flow.rootNativeId)?.typeIds ?? []) {
      subtree(typeId, "flow", flowKinds);
    }
    for (const node of flow.nodes) {
      if (node.allocationId) {
        assign(node.allocationId, "flow");
        const allocation = raw.get(node.allocationId);
        const connector = snapshot.connectors.find((entry) =>
          entry.id === node.allocationId
        );
        const endIds = sourceRefs(allocation?.connectorEnd);
        // Enrich only a positively recognized native representation. Older or
        // unsupported forms retain their previous protected support facts.
        if (
          allocation?.["@type"] === "AllocationUsage" && connector &&
          connector.ownerId === model.identity.systemId &&
          endIds.length === 2 && connector.ends.length === 2 &&
          node.performerId
        ) {
          const actionEnds = connector.ends.flatMap((end, index) => {
            const chain = end.chain.map((link) => link.id);
            return chain.length === 2 && chain[0] === flow.rootNativeId &&
                  chain[1] === node.nativeId ||
                chain.length === 1 && chain[0] === node.nativeId
              ? [index]
              : [];
          });
          if (actionEnds.length === 1) {
            const role = connector.ends[1 - actionEnds[0]!]!.chain;
            if (role.length === 1) {
              requireEvolution(
                role[0]!.id === node.performerId,
                "Native allocation endpoints differ from the compiled action",
              );
              // The performer side stays protected, including another local
              // part with the same role type. No role authority follows a flow.
              subtree(endIds[actionEnds[0]!]!, "flow", flowReferenceKinds);
            }
          }
        }
      }
      for (const assertion of node.assertions) {
        for (
          const id of [assertion.nativeId, ...assertion.expressionSourceIds]
        ) assign(id, "flow");
      }
    }
    for (const edge of flow.edges) {
      for (const id of [edge.nativeId, ...edge.guardIds]) {
        assign(id, "flow");
      }
    }
    for (const binding of flow.bindings) assign(binding.nativeId, "flow");
    activeFlowRoot = undefined;
  }
  for (const contract of model.contracts) {
    includeDescendants(contract.nativeId);
    assign(contract.nativeId, "contracts");
    scalars(
      contract.nativeId,
      ["kind", "module", "acceptanceCriteria"],
      "contracts",
    );
  }
  const declarations = compileBehaviorDeclarationProvenance({
    version: model.version.repositoryVersion ?? "evolution-evidence",
    sources: {},
    elements,
  }, model.identity);
  requireEvolution(
    canonical(
      declarations.filter((entry) => entry.enabled).map((
        { enabled: _enabled, ...contract },
      ) => contract),
    ) === canonical(model.behaviors ?? []),
    "Behavior declaration provenance differs from the callable catalog",
  );
  const behaviorDeclarations = declarations.map((behavior) => {
    // Retain referenced declarations on both sides even when the callable
    // catalog stops contributing their IDs. They remain protected unless an
    // exact owned access/input subtree below independently categorizes them.
    for (const id of behavior.sourceIds) ids.add(id);
    const accessIds = subtree(behavior.id, "contracts");
    includeDescendants(behavior.inputTypeId);
    const inputIds = subtree(behavior.inputTypeId, "contracts");
    return {
      ...behavior,
      sourceIds: [
        ...new Set([
          ...behavior.sourceIds,
          ...accessIds,
          ...inputIds,
        ]),
      ].sort(),
    };
  });
  for (const contract of model.workResultContracts ?? []) {
    for (
      const id of [
        contract.id,
        contract.input?.typeId,
        contract.expected.typeId,
        contract.observed.typeId,
        contract.query?.typeId,
        contract.condition.nativeId,
      ]
    ) {
      if (id) subtree(id, "contracts");
    }
    for (const id of contract.condition.sourceIds) assign(id, "contracts");
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const element of elements) {
      if (
        ![
          "OwningMembership",
          "FeatureMembership",
          "ParameterMembership",
          "ReturnParameterMembership",
          "EndFeatureMembership",
        ].includes(String(element["@type"]))
      ) continue;
      const members = [
        ...sourceRefs(element.memberElement),
        ...sourceRefs(element.ownedMemberElement),
      ];
      const memberCategories = [
        ...new Set(members.map((id) => categories[id]).filter(Boolean)),
      ];
      if (members.length === 1 && memberCategories.length === 1) {
        const id = String(element["@id"]);
        assign(id, memberCategories[0]!);
        if (sourceFlowRoots[members[0]!]) {
          sourceFlowRoots[id] = [...sourceFlowRoots[members[0]!]!];
        }
      }
    }
  }
  const sourceFacts: Record<string, unknown> = {};
  // An unresolved source ID is evidence too: disappearance cannot pass silently.
  for (const id of [...ids].sort()) {
    const fact = raw.get(id) ?? { missingNativeFact: id };
    if (
      !categories[id] && fact && typeof fact === "object" &&
      !Array.isArray(fact)
    ) {
      // The native normalizer records whole-container source extents for
      // editing/readback. A child's admitted scalar edit changes these text
      // copies on its PartUsage and Package ancestors, including a shared
      // package used by an unaffected operator. Typed facts and separately
      // derived flags remain protected. Transition source text is deliberately
      // excluded: the native normalizer uses it to establish branch semantics.
      if (
        ["PartUsage", "Package"].includes(
          String((fact as Record<string, unknown>)["@type"]),
        )
      ) {
        const normalized = { ...(fact as Record<string, unknown>) };
        delete normalized["sysx:sourceText"];
        sourceFacts[id] = normalized;
        continue;
      }
    }
    sourceFacts[id] = fact;
  }
  return {
    digestInputs: structuredClone(digestInputs),
    sourceFacts: structuredClone(sourceFacts),
    sourceCategories: categories,
    behaviorDeclarations,
    sourceFlowRoots,
    ...(templateFlow ? { templateFlow } : {}),
  };
}
