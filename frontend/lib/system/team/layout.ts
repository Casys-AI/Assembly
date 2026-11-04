// @deno-types="npm:@types/d3-force@3"
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { seeded, separate } from "../../graph/force-order.ts";
import { MAIN, type Team, type TeamEdge, YOU } from "./projection.ts";

/**
 * Where the team's network puts its nodes. The same elements as the prototype
 * (avatars, pills), placed by a force simulation: links pull, nodes repel,
 * nothing overlaps. Pure and deterministic: the start, the random source and
 * the number of ticks are fixed, so the same team in the same width always
 * settles the same way, on the server and in the browser. Sizes are estimated
 * from the labels, never measured, so there is nothing to read from a page
 * before it can be drawn. The simulation runs once per layout: a page asks for
 * a layout only when the team or the width changes, never to select a node.
 */

export type NodeKind = "you" | "main" | "branch" | "agent" | "resource";

export interface LayoutNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** A resource shared by this many agents. */
  times?: number;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  kind: TeamEdge["kind"];
}

/** A node placed: its centre, its size, and where the wires meet it. */
export interface Box {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** From the centre of the box down to the centre of its avatar; 0 for a pill. */
  ay: number;
}

export interface TeamLayout {
  width: number;
  height: number;
  /** In the order the nodes were given. */
  boxes: readonly Box[];
}

/** The width the network is laid out in when the page has not measured its own. */
export const TEAM_ROOM = 1056;
const PAD = 18;
const EDGE = 6;
const TICKS = 320;
const SEPARATIONS = 60;
const GAP = 6;

/** Metrics of the nodes (see `.tnode` and `.tres` in view.css), in pixels. */
export const AVATAR = 52;
const NODE_PAD = 8;
const NODE_GAP = 5;
const NAME_LINE = 18;
const NAME_CHAR = 8.1;
const NODE_MIN = 76;
const NODE_MAX = 150;
const PILL_HEIGHT = 28;
const PILL_CHAR = 6.7;
const PILL_FRAME = 9 + 16 + 6 + 11 + 2;
const PILL_MAX = 230;
const TIMES = 26;

export function boxSize(
  node: Pick<LayoutNode, "kind" | "label" | "times">,
): Pick<Box, "w" | "h" | "ay"> {
  if (node.kind === "resource") {
    const w = PILL_FRAME + node.label.length * PILL_CHAR +
      (node.times ? TIMES : 0);
    return { w: Math.min(PILL_MAX, Math.ceil(w)), h: PILL_HEIGHT, ay: 0 };
  }
  // A name too long for the widest box takes a second line, never a third.
  const name = Math.ceil(node.label.length * NAME_CHAR);
  const lines = name > NODE_MAX - 2 * NODE_PAD ? 2 : 1;
  const h = NODE_PAD + AVATAR + NODE_GAP + lines * NAME_LINE + NODE_PAD;
  const w = name + 2 * NODE_PAD;
  return {
    w: Math.min(NODE_MAX, Math.max(NODE_MIN, w)),
    h,
    ay: NODE_PAD + AVATAR / 2 - h / 2,
  };
}

/**
 * The nodes of a team in the order the simulation starts them: the person, the
 * global Main in a Case, the agents the person talks with, the other agents,
 * the Branch Operators on the main system, then what the agents work with.
 */
export function nodesOf(team: Team): LayoutNode[] {
  const direct = team.agents.filter((agent) => agent.contact === "direct");
  const others = team.agents.filter((agent) => agent.contact !== "direct");
  return [
    ...(team.talks ? [{ id: YOU, kind: "you" as const, label: "You" }] : []),
    ...(team.main
      ? [{ id: MAIN, kind: "main" as const, label: "Main Operator" }]
      : []),
    ...[...direct, ...others].map((agent) => ({
      id: agent.id,
      kind: "agent" as const,
      label: agent.name,
    })),
    ...(team.branches ?? []).map((branch) => ({
      id: branch.id,
      kind: "branch" as const,
      label: branch.label,
    })),
    ...team.resources.map((resource) => ({
      id: resource.key,
      kind: "resource" as const,
      label: resource.label,
      ...(resource.agents.length > 1 ? { times: resource.agents.length } : {}),
    })),
  ];
}

export function edgesOf(team: Team): LayoutEdge[] {
  return team.edges.map(({ id, from, to, kind }) => ({ id, from, to, kind }));
}

/** What a layout depends on, as text: equal keys mean an equal layout. */
export function layoutKey(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  width: number,
): string {
  return JSON.stringify([
    width,
    nodes.map((n) => [n.id, n.kind, n.label, n.times ?? 0]),
    edges.map((e) => [e.from, e.to, e.kind]),
  ]);
}

interface Body extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  w: number;
  h: number;
  /** Collision radius. */
  r: number;
}
interface Wire extends SimulationLinkDatum<Body> {
  kind: LayoutEdge["kind"];
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * The network settled: the person and the agents are pushed apart harder than
 * the resources, which hang from the agents that use them; the result is
 * centred, narrowed horizontally when wider than `width`, and kept inside it.
 */
export function layoutTeam(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  width: number = TEAM_ROOM,
): TeamLayout {
  if (nodes.length === 0) return { width, height: 0, boxes: [] };
  const bodies: Body[] = nodes.map((node, index) => {
    const { w, h } = boxSize(node);
    // A sunflower start: every node apart from the others, the same each time.
    const angle = index * 2.39996, distance = 18 * Math.sqrt(index + 1);
    return {
      id: node.id,
      kind: node.kind,
      w,
      h,
      // The circle that holds the box, so that nodes kept apart by it never touch.
      r: Math.max(Math.max(w, h) / 2 + 10, Math.hypot(w, h) / 2 + 2),
      x: distance * Math.cos(angle),
      y: distance * Math.sin(angle),
      vx: 0,
      vy: 0,
    };
  });
  const known = new Set(bodies.map((body) => body.id));
  const wires: Wire[] = edges.filter((edge) =>
    known.has(edge.from) && known.has(edge.to)
  ).map((edge) => ({ source: edge.from, target: edge.to, kind: edge.kind }));
  const simulation = forceSimulation<Body>(bodies)
    // d3 draws from it only to separate nodes that coincide.
    .randomSource(seeded(0x7ea3))
    .force(
      "link",
      forceLink<Body, Wire>(wires)
        .id((body) => body.id)
        .distance((wire) => wire.kind === "uses" ? 105 : 175)
        .strength((wire) => wire.kind === "uses" ? 0.5 : 0.8),
    )
    .force(
      "charge",
      forceManyBody<Body>().strength((body) =>
        body.kind === "resource" ? -320 : -900
      ),
    )
    .force("collide", forceCollide<Body>((body) => body.r).iterations(2))
    .force("x", forceX<Body>(0).strength(0.05))
    .force("y", forceY<Body>(0).strength(0.09))
    .stop();
  for (let tick = 0; tick < TICKS; tick++) simulation.tick();
  // What a soft collision leaves touching is pushed apart, box against box.
  for (let pass = 0; pass < SEPARATIONS; pass++) separate(bodies, GAP);

  const extent = () => ({
    left: Math.min(...bodies.map((b) => (b.x ?? 0) - b.w / 2)),
    right: Math.max(...bodies.map((b) => (b.x ?? 0) + b.w / 2)),
    top: Math.min(...bodies.map((b) => (b.y ?? 0) - b.h / 2)),
    bottom: Math.max(...bodies.map((b) => (b.y ?? 0) + b.h / 2)),
  });
  const { left, right } = extent();
  const scale = Math.min(1, (width - 2 * PAD) / (right - left));
  for (const body of bodies) {
    body.x = width / 2 + ((body.x ?? 0) - (left + right) / 2) * scale;
  }
  // Narrowing brings nodes together again, and the room has walls where the
  // frame's height has none: the walls hold each node in, and the nodes are
  // pushed apart vertically only, so that holding them in never puts one back
  // on top of another.
  if (scale < 1) {
    for (let pass = 0; pass < SEPARATIONS * 3; pass++) {
      for (const body of bodies) body.x = hold(body.x ?? 0, body.w, width);
      separate(bodies, GAP, "y");
    }
  }
  const { top, bottom } = extent();
  const height = Math.ceil(bottom - top + 2 * PAD);
  const boxes = bodies.map((body, index): Box => {
    const { ay } = boxSize(nodes[index]);
    const at = keepInside(
      { x: body.x ?? 0, y: PAD + (body.y ?? 0) - top },
      body,
      { width, height },
    );
    return { id: body.id, kind: body.kind, ...at, w: body.w, h: body.h, ay };
  });
  return { width, height, boxes };
}

/** A value kept between the two ends of a limit, with a little air; the middle when it does not fit. */
function hold(value: number, extent: number, limit: number): number {
  const low = extent / 2 + EDGE, high = limit - extent / 2 - EDGE;
  return high < low ? limit / 2 : Math.min(high, Math.max(low, value));
}

/** A centre kept inside the frame, with a little air, whatever the box. */
export function keepInside(
  at: { x: number; y: number },
  size: Pick<Box, "w" | "h">,
  frame: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: tenth(hold(at.x, size.w, frame.width)),
    y: tenth(hold(at.y, size.h, frame.height)),
  };
}

/** The line between two boxes: from avatar to avatar, from pill to pill. */
export function wireBetween(
  from: Pick<Box, "x" | "y" | "ay">,
  to: Pick<Box, "x" | "y" | "ay">,
): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: from.x,
    y1: tenth(from.y + from.ay),
    x2: to.x,
    y2: tenth(to.y + to.ay),
  };
}

/** A press that moves less than this is a click, not a drag. */
export const DRAG_SLOP = 4;

export const isDrag = (dx: number, dy: number): boolean =>
  Math.hypot(dx, dy) > DRAG_SLOP;
