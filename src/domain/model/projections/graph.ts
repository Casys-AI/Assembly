/** Read-only native SysML projection for the Live Builder.
 *
 * Occurrence IDs use native feature chains, rather than labels. The same feature
 * inherited by two usages therefore has two distinct, stable graph identities.
 * Definitions remain a separate library; an Action is never converted to a Part.
 */
import type {
  Dimension,
  GraphData,
  GraphEdge,
  GraphNode,
} from "../records/graph-sequence.ts";
import {
  type ConnectorEnd,
  type ElementRecord,
  type ModelSnapshot,
} from "../records/snapshot.ts";

export interface ModelGraphNode extends Omit<GraphNode, "provenance"> {
  provenance: "ASE" | "APE";
  nativeId: string;
  metaclass: string;
  contextPath: string[];
  performerLabels?: string[];
  stateRole?: "initial";
  stateRoleSourceId?: string;
  /** Exact Feature.direction spelling from the native model; empty if unset. */
  declaredDirection: string;
  isReference: boolean;
  /** Present only when a containing native conjugated port establishes it. */
  effectiveDirection?: string;
  /** Native conjugated typing of this port occurrence, never its display name. */
  conjugated?: boolean;
  conjugationSourceIds?: string[];
  /** Native markers behind the containing-port direction calculation. */
  directionConjugationIds?: string[];
}
interface ModelGraphEdge extends GraphEdge {
  nativeId: string;
  metaclass: string;
  guard?: string;
  guardIds?: string[];
  event?: string;
  triggerIds?: string[];
  eventTypeIds?: string[];
  sourceEvidenceIds?: string[];
  satisfaction?: "declared";
  sourceFeaturePath?: string[];
  targetFeaturePath?: string[];
}
export interface ModelGraphData extends Omit<GraphData, "nodes" | "edges"> {
  nodes: ModelGraphNode[];
  edges: ModelGraphEdge[];
  diagnostics: string[];
}
export interface NativeRelation {
  id: string;
  metaclass: string;
  ownerId: string;
  sourceId: string;
  targetId: string;
  label?: string;
  event?: string;
  triggerIds?: string[];
  eventTypeIds?: string[];
  sourceEvidenceIds?: string[];
  isNegated?: boolean;
  guard?: string;
  guardIds?: string[];
  /** Exact IDs of unsupported guard AST nodes; never fabricate their text. */
  unresolvedGuardIds?: string[];
  /** A TransitionUsage owns a Succession which must not be rendered twice. */
  successionId?: string;
}
export interface NativeRelations {
  relations?: NativeRelation[];
  diagnostics?: string[];
  /** Referenced library endpoints, read from native connector ends. */
  endpointElements?: ElementRecord[];
  stateEntries?: Array<{ ownerId: string; entryActionId: string }>;
}

const usageClasses = new Set([
  "PartUsage",
  "OccurrenceUsage",
  "PortUsage",
  "ItemUsage",
  "ReferenceUsage",
  "ActionUsage",
  "PerformActionUsage",
  "AcceptActionUsage",
  "SendActionUsage",
  "AssignmentActionUsage",
  "DecisionNode",
  "MergeNode",
  "ForkNode",
  "JoinNode",
  "StateUsage",
  "ExhibitStateUsage",
  "UseCaseUsage",
  "RequirementUsage",
  "ConstraintUsage",
  "AssertConstraintUsage",
  "CalculationUsage",
]);
const definitionClasses = new Set([
  "PartDefinition",
  "OccurrenceDefinition",
  "PortDefinition",
  "ItemDefinition",
  "ActionDefinition",
  "StateDefinition",
  "UseCaseDefinition",
  "RequirementDefinition",
  "ConstraintDefinition",
  "CalculationDefinition",
  "EnumerationDefinition",
  "AttributeDefinition",
  "InterfaceDefinition",
  "ConnectionDefinition",
]);
const kebab = (name: string) =>
  name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
const dimension = (name: string): Dimension =>
  /Action|Node$|State|UseCase|Occurrence/.test(name)
    ? "behavior"
    : /Requirement/.test(name)
    ? "requirements"
    : /Constraint|Calculation/.test(name)
    ? "constraints"
    : "structure";
const category = (name: string) =>
  /Port/.test(name)
    ? "port"
    : /Item|ReferenceUsage/.test(name)
    ? "item"
    : /Part/.test(name)
    ? "part"
    : /Node$/.test(name)
    ? "control"
    : /Action/.test(name)
    ? "action"
    : kebab(name);
const relationKind = (name: string) =>
  /SatisfyRequirement/.test(name)
    ? "satisfies"
    : /Allocation/.test(name)
    ? "allocation"
    : /Binding/.test(name)
    ? "binding"
    : /Flow/.test(name)
    ? "flow"
    : /Succession|Transition/.test(name)
    ? "succession"
    : /Perform/.test(name)
    ? "perform"
    : "connection";

/** Pure projection. Native relation facts may be injected by tests/read adapters. */
export function buildModelGraph(
  snapshot: ModelSnapshot,
  native: NativeRelations = {},
  title = "Assembly",
  projectLabel = "SysML",
): ModelGraphData {
  const diagnostics = [...(native.diagnostics ?? [])];
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const children = new Map<string, ElementRecord[]>();
  for (const element of snapshot.elements) {
    const owned = children.get(element.ownerId) ?? [];
    owned.push(element);
    children.set(element.ownerId, owned);
  }
  const packageOf = (element: ElementRecord): ElementRecord | undefined => {
    const seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (/^(Library)?Package$/.test(current.metaclass)) return current;
      current = byId.get(current.ownerId);
    }
    return undefined;
  };
  const nodes: ModelGraphNode[] = [];
  const edges: ModelGraphEdge[] = [];
  const nodeById = new Map<string, ModelGraphNode>();
  const edgeIds = new Set<string>();
  const addEdge = (
    source: ModelGraphNode,
    target: ModelGraphNode,
    kind: string,
    nativeId: string,
    metaclass: string,
    label = "",
    extra: Partial<ModelGraphEdge> = {},
  ) => {
    const id = `${kind}:${
      encodeURIComponent(nativeId)
    }:${source.id}->${target.id}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({
      id,
      source: source.id,
      target: target.id,
      kind,
      label,
      nativeId,
      metaclass,
      origin: kind === "typing" || kind === "specialization"
        ? "typed-projection"
        : "declared",
      sourceEvidence: { file: projectLabel, line: nativeId },
      ...extra,
    });
  };
  // ConjugatedPortDefinition.originalPortDefinition redefines owningNamespace
  // in the native metamodel. Verify that owner's metaclass before resolving it.
  const conjugationsOf = (
    element: ElementRecord,
  ): { types: ElementRecord[]; resolved: boolean } => {
    if (element.metaclass !== "PortUsage") return { types: [], resolved: true };
    const found: ElementRecord[] = [];
    let resolved = true;
    const seen = new Set<string>();
    const visit = (id: string, direct = false) => {
      if (seen.has(id)) return;
      seen.add(id);
      const type = byId.get(id);
      if (!type) {
        // External standard-library base types are outside this root snapshot.
        // An unresolved directly declared type, however, leaves conjugation unknown.
        if (!direct) return;
        resolved = false;
        diagnostics.push(
          `Native port type ${id} could not be resolved for ${element.id}.`,
        );
        return;
      }
      if (type.metaclass === "ConjugatedPortDefinition") {
        if (byId.get(type.ownerId)?.metaclass === "PortDefinition") {
          found.push(type);
        } else {
          resolved = false;
          diagnostics.push(
            `Conjugated port definition ${id} has no resolved native original port definition.`,
          );
        }
        return;
      }
      for (const generalId of type.generalIds) visit(generalId);
    };
    for (const typeId of element.typeIds) visit(typeId, true);
    return { types: found, resolved };
  };
  const directionContexts = new Map<
    string,
    { sourceIds: string[]; inversions: number }
  >();
  const addNode = (
    element: ElementRecord,
    parent: ModelGraphNode | null,
    path: string[],
    definition = false,
  ): ModelGraphNode => {
    const id = definition
      ? `def:${element.id}`
      : `use:${path.map(encodeURIComponent).join("/")}`;
    const previous = nodeById.get(id);
    if (previous) return previous;
    const pkg = packageOf(element);
    const conjugation = definition
      ? { types: [], resolved: true }
      : conjugationsOf(element);
    const conjugations = conjugation.resolved ? conjugation.types : [];
    const directionContext = parent
      ? directionContexts.get(parent.id)
      : undefined;
    const declaredDirection = element.direction;
    const directional = ["in", "out", "inout"].includes(declaredDirection);
    const node: ModelGraphNode = {
      id,
      nativeId: element.id,
      metaclass: element.metaclass,
      contextPath: path,
      declaredDirection,
      isReference: element.isReference,
      ...(directionContext?.inversions && directional
        ? {
          effectiveDirection: directionContext.inversions % 2 === 0 ||
              declaredDirection === "inout"
            ? declaredDirection
            : declaredDirection === "out"
            ? "in"
            : "out",
          directionConjugationIds: directionContext.sourceIds,
        }
        : {}),
      ...(element.metaclass === "PortUsage" && conjugation.resolved
        ? {
          conjugated: conjugations.length > 0,
          ...(conjugations.length
            ? { conjugationSourceIds: conjugations.map((type) => type.id) }
            : {}),
        }
        : {}),
      label: element.name || element.metaclass,
      dimension: dimension(element.metaclass),
      kind: kebab(element.metaclass),
      symbol: element.qualifiedName,
      parentId: parent?.id ?? null,
      level: parent ? parent.level + 1 : 0,
      subsystem: pkg?.name ?? "",
      description: element.doc,
      source: {
        file: projectLabel,
        line: element.id,
        quote: element.qualifiedName,
        native: true,
      },
      origin: definition || element.ownerId === parent?.nativeId
        ? "declared"
        : "typed-projection",
      packageId: pkg?.id ?? "",
      role: definition ? "definition" : "usage",
      provenance: /^APE/.test(pkg?.name ?? "") ? "APE" : "ASE",
      category: category(element.metaclass),
      fields: (children.get(element.id) ?? []).filter((e) =>
        e.metaclass === "AttributeUsage"
      ).map((e) => e.name),
    };
    nodes.push(node);
    nodeById.set(id, node);
    directionContexts.set(id, {
      sourceIds: [
        ...(directionContext?.sourceIds ?? []),
        ...conjugations.map((type) => type.id),
      ],
      inversions: (directionContext?.inversions ?? 0) +
        (conjugations.length > 0 ? 1 : 0),
    });
    if (parent) {
      addEdge(parent, node, "owns", element.id, element.metaclass, "owns");
    }
    return node;
  };
  for (const element of snapshot.elements) {
    if (definitionClasses.has(element.metaclass)) {
      addNode(element, null, [], true);
    }
  }
  const definitions = new Map(nodes.map((node) => [node.nativeId, node]));
  // Each context can instantiate owned relationships from itself and its types.
  const contexts = new Map<string, ModelGraphNode[]>();
  const recordContext = (nativeId: string, node: ModelGraphNode) => {
    const values = contexts.get(nativeId) ?? [];
    if (!values.some((value) => value.id === node.id)) values.push(node);
    contexts.set(nativeId, values);
  };
  const inheritedTypes = (element: ElementRecord): ElementRecord[] => {
    const found: ElementRecord[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const type = byId.get(id);
      if (!type) return;
      if (type.metaclass === "ConjugatedPortDefinition") {
        if (byId.get(type.ownerId)?.metaclass === "PortDefinition") {
          visit(type.ownerId);
        }
        return;
      }
      found.push(type);
      for (const parent of type.generalIds) visit(parent);
    };
    for (const id of element.typeIds) visit(id);
    return found;
  };
  const expand = (
    element: ElementRecord,
    parent: ModelGraphNode | null,
    path: string[],
    expanding: Set<string>,
  ) => {
    const node = addNode(element, parent, [...path, element.id]);
    recordContext(element.id, node);
    const types = inheritedTypes(element);
    // A reference to a structural value/part is a feature of this occurrence,
    // not a second owned instance of the referred definition. Keep the actual
    // reference node, typing and its explicitly declared members. Ports still
    // expose their contract payloads; behavior/state usages retain their scopes.
    const expandsTypeMembers = !element.isReference ||
      !["part", "item"].includes(category(element.metaclass));
    for (const type of types) {
      if (expandsTypeMembers) recordContext(type.id, node);
      const definition = definitions.get(type.id);
      if (definition) {
        addEdge(
          node,
          definition,
          "typing",
          element.id,
          "FeatureTyping",
          "typed by",
        );
      }
    }
    if (
      parent && element.metaclass === "PerformActionUsage" &&
      /Part/.test(parent.metaclass)
    ) {
      addEdge(
        parent,
        node,
        "perform",
        element.id,
        element.metaclass,
        "performs",
      );
      node.performerLabels = [parent.label];
    }
    if (expanding.has(element.id) || path.length >= 24) {
      diagnostics.push(`Recursive feature expansion stopped at ${node.id}`);
      return;
    }
    const nextExpanding = new Set([...expanding, element.id]);
    const owned = [...(children.get(element.id) ?? [])];
    const suppressed = new Set(owned.flatMap((child) => child.redefinedIds));
    if (expandsTypeMembers) {
      for (const type of types) owned.push(...(children.get(type.id) ?? []));
    }
    const seen = new Set<string>();
    for (const child of owned) {
      if (
        seen.has(child.id) || suppressed.has(child.id) ||
        !usageClasses.has(child.metaclass)
      ) continue;
      seen.add(child.id);
      expand(child, node, node.contextPath, nextExpanding);
    }
  };
  // Library members are instantiated only through a native usage. This prevents
  // the ActionDefinition's children masquerading as independent executions.
  const roots = snapshot.elements.filter((element) =>
    usageClasses.has(element.metaclass) &&
    (!byId.has(element.ownerId) ||
      /^(Library)?Package$/.test(byId.get(element.ownerId)!.metaclass))
  );
  for (const root of roots) expand(root, null, [], new Set());
  if (!roots.length) {
    diagnostics.push(
      "No package-owned native usage was found; only definitions are available.",
    );
  }
  for (const entry of native.stateEntries ?? []) {
    for (const context of contexts.get(entry.ownerId) ?? []) {
      const initial = nodes.find((candidate) =>
        candidate.parentId === context.id &&
        candidate.nativeId === entry.entryActionId
      );
      if (initial) {
        initial.stateRole = "initial";
        initial.stateRoleSourceId = entry.ownerId;
      } else {diagnostics.push(
          `Native state entry ${entry.entryActionId} could not be resolved in ${context.id}.`,
        );}
    }
  }
  for (const definition of definitions.values()) {
    const element = byId.get(definition.nativeId)!;
    for (const generalId of element.generalIds) {
      const general = definitions.get(generalId);
      if (general) {
        addEdge(
          definition,
          general,
          "specialization",
          element.id,
          "Specialization",
          "specializes",
        );
      }
    }
  }
  const usageNodes = nodes.filter((node) => node.role === "usage");
  const endpoints = new Map(
    (native.endpointElements ?? []).map((element) => [element.id, element]),
  );
  const isWithin = (node: ModelGraphNode, context: ModelGraphNode) =>
    node.contextPath.length >= context.contextPath.length &&
    context.contextPath.every((part, index) =>
      node.contextPath[index] === part
    );
  const resolve = (
    chain: ConnectorEnd["chain"],
    context: ModelGraphNode,
  ): ModelGraphNode | undefined => {
    let current: ModelGraphNode | undefined = context;
    // An absolute native chain can start at an ancestor (for example a
    // candidate binding its reference to system.catalog.contract). Preserve
    // the entire occurrence path rather than guessing from its last feature.
    if (chain.length > 1) {
      const first = chain[0]!.id;
      const ancestors = usageNodes.filter((node) =>
        node.nativeId === first && isWithin(context, node)
      );
      const roots = usageNodes.filter((node) =>
        node.nativeId === first && !node.parentId
      );
      if (ancestors.length === 1) current = ancestors[0];
      else if (roots.length === 1) current = roots[0];
    }
    for (const link of chain) {
      if (current?.nativeId === link.id) continue;
      const candidates: ModelGraphNode[] = usageNodes.filter((node) =>
        node.parentId === current?.id && node.nativeId === link.id
      );
      if (candidates.length !== 1) {
        // Scalar features stay fields on their real owner; the relation still
        // retains both native endpoint chains below.
        const field = byId.get(link.id);
        if (
          current && field?.metaclass === "AttributeUsage" &&
          ((contexts.get(field.ownerId) ?? []).some((owner) =>
            owner.id === current!.id
          ) ||
            (byId.has(current.nativeId) &&
              inheritedTypes(byId.get(current.nativeId)!).some((type) =>
                type.id === field.ownerId
              )))
        ) continue;
        current = undefined;
        break;
      }
      current = candidates[0];
    }
    if (current && chain.length) return current;
    // A native end may point directly to a nested feature instead of carrying a
    // feature chain. Resolve it only when unambiguous within this occurrence.
    const last = chain.at(-1)?.id;
    const candidates = chain.length === 1
      ? usageNodes.filter((node) =>
        node.nativeId === last && isWithin(node, context)
      )
      : [];
    if (candidates.length === 1) return candidates[0];
    const endpoint = last ? endpoints.get(last) : undefined;
    // Only an actual library ActionUsage read from a native connector end may
    // add an external endpoint. No synthetic start/done/failed marker is made.
    if (
      chain.length === 1 && endpoint?.metaclass === "ActionUsage" &&
      !byId.has(endpoint.id)
    ) {
      const node = addNode(endpoint, context, [
        ...context.contextPath,
        endpoint.id,
      ]);
      if (!usageNodes.some((candidate) => candidate.id === node.id)) {
        usageNodes.push(node);
      }
      return node;
    }
    return undefined;
  };
  const bindRelation = (relation: NativeRelation, ends: ConnectorEnd[]) => {
    const owners = contexts.get(relation.ownerId) ?? [];
    if (!owners.length) return; // A library definition with no usage has no execution context.
    if (ends.length !== 2 || !ends.every((end) => end.chain.length)) {
      diagnostics.push(
        `Native ${relation.metaclass} ${relation.id} does not have two resolved ends.`,
      );
      return;
    }
    if (relation.unresolvedGuardIds?.length) {
      diagnostics.push(
        `Guard expression not rendered for ${relation.id}: ${
          relation.unresolvedGuardIds.join(", ")
        }`,
      );
    }
    for (const owner of owners) {
      const source = resolve(ends[0].chain, owner);
      const target = resolve(ends[1].chain, owner);
      if (!source || !target) {
        diagnostics.push(
          `Unresolved native ${relation.metaclass} ${relation.id} in ${owner.id}`,
        );
        continue;
      }
      const kind =
        relation.isNegated && relation.metaclass === "SatisfyRequirementUsage"
          ? "not-satisfies"
          : relationKind(relation.metaclass);
      const label = relation.event
        ? `${relation.event}${relation.guard ? ` [${relation.guard}]` : ""}`
        : relation.guard || relation.label ||
          (kind === "satisfies" ? "declared satisfies" : "");
      addEdge(
        source,
        target,
        kind,
        relation.id,
        relation.metaclass,
        label,
        {
          ...(relation.event ? { event: relation.event } : {}),
          ...(relation.triggerIds?.length
            ? { triggerIds: relation.triggerIds }
            : {}),
          ...(relation.eventTypeIds?.length
            ? { eventTypeIds: relation.eventTypeIds }
            : {}),
          ...(relation.sourceEvidenceIds?.length
            ? { sourceEvidenceIds: relation.sourceEvidenceIds }
            : {}),
          ...(kind === "satisfies" || kind === "not-satisfies"
            ? { satisfaction: "declared" as const }
            : {}),
          sourceFeaturePath: ends[0].chain.map((link) => link.id),
          targetFeaturePath: ends[1].chain.map((link) => link.id),
          ...(relation.guard ? { guard: relation.guard } : {}),
          ...(relation.guardIds?.length ? { guardIds: relation.guardIds } : {}),
        },
      );
      if (kind === "allocation") {
        const action = source.dimension === "behavior"
          ? source
          : target.dimension === "behavior"
          ? target
          : undefined;
        const part = category(source.metaclass) === "part"
          ? source
          : category(target.metaclass) === "part"
          ? target
          : undefined;
        if (action && part) {
          action.performerLabels = [
            ...new Set([...(action.performerLabels ?? []), part.label]),
          ];
        }
      }
    }
  };
  const transitionSuccessions = new Set(
    (native.relations ?? []).map((relation) => relation.successionId).filter(
      Boolean,
    ),
  );
  for (const connector of snapshot.connectors) {
    if (transitionSuccessions.has(connector.id)) continue;
    bindRelation({
      id: connector.id,
      metaclass: connector.metaclass,
      ownerId: connector.ownerId,
      sourceId: "",
      targetId: "",
      label: connector.name,
    }, connector.ends);
  }
  for (const relation of native.relations ?? []) {
    // A self-performing usage needs no second node; its native containment and
    // typing already retain its meaning and identity.
    if (
      relation.metaclass === "PerformActionUsage" &&
      relation.sourceId === relation.targetId
    ) continue;
    bindRelation(
      relation,
      [relation.sourceId, relation.targetId].map((id) => ({
        chain: [{ id, name: "" }],
      })),
    );
  }
  const packages = snapshot.elements.filter((e) =>
    /^(Library)?Package$/.test(e.metaclass)
  ).map((e) => ({ id: e.id, label: e.name }));
  return {
    title,
    sourceFile: projectLabel,
    projectionNote:
      "Native SysML usages expanded through their declared types; definitions remain a separate library. Relations and guards retain native source identities.",
    nodes,
    edges,
    packages,
    scopes: [
      {
        id: "all",
        label: "Whole model",
        nodeIds: nodes.map((node) => node.id),
      },
      ...packages.map((pkg) => ({
        id: pkg.id,
        label: pkg.label,
        nodeIds: nodes.filter((node) => node.packageId === pkg.id).map((node) =>
          node.id
        ),
      })),
    ],
    levels: [{
      id: "0",
      label: "Model",
      maxLevel: Math.max(0, ...nodes.map((node) => node.level)),
    }],
    diagnostics: [...new Set(diagnostics)],
  };
}
