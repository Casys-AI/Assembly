/** Native SysML facts projected into the existing read-only house viewer. */
import type { ModelIdentity } from "../../../../domain/work/dialogue.ts";
import type {
  MandateAnnotation,
  OperatorAnnotation,
} from "../../../../domain/governance/mandates.ts";
import type {
  ConnectorEnd,
  ConnectorRecord,
  ElementRecord,
  ModelSnapshot,
} from "../../../../domain/model/records/snapshot.ts";
import {
  buildModelGraph,
  type ModelGraphData,
  type ModelGraphNode,
  type NativeRelation,
} from "../../../../domain/model/projections/graph.ts";
import {
  type NativeViewExposure,
  type NativeViewRecord,
  projectNativeViews,
} from "../../../../domain/model/projections/native-views.ts";
import type { NativeLiteral } from "../../../out/sysml-toolkit/compilation-policies/work/execution-model.ts";
import { sourceMultiplicityReader } from "../../sources/values/multiplicity.ts";
import {
  sourceExpressionReader,
  type SourceValueEntry,
  valueRefs,
} from "../../sources/values/expressions.ts";
import {
  type NativeSequence,
  projectSourceSequences,
} from "../../../../domain/model/projections/sequence.ts";

type ObjectValue = Record<string, unknown>;

export interface SourceGraph extends Omit<ModelGraphData, "nodes"> {
  nodes: Array<
    ModelGraphNode & {
      modelStage?: string;
      operator?: OperatorAnnotation;
      mandate?: MandateAnnotation;
      expression?: string;
      expressionSourceIds?: string[];
      /** Reusable native definition scaffold, never a live state observation. */
      prototype?: true;
      observedState?: boolean;
      definitionOwnerId?: string;
      inheritedFromDefinitionId?: string;
    }
  >;
  views: ReturnType<typeof projectNativeViews>["views"];
  /** Present when native view ambiguity is separate from executable facts. */
  executionDiagnostics?: string[];
  viewDiagnostics?: string[];
  identity: ModelIdentity;
  networkScope?: { allowedHosts: string[]; nativeSourceIds: string[] };
  sequences: NativeSequence[];
  sequenceDiagnostics: string[];
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const unique = (
  values: string[],
): string[] => [...new Set(values.filter(Boolean))];
export function sourceRefs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    if (
      entry && typeof entry === "object" && typeof entry["@id"] === "string"
    ) {
      return [entry["@id"] as string];
    }
    return [];
  });
}

function provider(elements: ObjectValue[]) {
  const byId = new Map(
    elements.flatMap((element) =>
      typeof element["@id"] === "string"
        ? [[element["@id"] as string, element] as const]
        : []
    ),
  );
  if (byId.size !== elements.length) {
    throw new Error(
      "Native snapshot contains missing or duplicate element identities",
    );
  }
  const byOwner = new Map<string, ObjectValue[]>();
  for (const element of elements) {
    const owner = sourceRefs(element.owner)[0] ?? "";
    const children = byOwner.get(owner);
    if (children) children.push(element);
    else byOwner.set(owner, [element]);
  }
  const id = (element: ObjectValue) => text(element["@id"]);
  const meta = (element: ObjectValue) => text(element["@type"]);
  const name = (
    element: ObjectValue | undefined,
    seen = new Set<string>(),
  ): string => {
    if (!element) return "";
    const declared = text(element.declaredName);
    if (declared) return declared;
    if (seen.has(id(element))) return "";
    const redefined = unique([
      ...sourceRefs(element.redefines),
      ...sourceRefs(element.redefinedFeature),
      ...sourceRefs(element.ownedRedefinition).flatMap((relationId) => {
        const relation = byId.get(relationId);
        return relation
          ? unique([
            ...sourceRefs(relation.redefinedFeature),
            ...sourceRefs(relation.general),
          ])
          : [];
      }),
    ]);
    return redefined.length === 1
      ? name(byId.get(redefined[0]), new Set([...seen, id(element)]))
      : "";
  };
  const related = (element: ObjectValue, kinds: string[], field: string) => {
    const relations = unique([
      ...sourceRefs(element.ownedSpecialization),
      ...sourceRefs(element.ownedRelationship),
    ]).flatMap((relationId) => {
      const relation = byId.get(relationId);
      return relation && kinds.includes(meta(relation))
        ? sourceRefs(relation[field])
        : [];
    });
    return relations;
  };
  const types = (element: ObjectValue, seen = new Set<string>()): string[] => {
    // Native `type` may include the types inherited through a redefinition.
    // An owned explicit typing is the effective declaration's narrower contract.
    const declared = unique([
      ...sourceRefs(element.ownedTyping),
      ...sourceRefs(element.ownedSpecialization),
      ...sourceRefs(element.ownedRelationship),
    ]).flatMap((relationId) => {
      const relation = byId.get(relationId);
      return relation &&
          ["FeatureTyping", "ConjugatedPortTyping"].includes(meta(relation)) &&
          relation.isImplied !== true
        ? sourceRefs(relation.target)
        : [];
    });
    const direct = unique(
      declared.length ? declared : [
        ...sourceRefs(element.type),
        ...related(
          element,
          ["FeatureTyping", "ConjugatedPortTyping"],
          "target",
        ),
      ],
    );
    if (direct.length || seen.has(id(element))) return direct;
    const parents = unique([
      ...sourceRefs(element.redefines),
      ...sourceRefs(element.redefinedFeature),
      ...related(
        element,
        ["Redefinition", "Subsetting", "ReferenceSubsetting"],
        "general",
      ),
    ]);
    return unique(parents.flatMap((parentId) => {
      const parent = byId.get(parentId);
      return parent ? types(parent, new Set([...seen, id(element)])) : [];
    }));
  };
  const record = (element: ObjectValue): ElementRecord => ({
    id: id(element),
    metaclass: meta(element),
    name: name(element),
    ownerId: sourceRefs(element.owner)[0] ?? "",
    qualifiedName: text(element.qualifiedName),
    typeIds: types(element),
    direction: text(element.direction),
    generalIds: unique([
      ...sourceRefs(element.general),
      ...related(element, [
        "Subclassification",
        "Subsetting",
        "ReferenceSubsetting",
        "Redefinition",
      ], "general"),
    ]),
    isReference: element.isReference === true,
    ...(typeof element["sysx:declaredReference"] === "boolean"
      ? { declaredReference: element["sysx:declaredReference"] }
      : {}),
    redefinedIds: unique([
      ...sourceRefs(element.redefines),
      ...sourceRefs(element.redefinedFeature),
      ...related(element, ["Redefinition"], "redefinedFeature"),
    ]),
    multiplicity: (byOwner.get(id(element)) ?? []).filter((child) =>
      meta(child) === "MultiplicityRange"
    ).map((range) =>
      sourceRefs(range.bound).map((boundId) => {
        const bound = byId.get(boundId);
        return bound?.["@type"] === "LiteralInfinity"
          ? "*"
          : String(bound?.value ?? "?");
      }).join("..")
    ).join(""),
    doc: (byOwner.get(id(element)) ?? []).filter((child) =>
      meta(child) === "Documentation"
    ).map((child) => text(child.body)).join("\n"),
  });
  const chain = (
    featureId: string,
    seen = new Set<string>(),
  ): ConnectorEnd["chain"] => {
    if (seen.has(featureId)) return [];
    const feature = byId.get(featureId);
    if (!feature) return [];
    const chaining = sourceRefs(feature.chainingFeature);
    if (!chaining.length) return [{ id: featureId, name: name(feature) }];
    return chaining.flatMap((segment) =>
      chain(segment, new Set([...seen, featureId]))
    );
  };
  const connectorEnds = (element: ObjectValue): ConnectorEnd[] => {
    const endIds = sourceRefs(element.connectorEnd);
    if (endIds.length) {
      return endIds.map((endId) => {
        const end = byId.get(endId);
        const subset = end &&
          byId.get(sourceRefs(end.ownedReferenceSubsetting)[0]);
        const targets = subset
          ? unique([
            ...sourceRefs(subset.referencedFeature),
            ...sourceRefs(subset.target),
          ])
          : [];
        return { chain: targets.length === 1 ? chain(targets[0]) : [] };
      });
    }
    const source = unique([
      ...sourceRefs(element.sourceFeature),
      ...sourceRefs(element["sysx:sourceMember"]),
    ]);
    const target = sourceRefs(element.targetFeature);
    return source.length === 1 && target.length === 1
      ? [source[0], target[0]].map((target) => ({ chain: chain(target) }))
      : [];
  };
  const featureText = (featureId: string): string | undefined => {
    const segments = chain(featureId);
    return segments.length && segments.every((segment) => !!segment.name)
      ? segments.map((segment) => segment.name).join(".")
      : undefined;
  };
  const expressionText = (
    expressionId: string,
    seen = new Set<string>(),
  ): string | undefined => {
    if (seen.has(expressionId)) return undefined;
    const expression = byId.get(expressionId);
    if (!expression) return undefined;
    const type = meta(expression);
    if (type === "FeatureReferenceExpression") {
      return featureText(sourceRefs(expression.referent)[0]);
    }
    if (["LiteralBoolean", "LiteralInteger", "LiteralReal"].includes(type)) {
      return String(expression.value);
    }
    if (type === "LiteralString") return JSON.stringify(expression.value);
    const args = sourceRefs(expression.argument).map((argument) =>
      expressionText(argument, new Set([...seen, expressionId]))
    );
    if (type === "FeatureChainExpression" && args.length === 1 && args[0]) {
      const target = featureText(sourceRefs(expression.targetFeature)[0]);
      return target ? `${args[0]}.${target}` : undefined;
    }
    const operator = text(expression.operator);
    if (
      type === "OperatorExpression" &&
      args.every((argument) => argument !== undefined)
    ) {
      if (args.length === 1 && ["not", "-", "+"].includes(operator)) {
        return `${operator} (${args[0]})`;
      }
      if (
        args.length === 2 &&
        [
          "and",
          "or",
          "xor",
          "implies",
          "==",
          "!=",
          "<",
          ">",
          "<=",
          ">=",
          "+",
          "-",
          "*",
          "/",
        ].includes(operator)
      ) return `(${args[0]} ${operator} ${args[1]})`;
    }
    return undefined;
  };
  return {
    byId,
    byOwner,
    id,
    meta,
    name,
    record,
    chain,
    connectorEnds,
    expressionText,
    types,
  };
}

/** Read only literal defaults with their effective native scalar typing. */
export function sourceLiterals(elements: ObjectValue[]): NativeLiteral[] {
  const facts = provider(elements);
  return elements.filter((element) => facts.meta(element) === "FeatureValue")
    .flatMap((element) => {
      const attributeId = sourceRefs(element.featureWithValue)[0];
      const attribute = facts.byId.get(attributeId);
      const literalId = sourceRefs(element.value)[0];
      const literal = facts.byId.get(literalId);
      if (
        !attribute || facts.meta(attribute) !== "AttributeUsage" || !literal ||
        !["LiteralString", "LiteralBoolean", "LiteralInteger", "LiteralReal"]
          .includes(facts.meta(literal))
      ) return [];
      const typeIds = facts.types(attribute);
      return [{
        owner: sourceRefs(attribute.owner)[0] ?? "",
        name: facts.name(attribute),
        attributeId,
        literalId,
        kind: facts.meta(literal),
        value: String(literal.value),
        typeIds,
        typeNames: typeIds.map((typeId) =>
          text(facts.byId.get(typeId)?.qualifiedName)
        ),
      }];
    });
}

/**
 * One entry per valued native feature, including expression input features.
 * Absence of a FeatureValue means no declared value, not an unsupported value.
 * Unknown expressions remain explicit; malformed feature endpoints are refused
 * with the FeatureValue identity because they cannot be attached to a feature.
 * This opt-in projection never changes sourceLiterals or artifact serialization.
 */
export function sourceValues(elements: ObjectValue[]): SourceValueEntry[] {
  const facts = provider(elements);
  const valuesByFeature = new Map<string, ObjectValue[]>();
  for (const relation of elements) {
    if (facts.meta(relation) !== "FeatureValue") continue;
    try {
      const targets = valueRefs(relation.featureWithValue);
      if (targets.length !== 1 || !facts.byId.has(targets[0])) {
        throw new Error("expected one resolved featureWithValue");
      }
      const id = targets[0];
      const relations = valuesByFeature.get(id);
      if (relations) relations.push(relation);
      else valuesByFeature.set(id, [relation]);
    } catch (error) {
      throw new Error(
        `FeatureValue ${facts.id(relation)}: ${(error as Error).message}`,
      );
    }
  }
  const read = sourceExpressionReader(facts.byId, valuesByFeature);
  const multiplicity = sourceMultiplicityReader(facts.byId, facts.byOwner);
  return [...valuesByFeature].map(([featureId, relations]) => {
    const feature = facts.byId.get(featureId)!;
    const relation = relations[0];
    const typeIds = facts.types(feature);
    const entry: SourceValueEntry = {
      owner: sourceRefs(feature.owner)[0] ?? "",
      name: facts.name(feature),
      featureId,
      expressionId: "",
      featureValueId: facts.id(relation),
      qualifiedName: text(feature.qualifiedName),
      typeIds,
      typeNames: typeIds.map((id) => text(facts.byId.get(id)?.qualifiedName)),
      multiplicity: "unknown",
      value: { kind: "unsupported", reason: "Missing native value" },
    };
    if (
      typeof feature["sysx:sourceDocument"] === "string" &&
      typeof feature["sysx:sourceLine"] === "number" &&
      typeof feature["sysx:sourceColumn"] === "number"
    ) {
      entry.location = {
        document: feature["sysx:sourceDocument"],
        line: feature["sysx:sourceLine"],
        column: feature["sysx:sourceColumn"],
      };
    }
    try {
      if (relations.length !== 1) {
        throw new Error(
          `Multiple FeatureValues: ${relations.map(facts.id).join(", ")}`,
        );
      }
      const expressions = valueRefs(relation.value);
      if (expressions.length !== 1) {
        throw new Error("Expected one native value expression");
      }
      entry.expressionId = expressions[0];
      entry.value = read(entry.expressionId);
      // Parentheses around a singleton disappear in native JSON. Preserve the
      // collection contract from native multiplicity, never from source text.
      entry.multiplicity = multiplicity(featureId);
      if (entry.multiplicity === "many") {
        if (entry.value.kind === "reference") {
          throw new Error(
            "Reference items in a multi-valued feature are unsupported",
          );
        }
        if (
          entry.value.kind !== "sequence" &&
          entry.value.kind !== "unsupported"
        ) entry.value = { kind: "sequence", items: [entry.value] };
      }
    } catch (error) {
      entry.value = { kind: "unsupported", reason: (error as Error).message };
    }
    return entry;
  });
}

export function sourceSnapshot(
  elements: ObjectValue[],
  rootId: string,
): ModelSnapshot {
  const facts = provider(elements);
  const records = elements.filter((element) =>
    element["toolkit:catalogOnly"] !== true &&
    (/(?:Definition|Usage|Package|Node)$/.test(facts.meta(element)) ||
      ["Feature", "LibraryPackage"].includes(facts.meta(element)))
  ).map(facts.record);
  // Global library start/done actions are endpoint facts, not model-owned roots.
  const owned = records.filter((record) =>
    record.ownerId || record.metaclass !== "ActionUsage"
  );
  for (const record of owned) {
    const owner = facts.byId.get(record.ownerId);
    if (
      /^(Library)?Package$/.test(record.metaclass) &&
      (!record.ownerId ||
        owner?.["@type"] === "Namespace" &&
          !sourceRefs(owner.owner).length && !text(owner.qualifiedName))
    ) {
      record.ownerId = rootId;
    }
  }
  const connectors = elements.filter((element) =>
    /^(?:BindingConnectorAsUsage|ConnectionUsage|AllocationUsage|FlowUsage|FlowConnectionUsage|SuccessionAsUsage)$/
      .test(facts.meta(element))
  ).map((element): ConnectorRecord => ({
    id: facts.id(element),
    metaclass: facts.meta(element),
    name: facts.name(element),
    ownerId: sourceRefs(element.owner)[0] ?? "",
    ends: facts.connectorEnds(element),
  }));
  return {
    rootId,
    elements: owned,
    connectors,
    invocations: [],
    patternIds: [],
    messages: [],
  };
}

function nativeViews(elements: ObjectValue[]): NativeViewRecord[] {
  const facts = provider(elements);
  return elements.filter((element) => facts.meta(element) === "ViewUsage").map((
    view,
  ) => ({
    nativeId: facts.id(view),
    label: facts.name(view),
    ownerNativeId: sourceRefs(view.owner)[0] ?? "",
    exposures: sourceRefs(view.ownedImport).flatMap(
      (exposureId): NativeViewExposure[] => {
        const exposure = facts.byId.get(exposureId);
        if (
          !exposure ||
          !["MembershipExpose", "NamespaceExpose"].includes(
            facts.meta(exposure),
          )
        ) return [];
        const namespace = facts.meta(exposure) === "NamespaceExpose";
        const membershipId = sourceRefs(exposure.importedMembership)[0] ??
          "";
        const membership = facts.byId.get(membershipId);
        const target = namespace
          ? sourceRefs(exposure.importedNamespace)[0]
          : membership && sourceRefs(membership.memberElement)[0];
        if (!target) {
          return [{
            nativeId: exposureId,
            importedMembershipId: membershipId,
            targetNativeId: "",
            featurePath: [],
            recursive: exposure.isRecursive === true,
          }];
        }
        const featurePath = facts.chain(target).map((segment) => segment.id);
        return [{
          nativeId: exposureId,
          importedMembershipId: membershipId,
          kind: namespace ? "namespace" as const : "membership" as const,
          ...(namespace ? { importedNamespaceId: target } : {}),
          isImportAll: exposure.isImportAll === true,
          targetNativeId: featurePath.at(-1) ?? target,
          featurePath,
          recursive: exposure.isRecursive === true,
        }];
      },
    ),
  }));
}

/** Projection only: native mandate literals document a model; they grant no host rights. */
export function projectSourceGraph(
  elements: ObjectValue[],
  identity: ModelIdentity,
): SourceGraph {
  const facts = provider(elements);
  const snapshot = sourceSnapshot(elements, identity.rootId);
  const entries = elements.filter((element) =>
    facts.meta(element) === "StateSubactionMembership" &&
    (element.kind === "entry" || element["sysx:subactionKind"] === "entry") &&
    !sourceRefs(element.memberElement).length
  );
  const entryIds = new Set(entries.map(facts.id));
  const diagnostics: string[] = [];
  const relations: NativeRelation[] = [];
  for (const element of elements) {
    const metaclass = facts.meta(element);
    if (metaclass === "TransitionUsage") {
      const guardIds = sourceRefs(element.guardExpression);
      const guardTexts = guardIds.map((guard) => facts.expressionText(guard));
      const triggerIds = sourceRefs(element.triggerAction);
      const eventTypeIds = unique(triggerIds.flatMap((triggerId) => {
        const trigger = facts.byId.get(triggerId);
        return trigger
          ? sourceRefs(trigger.payloadParameter).flatMap((parameterId) =>
            sourceRefs(facts.byId.get(parameterId)?.type)
          )
          : [];
      }));
      const eventNames = eventTypeIds.map((eventId) =>
        facts.name(facts.byId.get(eventId))
      );
      if (
        triggerIds.length && (!eventNames.length || !eventNames.every(Boolean))
      ) {
        diagnostics.push(
          `Unresolved native transition event: ${facts.id(element)}`,
        );
      }
      relations.push({
        id: facts.id(element),
        metaclass,
        ownerId: sourceRefs(element.owner)[0] ?? "",
        sourceId: sourceRefs(element.source)[0] ?? "",
        targetId: sourceRefs(element.target)[0] ?? "",
        label: facts.name(element),
        successionId: sourceRefs(element.succession)[0],
        triggerIds,
        eventTypeIds,
        event: eventNames.length && eventNames.every(Boolean)
          ? eventNames.join("; ")
          : undefined,
        guardIds,
        guard: element["sysx:isElse"] === true
          ? "else"
          : guardIds.length && guardTexts.every((guard) => guard !== undefined)
          ? guardTexts.join("; ")
          : undefined,
        unresolvedGuardIds: guardIds.filter((_, index) =>
          guardTexts[index] === undefined
        ),
      });
    } else if (metaclass === "SatisfyRequirementUsage") {
      relations.push({
        id: facts.id(element),
        metaclass,
        ownerId: sourceRefs(element.owner)[0] ?? "",
        sourceId: sourceRefs(element.subject)[0] ?? "",
        targetId: sourceRefs(element.subsets)[0] ?? "",
        isNegated: element.isNegated === true,
      });
    }
  }
  const graph = buildModelGraph(
    {
      ...snapshot,
      connectors: snapshot.connectors.filter((connector) =>
        !connector.ends.some((end) =>
          end.chain.some((link) => entryIds.has(link.id))
        )
      ),
    },
    {
      relations,
      diagnostics,
      endpointElements: elements.filter((element) =>
        facts.meta(element) === "ActionUsage" &&
        (!sourceRefs(element.owner).length ||
          element["toolkit:catalogOnly"] === true)
      ).map(facts.record),
      stateEntries: elements.flatMap((element) =>
        sourceRefs(element.entryAction).map((entryActionId) => ({
          ownerId: facts.id(element),
          entryActionId,
        }))
      ),
    },
    "Assembly",
    "SysML Toolkit / Git",
  );
  const result: SourceGraph = {
    ...graph,
    views: [],
    identity,
    sequences: [],
    sequenceDiagnostics: [],
  };
  // The provider exposes this native state-entry marker as a membership without
  // an ActionUsage. Preserve its real metaclass and identity in the view.
  const records = new Map(
    snapshot.elements.map((record) => [record.id, record]),
  );
  const inherits = (
    id: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    const record = records.get(id);
    return !!record &&
      [...record.typeIds, ...record.generalIds].some((parent) =>
        inherits(parent, target, new Set([...seen, id]))
      );
  };
  for (const entry of entries) {
    const entryId = facts.id(entry);
    const ownerId = sourceRefs(entry.owner)[0] ?? "";
    const contexts = result.nodes.filter((node) =>
      node.role === "usage" && inherits(node.nativeId, ownerId)
    );
    for (const context of contexts) {
      const path = [...context.contextPath, entryId];
      const marker: ModelGraphNode = {
        ...context,
        id: `use:${path.map(encodeURIComponent).join("/")}`,
        nativeId: entryId,
        metaclass: "StateSubactionMembership",
        contextPath: path,
        label: "entry",
        kind: "state-subaction-membership",
        symbol: "",
        description: "Native state entry membership",
        parentId: context.id,
        level: context.level + 1,
        category: "control",
        fields: [],
        declaredDirection: "",
        isReference: false,
        origin: "typed-projection",
        stateRole: "initial",
        stateRoleSourceId: entryId,
        source: {
          ...context.source,
          line: entryId,
          quote: "entry",
          native: true,
        },
      };
      result.nodes.push(marker);
      for (const scope of result.scopes) {
        if (scope.id === "all" || scope.id === marker.packageId) {
          scope.nodeIds.push(marker.id);
        }
      }
      for (const level of result.levels) {
        level.maxLevel = Math.max(level.maxLevel, marker.level);
      }
      for (
        const connector of snapshot.connectors.filter((connector) =>
          connector.metaclass === "SuccessionAsUsage" &&
          connector.ends[0]?.chain.some((link) => link.id === entryId)
        )
      ) {
        const targetId = connector.ends[1]?.chain.at(-1)?.id;
        const targets = result.nodes.filter((node) =>
          node.nativeId === targetId && node.parentId === context.id
        );
        if (targets.length !== 1) {
          result.diagnostics.push(
            `Native state entry target unresolved: ${connector.id} in ${context.id}`,
          );
          continue;
        }
        result.edges.push({
          id: `succession:${encodeURIComponent(connector.id)}:${marker.id}->${
            targets[0].id
          }`,
          source: marker.id,
          target: targets[0].id,
          kind: "succession",
          label: "",
          nativeId: connector.id,
          metaclass: connector.metaclass,
          origin: "declared",
          sourceFeaturePath: [entryId],
          targetFeaturePath: connector.ends[1].chain.map((link) => link.id),
          sourceEvidence: {
            file: "SysML Toolkit / Git",
            line: connector.id,
          },
        });
      }
    }
  }
  // Definitions are useful before a system exhibits them. Keep these members
  // in the library role so execution compilation still selects only usages.
  for (
    const root of [...result.nodes].filter((node) =>
      node.metaclass === "StateDefinition" && node.role === "definition"
    )
  ) {
    root.prototype = true;
    root.observedState = false;
    const members = new Map<string, SourceGraph["nodes"][number]>();
    const owners = new Set<string>();
    const visit = (
      ownerId: string,
      parent: ModelGraphNode,
      seen = new Set<string>(),
    ) => {
      if (seen.has(ownerId)) return;
      owners.add(ownerId);
      const next = new Set([...seen, ownerId]);
      for (const generalId of records.get(ownerId)?.generalIds ?? []) {
        if (records.get(generalId)?.metaclass === "StateDefinition") {
          visit(generalId, parent, next);
        }
      }
      for (const child of facts.byOwner.get(ownerId) ?? []) {
        const childId = facts.id(child);
        const initial = entryIds.has(childId);
        if (facts.meta(child) !== "StateUsage" && !initial) continue;
        if (members.has(childId)) continue;
        const record = records.get(childId);
        const node: SourceGraph["nodes"][number] = {
          ...root,
          id: `def-member:${encodeURIComponent(root.nativeId)}/${
            encodeURIComponent(childId)
          }`,
          nativeId: childId,
          metaclass: facts.meta(child),
          contextPath: [...parent.contextPath, childId],
          label: initial ? "entry" : facts.name(child) || facts.meta(child),
          kind: initial ? "state-subaction-membership" : "state-usage",
          category: initial ? "control" : "state",
          symbol: text(child.qualifiedName),
          description: record?.doc ?? "Native state entry membership",
          parentId: parent.id,
          level: parent.level + 1,
          role: "definition",
          origin: ownerId === parent.nativeId ? "declared" : "typed-projection",
          declaredDirection: record?.direction ?? "",
          isReference: record?.isReference ?? false,
          fields: [],
          definitionOwnerId: ownerId,
          ...(ownerId !== parent.nativeId
            ? { inheritedFromDefinitionId: ownerId }
            : {}),
          ...(initial
            ? { stateRole: "initial" as const, stateRoleSourceId: childId }
            : {}),
          source: {
            ...root.source,
            line: childId,
            quote: text(child["sysx:sourceText"]) || text(child.qualifiedName),
          },
        };
        members.set(childId, node);
        result.nodes.push(node);
        result.edges.push({
          id: `definition-owns:${parent.id}/${encodeURIComponent(childId)}`,
          source: parent.id,
          target: node.id,
          kind: "owns",
          label: "owns",
          nativeId: childId,
          metaclass: facts.meta(child),
          origin: node.origin,
          sourceEvidence: { file: "SysML Toolkit / Git", line: childId },
        });
        if (!initial) visit(childId, node, next);
      }
    };
    visit(root.nativeId, root);
    const transitionSuccessions = new Set(
      relations.map((relation) => relation.successionId),
    );
    const candidates = [
      ...relations.filter((relation) =>
        relation.metaclass === "TransitionUsage" && owners.has(relation.ownerId)
      ).map((relation) => ({
        ...relation,
        sourcePath: [relation.sourceId],
        targetPath: [relation.targetId],
      })),
      ...snapshot.connectors.filter((connector) =>
        connector.metaclass === "SuccessionAsUsage" &&
        owners.has(connector.ownerId) &&
        !transitionSuccessions.has(connector.id)
      ).map((connector) => ({
        id: connector.id,
        metaclass: connector.metaclass,
        ownerId: connector.ownerId,
        sourceId: connector.ends[0]?.chain.at(-1)?.id ?? "",
        targetId: connector.ends[1]?.chain.at(-1)?.id ?? "",
        sourcePath: connector.ends[0]?.chain.map((link) => link.id) ?? [],
        targetPath: connector.ends[1]?.chain.map((link) => link.id) ?? [],
      })),
    ];
    for (const relation of candidates) {
      const source = members.get(relation.sourceId);
      const target = members.get(relation.targetId);
      if (!source || !target) continue;
      const detail = relation as NativeRelation;
      result.edges.push({
        id: `definition-relation:${encodeURIComponent(root.nativeId)}/${
          encodeURIComponent(relation.id)
        }`,
        source: source.id,
        target: target.id,
        kind: relation.metaclass === "TransitionUsage"
          ? "transition"
          : "succession",
        label: detail.event
          ? `${detail.event}${detail.guard ? ` [${detail.guard}]` : ""}`
          : detail.guard || detail.label || "",
        nativeId: relation.id,
        metaclass: relation.metaclass,
        origin: "declared",
        event: detail.event,
        eventTypeIds: detail.eventTypeIds,
        triggerIds: detail.triggerIds,
        guard: detail.guard,
        guardIds: detail.guardIds,
        sourceFeaturePath: relation.sourcePath,
        targetFeaturePath: relation.targetPath,
        sourceEvidence: { file: "SysML Toolkit / Git", line: relation.id },
      });
    }
    for (const node of members.values()) {
      for (const scope of result.scopes) {
        if (scope.id === "all" || scope.id === node.packageId) {
          scope.nodeIds.push(node.id);
        }
      }
      for (const level of result.levels) {
        level.maxLevel = Math.max(level.maxLevel, node.level);
      }
    }
  }
  for (const node of result.nodes) {
    const raw = facts.byId.get(node.nativeId);
    node.source = {
      ...node.source,
      // Historical viewer field means native element identity, not a file line.
      native: true,
      quote: text(raw?.["sysx:sourceText"]) || node.source.quote,
    };
    if (raw && /ConstraintUsage$/.test(node.metaclass)) {
      const memberships = [
        ...(facts.byOwner.get(node.nativeId) ?? []),
        ...sourceRefs(raw.ownedMembership).flatMap((id) => {
          const member = facts.byId.get(id);
          return member ? [member] : [];
        }),
      ].filter((member) => facts.meta(member) === "ResultExpressionMembership");
      const roots = unique([
        ...sourceRefs(raw.resultExpression),
        ...memberships.flatMap((member) => sourceRefs(member.memberElement)),
      ]);
      if (roots.length === 1) {
        const expression = facts.expressionText(roots[0]);
        if (expression !== undefined) {
          const expressionIds = new Set<string>([
            node.nativeId,
            ...memberships.map(facts.id),
          ]);
          const visit = (id: string) => {
            if (expressionIds.has(id)) return;
            expressionIds.add(id);
            const value = facts.byId.get(id);
            if (!value) return;
            for (
              const field of [
                "argument",
                "referent",
                "targetFeature",
                "chainingFeature",
              ]
            ) {
              for (const reference of sourceRefs(value[field])) {
                visit(reference);
              }
            }
          };
          visit(roots[0]);
          node.expression = expression;
          node.expressionSourceIds = [...expressionIds];
        } else {result.diagnostics.push(
            `Unsupported native constraint expression: ${node.nativeId}`,
          );}
      } else if (node.metaclass === "AssertConstraintUsage") {
        result.diagnostics.push(
          `Native assertion has no unique result expression: ${node.nativeId}`,
        );
      }
    }
  }
  const values = new Map<
    string,
    Array<{ name: string; value: unknown; attribute: string; literal: string }>
  >();
  for (const element of elements) {
    if (facts.meta(element) !== "FeatureValue") continue;
    const attributeId = sourceRefs(element.featureWithValue)[0];
    const attribute = facts.byId.get(attributeId);
    const literalId = sourceRefs(element.value)[0];
    const literal = facts.byId.get(literalId);
    if (
      !attribute || !literal ||
      !["LiteralString", "LiteralBoolean", "LiteralInteger"].includes(
        facts.meta(literal),
      )
    ) continue;
    const ownerId = sourceRefs(attribute.owner)[0] ?? "";
    const value = {
      name: facts.name(attribute),
      value: literal.value,
      attribute: attributeId,
      literal: literalId,
    };
    const ownerValues = values.get(ownerId);
    if (ownerValues) ownerValues.push(value);
    else values.set(ownerId, [value]);
  }
  const literalMap = (ownerId: string) =>
    new Map(
      (values.get(ownerId) ?? []).map((value) => [value.name, value.value]),
    );
  for (const node of result.nodes) {
    const valuesForNode = literalMap(node.nativeId);
    if (valuesForNode.has("status")) {
      node.modelStage = String(valuesForNode.get("status"));
    }
    const record = snapshot.elements.find((record) =>
      record.id === node.nativeId
    );
    const isMandate = record?.typeIds.some((typeId) =>
      facts.name(facts.byId.get(typeId)) === "ConfiguredMandate"
    );
    if (
      !isMandate || node.role !== "usage" ||
      valuesForNode.get("evidenceLevel") !== "configured"
    ) continue;
    const bindings = snapshot.connectors.filter((connector) =>
      connector.metaclass === "BindingConnectorAsUsage" &&
      connector.ownerId === record!.ownerId
    );
    const holders = bindings.flatMap((binding) =>
      binding.ends.flatMap((end, index) =>
        end.chain.length === 2 && end.chain[0].id === node.nativeId &&
          end.chain[1].name === "holder"
          ? [{ binding, chain: binding.ends[1 - index]?.chain ?? [] }]
          : []
      )
    );
    if (holders.length !== 1 || holders[0].chain.length !== 1) {
      result.diagnostics.push(
        `Native mandate holder unresolved: ${node.nativeId}`,
      );
      continue;
    }
    const holderId = holders[0].chain[0].id;
    const holder = result.nodes.find((candidate) =>
      candidate.nativeId === holderId && candidate.role === "usage" &&
      candidate.origin === "declared"
    );
    if (!holder) continue;
    const fields = values.get(node.nativeId) ?? [];
    holder.mandate = {
      id: String(valuesForNode.get("id") ?? ""),
      version: String(valuesForNode.get("version") ?? ""),
      nativeId: node.nativeId,
      holderNativeId: holderId,
      scopeLabel: String(valuesForNode.get("scope") ?? ""),
      allowedChoices: fields.filter((field) => field.value === true).map((
        field,
      ) => field.name),
      limits: fields.filter((field) => field.value === false).map((field) =>
        `${field.name} = false`
      ),
      sourceRefs: unique([
        String(valuesForNode.get("source") ?? ""),
        node.nativeId,
        holderId,
        holders[0].binding.id,
        ...fields.flatMap((field) => [field.attribute, field.literal]),
      ]),
      evidenceLevel: "configured",
      grantingOperator: "unknown",
    };
    holder.operator = {
      nativeId: holderId,
      roleLabel: holder.label,
      depictedJudgmentRefs: unique(
        result.edges.filter((edge) =>
          edge.kind === "allocation" &&
          [edge.source, edge.target].includes(holder.id)
        ).flatMap((edge) => [edge.source, edge.target]).flatMap((id) =>
          result.nodes.filter((candidate) =>
            candidate.id === id && candidate.dimension === "behavior"
          ).map((candidate) => candidate.nativeId)
        ),
      ),
      capabilityBindings: [],
    };
  }
  const systemValues = values.get(identity.systemId) ?? [];
  const hosts = systemValues.filter((value) => value.name === "networkHosts");
  if (hosts.length === 1 && typeof hosts[0].value === "string") {
    try {
      const allowedHosts: unknown = JSON.parse(hosts[0].value);
      if (
        Array.isArray(allowedHosts) &&
        allowedHosts.every((host) => typeof host === "string")
      ) {
        result.networkScope = {
          allowedHosts,
          nativeSourceIds: [hosts[0].attribute, hosts[0].literal],
        };
      } else {result.diagnostics.push(
          "Native networkHosts is not a string array",
        );}
    } catch {
      result.diagnostics.push("Native networkHosts is not JSON");
    }
  }
  const projectedViews = projectNativeViews(nativeViews(elements), result);
  result.views = projectedViews.views;
  if (projectedViews.diagnostics.length) {
    // An unresolved presentation exposure must remain visible to the viewer,
    // but it neither supplies nor invalidates a native execution relationship.
    result.executionDiagnostics = [...result.diagnostics];
    result.viewDiagnostics = [...projectedViews.diagnostics];
  }
  const sequenceProjection = projectSourceSequences(elements);
  result.sequences = sequenceProjection.sequences;
  result.sequenceDiagnostics = sequenceProjection.diagnostics;
  result.diagnostics = unique([
    ...result.diagnostics,
    ...projectedViews.diagnostics,
  ]);
  return result;
}
