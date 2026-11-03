import { isPlainRecord as object } from "../../../../domain/primitives/is-plain-record.ts";
import { isNativeToolkitPanic } from "../runtime/native-addon.ts";
/** Diagram views from one Toolkit session: `toGraph` for the standard kinds,
 * `viewInfo` for declared `view` usages. Node names come from the
 * `outline().shape` entry sharing the node id, and type names from
 * `typings(elementById(id))`; the composite Toolkit label is never split.
 * Every element acquired for typing resolution is freed in a `finally`. */
import type {
  ModelDiagram,
  ModelDiagramEdge,
  ModelDiagramNode,
  ModelViewDiagnostic,
  ModelViewGroup,
  ModelViewKind,
  ModelViewSummary,
} from "../../../../domain/model/records/diagram-views.ts";
import { modelViewId } from "../../../../domain/model/records/diagram-views.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import { parseSysmlQualifiedName } from "../../../../domain/model/value-objects/sysml-qualified-name.ts";
import type { ToolkitElement, ToolkitSession } from "../runtime/loader.ts";

type ViewSession =
  & ToolkitSession
  & Required<Pick<ToolkitSession, "toGraph" | "viewInfo" | "outline">>;

export class ToolkitViewApiUnavailableError extends Error {
  readonly code = "TOOLKIT_VIEW_API_UNAVAILABLE";
  readonly recovery =
    "Use a Toolkit runtime exposing the missing Session methods reported in context.missing.";
  constructor(readonly context: { missing: string[] }) {
    super(
      `Toolkit view API unavailable: missing ${
        context.missing.map((m) => `Session.${m}`).join(", ")
      }`,
    );
    this.name = "ToolkitViewApiUnavailableError";
  }
}

function requireViewSession(session: ToolkitSession): ViewSession {
  const missing = (["toGraph", "viewInfo", "outline"] as const).filter(
    (method) => typeof session[method] !== "function",
  );
  if (missing.length) {
    throw new ToolkitViewApiUnavailableError({ missing: [...missing] });
  }
  return session as ViewSession;
}

interface ShapeNode {
  id: string;
  name: string;
  qualifiedName: string;
  metaclass: string;
  owner: number;
}

const GROUP_ORDER: ModelViewGroup[] = [
  "structure",
  "behavior",
  "state",
  "declared",
  "definitions",
];

function parseShape(session: ViewSession): {
  shape: ShapeNode[];
  truncated: boolean;
} {
  const outline: unknown = JSON.parse(
    session.outline(JSON.stringify({ shapeNodes: 20_000 })),
  );
  if (
    !object(outline) || !object(outline.shape) ||
    !Array.isArray(outline.shape.nodes)
  ) {
    throw new Error("Invalid Toolkit outline");
  }
  return {
    shape: outline.shape.nodes as ShapeNode[],
    truncated: outline.shape.truncated === true,
  };
}

/** Resolve the declared name and typing names of one graph node id.
 * `resolved` is false when the id is a pseudo-node the Toolkit cannot
 * resolve by id or native qualified name: callers then keep the raw label
 * and fabricate no type. Synthetic graph ids (e.g. inherited ports) resolve
 * through their Toolkit-provided qname, without splitting a label or id. Every acquired element is
 * freed in the `finally`. */
function resolveTypings(
  session: ViewSession,
  id: string,
  qualifiedName?: string,
): { resolved: boolean; elementName?: string; typeName?: string } {
  const element = session.elementById?.(id) ??
    (qualifiedName ? session.resolve(qualifiedName) : undefined);
  if (!element) return { resolved: false };
  let types: ToolkitElement[] = [];
  let result: { resolved: boolean; elementName?: string; typeName?: string } = {
    resolved: true,
  };
  let failure: unknown;
  try {
    const elementName = typeof session.name === "function"
      ? session.name(element)
      : undefined;
    types = session.typings(element);
    const names: string[] = [];
    for (const type of types) {
      const named = typeof session.name === "function"
        ? session.name(type)
        : undefined;
      if (named) {
        names.push(named);
        continue;
      }
      const qualified = typeof session.qualifiedName === "function"
        ? session.qualifiedName(type)
        : undefined;
      if (qualified) {
        const segments = parseSysmlQualifiedName(qualified);
        names.push(segments ? segments[segments.length - 1] : qualified);
      }
    }
    result = {
      resolved: true,
      ...(elementName ? { elementName } : {}),
      ...(names.length ? { typeName: names.join(", ") } : {}),
    };
  } catch (error) {
    failure = error;
  }
  // Every acquired element is freed, even when resolution failed; a trap
  // raised while freeing replaces the outcome, as in the board projector.
  let trap: unknown;
  for (const type of types) {
    try {
      type.free();
    } catch (error) {
      if (isNativeToolkitPanic(error)) trap ??= error;
    }
  }
  try {
    element.free();
  } catch (error) {
    if (isNativeToolkitPanic(error)) trap ??= error;
  }
  if (trap) throw trap;
  if (failure !== undefined) throw failure;
  return result;
}

function normalizeNode(
  session: ViewSession,
  shapeById: ReadonlyMap<string, ShapeNode>,
  raw: unknown,
): ModelDiagramNode {
  if (!object(raw)) throw new Error("Invalid Toolkit diagram node");
  const label = typeof raw.label === "string" ? raw.label : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  const shapeNode = id ? shapeById.get(id) : undefined;
  // The declared name comes first from the outline shape entry sharing
  // this id; library nodes absent from the outline fall back to the name
  // of the resolved element itself. Anonymous nodes resolve with an
  // empty name and unresolved pseudo-nodes do not resolve at all: both
  // keep the raw label and fabricate no type.
  let name = label;
  let typeName: string | undefined;
  const resolved = resolveTypings(
    session,
    id,
    typeof raw.qname === "string" ? raw.qname : undefined,
  );
  if (shapeNode && shapeNode.name) {
    if (resolved.resolved || typeof session.elementById !== "function") {
      name = shapeNode.name;
      typeName = resolved.typeName;
    }
  } else if (resolved.resolved && resolved.elementName) {
    name = resolved.elementName;
    typeName = resolved.typeName;
  }
  return {
    id,
    kind: typeof raw.kind === "string" ? raw.kind : "",
    name,
    ...(typeName ? { typeName } : {}),
    ...(typeof raw.metaclass === "string" ? { metaclass: raw.metaclass } : {}),
    ...(typeof raw.qname === "string" ? { qname: raw.qname } : {}),
    ...(typeof raw.stereo === "string" ? { stereo: raw.stereo } : {}),
    ...(typeof raw.nodeKind === "string" ? { nodeKind: raw.nodeKind } : {}),
    ...(typeof raw.parent === "string" ? { parent: raw.parent } : {}),
    ...(typeof raw.conjugated === "boolean"
      ? { conjugated: raw.conjugated }
      : {}),
    rows: Array.isArray(raw.rows) ? raw.rows as ModelDiagramNode["rows"] : [],
    ...(typeof raw.file === "string" ? { file: raw.file } : {}),
    ...(Number.isSafeInteger(raw.line) ? { line: Number(raw.line) } : {}),
    ...(Number.isSafeInteger(raw.col) ? { col: Number(raw.col) } : {}),
  };
}

function diagram(
  session: ViewSession,
  shapeById: ReadonlyMap<string, ShapeNode>,
  options: Record<string, unknown>,
): ModelDiagram {
  const graph: unknown = JSON.parse(session.toGraph(JSON.stringify(options)));
  if (
    !object(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
  ) {
    throw new Error("Invalid Toolkit diagram graph");
  }
  // Overlapping exposed roots can emit one native node more than once.
  // Compare all raw metadata before normalization, so no dropped field can
  // conceal a conflict. Preserve first occurrence order and native identities.
  const seen = new Map<string, string>();
  const nodes: ModelDiagramNode[] = [];
  for (const node of graph.nodes) {
    if (object(node) && typeof node.id === "string" && node.id) {
      const encoded = canonical(node);
      const previous = seen.get(node.id);
      if (previous !== undefined) {
        if (previous !== encoded) {
          throw new ToolkitViewNodeConflictError(node.id);
        }
        continue;
      }
      seen.set(node.id, encoded);
    }
    nodes.push(normalizeNode(session, shapeById, node));
  }
  return { nodes, edges: graph.edges as ModelDiagramEdge[] };
}

class ToolkitViewNodeConflictError extends Error {
  readonly code = "TOOLKIT_VIEW_NODE_CONFLICT";
  constructor(id: string) {
    super(`Toolkit diagram repeats node ${id} with conflicting metadata`);
    this.name = "ToolkitViewNodeConflictError";
  }
}

function declaredRoots(
  session: Pick<ViewSession, "viewInfo">,
  element: string,
): string[] {
  const info: unknown = JSON.parse(session.viewInfo(element));
  const exposed = object(info) && Array.isArray(info.exposed)
    ? info.exposed
    : [];
  const roots = [
    ...new Set<string>(
      exposed
        .map((entry) =>
          object(entry) && typeof entry.qualifiedName === "string"
            ? entry.qualifiedName
            : null
        )
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  return roots;
}

function declaredDiagram(
  session: ViewSession,
  shapeById: ReadonlyMap<string, ShapeNode>,
  element: string,
): ModelDiagram {
  const roots = declaredRoots(session, element);
  return roots.length
    ? diagram(session, shapeById, { view: "tree", roots })
    : { nodes: [], edges: [] };
}

export function projectToolkitViewList(session: ToolkitSession): {
  summaries: ModelViewSummary[];
  diagnostics: ModelViewDiagnostic[];
} {
  const viewSession = requireViewSession(session);
  const { shape, truncated } = parseShape(viewSession);
  const shapeById = new Map(shape.map((node) => [node.id, node]));
  const summaries: ModelViewSummary[] = [];
  const diagnostics: ModelViewDiagnostic[] = [];
  if (truncated) {
    diagnostics.push({
      code: "SHAPE_TRUNCATED",
      severity: "error",
      context: { message: `Outline truncated at ${shape.length} nodes` },
      recovery: "Raise shapeNodes in the outline call.",
    });
  }
  const add = (
    group: ModelViewGroup,
    kind: ModelViewKind,
    node: ShapeNode,
    build: () => ModelDiagram,
    keep: (d: ModelDiagram) => boolean,
    onEmpty?: () => void,
  ) => {
    try {
      const projected = build();
      if (!keep(projected)) {
        onEmpty?.();
        return;
      }
      summaries.push({
        id: modelViewId(group, node.qualifiedName),
        title: node.name,
        kind,
        group,
        element: node.qualifiedName,
        nodes: projected.nodes.length,
        edges: projected.edges.length,
      });
    } catch (error) {
      if (isNativeToolkitPanic(error)) throw error;
      diagnostics.push({
        code: "VIEW_UNPROJECTABLE",
        severity: "warning",
        context: {
          group,
          element: node.qualifiedName,
          message: error instanceof Error ? error.message : String(error),
        },
        recovery:
          "The view is omitted from the list; fix the model or the Toolkit projection and re-read the list.",
      });
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
        () =>
          diagram(viewSession, shapeById, {
            view: "interconnection",
            ...element,
          }),
        (d) => d.nodes.length > 1,
      );
    } else if (node.metaclass === "ActionDefinition") {
      add(
        "behavior",
        "action",
        node,
        () => diagram(viewSession, shapeById, { view: "action", ...element }),
        (d) => d.edges.length > 0,
      );
    } else if (node.metaclass === "StateDefinition") {
      add(
        "state",
        "state",
        node,
        () => diagram(viewSession, shapeById, { view: "state", ...element }),
        (d) => d.edges.some((edge) => edge.kind === "transition"),
      );
    } else if (node.metaclass === "Package" && node.owner < 0) {
      add(
        "definitions",
        "tree",
        node,
        () => diagram(viewSession, shapeById, { view: "tree", ...element }),
        (d) => d.nodes.length > 1,
      );
    } else if (node.metaclass === "ViewUsage") {
      add(
        "declared",
        "tree",
        node,
        () => declaredDiagram(viewSession, shapeById, node.qualifiedName),
        (d) => d.nodes.length > 0,
        () => {
          diagnostics.push({
            code: "VIEW_EMPTY",
            severity: "warning",
            context: {
              group: "declared",
              element: node.qualifiedName,
              message: "Declared view exposes no elements",
            },
            recovery:
              "The declared view is omitted from the list; check its expose and filter expressions in the model.",
          });
        },
      );
    }
  }
  summaries.sort((a, b) =>
    GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
  );
  return { summaries, diagnostics };
}

export function projectToolkitViewDiagram(
  session: ToolkitSession,
  view: ModelViewSummary,
): ModelDiagram {
  const viewSession = requireViewSession(session);
  const { shape } = parseShape(viewSession);
  const shapeById = new Map(shape.map((node) => [node.id, node]));
  if (view.group === "declared") {
    return declaredDiagram(viewSession, shapeById, view.element);
  }
  return diagram(viewSession, shapeById, {
    view: view.kind,
    element: view.element,
  });
}

/** The exporter uses the same Toolkit selection as the graph, without making
 * an additional graph or parsing SysML source text. */
export function projectToolkitViewPlantuml(
  session: ToolkitSession,
  view: ModelViewSummary,
): string {
  const required = view.group === "declared"
    ? ["toPlantuml", "viewInfo"] as const
    : ["toPlantuml"] as const;
  const missing = required.filter((method) =>
    typeof session[method] !== "function"
  );
  if (missing.length) {
    throw new ToolkitViewApiUnavailableError({ missing: [...missing] });
  }
  const options = view.group === "declared"
    ? {
      view: "tree",
      roots: declaredRoots(session as ViewSession, view.element),
    }
    : { view: view.kind, element: view.element };
  // An empty root list can mean the whole model to an exporter. Never broaden
  // a declared view whose expose selection cannot be recovered.
  if (options.roots && !options.roots.length) {
    throw new Error("Declared view exposes no elements for PlantUML export");
  }
  return session.toPlantuml!(JSON.stringify(options));
}
