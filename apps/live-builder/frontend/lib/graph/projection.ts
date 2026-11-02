import type {
  GraphEdge,
  GraphNode,
  MandateAnnotation,
  NativeModelView,
  OperatorAnnotation,
} from "./types.ts";

export const isSuccession = (edge: Pick<GraphEdge, "kind">): boolean =>
  /succession|transition/.test(edge.kind || "");
export const isFlow = (edge: Pick<GraphEdge, "kind">): boolean =>
  /flow/.test(edge.kind || "");

/** Pure projections of native facts, shared by the Preact view and its tests. */
export const kind = (node: GraphNode | undefined): string =>
  String(node?.nativeKind || node?.kind || node?.metaclass || "").toLowerCase();
export const isDefinition = (node: GraphNode): boolean =>
  node.role === "definition" || /definition/.test(kind(node));
export const isPort = (node: GraphNode): boolean =>
  node.category === "port" || /port-usage|portusage/.test(kind(node));
export const isItem = (node: GraphNode): boolean =>
  ["item", "attribute"].includes(node.category || "") ||
  /item-usage|itemusage|attribute-usage|attributeusage/.test(kind(node));
export const isPart = (node: GraphNode | undefined): boolean =>
  ["part", "use-case"].includes(node?.category || "") ||
  /part-usage|partusage/.test(kind(node));
export const isAction = (node: GraphNode): boolean =>
  node.category === "action" ||
  /action-usage|actionusage|decision-node|decisionnode|merge-node|mergenode|fork-node|forknode|join-node|joinnode|initial-node|initialnode|final-node|finalnode/
    .test(kind(node));
export const isControl = (node: GraphNode): boolean =>
  /decision|merge|fork|join|initial|final/.test(kind(node));
export const isState = (node: GraphNode): boolean =>
  node.stateRole === "initial" || node.category === "state" ||
  /state-usage|stateusage/.test(kind(node));
export const display = (node: GraphNode | undefined): string =>
  String(node?.label || node?.name || node?.symbol || node?.id || "");
export const stageOf = (node: GraphNode): string =>
  !isDefinition(node)
    ? String(node.runtimeStage || node.modelStage || "").toLowerCase()
    : "";

export function terminalIds(nodes: GraphNode[]): Set<string> {
  const hidden = new Set(
    nodes.filter((node) => ["refused", "failed"].includes(stageOf(node))).map((
      node,
    ) => node.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!hidden.has(node.id) && hidden.has(node.parentId || "")) {
        hidden.add(node.id);
        changed = true;
      }
    }
  }
  return hidden;
}

export function judgmentOperator(
  node: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): OperatorAnnotation | null {
  const operator = node.operator;
  if (
    node.role === "definition" || !operator ||
    operator.nativeId !== node.nativeId ||
    !Array.isArray(operator.depictedJudgmentRefs) ||
    !operator.depictedJudgmentRefs.length
  ) return null;
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const proved = operator.depictedJudgmentRefs.every((ref) =>
    typeof ref === "string" && edges.some((edge) => {
      if (edge.kind !== "allocation") return false;
      const source = byId.get(edge.source), target = byId.get(edge.target);
      if (!source || !target) return false;
      return (source.nativeId === ref && target.nativeId === node.nativeId) ||
        (target.nativeId === ref && source.nativeId === node.nativeId);
    })
  );
  return proved ? operator : null;
}

export function documentedMandate(
  node: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): MandateAnnotation | null {
  const mandate = node.mandate;
  if (
    !judgmentOperator(node, nodes, edges) || !mandate ||
    mandate.evidenceLevel !== "configured" ||
    mandate.holderNativeId !== node.nativeId || !mandate.id ||
    !mandate.version || !mandate.scopeLabel ||
    !Array.isArray(mandate.allowedChoices) || !mandate.allowedChoices.length ||
    !Array.isArray(mandate.sourceRefs) || !mandate.sourceRefs.length
  ) return null;
  const nativeRecord = nodes.some((entry) =>
    entry.nativeId === mandate.nativeId && entry.role !== "definition" &&
    (entry.category === "item" ||
      /item-usage|itemusage/i.test(entry.kind || entry.metaclass || ""))
  );
  return nativeRecord ? mandate : null;
}

export interface AllocatedContent {
  actions: GraphNode[];
  outputs: GraphNode[];
  owner: Map<string, string>;
  edges: GraphEdge[];
}

export function allocatedNativeContent(
  nodes: GraphNode[],
  edges: GraphEdge[],
  operatorIds: string[],
): AllocatedContent {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const holders = new Set(operatorIds), actions = new Map<string, GraphNode>();
  const owner = new Map<string, string>(), allocations: GraphEdge[] = [];
  const action = (node: GraphNode | undefined): node is GraphNode =>
    !!node && node.role !== "definition" &&
    /action-usage|actionusage/i.test(node.kind || node.metaclass || "");
  for (const edge of edges) {
    if (edge.kind !== "allocation") continue;
    const source = byId.get(edge.source), target = byId.get(edge.target);
    let usage: GraphNode, holder: string;
    if (action(source) && holders.has(edge.target)) {
      usage = source;
      holder = edge.target;
    } else if (action(target) && holders.has(edge.source)) {
      usage = target;
      holder = edge.source;
    } else continue;
    actions.set(usage.id, usage);
    owner.set(usage.id, holder);
    allocations.push(edge);
  }
  const outputs = nodes.filter((node) =>
    node.role !== "definition" && node.category === "item" &&
    actions.has(node.parentId || "") &&
    (node.effectiveDirection || node.declaredDirection) === "out"
  );
  const outputIds = new Set(outputs.map((node) => node.id));
  const ownership = edges.filter((edge) =>
    edge.kind === "owns" && actions.has(edge.source) &&
    outputIds.has(edge.target)
  );
  return {
    actions: [...actions.values()],
    outputs,
    owner,
    edges: allocations.concat(ownership),
  };
}

export function configuredInvocationLinks(
  nodes: GraphNode[],
  edges: GraphEdge[],
  content: AllocatedContent,
): GraphEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: GraphEdge[] = [];
  for (const action of content.actions) {
    const holder = byId.get(content.owner.get(action.id) || "");
    if (!holder || action.label !== "invokeRequest") continue;
    const mandate = documentedMandate(holder, nodes, edges);
    if (!mandate) continue;
    const typed = action.typeName === "RequestToolInvocation" ||
      edges.some((edge) =>
        ["typing", "feature-typing"].includes(edge.kind) &&
        edge.source === action.id &&
        byId.get(edge.target)?.label === "RequestToolInvocation"
      );
    if (!typed) continue;
    for (const binding of holder.operator?.capabilityBindings || []) {
      if (
        binding.relationship !== "may-invoke" ||
        binding.evidenceLevel !== "configured" ||
        !Array.isArray(binding.sourceRefs) || !binding.sourceRefs.length
      ) continue;
      const target = nodes.find((node) =>
        node.role !== "definition" && node.nativeId === binding.nativeId &&
        node.runtimeStage === "active"
      );
      if (!target) continue;
      links.push({
        id: "configured-invoke:" + action.id + ":" + target.id,
        source: action.id,
        target: target.id,
        kind: "configured-permission",
        label: "authorized call (configuration)",
        displayOnly: true,
        origin: "presentation",
        description:
          "Configured right documented for this native request and this active tool. Admission and execution are established separately.",
        sourceEvidence: {
          mandateId: mandate.id,
          holderNativeId: holder.nativeId,
          actionNativeId: action.nativeId,
          toolNativeId: target.nativeId,
          sourceRefs: binding.sourceRefs,
          evidenceLevel: "configured",
        },
      });
    }
  }
  return links;
}

export interface NativeViewGroup {
  view: NativeModelView;
  ids: Set<string>;
}
export interface NativeViewPlan {
  overview: NativeModelView;
  groups: NativeViewGroup[];
  selectedIds: Set<string>;
  parentByNode: Map<string, string>;
  parentByView: Map<string, string>;
  ambiguousIds: string[];
  ambiguousViewIds: string[];
}

export function planNativeViews(
  nodes: GraphNode[],
  views: NativeModelView[] | undefined,
): NativeViewPlan | null {
  const records = (Array.isArray(views) ? views : []).filter((view) =>
    view?.nativeId && view.id === "view:" + view.nativeId &&
    Array.isArray(view.members)
  );
  const byView = new Map(records.map((view) => [view.id, view]));
  if (byView.size !== records.length) return null;
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map(records.map((view) => [
    view.id,
    new Set(
      view.members.filter((member) =>
        member.resolution === "resolved" &&
        byView.has(member.nestedViewId || "")
      ).map((member) => member.nestedViewId!),
    ),
  ]));
  const nestedIds = new Set([...children.values()].flatMap((ids) => [...ids]));
  const roots = records.filter((view) =>
    !nestedIds.has(view.id) && children.get(view.id)!.size >= 1
  );
  if (roots.length !== 1) return null;
  const overview = roots[0], groups: NativeViewGroup[] = [];
  const selectedIds = new Set<string>(),
    occurrences = new Map<string, Set<string>>(),
    viewParents = new Map<string, Set<string>>();
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (view: NativeModelView): boolean => {
    if (visiting.has(view.id)) return false;
    if (visited.has(view.id)) return true;
    visiting.add(view.id);
    const ids = new Set<string>();
    for (const member of view.members) {
      if (member.resolution !== "resolved" || member.nestedViewId) continue;
      for (const id of member.graphNodeIds || []) {
        const node = byNode.get(id);
        if (node && node.role !== "definition") {
          ids.add(id);
          selectedIds.add(id);
          const owners = occurrences.get(id) ?? new Set<string>();
          owners.add(view.id);
          occurrences.set(id, owners);
        }
      }
    }
    if (view.id !== overview.id) groups.push({ view, ids });
    for (const childId of children.get(view.id)!) {
      const parents = viewParents.get(childId) ?? new Set<string>();
      parents.add(view.id);
      viewParents.set(childId, parents);
      if (!visit(byView.get(childId)!)) return false;
    }
    visiting.delete(view.id);
    visited.add(view.id);
    return true;
  };
  // A cyclic expose relation cannot define a compound hierarchy. Fall back to
  // the native graph rather than inventing an ordering or a missing frame.
  if (!visit(overview)) return null;
  const parentByNode = new Map<string, string>();
  for (const [id, parents] of occurrences) {
    if (parents.size === 1 && !parents.has(overview.id)) {
      parentByNode.set(id, [...parents][0]);
    }
  }
  const parentByView = new Map<string, string>();
  for (const [id, parents] of viewParents) {
    if (parents.size === 1 && !parents.has(overview.id)) {
      parentByView.set(id, [...parents][0]);
    }
  }
  return {
    overview,
    groups,
    selectedIds,
    parentByNode,
    parentByView,
    ambiguousIds: [...occurrences].filter(([, parents]) => parents.size > 1)
      .map(([id]) => id),
    ambiguousViewIds: [...viewParents].filter(([, parents]) => parents.size > 1)
      .map(([id]) => id),
  };
}

export function mandateScopeForView(
  group: NativeViewGroup,
  plan: Pick<NativeViewPlan, "parentByNode">,
  nodes: GraphNode[],
  edges: GraphEdge[],
):
  | { holder: GraphNode; mandate: MandateAnnotation; actions: GraphNode[] }
  | null {
  if (
    group.view.members.some((member) =>
      member.resolution !== "resolved" || member.nestedViewId
    )
  ) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const members: GraphNode[] = [];
  for (const id of group.ids) {
    const node = byId.get(id);
    if (!node || plan.parentByNode.get(node.id) !== group.view.id) return null;
    members.push(node);
  }
  const holders = members.filter((node) =>
    judgmentOperator(node, nodes, edges)
  );
  if (holders.length !== 1) return null;
  const holder = holders[0], mandate = documentedMandate(holder, nodes, edges);
  if (!mandate) return null;
  const actions = members.filter((node) =>
    node.role !== "definition" &&
    /action-usage|actionusage/i.test(node.kind || node.metaclass || "")
  );
  if (!actions.length) return null;
  const actionIds = new Set(actions.map((action) => action.id));
  for (const action of actions) {
    const allocated = edges.filter((edge) =>
      edge.kind === "allocation" &&
      (edge.source === action.id || edge.target === action.id)
    );
    if (
      allocated.length !== 1 ||
      !allocated.some((edge) =>
        (edge.source === action.id ? edge.target : edge.source) === holder.id
      )
    ) return null;
  }
  if (
    members.some((node) =>
      node.id !== holder.id && !actionIds.has(node.id) &&
      !(node.category === "item" && actionIds.has(node.parentId || "") &&
        (node.effectiveDirection || node.declaredDirection) === "out")
    )
  ) return null;
  return { holder, mandate, actions };
}

export interface NativeFlowScope {
  scope: GraphNode;
  typeName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function nativeFlowScopes(
  nodes: GraphNode[],
  edges: GraphEdge[],
): NativeFlowScope[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const perform = (node: GraphNode): boolean =>
    node.role !== "definition" &&
    /perform-action-usage|performactionusage/.test(kind(node));
  const action = (node: GraphNode): boolean =>
    node.role !== "definition" && (node.category === "action" ||
      /action-usage|actionusage|decision|merge|fork|join|initial-node|final-node/
        .test(kind(node)));
  const state = (node: GraphNode): boolean =>
    !!node.stateRole || node.category === "state" ||
    /state-usage|stateusage/.test(kind(node));
  const owner = (node: GraphNode): string | null => {
    const seen = new Set<string>();
    let parent = byId.get(node.parentId || "");
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (state(parent)) return null;
      if (perform(parent)) return parent.id;
      parent = byId.get(parent.parentId || "");
    }
    return null;
  };
  const scopes: NativeFlowScope[] = [];
  for (const scope of nodes.filter(perform)) {
    const candidates = nodes.filter((node) =>
      action(node) && !state(node) && owner(node) === scope.id
    );
    const ids = new Set(candidates.map((node) => node.id));
    const successions = edges.filter((edge) =>
      /succession|transition/.test(edge.kind || "") && ids.has(edge.source) &&
      ids.has(edge.target)
    );
    if (!successions.length) continue;
    const linked = new Set(
      successions.flatMap((edge) => [edge.source, edge.target]),
    );
    scopes.push({
      scope,
      typeName: typeLabel(scope, nodes, edges),
      nodes: candidates.filter((node) => linked.has(node.id)),
      edges: successions,
    });
  }
  return scopes;
}

export function flowCycleBreak<
  T extends Pick<GraphEdge, "id" | "source" | "target">,
>(
  nodeIds: string[],
  edges: T[],
): { feedbackEdgeIds: Set<string>; layoutEdges: T[] } {
  const ids = new Set(nodeIds),
    outgoing = new Map(nodeIds.map((id) => [id, [] as T[]]));
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const color = new Map<string, number>(), feedback = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const edge of outgoing.get(id)!) {
      if (color.get(edge.target) === 1) feedback.add(edge.id);
      else if (!color.has(edge.target)) visit(edge.target);
    }
    color.set(id, 2);
  };
  for (const id of nodeIds.filter((id) => !incoming.get(id)).concat(nodeIds)) {
    if (!color.has(id)) visit(id);
  }
  return {
    feedbackEdgeIds: feedback,
    layoutEdges: edges.filter((edge) => !feedback.has(edge.id)),
  };
}

export type ScaffoldMode = "instances" | "library";
export function nativeScaffoldNodes(
  nodes: GraphNode[],
  dimension: string,
  mode?: ScaffoldMode | null,
): {
  mode: ScaffoldMode;
  nodes: GraphNode[];
  library: GraphNode[];
  usages: GraphNode[];
} {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const root = (node: GraphNode): boolean =>
    dimension === "state-transition"
      ? /state-definition|statedefinition/.test(kind(node))
      : /requirement-definition|requirementdefinition/.test(kind(node));
  const inLibrary = (node: GraphNode): boolean => {
    const seen = new Set<string>();
    let cursor: GraphNode | undefined = node;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (root(cursor)) return true;
      cursor = map.get(cursor.parentId || "");
    }
    return false;
  };
  const library = nodes.filter(inLibrary),
    usages = nodes.filter((node) =>
      !inLibrary(node) && !isDefinition(node) &&
      (dimension === "state-transition"
        ? isState(node) ||
          /exhibit-state-usage|exhibitstateusage/.test(kind(node))
        : node.dimension === "requirements" || /requirement/.test(kind(node)))
    );
  const selected = mode || (usages.length ? "instances" : "library");
  return {
    mode: selected,
    nodes: selected === "library" ? library : usages,
    library,
    usages,
  };
}

export function typeLabel(
  node: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): string {
  const relation = edges.find((edge) =>
    ["typing", "feature-typing"].includes(edge.kind) && edge.source === node.id
  );
  return node.typeName || node.typeLabel ||
    nodes.find((entry) => entry.id === relation?.target)?.label || "";
}

/**
 * A native `ASEInvocations::BehaviorAccess` usage. Detection follows the
 * existing typing evidence (`typeName` or the `typing` edge to the
 * `BehaviorAccess` definition), never the display label: every access is a
 * `PartUsage`, so kind/metaclass alone cannot distinguish it. Definitions
 * themselves are never accesses.
 */
export const isBehaviorAccess = (
  node: GraphNode | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
): boolean =>
  !!node && node.role !== "definition" &&
  typeLabel(node, nodes, edges).split("::").at(-1) === "BehaviorAccess";

/**
 * Strict descendants of every BehaviorAccess, mapped to their access.
 * The access itself is never hidden, so each access stays visible as a
 * leaf; `caller`/`target`/`input` remain in the native graph (inspector,
 * other views) and are only factored out of structural projections.
 */
export function behaviorAccessDescendants(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const accesses = new Set(
    nodes.filter((node) => isBehaviorAccess(node, nodes, edges)).map((node) =>
      node.id
    ),
  );
  const descendants = new Map<string, string>();
  if (!accesses.size) return descendants;
  for (const node of nodes) {
    if (accesses.has(node.id)) continue;
    const seen = new Set<string>();
    let cursor = byId.get(node.parentId || "");
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (accesses.has(cursor.id)) {
        descendants.set(node.id, cursor.id);
        break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return descendants;
}

export function structuralOwnership(
  node: GraphNode | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
): boolean {
  const map = new Map(nodes.map((entry) => [entry.id, entry])),
    seen = new Set<string>();
  let cursor = node, ownsPart = false;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (
      isAction(cursor) || isState(cursor) ||
      ["behavior", "requirements", "constraints"].includes(
        cursor.dimension || "",
      ) ||
      /requirement|constraint/.test(kind(cursor)) ||
      typeLabel(cursor, nodes, edges) === "ConfiguredMandate"
    ) return false;
    if (isPart(cursor)) ownsPart = true;
    cursor = map.get(cursor.parentId || "");
  }
  return ownsPart;
}

export function owningPort(
  node: GraphNode,
  nodes: GraphNode[],
): GraphNode | null {
  const map = new Map(nodes.map((entry) => [entry.id, entry])),
    seen = new Set<string>();
  let parent = map.get(node.parentId || "");
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (isPort(parent)) return parent;
    if (isPart(parent)) return null;
    parent = map.get(parent.parentId || "");
  }
  return null;
}

export const nativeContext = (
  node: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): boolean =>
  !isDefinition(node) &&
  /perform-action-usage|performactionusage/.test(kind(node)) &&
  typeLabel(node, nodes, edges).split("::").at(-1) === "ConversationCase";

export function nativeStructure(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ports = false,
): GraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const structural = nodes.filter((node) =>
    !isDefinition(node) && structuralOwnership(node, nodes, edges) &&
    (isPart(node) || ports && isPort(node) ||
      isItem(node) && isPart(byId.get(node.parentId || "")) &&
        !owningPort(node, nodes))
  );
  const contexts = nodes.filter((node) => nativeContext(node, nodes, edges));
  const policies = nodes.filter((node) =>
    !isDefinition(node) && isItem(node) && contexts.some((owner) =>
      owner.id === node.parentId
    ) &&
    typeLabel(node, nodes, edges).split("::").at(-1) === "ExecutionPolicy"
  );
  const owners = new Set(policies.map((node) => node.parentId));
  return structural.concat(
    contexts.filter((node) => owners.has(node.id)),
    policies,
  );
}
