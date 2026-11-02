/** Native model diagrams: SysML Toolkit `toGraph` → ELK layout → absolute scene.
 * Pure functions; the caller supplies text measurement and runs ELK. */
import type {
  ModelDiagram,
  ModelDiagramEdge,
  ModelDiagramNode,
  ModelViewKind,
} from "../../../../src/domain/model/records/diagram-views.ts";

export type FontRole =
  | "stereo"
  | "name"
  | "type"
  | "sect"
  | "row"
  | "port"
  | "edge"
  | "note"
  | "ctl";
export type Measure = (text: string, role: FontRole) => number;

export type Shape =
  | "block"
  | "port"
  | "pill"
  | "frame"
  | "package"
  | "note"
  | "diamond"
  | "bar"
  | "initial"
  | "final";

export interface DiagramOptions {
  folded: ReadonlySet<string>;
  /** Edge kinds left out of the picture. */
  hiddenKinds: ReadonlySet<string>;
}

export interface ElkLabel {
  text: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
}
export interface ElkPort {
  id: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  labels?: ElkLabel[];
  layoutOptions?: Record<string, string>;
}
export interface ElkSection {
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
}
export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: ElkSection[];
  container?: string;
}
export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  ports?: ElkPort[];
  labels?: ElkLabel[];
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
}
export interface Point {
  x: number;
  y: number;
}

/** What the renderer needs to draw one element, kept apart from ELK's tree. */
export interface NodeInfo {
  node: ModelDiagramNode;
  shape: Shape;
  depth: number;
  compound: boolean;
  /** Number of elements hidden inside a folded block. */
  folded: number;
  noteLines?: string[];
}
export interface EdgeInfo {
  kind: string;
  members: ModelDiagramEdge[];
  lines: string[];
  guard: boolean;
}
export interface PortInfo {
  node?: ModelDiagramNode;
  owner: string;
  implicit: boolean;
}
export interface DiagramModel {
  graph: ElkNode;
  nodes: Map<string, NodeInfo>;
  edges: Map<string, EdgeInfo>;
  ports: Map<string, PortInfo>;
}

export interface SceneNode extends NodeInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  labels: { text: string; x: number; y: number }[];
}
export interface ScenePort extends PortInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: { text: string; x: number; y: number };
}
export interface SceneEdge extends EdgeInfo {
  id: string;
  source: string;
  target: string;
  paths: Point[][];
  labels: { lines: string[]; x: number; y: number }[];
}
export interface Scene {
  width: number;
  height: number;
  /** Containers before their contents, so drawing order is painting order. */
  nodes: SceneNode[];
  edges: SceneEdge[];
  ports: ScenePort[];
}

export const METRICS = {
  padX: 12,
  padTop: 8,
  stereoH: 13,
  nameH: 17,
  rowH: 16,
  sectH: 15,
  sectGap: 5,
  portSize: 11,
  control: 24,
  pseudo: 15,
} as const;

export function shapeOf(node: ModelDiagramNode): Shape {
  if (node.kind === "port") return "port";
  if (node.kind === "pseudo") {
    return node.stereo === "final" ? "final" : "initial";
  }
  if (node.kind === "control") {
    return /fork|join/.test(node.stereo ?? "") ? "bar" : "diamond";
  }
  if (node.kind === "package") return "package";
  if (node.kind === "note") return "note";
  if (node.kind === "state") return node.nodeKind === "def" ? "frame" : "pill";
  return "block";
}

/** SysML v2 keyword shown above a name; actions and states inside a flow omit it. */
export function keyword(node: ModelDiagramNode): string {
  if (node.kind === "state" && node.nodeKind !== "def") return "";
  const stereo = node.stereo || node.kind;
  const ref = node.nodeKind === "ref" && !/^ref /.test(stereo) ? "ref " : "";
  return `«${ref}${stereo}»`;
}

export function sections(node: ModelDiagramNode) {
  const out = new Map<string, ModelDiagramNode["rows"]>();
  for (const row of node.rows ?? []) {
    const rows = out.get(row.section) ?? [];
    rows.push(row);
    out.set(row.section, rows);
  }
  return [...out];
}

/** Typing punctuation belongs to the drawing, never to the admitted name. */
export function typeLabel(node: ModelDiagramNode): string {
  return node.typeName ? `: ${node.typeName}` : "";
}

export function header(node: ModelDiagramNode, measure: Measure) {
  const name = node.name, type = typeLabel(node);
  const stereo = keyword(node);
  const width = Math.max(
    stereo ? measure(stereo, "stereo") : 0,
    measure(name, "name") + (type ? measure(` ${type}`, "type") : 0),
  );
  const height = METRICS.padTop + (stereo ? METRICS.stereoH : 0) +
    METRICS.nameH + 4;
  return { width, height, stereo, name, type };
}

export function wrap(
  text: string,
  role: FontRole,
  max: number,
  measure: Measure,
  maxLines = 4,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, role) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += " …";
  }
  return lines;
}

function leafSize(
  node: ModelDiagramNode,
  hasPorts: boolean,
  measure: Measure,
): { width: number; height: number; noteLines?: string[] } {
  const M = METRICS;
  switch (shapeOf(node)) {
    case "diamond":
      return { width: M.control, height: M.control };
    case "bar":
      return { width: 60, height: 6 };
    case "initial":
      return { width: M.pseudo, height: M.pseudo };
    case "final":
      return { width: M.pseudo + 4, height: M.pseudo + 4 };
    case "note": {
      const noteLines = wrap(
        node.name.replace(/\s+/g, " "),
        "note",
        200,
        measure,
        5,
      );
      return {
        width: Math.max(...noteLines.map((l) => measure(l, "note"))) + 28,
        height: noteLines.length * 15 + 16,
        noteLines,
      };
    }
    case "pill": {
      const name = node.name, type = typeLabel(node);
      const width = Math.max(
        measure(name, "name"),
        type ? measure(type, "type") : 0,
      ) + 32;
      return { width: Math.max(width, 110), height: type ? 46 : 32 };
    }
    default: {
      const head = header(node, measure);
      let width = head.width;
      let height = head.height;
      for (const [section, rows] of sections(node)) {
        width = Math.max(
          width,
          measure(section, "sect"),
          ...rows.map((r) => measure(r.label, "row")),
        );
        height += M.sectGap + M.sectH + rows.length * M.rowH;
      }
      return {
        width: Math.max(width + 2 * M.padX, hasPorts ? 128 : 104),
        height: height + 8,
      };
    }
  }
}

export function edgeLabel(
  edge: ModelDiagramEdge,
): { text: string; guard: boolean } | null {
  if (edge.guard) {
    return {
      text: edge.guard === "else" ? "[else]" : `[${edge.guard}]`,
      guard: true,
    };
  }
  if (edge.kind === "allocation") return { text: "«allocate»", guard: false };
  if (edge.kind === "satisfy") return { text: "«satisfy»", guard: false };
  if (edge.label) return { text: edge.label, guard: false };
  return null;
}

export function layoutOptions(kind: ModelViewKind): Record<string, string> {
  const base: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.spacing.nodeNode": "30",
    "elk.layered.spacing.nodeNodeBetweenLayers": "54",
    "elk.spacing.edgeNode": "18",
    "elk.spacing.edgeEdge": "11",
    "elk.layered.spacing.edgeNodeBetweenLayers": "20",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "11",
    "elk.spacing.labelNode": "6",
    "elk.spacing.edgeLabel": "4",
  };
  if (kind === "interconnection") {
    return {
      ...base,
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
    };
  }
  if (kind === "action" || kind === "state") {
    return {
      ...base,
      "elk.direction": "DOWN",
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
    };
  }
  return {
    ...base,
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "46",
  };
}

/** The first picture is a summary: blocks below the top one start folded. */
export function defaultFolds(
  kind: ModelViewKind,
  diagram: ModelDiagram,
): Set<string> {
  if (kind !== "interconnection") return new Set();
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const depth = (n: ModelDiagramNode): number =>
    n.parent && byId.has(n.parent) ? 1 + depth(byId.get(n.parent)!) : 0;
  const containers = new Set(
    diagram.nodes.filter((n) => n.kind !== "port").map((n) => n.parent),
  );
  return new Set(
    diagram.nodes.filter((n) => depth(n) >= 1 && containers.has(n.id)).map((
      n,
    ) => n.id),
  );
}

export function buildDiagram(
  kind: ModelViewKind,
  diagram: ModelDiagram,
  options: DiagramOptions,
  measure: Measure,
): DiagramModel {
  const M = METRICS;
  const nodes = new Map(diagram.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, ModelDiagramNode[]>();
  for (const n of nodes.values()) {
    if (n.parent && nodes.has(n.parent)) {
      kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
    }
  }
  const hidden = (n: ModelDiagramNode) =>
    n.kind === "note" && options.hiddenKinds.has("note");
  const ancestors = (id: string) => {
    const out: string[] = [];
    let n = nodes.get(id);
    while (n?.parent && nodes.has(n.parent)) {
      out.push(n.parent);
      n = nodes.get(n.parent);
    }
    return out;
  };
  // The outermost folded ancestor stands for everything it hides.
  const shownAs = (id: string) => {
    let shown = id;
    for (const a of ancestors(id)) if (options.folded.has(a)) shown = a;
    return shown;
  };
  // A port lies on its owner's border: shown whenever the owner is, folded or not.
  const visible = (n: ModelDiagramNode) =>
    !hidden(n) &&
    (n.kind === "port"
      ? shownAs(n.parent!) === n.parent
      : shownAs(n.id) === n.id);
  const hiddenCount = (id: string): number =>
    (kids.get(id) ?? []).reduce(
      (sum, k) => sum + (k.kind === "port" ? 0 : 1) + hiddenCount(k.id),
      0,
    );
  const endpoint = (id: string): { node: string; port?: string } | null => {
    const n = nodes.get(id);
    if (!n || hidden(n)) return null;
    if (n.kind === "port") {
      return shownAs(n.parent!) === n.parent
        ? { node: n.parent!, port: id }
        : { node: shownAs(n.parent!) };
    }
    return { node: shownAs(id) };
  };

  // Behaviour views read in flow order: rank by a depth-first walk from the
  // initial node, which ELK's depth-first cycle breaking then follows.
  const rank = new Map<string, number>();
  if (kind === "action" || kind === "state") {
    const start = (id: string) => {
      const n = nodes.get(id);
      if (n && shapeOf(n) !== "frame") return id;
      return (kids.get(id) ?? []).find((k) =>
        k.kind === "pseudo" && k.stereo !== "final"
      )?.id ?? id;
    };
    const next = new Map<string, string[]>();
    for (const e of diagram.edges) {
      const s = start(e.source);
      next.set(s, [...(next.get(s) ?? []), e.target]);
    }
    const visit = (id: string) => {
      if (rank.has(id)) return;
      rank.set(id, rank.size);
      for (const t of next.get(id) ?? []) visit(t);
    };
    for (const n of nodes.values()) {
      if (n.kind === "pseudo" && n.stereo !== "final") visit(n.id);
    }
    for (const n of nodes.values()) visit(n.id);
  }

  const infos = new Map<string, NodeInfo>();
  const ports = new Map<string, PortInfo>();
  const elkNodes = new Map<string, ElkNode>();
  const options0 = layoutOptions(kind);
  const make = (n: ModelDiagramNode, depth: number): ElkNode => {
    const children = (kids.get(n.id) ?? []).filter((k) =>
      k.kind !== "port" && visible(k)
    );
    if (rank.size) {
      children.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
    const ownPorts = (kids.get(n.id) ?? []).filter((k) =>
      k.kind === "port" && visible(k)
    );
    const folded = options.folded.has(n.id);
    const compound = !folded && children.length > 0;
    const shape = shapeOf(n);
    const elk: ElkNode = {
      id: n.id,
      ports: [],
      children: [],
      edges: [],
      layoutOptions: {},
    };
    for (const p of ownPorts) {
      const name = p.name;
      elk.ports!.push({
        id: p.id,
        width: M.portSize,
        height: M.portSize,
        labels: [{ text: name, width: measure(name, "port") + 4, height: 13 }],
        layoutOptions: { "elk.port.borderOffset": String(-M.portSize / 2) },
      });
      ports.set(p.id, { node: p, owner: n.id, implicit: false });
    }
    if (ownPorts.length) {
      Object.assign(elk.layoutOptions!, {
        "elk.portConstraints": "FREE",
        "elk.portLabels.placement": "OUTSIDE",
        "elk.spacing.portPort": "28",
      });
    }
    let noteLines: string[] | undefined;
    if (compound) {
      // Nested graphs keep their own layered settings under INCLUDE_CHILDREN.
      Object.assign(elk.layoutOptions!, options0);
      const head = shape === "frame" || shape === "package"
        ? {
          width: measure(`${keyword(n)} ${n.name}`, "name") + 40,
          height: 30,
        }
        : header(n, measure);
      Object.assign(elk.layoutOptions!, {
        "elk.padding": `[top=${
          Math.round(head.height + 16)
        },left=20,bottom=20,right=20]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${Math.round(head.width + 2 * M.padX + 8)}, ${
          Math.round(head.height + 40)
        })`,
      });
      for (const c of children) elk.children!.push(make(c, depth + 1));
    } else {
      const size = leafSize(n, ownPorts.length > 0, measure);
      noteLines = size.noteLines;
      elk.width = size.width;
      elk.height = size.height + (folded ? 12 : 0);
      if (folded) {
        elk.width = Math.max(
          elk.width,
          header(n, measure).width + 2 * M.padX + 34,
        );
      }
      // ELK grows a block until its ports fit along the sides, below the header.
      if (ownPorts.length) {
        Object.assign(elk.layoutOptions!, {
          "elk.nodeSize.constraints": "PORTS MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${Math.round(elk.width)}, ${
            Math.round(elk.height)
          })`,
          "elk.spacing.portsSurrounding": `[top=${
            Math.round(header(n, measure).height)
          },left=0,bottom=8,right=0]`,
        });
      }
      if (shape === "diamond" && n.name) {
        elk.labels = [{
          text: n.name,
          width: measure(n.name, "ctl") + 2,
          height: 13,
        }];
        elk.layoutOptions!["elk.nodeLabels.placement"] =
          "OUTSIDE V_TOP H_RIGHT";
      }
    }
    infos.set(n.id, {
      node: n,
      shape,
      depth,
      compound,
      folded: folded ? hiddenCount(n.id) : 0,
      noteLines,
    });
    elkNodes.set(n.id, elk);
    return elk;
  };
  const roots = diagram.nodes.filter((n) =>
    !(n.parent && nodes.has(n.parent)) && n.kind !== "port" && visible(n)
  );
  const graph: ElkNode = {
    id: "root",
    children: roots.map((r) => make(r, 0)),
    edges: [],
    layoutOptions: options0,
  };

  const merged = new Map<string, ElkEdge>();
  const edgeInfos = new Map<string, EdgeInfo>();
  for (const e of diagram.edges) {
    if (options.hiddenKinds.has(e.kind)) continue;
    const s = endpoint(e.source), t = endpoint(e.target);
    if (!s || !t) continue;
    // Successions from a behaviour frame itself start (or end) at its pseudo-state.
    for (const [end, initial] of [[s, true], [t, false]] as const) {
      const n = nodes.get(end.node);
      if (n && shapeOf(n) === "frame" && infos.get(end.node)?.compound) {
        const pseudo = (kids.get(n.id) ?? []).find((k) =>
          k.kind === "pseudo" &&
          (initial ? k.stereo !== "final" : k.stereo === "final")
        );
        if (pseudo) end.node = pseudo.id;
      }
    }
    // Folding hides internal relationships between distinct elements, but a
    // declared self-transition/succession remains a meaningful loop.
    if (e.source !== e.target && s.node === t.node && !s.port && !t.port) {
      continue;
    }
    const sChain = [s.node, ...ancestors(s.node)];
    const tChain = [t.node, ...ancestors(t.node)];
    // An edge to an enclosing block lands on a port on its inner border.
    for (
      const [near, far, chain] of [[s, t, sChain], [t, s, tChain]] as const
    ) {
      if (!far.port && chain.includes(far.node) && near.node !== far.node) {
        const id = `${far.node}~inner`;
        if (!ports.has(id)) {
          elkNodes.get(far.node)!.ports!.push({
            id,
            width: 6,
            height: 6,
            layoutOptions: { "elk.port.borderOffset": "-3" },
          });
          ports.set(id, { owner: far.node, implicit: true });
        }
        far.port = id;
      }
    }
    const key = `${e.kind}|${s.port ?? s.node}|${t.port ?? t.node}`;
    const existing = merged.get(key);
    if (existing) {
      edgeInfos.get(existing.id)!.members.push(e);
      continue;
    }
    let container = "root";
    if (s.port?.endsWith("~inner") && tChain.includes(s.node)) {
      container = s.node;
    } else if (t.port?.endsWith("~inner") && sChain.includes(t.node)) {
      container = t.node;
    } else {
      const tAncestors = new Set(ancestors(t.node));
      container = ancestors(s.node).find((a) =>
        tAncestors.has(a) && elkNodes.has(a)
      ) ?? "root";
    }
    const edge: ElkEdge = {
      id: `e${merged.size}`,
      sources: [s.port ?? s.node],
      targets: [t.port ?? t.node],
    };
    merged.set(key, edge);
    edgeInfos.set(edge.id, {
      kind: e.kind,
      members: [e],
      lines: [],
      guard: false,
    });
    (container === "root" ? graph : elkNodes.get(container)!).edges!.push(edge);
  }
  // Labels last: parallel edges merge into one line listing their distinct
  // labels (several triggers on one transition) and counting folded repeats.
  for (const edge of merged.values()) {
    const info = edgeInfos.get(edge.id)!;
    const labels = info.members.map(edgeLabel).filter((l) => l !== null);
    const distinct = [...new Set(labels.map((l) => l.text))];
    const repeats = info.members.length - Math.max(distinct.length, 1);
    const count = repeats > 0 ? `×${info.members.length}` : "";
    if (!labels.length && !count) continue;
    const text = [distinct.join(", "), count].filter(Boolean).join(" ");
    info.lines = wrap(text, "edge", 170, measure, 3);
    info.guard = labels[0]?.guard ?? false;
    edge.labels = [{
      text,
      width: Math.max(...info.lines.map((l) => measure(l, "edge"))) + 6,
      height: info.lines.length * 13 + 2,
      layoutOptions: {
        "elk.edgeLabels.placement": info.guard ? "HEAD" : "CENTER",
      },
    }];
  }
  return { graph, nodes: infos, edges: edgeInfos, ports };
}

/** Absolute coordinates for drawing. ELK keeps shapes relative to their parent
 * and edge sections relative to the edge's container. */
export function sceneOf(model: DiagramModel, laid: ElkNode): Scene {
  const scene: Scene = {
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    nodes: [],
    edges: [],
    ports: [],
  };
  const origin = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const walk = (n: ElkNode, ox: number, oy: number) => {
    const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0);
    origin.set(n.id, { x, y });
    const info = model.nodes.get(n.id);
    if (info) {
      scene.nodes.push({
        ...info,
        id: n.id,
        x,
        y,
        w: n.width ?? 0,
        h: n.height ?? 0,
        labels: (n.labels ?? []).map((l) => ({
          text: l.text,
          x: x + (l.x ?? 0),
          y: y + (l.y ?? 0),
        })),
      });
    }
    for (const p of n.ports ?? []) {
      const port = model.ports.get(p.id);
      if (!port) continue;
      const px = x + (p.x ?? 0), py = y + (p.y ?? 0);
      const l = p.labels?.[0];
      scene.ports.push({
        ...port,
        id: p.id,
        x: px,
        y: py,
        w: p.width,
        h: p.height,
        label: l
          ? { text: l.text, x: px + (l.x ?? 0), y: py + (l.y ?? 0) }
          : undefined,
      });
    }
    for (const c of n.children ?? []) walk(c, x, y);
  };
  walk(laid, -(laid.x ?? 0), -(laid.y ?? 0));
  const collect = (n: ElkNode) => {
    for (const e of n.edges ?? []) {
      const info = model.edges.get(e.id);
      if (!info) continue;
      const off = origin.get(e.container ?? n.id) ?? { x: 0, y: 0 };
      const shift = (p: Point) => ({ x: p.x + off.x, y: p.y + off.y });
      scene.edges.push({
        ...info,
        id: e.id,
        source: e.sources[0],
        target: e.targets[0],
        paths: (e.sections ?? []).map((s) =>
          [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift)
        ),
        labels: (e.labels ?? []).map((l) => ({
          lines: info.lines,
          x: off.x + (l.x ?? 0),
          y: off.y + (l.y ?? 0),
        })),
      });
    }
    for (const c of n.children ?? []) collect(c);
  };
  collect(laid);
  return scene;
}

/** Orthogonal polyline with softened corners. */
export function roundedPath(points: Point[], radius = 7): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1], p = points[i], p1 = points[i + 1];
    const d0 = Math.hypot(p.x - p0.x, p.y - p0.y);
    const d1 = Math.hypot(p1.x - p.x, p1.y - p.y);
    const r = Math.min(radius, d0 / 2, d1 / 2);
    if (r < 0.5) {
      d += ` L${p.x},${p.y}`;
      continue;
    }
    const a = {
      x: p.x + ((p0.x - p.x) * r) / d0,
      y: p.y + ((p0.y - p.y) * r) / d0,
    };
    const b = {
      x: p.x + ((p1.x - p.x) * r) / d1,
      y: p.y + ((p1.y - p.y) * r) / d1,
    };
    d += ` L${a.x},${a.y} Q${p.x},${p.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
