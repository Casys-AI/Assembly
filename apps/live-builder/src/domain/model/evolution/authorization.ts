/** Prior authority is captured independently for every act and exact proposal. */
import type { ExecutableModel } from "../execution/executable-model.ts";
import type { CompiledFlow } from "../execution/flow.ts";
import type {
  EvolutionEffect,
  ScopedExecutableModel,
} from "./semantic-effects.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { executionDigest } from "../../primitives/execution-digest.ts";
import {
  type EvolutionAct,
  type EvolutionAuthorityExercise,
  type EvolutionCategory,
  type EvolutionGrant,
  evolutionIdentity,
  type NativeEvolutionPolicy,
  type NumericEnvelope,
  parseEvolutionGrants,
  requireEvolution,
} from "./policy.ts";

type AuthorityInput = {
  act: EvolutionAct;
  systemQualifiedName: string;
  targets: string[];
  categories: EvolutionCategory[];
  proposalDigest: string;
  effects?: Pick<EvolutionEffect, "targetNativeId" | "category">[];
};
function policyFor(model: ExecutableModel): NativeEvolutionPolicy {
  const policy = model.evolutionPolicy;
  requireEvolution(
    policy && policy.holderNativeId === model.identity.builderId &&
      policy.mandateId === model.mandate.id &&
      policy.mandateRevision === model.configuration.builder.mandateRevision &&
      policy.rootAuthority?.ownerSource === "modeled",
    "No current explicit evolution mandate for this operator",
  );
  // Also reject malformed in-memory/imported contracts before a receipt is issued.
  parseEvolutionGrants(JSON.stringify(policy.grants));
  return policy;
}
export async function createEvolutionAuthorityExercise(
  model: ExecutableModel,
  input: AuthorityInput,
): Promise<EvolutionAuthorityExercise> {
  const policy = policyFor(model);
  requireEvolution(
    evolutionIdentity(input.proposalDigest) && input.targets.length > 0 &&
      input.categories.length > 0 &&
      new Set(input.targets).size === input.targets.length &&
      new Set(input.categories).size === input.categories.length,
    "Missing exact evolution subject",
  );
  const pairs = input.effects ??
    input.targets.flatMap((targetNativeId) =>
      input.categories.map((category) => ({ targetNativeId, category }))
    );
  requireEvolution(
    pairs.length > 0 &&
      pairs.every((pair) =>
        input.targets.includes(pair.targetNativeId) &&
        input.categories.includes(pair.category)
      ),
    "Evolution receipt omits an affected subject",
  );
  requireEvolution(
    input.targets.every((target) =>
      pairs.some((pair) => pair.targetNativeId === target)
    ) && input.categories.every((category) =>
      pairs.some((pair) =>
        pair.category === category
      )
    ),
    "Evolution receipt contains an unbound subject",
  );
  for (const pair of pairs) {
    requireEvolution(
      policy.grants.some((grant) =>
        grant.act === input.act &&
        grant.targetNativeId === pair.targetNativeId &&
        grant.category === pair.category
      ),
      `Missing ${input.act} grant for ${pair.targetNativeId}/${pair.category}`,
    );
  }
  return {
    act: input.act,
    operatorNativeId: model.identity.builderId,
    systemQualifiedName: input.systemQualifiedName,
    authorityDigest: await executionDigest(policy),
    policyId: policy.id,
    policyRevision: policy.revision,
    mandateNativeId: policy.mandateNativeId,
    mandateId: policy.mandateId,
    mandateRevision: policy.mandateRevision,
    targets: [...input.targets].sort(),
    categories: [...input.categories].sort(),
    proposalDigest: input.proposalDigest,
  };
}
export async function revalidateEvolutionAuthorityExercise(
  model: ExecutableModel,
  exercise: EvolutionAuthorityExercise,
  effects?: Pick<EvolutionEffect, "targetNativeId" | "category">[],
): Promise<void> {
  const expected = await createEvolutionAuthorityExercise(model, {
    ...exercise,
    effects,
  });
  requireEvolution(
    canonical(expected) === canonical(exercise),
    "Evolution authority changed or receipt does not match its exact subject",
  );
}
function changed(a: unknown, b: unknown): boolean {
  return canonical(a ?? null) !== canonical(b ?? null);
}
function within(value: unknown, bound: NumericEnvelope | undefined): void {
  requireEvolution(
    bound && typeof value === "number" && Number.isSafeInteger(value) &&
      value >= bound.min && value <= bound.max,
    "Evolution value exceeds its prior field envelope",
  );
}
function flowSemantics(value: unknown): unknown {
  const flow = structuredClone(value) as Record<string, unknown>;
  delete flow.maxSteps;
  return flow;
}
/** Bounds are checked against complete compiled consumers, never agent-declared effects. */
export function requireEvolutionEffectBounds(
  actor: ExecutableModel,
  act: EvolutionAct,
  effects: readonly EvolutionEffect[],
  before: readonly ScopedExecutableModel[],
  after: readonly ScopedExecutableModel[],
): void {
  const policy = policyFor(actor);
  for (const effect of effects) {
    const grant = policy.grants.find((grant) =>
      grant.act === act && grant.targetNativeId === effect.targetNativeId &&
      grant.category === effect.category
    );
    requireEvolution(grant, `Missing ${act} evolution category grant`);
    const oldScope = before.find((scope) =>
      scope.model.identity.builderId === effect.targetNativeId
    );
    const nextScope = after.find((scope) =>
      scope.model.identity.builderId === effect.targetNativeId
    );
    const a = oldScope?.model, b = nextScope?.model;
    requireEvolution(a && b, "Missing affected native consumer");
    if (grant.category === "flow") {
      const ids = new Set([
        ...Object.keys(oldScope!.evidence.sourceFacts),
        ...Object.keys(nextScope!.evidence.sourceFacts),
      ]);
      for (const id of ids) {
        if (
          oldScope!.evidence.sourceCategories[id] !== "flow" &&
          nextScope!.evidence.sourceCategories[id] !== "flow"
        ) continue;
        if (
          !changed(
            oldScope!.evidence.sourceFacts[id],
            nextScope!.evidence.sourceFacts[id],
          )
        ) continue;
        const roots = [
          ...new Set([
            ...(oldScope!.evidence.sourceFlowRoots?.[id] ?? []),
            ...(nextScope!.evidence.sourceFlowRoots?.[id] ?? []),
          ]),
        ];
        requireEvolution(
          roots.length > 0 &&
            roots.every((root) => grant.bounds.rootNativeIds.includes(root)),
          "Native flow fact is outside its exact granted root",
        );
      }
    }
    if (grant.category === "contracts") {
      checkBehaviorDeclarationBounds(grant, oldScope!, nextScope!);
    }
    checkGrant(
      grant,
      a,
      b,
      oldScope?.evidence?.templateFlow,
      nextScope?.evidence?.templateFlow,
    );
  }
}
function checkBehaviorDeclarationBounds(
  grant: Extract<EvolutionGrant, { category: "contracts" }>,
  before: ScopedExecutableModel,
  after: ScopedExecutableModel,
): void {
  const a = before.evidence?.behaviorDeclarations;
  const b = after.evidence?.behaviorDeclarations;
  // Historical projections and test ports without declaration evidence still
  // undergo the existing callable-contract checks. Native assessment always
  // recompiles both sides with the trusted declaration collector.
  if (!a && !b) return;
  requireEvolution(a && b, "Incomplete behavior declaration provenance");
  for (const id of new Set([...a, ...b].map((entry) => entry.id))) {
    const old = a.find((entry) => entry.id === id);
    const next = b.find((entry) => entry.id === id);
    const sourceIds = new Set([
      ...old?.sourceIds ?? [],
      ...next?.sourceIds ?? [],
    ]);
    const nativeChanged = [...sourceIds].some((sourceId) =>
      (before.evidence.sourceCategories[sourceId] === "contracts" ||
        after.evidence.sourceCategories[sourceId] === "contracts") &&
      changed(
        before.evidence.sourceFacts[sourceId],
        after.evidence.sourceFacts[sourceId],
      )
    );
    if (!changed(old, next) && !nativeChanged) continue;
    requireEvolution(
      grant.bounds.contractNativeIds.includes(id),
      "Behavior declaration is outside its prior native scope",
    );
    // Check both ends, including disabled declarations. Disabling or removing
    // an exposure cannot erase the caller/target/input scope being exercised.
    for (const declaration of [old, next]) {
      if (!declaration) continue;
      requireEvolution(
        grant.bounds.inputTypeNativeIds.includes(declaration.inputTypeId),
        "Contract input type exceeds its prior scope",
      );
      requireEvolution(
        grant.bounds.allowedExposures.some((entry) =>
          entry.callerNativeId === declaration.callerNativeId &&
          entry.targetNativeId === declaration.targetNativeId &&
          entry.inputTypeId === declaration.inputTypeId
        ),
        "No prior explicit exposure authority for this caller/target/type",
      );
    }
  }
}
function checkGrant(
  grant: EvolutionGrant,
  a: ExecutableModel,
  b: ExecutableModel,
  oldTemplate?: CompiledFlow,
  nextTemplate?: CompiledFlow,
): void {
  switch (grant.category) {
    case "instructions":
      requireEvolution(
        !!b.operator?.instruction.trim() &&
          b.operator.instruction.length <= grant.bounds.maxCharacters,
        "Instruction exceeds its prior envelope",
      );
      break;
    case "flow": {
      const selectedRoots = new Set<string>();
      if (changed(a.operatorFlowTemplate, b.operatorFlowTemplate)) {
        requireEvolution(
          nextTemplate &&
            grant.bounds.rootNativeIds.includes(nextTemplate.rootNativeId),
          "Creator template is outside its exact granted root",
        );
        selectedRoots.add(nextTemplate.rootNativeId);
      }
      for (const type of b.caseTypes ?? []) {
        if (
          changed(
            a.caseTypes?.find((entry) => entry.id === type.id)?.behaviorId,
            type.behaviorId,
          )
        ) {
          requireEvolution(
            grant.bounds.rootNativeIds.includes(type.behaviorId),
            "Case behavior is outside its exact granted flow root",
          );
          selectedRoots.add(type.behaviorId);
        }
      }
      const oldFlows = {
          ...a.flows,
          ...a.caseFlows,
          ...(oldTemplate ? { operatorTemplate: oldTemplate } : {}),
        },
        nextFlows = {
          ...b.flows,
          ...b.caseFlows,
          ...(nextTemplate ? { operatorTemplate: nextTemplate } : {}),
        };
      requireEvolution(
        [...selectedRoots].every((root) =>
          Object.values(nextFlows).some((flow) => flow.rootNativeId === root)
        ),
        "Selected Case behavior has no supported compiled flow",
      );
      for (const [name, flow] of Object.entries(nextFlows)) {
        if (
          !selectedRoots.has(flow.rootNativeId) &&
          oldFlows[name as keyof typeof oldFlows] &&
          !changed(
            flowSemantics(oldFlows[name as keyof typeof oldFlows]),
            flowSemantics(flow),
          )
        ) continue;
        requireEvolution(
          grant.bounds.rootNativeIds.includes(flow.rootNativeId) &&
            flow.nodes.length <= grant.bounds.maxNodes &&
            flow.edges.length <= grant.bounds.maxEdges &&
            flow.nodes.every((node) =>
              !node.mechanism ||
              grant.bounds.allowedMechanisms.includes(node.mechanism)
            ),
          "Flow exceeds its prior native envelope",
        );
      }
      requireEvolution(
        Object.keys(oldFlows).every((name) => Object.hasOwn(nextFlows, name)),
        "Removing an executable flow is unsupported",
      );
      break;
    }
    case "budgets": {
      for (
        const key of [
          "maxAgentDecisions",
          "maxToolProposals",
          "maxFlowSteps",
        ] as const
      ) {
        if (changed(a.policy[key], b.policy[key])) {
          within(b.policy[key], grant.bounds.fields[key]);
        }
      }
      if (changed(a.workBudgetPolicy?.limit, b.workBudgetPolicy?.limit)) {
        within(b.workBudgetPolicy?.limit, grant.bounds.fields.workBudgetLimit);
      }
      for (const next of b.caseTypes ?? []) {
        const old = a.caseTypes?.find((entry) => entry.id === next.id);
        if (changed(old?.maxInvocations, next.maxInvocations)) {
          within(
            next.maxInvocations,
            grant.bounds.caseTypes.find((entry) => entry.caseTypeId === next.id)
              ?.limit,
          );
        }
      }
      break;
    }
    case "context": {
      requireEvolution(
        a.contextPolicy && b.contextPolicy,
        "Adding or removing a context policy is unsupported",
      );
      for (
        const key of [
          "recentMessages",
          "maxMessageCharacters",
          "maxCollectionItems",
          "maxContextCharacters",
        ] as const
      ) {
        if (changed(a.contextPolicy[key], b.contextPolicy[key])) {
          within(b.contextPolicy[key], grant.bounds.fields[key]);
        }
      }
      break;
    }
    case "memory": {
      requireEvolution(
        a.memoryPolicy && b.memoryPolicy,
        "Adding or removing a memory policy is unsupported",
      );
      if (changed(a.memoryPolicy.allowedScopes, b.memoryPolicy.allowedScopes)) {
        requireEvolution(
          grant.bounds.fields.allowedScopes &&
            b.memoryPolicy.allowedScopes.every((scope) =>
              grant.bounds.fields.allowedScopes!.includes(scope)
            ),
          "Memory scope exceeds its prior envelope",
        );
      }
      if (changed(a.memoryPolicy.maxValidityMs, b.memoryPolicy.maxValidityMs)) {
        within(b.memoryPolicy.maxValidityMs, grant.bounds.fields.maxValidityMs);
      }
      for (
        const key of [
          "requireSourceRefs",
          "requireKnownOutcome",
          "allowSelfAdmission",
        ] as const
      ) {
        if (changed(a.memoryPolicy[key], b.memoryPolicy[key])) {
          requireEvolution(
            grant.bounds.fields[key]?.includes(b.memoryPolicy[key]),
            "Memory review change exceeds its prior envelope",
          );
        }
      }
      break;
    }
    case "contracts": {
      const checkIdentities = <T>(
        old: readonly T[],
        next: readonly T[],
        id: (value: T) => string,
      ) => {
        for (const entry of [...old, ...next]) {
          const nativeId = id(entry);
          if (
            !changed(
              old.find((value) => id(value) === nativeId),
              next.find((value) => id(value) === nativeId),
            )
          ) continue;
          requireEvolution(
            grant.bounds.contractNativeIds.includes(nativeId),
            "Executable contract is outside its prior native scope",
          );
        }
      };
      checkIdentities(a.contracts, b.contracts, (entry) => entry.nativeId);
      checkIdentities(
        a.behaviors ?? [],
        b.behaviors ?? [],
        (entry) => entry.id,
      );
      checkIdentities(
        a.workResultContracts ?? [],
        b.workResultContracts ?? [],
        (entry) => entry.id,
      );
      for (const exposure of b.behaviors ?? []) {
        const old = a.behaviors?.find((entry) => entry.id === exposure.id);
        if (!changed(old, exposure)) continue;
        requireEvolution(
          grant.bounds.inputTypeNativeIds.includes(exposure.inputTypeId),
          "Contract input type exceeds its prior scope",
        );
        requireEvolution(
          grant.bounds.allowedExposures.some((entry) =>
            entry.callerNativeId === exposure.callerNativeId &&
            entry.targetNativeId === exposure.targetNativeId &&
            entry.inputTypeId === exposure.inputTypeId
          ),
          "No prior explicit exposure authority for this caller/target/type",
        );
      }
      for (const contract of b.workResultContracts ?? []) {
        if (
          !changed(
            a.workResultContracts?.find((entry) => entry.id === contract.id),
            contract,
          )
        ) continue;
        for (
          const typeId of [
            contract.input?.typeId,
            contract.expected.typeId,
            contract.observed.typeId,
            contract.query?.typeId,
          ]
        ) {
          if (typeId) {
            requireEvolution(
              grant.bounds.inputTypeNativeIds.includes(typeId),
              "Typed result contract exceeds its prior type scope",
            );
          }
        }
      }
      break;
    }
  }
}
