import type { ElementDefinition } from "cytoscape";
import type { GraphData, GraphEdge, GraphNode } from "./types.ts";
import {
  allocatedNativeContent,
  behaviorAccessDescendants,
  configuredInvocationLinks,
  display,
  documentedMandate,
  isAction,
  isBehaviorAccess,
  isControl,
  isDefinition,
  isFlow,
  isItem,
  isPart,
  isPort,
  isState,
  isSuccession,
  judgmentOperator,
  kind,
  mandateScopeForView,
  nativeContext,
  nativeFlowScopes,
  nativeScaffoldNodes,
  nativeStructure,
  planNativeViews,
  stageOf,
  structuralOwnership,
  terminalIds,
  typeLabel,
} from "./projection.ts";

export const viewNames = [
  "action-flow",
  "interconnection",
  "general",
  "state-transition",
  "requirements",
  "sequence",
] as const;
export type DiagramView = typeof viewNames[number];
export const viewLabels: Record<DiagramView, string> = {
  "action-flow": "Action Flow",
  interconnection: "Interconnection",
  general: "General",
  "state-transition": "State Transition",
  requirements: "Requirements",
  sequence: "Sequence",
};
export const stageLabels: Record<string, string> = {
  proposed: "proposed",
  testing: "in testing",
  reviewing: "in review",
  activating: "integrating",
  active: "active",
  refused: "refused",
  failed: "interrupted",
};
export const edgeLabels: Record<string, string> = {
  owns: "contains",
  typing: "typed by",
  "feature-typing": "typed by",
  specialization: "specializes",
  connection: "connection",
  binding: "=",
  "field-binding": "=",
  succession: "succession",
  flow: "flow",
  allocation: "allocation",
  perform: "perform",
  satisfy: "satisfied",
  satisfies: "satisfied",
};
const inFlight = new Set(["proposed", "testing", "reviewing", "activating"]);
export interface DiagramOptions {
  view: DiagramView;
  filter: "usages" | "definitions" | "definitions-only" | "constraints";
  showData: boolean;
  showAllocated: boolean;
  showTerminal: boolean;
  flowScopeId: string | null;
  stateScopeId: string | null;
  scaffoldMode: "instances" | "library" | null;
  sequenceId: string | null;
}
export function defaultDiagramOptions(): DiagramOptions {
  return {
    view: "action-flow",
    filter: "usages",
    showData: false,
    showAllocated: true,
    showTerminal: false,
    flowScopeId: null,
    stateScopeId: null,
    scaffoldMode: null,
    sequenceId: null,
  };
}
export const emptyGraph: GraphData = { nodes: [], edges: [] };

/** Presentation queries are isolated from the graph renderer and application model. */
export class DiagramModel {
  constructor(readonly graph: GraphData, readonly options: DiagramOptions) {}
  get nodes(): GraphNode[] {
    if (this.options.showTerminal) return this.graph.nodes;
    const hidden = terminalIds(this.graph.nodes);
    return this.graph.nodes.filter((node) => !hidden.has(node.id));
  }
  get map(): Map<string, GraphNode> {
    const views: GraphNode[] = (this.graph.views || []).map((view) => ({
      id: view.id,
      nativeId: view.nativeId,
      label: view.label,
      ownerNativeId: view.ownerNativeId,
      role: "usage",
      category: "view",
      kind: "view-usage",
      metaclass: "ViewUsage",
      viewMembers: view.members,
      sourceEvidence: view.sourceEvidenceIds,
    }));
    return new Map(
      [...this.graph.nodes, ...views].map((node) => [node.id, node]),
    );
  }
  type(node: GraphNode): string {
    return typeLabel(node, this.graph.nodes, this.graph.edges);
  }
  operator(node: GraphNode) {
    return judgmentOperator(node, this.graph.nodes, this.graph.edges);
  }
  mandate(node: GraphNode) {
    return documentedMandate(node, this.graph.nodes, this.graph.edges);
  }
  get flowScopes() {
    return nativeFlowScopes(this.nodes, this.graph.edges);
  }
  get flowScope() {
    const scopes = this.flowScopes;
    return scopes.find((entry) =>
      entry.scope.id === this.options.flowScopeId
    ) ||
      scopes.find((entry) =>
        entry.typeName.split("::").at(-1) === "ConversationCase"
      ) || scopes[0];
  }
  get scaffold() {
    return nativeScaffoldNodes(
      this.nodes,
      this.options.view,
      this.options.scaffoldMode,
    );
  }
  get stateScopes() {
    return nativeScaffoldNodes(
      this.nodes,
      "state-transition",
      this.options.scaffoldMode,
    ).nodes.filter((node) =>
      /exhibit-state-usage|exhibitstateusage|state-definition|statedefinition/
        .test(kind(node))
    );
  }
  get stateScope() {
    return this.stateScopes.find((node) =>
      node.id === this.options.stateScopeId
    ) || this.stateScopes[0];
  }
  get viewPlan() {
    return planNativeViews(this.nodes, this.graph.views || []);
  }
  get allocated() {
    return allocatedNativeContent(
      this.nodes,
      this.graph.edges,
      this.nodes.filter((node) => this.operator(node)).map((node) => node.id),
    );
  }
  context(node: GraphNode): boolean {
    return nativeContext(node, this.graph.nodes, this.graph.edges);
  }
  allocationLabels(node: GraphNode): string[] {
    if (node.performerLabels) return node.performerLabels;
    if (node.allocatedTo) {
      return node.allocatedTo.map((entry) =>
        typeof entry === "string"
          ? (this.map.has(entry) ? display(this.map.get(entry)!) : entry)
          : entry.label || ""
      ).filter(Boolean);
    }
    return this.graph.edges.filter((edge) =>
      /allocation/.test(edge.kind) &&
      (edge.source === node.id || edge.target === node.id)
    ).map((edge) =>
      this.map.get(edge.source === node.id ? edge.target : edge.source)
    ).filter((node): node is GraphNode => Boolean(node)).filter(isPart).map(
      display,
    );
  }
  /**
   * Interconnection/General factor each BehaviorAccess into a single leaf:
   * its `caller`/`target`/`input` descendants leave these two projections
   * only. The native graph is untouched, so the inspector and the other
   * views (action-flow, state, requirements) still reach every child.
   */
  #withoutBehaviorAccessDescendants(nodes: GraphNode[]): GraphNode[] {
    const descendants = behaviorAccessDescendants(
      this.nodes,
      this.graph.edges,
    );
    return descendants.size
      ? nodes.filter((node) => !descendants.has(node.id))
      : nodes;
  }
  get visibleNodes(): GraphNode[] {
    const { view, filter, showData, showAllocated } = this.options;
    const nodes = this.nodes;
    if (view === "sequence") {
      return nodes.filter((node) =>
        (this.graph.sequences || []).some((sequence) => sequence.id === node.id)
      );
    }
    if (view === "action-flow") {
      const steps = this.flowScope?.nodes || [];
      if (!showData) return steps;
      const actionIds = new Set(steps.map((node) => node.id)),
        dataIds = new Set<string>();
      for (const edge of this.graph.edges) {
        if (
          isFlow(edge) &&
          (actionIds.has(edge.source) || actionIds.has(edge.target))
        ) {
          dataIds.add(edge.source);
          dataIds.add(edge.target);
        }
      }
      return nodes.filter((node) =>
        actionIds.has(node.id) ||
        (!isDefinition(node) && isItem(node) && dataIds.has(node.id))
      );
    }
    if (view === "interconnection") {
      return this.#withoutBehaviorAccessDescendants(
        nativeStructure(nodes, this.graph.edges, true),
      );
    }
    if (view === "state-transition") {
      const states = this.scaffold.nodes.filter((node) =>
        isState(node) && !/state-definition|statedefinition/.test(kind(node))
      );
      const parents = new Set(states.map((node) => node.parentId)),
        scope = this.stateScope;
      return states.filter((node) => {
        if (parents.has(node.id) || node.id === scope?.id) return false;
        if (!scope) return true;
        let cursor: GraphNode | undefined = node;
        const seen = new Set<string>();
        while (cursor && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          if (cursor.parentId === scope.id) return true;
          cursor = cursor.parentId ? this.map.get(cursor.parentId) : undefined;
        }
        return false;
      });
    }
    if (view === "requirements") return this.scaffold.nodes;
    // Remaining branches are the General view (all filters).
    if (filter === "definitions-only") {
      return this.#withoutBehaviorAccessDescendants(
        nodes.filter(isDefinition),
      );
    }
    if (filter === "constraints") {
      return this.#withoutBehaviorAccessDescendants(
        nodes.filter((node) =>
          node.category === "constraint" || node.dimension === "constraints" ||
          /constraint/.test(kind(node))
        ),
      );
    }
    const structure = nativeStructure(nodes, this.graph.edges);
    if (filter === "definitions") {
      return this.#withoutBehaviorAccessDescendants(
        structure.concat(nodes.filter(isDefinition)),
      );
    }
    if (!showAllocated) {
      return this.#withoutBehaviorAccessDescendants(structure);
    }
    const content = this.allocated, plan = this.viewPlan;
    const exposedActions = plan
      ? nodes.filter((node) =>
        plan.selectedIds.has(node.id) && !isDefinition(node) && isAction(node)
      )
      : [];
    const visible = structure.concat(content.actions, exposedActions).filter((
      node,
    ) =>
      !isAction(node) || this.context(node) || !plan ||
      plan.selectedIds.has(node.id)
    );
    const actions = new Set(visible.filter(isAction).map((node) => node.id));
    return this.#withoutBehaviorAccessDescendants(
      visible.concat(
        nodes.filter((node) =>
          !isDefinition(node) && node.category === "item" &&
          (node.effectiveDirection || node.declaredDirection) === "out" &&
          Boolean(node.parentId && actions.has(node.parentId))
        ),
      ).filter((node, index, all) =>
        all.findIndex((other) => other.id === node.id) === index
      ),
    );
  }
  projectedConnections(nodes = this.visibleNodes): GraphEdge[] {
    const ids = new Set(nodes.map((node) => node.id)),
      currentIds = new Set(this.nodes.map((node) => node.id));
    const partFor = (id: string) => {
      let node = this.map.get(id);
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (ids.has(node.id) && isPart(node)) return node;
        node = node.parentId ? this.map.get(node.parentId) : undefined;
      }
      return null;
    };
    return this.graph.edges.filter((edge) =>
      edge.kind === "connection" && currentIds.has(edge.source) &&
      currentIds.has(edge.target) &&
      structuralOwnership(
        this.map.get(edge.source),
        this.graph.nodes,
        this.graph.edges,
      ) &&
      structuralOwnership(
        this.map.get(edge.target),
        this.graph.nodes,
        this.graph.edges,
      )
    ).flatMap((edge) => {
      const source = partFor(edge.source), target = partFor(edge.target);
      if (!source || !target || source.id === target.id) return [];
      const from = this.map.get(edge.source)!, to = this.map.get(edge.target)!;
      return [{
        ...edge,
        source: source.id,
        target: target.id,
        label: `${display(from)} — ${display(to)}`,
        projection: {
          kind: "port-owner-connection",
          nativeSource: edge.source,
          nativeTarget: edge.target,
          relationshipId: edge.nativeId || edge.id,
          sourceFeaturePath: edge.sourceFeaturePath || from.symbol,
          targetFeaturePath: edge.targetFeaturePath || to.symbol,
        },
      }];
    });
  }
  /**
   * Bindings touching a factored BehaviorAccess child are re-anchored on
   * the access itself, mirroring how `projectedConnections` re-anchors
   * port connections on their part owner. `owns`/`typing` edges of hidden
   * children are not re-anchored: they describe the child and remain
   * available from the native graph through the inspector.
   */
  projectedBehaviorBindings(edges: GraphEdge[]): GraphEdge[] {
    const descendants = behaviorAccessDescendants(
      this.nodes,
      this.graph.edges,
    );
    if (!descendants.size) return edges;
    return edges.flatMap((edge) => {
      if (!["binding", "field-binding"].includes(edge.kind)) return [edge];
      const source = descendants.get(edge.source) || edge.source,
        target = descendants.get(edge.target) || edge.target;
      if (source === edge.source && target === edge.target) return [edge];
      if (source === target) return [];
      return [{
        ...edge,
        source,
        target,
        projection: {
          kind: "behavior-access-binding",
          nativeSource: edge.source,
          nativeTarget: edge.target,
          relationshipId: edge.nativeId || edge.id,
        },
      }];
    });
  }
  get edges(): GraphEdge[] {
    const { view, filter, showAllocated } = this.options;
    if (view === "interconnection") {
      return this.projectedBehaviorBindings(this.graph.edges);
    }
    if (view !== "general" || !["usages", "definitions"].includes(filter)) {
      return this.graph.edges;
    }
    let edges = this.projectedConnections().concat(
      this.projectedBehaviorBindings(
        this.graph.edges.filter((edge) =>
          ["binding", "field-binding"].includes(edge.kind)
        ),
      ),
    );
    if (filter === "definitions") {
      return edges.concat(
        this.graph.edges.filter((edge) =>
          ["typing", "feature-typing"].includes(edge.kind)
        ),
      );
    }
    if (showAllocated) {
      edges = edges.concat(
        this.allocated.edges,
        configuredInvocationLinks(this.nodes, this.graph.edges, this.allocated),
      );
    }
    return edges;
  }
  allowed(edge: GraphEdge): boolean {
    const { view, showAllocated, showData } = this.options;
    if (edge.kind === "owns") return view === "general" && showAllocated;
    if (view === "action-flow") {
      return isSuccession(edge) || (showData && isFlow(edge));
    }
    if (view === "interconnection") {
      return ["connection", "binding", "field-binding", "flow"].includes(
        edge.kind,
      );
    }
    if (view === "state-transition") return isSuccession(edge);
    return true;
  }
  nodeLabel(node: GraphNode): string {
    const { view } = this.options;
    if (
      view === "interconnection" && isPort(node) ||
      view === "general" && isAction(node)
    ) return display(node);
    let label = display(node);
    if (view === "state-transition" && node.observedState) {
      label += "\ncurrent state";
    }
    const stage = stageOf(node);
    if (inFlight.has(stage)) {
      label += `\nUnder construction · ${stageLabels[stage] || stage}`;
    } else if (stage) label += `\n${stageLabels[stage] || stage}`;
    const type = this.type(node);
    if (
      ["interconnection", "general"].includes(view) && type && type !== label
    ) label += `\n: ${type}`;
    const roles = this.allocationLabels(node);
    if (isAction(node) && roles.length) label += `\n${roles.join(", ")}`;
    const patterns = node.patternAnnotations || node.annotations;
    if (isPart(node) && patterns?.length) {
      label += `\n«${
        patterns.map((pattern) =>
          typeof pattern === "string"
            ? pattern
            : pattern.label || pattern.name || ""
        ).filter(Boolean).join(", ")
      }»`;
    }
    return label;
  }
  edgeLabel(edge: GraphEdge): string {
    const { view } = this.options;
    const guard = edge.guard ? guardCaption(edge.guard) : "";
    if (view === "general" && edge.kind === "allocation") return "allocation";
    if (view === "general" && edge.kind === "owns") return "declared output";
    if (
      ["general", "interconnection"].includes(view) &&
      edge.kind === "connection" &&
      (!edge.label || /^(connection|connexion)$/i.test(edge.label.trim()))
    ) return "";
    if (view === "state-transition") {
      return String(
        edge.trigger || edge.event || edge.triggerLabel || edge.eventLabel ||
          (edge.label && !["succession", "transition"].includes(edge.label)
            ? edge.label
            : ""),
      ) + (guard ? ` ${guard}` : "");
    }
    if (guard) return guard;
    if (["binding", "field-binding"].includes(edge.kind)) return "=";
    if (isSuccession(edge)) return "";
    return edge.label || edgeLabels[edge.kind] || edge.kind;
  }
  get elements(): ElementDefinition[] {
    const nodes = this.visibleNodes,
      ids = new Set(nodes.map((node) => node.id));
    const { view, filter } = this.options,
      compound = ["interconnection", "general"].includes(view);
    const plan = view === "general" && filter === "usages"
      ? this.viewPlan
      : null;
    const ambiguous = new Set(plan?.ambiguousIds);
    const ownerView = (node: GraphNode | undefined): string | undefined => {
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (ambiguous.has(node.id)) return;
        const frame = plan?.parentByNode.get(node.id);
        if (frame) return frame;
        node = node.parentId ? this.map.get(node.parentId) : undefined;
      }
    };
    const parentFor = (node: GraphNode): string | undefined => {
      if (!compound || isPort(node)) return;
      // Shared explicit membership must not pick a view indirectly through a
      // physical owner. The native owner remains available as evidence below.
      if (ambiguous.has(node.id)) return;
      const owner = node.parentId ? this.map.get(node.parentId) : undefined;
      const frame = plan?.parentByNode.get(node.id);
      if (frame && (this.operator(node) || ownerView(owner) !== frame)) {
        return frame;
      }
      if (
        owner && ids.has(owner.id) &&
        (isPart(node) || isItem(node) && isPart(owner) || this.context(node) ||
          isItem(node) && this.context(owner))
      ) return owner.id;
      if (frame) return frame;
      if (view === "general" && !isPart(node)) return;
      let parent = owner;
      const seen = new Set<string>();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        if (ids.has(parent.id) && !isPort(parent)) return parent.id;
        parent = parent.parentId ? this.map.get(parent.parentId) : undefined;
      }
    };
    const frames = new Set<string>();
    if (plan) {
      const frameIds = new Set(plan.groups.map((group) => group.view.id));
      for (const node of nodes) {
        let parent = parentFor(node);
        while (parent && frameIds.has(parent) && !frames.has(parent)) {
          frames.add(parent);
          parent = plan.parentByView.get(parent);
        }
      }
    }
    const elements: ElementDefinition[] = plan
      ? plan.groups.filter((group) => frames.has(group.view.id)).map(
        (group) => {
          const scope = mandateScopeForView(
            group,
            plan,
            this.nodes,
            this.graph.edges,
          );
          return {
            data: {
              id: group.view.id,
              label: scope
                ? `Mandate · ${display(scope.holder)} · ${scope.mandate.id}\n${
                  scope.mandate.allowedChoices.join(" · ")
                }`
                : `«view» ${group.view.label}`,
              isNativeView: true,
              nativeId: group.view.nativeId,
              parent: plan.parentByView.get(group.view.id),
              mandateId: scope?.mandate.id,
            },
            classes: `native-view${scope ? " mandate-scope" : ""}`,
          };
        },
      )
      : [];
    elements.push(...nodes.map((node) => ({
      data: {
        id: node.id,
        label: this.nodeLabel(node),
        parent: parentFor(node),
        nativeParent: node.parentId,
        stageColor: /^#[0-9a-f]{3,8}$/i.test(node.runtimeColor || "")
          ? node.runtimeColor
          : stageOf(node) === "active"
          ? "#2a9d8f"
          : inFlight.has(stageOf(node))
          ? "#c88b35"
          : "#b95757",
      },
      classes: [
        isDefinition(node) ? "definition" : "usage",
        isPort(node)
          ? "port"
          : isItem(node)
          ? "item"
          : isPart(node)
          ? "part"
          : isAction(node)
          ? "action"
          : isState(node)
          ? "state"
          : "other",
        isControl(node) ? "control" : "",
        view === "general" && ["usages", "definitions"].includes(filter) &&
          isPart(node)
          ? "overview"
          : "",
        stageOf(node) ? "candidate" : "",
        inFlight.has(stageOf(node)) ? "construction" : "",
        node.observedState ? "observed-state" : "",
        view === "general" && isAction(node) && !this.context(node)
          ? "general-action"
          : "",
        this.context(node) ? "native-context" : "",
        view === "general" && isItem(node) ? "general-result" : "",
        ["general", "interconnection"].includes(view) && this.operator(node)
          ? "operator"
          : "",
        isBehaviorAccess(node, this.graph.nodes, this.graph.edges)
          ? "behavior-access"
          : "",
        node.stateRole === "initial" || /initial|final/.test(kind(node))
          ? "endpoint"
          : "",
      ].join(" "),
    })));
    for (const edge of this.edges) {
      if (ids.has(edge.source) && ids.has(edge.target) && this.allowed(edge)) {
        elements.push({
          data: {
            id: `e:${edge.id}`,
            source: edge.source,
            target: edge.target,
            label: this.edgeLabel(edge),
            kind: edge.kind,
          },
          classes: [
            `edge-${edge.kind}`,
            isSuccession(edge)
              ? "directed"
              : isFlow(edge)
              ? "directed flow"
              : "",
            edge.guard ? "guard" : "",
          ].join(" "),
        });
      }
    }
    return elements;
  }
}
export function guardCaption(guard: string): string {
  const text = String(guard).replace(/^\[|\]$/g, "").trim();
  return text.length > 42 ? "[guard · select]" : `[${text}]`;
}
