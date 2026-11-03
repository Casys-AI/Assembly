/** Diagram views from one Toolkit session: `toGraph` for the standard kinds,
 * `viewInfo` for declared `view` usages. Reads only; the session is not edited. */
import type {
  ModelDiagram,
  ModelDiagramEdge,
  ModelView,
  ModelViewGroup,
  ModelViewKind,
} from "../domain/model-views.ts";
import { modelViewId } from "../domain/model-views.ts";
import type { ToolkitElement, ToolkitSession } from "./sysml-toolkit-loader.ts";

type ViewSession =
  & Pick<
    ToolkitSession,
    "resolve" | "elementId" | "metaclass" | "rows" | "units"
  >
  & Required<
    Pick<ToolkitSession, "toGraph" | "viewInfo" | "outline" | "members">
  >;

interface ShapeNode {
  id: string;
  name: string;
  qualifiedName: string;
  metaclass: string;
  owner: number;
}

interface Extent {
  unit: number;
  start: number;
  end: number;
}

const GROUP_ORDER: ModelViewGroup[] = [
  "structure",
  "behavior",
  "state",
  "declared",
  "definitions",
];

export function viewSession(session: ToolkitSession): ViewSession {
  const { toGraph, viewInfo, outline, members } = session;
  if (!toGraph || !viewInfo || !outline || !members) {
    throw new Error("Toolkit session lacks the diagram view API");
  }
  return session as ViewSession;
}

function diagram(
  session: ViewSession,
  options: Record<string, unknown>,
): ModelDiagram {
  const graph = JSON.parse(session.toGraph(JSON.stringify(options)));
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    throw new Error("Invalid Toolkit diagram graph");
  }
  return { nodes: graph.nodes, edges: graph.edges };
}

/** Toolkit 0.10.10 leaves `source` unset on the `if … then` / `else` branches
 * that follow a `decide`, and `toGraph` draws no edge for them
 * (https://github.com/Open-MBEE/sysml-toolkit/issues/13). Each branch is
 * attached to the decision node it follows, as SysML v2 §7.17.5 specifies.
 * The guard text is for display only. */
function decisionBranches(
  session: ViewSession,
  definition: ToolkitElement,
): ModelDiagramEdge[] {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const units = new Map<number, Uint8Array>(
    (JSON.parse(session.units()) as { unit: number; text: string }[])
      .map((u) => [u.unit, encoder.encode(u.text)]),
  );
  const source = (extent: Extent) =>
    decoder.decode(units.get(extent.unit)?.slice(extent.start, extent.end));
  const edges: ModelDiagramEdge[] = [];
  let decision: string | undefined;
  for (const member of session.members(definition)) {
    try {
      const metaclass = session.metaclass(member);
      const id = session.elementId(member);
      if (metaclass === "DecisionNode") {
        decision = id;
        continue;
      }
      if (metaclass !== "TransitionUsage") {
        if (metaclass !== "SuccessionAsUsage") decision = undefined;
        continue;
      }
      const [row] = JSON.parse(session.rows(
        JSON.stringify([id]),
        JSON.stringify([
          "memberExtent",
          "derived:source",
          "derived:target",
          "property:guardExpression",
        ]),
      ));
      const target = row?.["derived:target"]?.["@id"];
      if (row?.["derived:source"] || !decision || !target) continue;
      const guarded = (row["property:guardExpression"] ?? []).length > 0;
      const text = row.memberExtent ? source(row.memberExtent).trim() : "";
      const guard = guarded
        ? (/^if\s+([\s\S]*?)\s+then\s/.exec(text)?.[1] ?? "")
          .replace(/\s+/g, " ")
        : "else";
      edges.push({
        id,
        kind: "succession",
        directed: true,
        source: decision,
        target,
        guard,
        supplemented: true,
      });
    } finally {
      member.free();
    }
  }
  return edges;
}

export function projectToolkitViews(
  input: ToolkitSession,
): { views: ModelView[]; problems: string[] } {
  const session = viewSession(input);
  const shape: ShapeNode[] =
    JSON.parse(session.outline(JSON.stringify({ shapeNodes: 20_000 })))
      .shape.nodes;
  const views: ModelView[] = [];
  const problems: string[] = [];
  const add = (
    group: ModelViewGroup,
    kind: ModelViewKind,
    node: ShapeNode,
    build: () => ModelDiagram,
    keep: (d: ModelDiagram) => boolean,
  ) => {
    try {
      const d = build();
      if (!keep(d)) return;
      views.push({
        id: modelViewId(group, node.qualifiedName),
        title: node.name,
        kind,
        group,
        element: node.qualifiedName,
        nodes: d.nodes.length,
        edges: d.edges.length,
        diagram: d,
      });
    } catch (error) {
      problems.push(
        `${group} ${node.qualifiedName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const ownerIsPackage = (node: ShapeNode) =>
    node.owner < 0 || shape[node.owner]?.metaclass === "Package";

  for (const node of shape) {
    const element = { element: node.qualifiedName };
    if (node.metaclass === "PartUsage" && ownerIsPackage(node)) {
      add(
        "structure",
        "interconnection",
        node,
        () => diagram(session, { view: "interconnection", ...element }),
        (d) => d.nodes.length > 1,
      );
    } else if (node.metaclass === "ActionDefinition") {
      add("behavior", "action", node, () => {
        const d = diagram(session, { view: "action", ...element });
        const definition = session.resolve(node.qualifiedName);
        if (!definition) throw new Error("Definition does not resolve");
        try {
          d.edges.push(...decisionBranches(session, definition));
        } finally {
          definition.free();
        }
        return d;
      }, (d) => d.edges.length > 0);
    } else if (node.metaclass === "StateDefinition") {
      add(
        "state",
        "state",
        node,
        () => diagram(session, { view: "state", ...element }),
        (d) => d.edges.some((e) => e.kind === "transition"),
      );
    } else if (node.metaclass === "Package" && node.owner < 0) {
      add(
        "definitions",
        "tree",
        node,
        () => diagram(session, { view: "tree", ...element }),
        (d) => d.nodes.length > 1,
      );
    } else if (node.metaclass === "ViewUsage") {
      add("declared", "tree", node, () => {
        const info = JSON.parse(session.viewInfo(node.qualifiedName));
        const roots = [
          ...new Set<string>(
            (info.exposed as { qualifiedName: string | null }[])
              .map((e) => e.qualifiedName)
              .filter((name): name is string => Boolean(name)),
          ),
        ];
        return roots.length
          ? diagram(session, { view: "tree", roots })
          : { nodes: [], edges: [] };
      }, (d) => d.nodes.length > 0);
    }
  }
  views.sort((a, b) =>
    GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
  );
  return { views, problems };
}
