import type {
  ConnectorEnd,
  ConnectorRecord,
  ElementRecord,
  ModelSnapshot,
} from "../records/snapshot.ts";
import type { NativeLiteral } from "../records/native-literal.ts";

type ObjectValue = Record<string, unknown>;

export const sourceText = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const uniqueSourceRefs = (
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

export function sourceFacts(elements: ObjectValue[]) {
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
  const id = (element: ObjectValue) => sourceText(element["@id"]);
  const meta = (element: ObjectValue) => sourceText(element["@type"]);
  const name = (
    element: ObjectValue | undefined,
    seen = new Set<string>(),
  ): string => {
    if (!element) return "";
    const declared = sourceText(element.declaredName);
    if (declared) return declared;
    if (seen.has(id(element))) return "";
    const redefined = uniqueSourceRefs([
      ...sourceRefs(element.redefines),
      ...sourceRefs(element.redefinedFeature),
      ...sourceRefs(element.ownedRedefinition).flatMap((relationId) => {
        const relation = byId.get(relationId);
        return relation
          ? uniqueSourceRefs([
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
    const relations = uniqueSourceRefs([
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
    const declared = uniqueSourceRefs([
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
    const direct = uniqueSourceRefs(
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
    const parents = uniqueSourceRefs([
      ...sourceRefs(element.redefines),
      ...sourceRefs(element.redefinedFeature),
      ...related(
        element,
        ["Redefinition", "Subsetting", "ReferenceSubsetting"],
        "general",
      ),
    ]);
    return uniqueSourceRefs(parents.flatMap((parentId) => {
      const parent = byId.get(parentId);
      return parent ? types(parent, new Set([...seen, id(element)])) : [];
    }));
  };
  const record = (element: ObjectValue): ElementRecord => ({
    id: id(element),
    metaclass: meta(element),
    name: name(element),
    ownerId: sourceRefs(element.owner)[0] ?? "",
    qualifiedName: sourceText(element.qualifiedName),
    typeIds: types(element),
    direction: sourceText(element.direction),
    generalIds: uniqueSourceRefs([
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
    redefinedIds: uniqueSourceRefs([
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
    ).map((child) => sourceText(child.body)).join("\n"),
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
          ? uniqueSourceRefs([
            ...sourceRefs(subset.referencedFeature),
            ...sourceRefs(subset.target),
          ])
          : [];
        return { chain: targets.length === 1 ? chain(targets[0]) : [] };
      });
    }
    const source = uniqueSourceRefs([
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
    const operator = sourceText(expression.operator);
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
  const facts = sourceFacts(elements);
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
          sourceText(facts.byId.get(typeId)?.qualifiedName)
        ),
      }];
    });
}

export function sourceSnapshot(
  elements: ObjectValue[],
  rootId: string,
): ModelSnapshot {
  const facts = sourceFacts(elements);
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
          !sourceRefs(owner.owner).length && !sourceText(owner.qualifiedName))
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
