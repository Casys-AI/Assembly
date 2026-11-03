/**
 * Force-directed sibling ordering for compound diagrams.
 *
 * Pure position computation (d3-force): a seeded spring simulation runs on
 * one sibling group — link springs over caller-supplied representative
 * weights, many-body repulsion, rectangle collision — and the equilibrium
 * is read back as row bands. The caller packs those rows with its aligned
 * deterministic packer, so containment and zero-overlap stay guaranteed by
 * construction while connected siblings end up adjacent.
 */
// @deno-types="npm:@types/d3-force@3"
import {
  type Force,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export interface ForceOrderItem {
  id: string;
  w: number;
  h: number;
}
export interface ForceOrderLink {
  source: string;
  target: string;
  weight: number;
}
export interface ForcePosition {
  x: number;
  y: number;
}

/** A rectangle that moves: its centre `x`, `y` and its size. */
export interface SimItem extends SimulationNodeDatum {
  id: string;
  w: number;
  h: number;
}
interface SimLink extends SimulationLinkDatum<SimItem> {
  weight: number;
}

/** Deterministic PRNG so equal inputs simulate identically. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Push overlapping rectangles apart along their smallest penetration axis, or
 * along `along` when the caller has an axis it cannot give way on.
 */
export function separate(
  items: SimItem[],
  gap: number,
  along?: "x" | "y",
): void {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
      const ox = (a.w + b.w) / 2 + gap - Math.abs(dx);
      const oy = (a.h + b.h) / 2 + gap - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      if (along === undefined ? ox < oy : along === "x") {
        const shift = ox / 2 * (dx >= 0 ? 1 : -1);
        a.x = (a.x ?? 0) - shift;
        b.x = (b.x ?? 0) + shift;
      } else {
        const shift = oy / 2 * (dy >= 0 ? 1 : -1);
        a.y = (a.y ?? 0) - shift;
        b.y = (b.y ?? 0) + shift;
      }
    }
  }
}

/** Equilibrium centres for one sibling group. Sizes stay the caller's. */
export function forcePositions(
  items: ForceOrderItem[],
  links: ForceOrderLink[],
  options: { gap?: number; iterations?: number } = {},
): Map<string, ForcePosition> {
  const gap = options.gap ?? 18;
  const sims: SimItem[] = items.map((item) => ({ ...item }));
  const byId = new Map(sims.map((item) => [item.id, item]));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sims.length) * 1.5));
  const stepX = Math.max(...sims.map((item) => item.w), 60) + 48;
  const stepY = Math.max(...sims.map((item) => item.h), 40) + 48;
  sims.forEach((item, index) => {
    item.x = (index % cols - (cols - 1) / 2) * stepX + (index * 37) % 13;
    item.y = (Math.floor(index / cols) - 0.5) * stepY + (index * 53) % 11;
    item.vx = 0;
    item.vy = 0;
  });
  const aggregated = new Map<string, SimLink>();
  for (const link of links) {
    if (!byId.has(link.source) || !byId.has(link.target)) continue;
    if (link.source === link.target) continue;
    const key = [link.source, link.target].sort().join("\0");
    const known = aggregated.get(key);
    if (known) known.weight += link.weight;
    else aggregated.set(key, { ...link });
  }
  const nodeOf = (end: string | number | SimItem): SimItem =>
    typeof end === "object" ? end : byId.get(String(end))!;
  const rectForce: Force<SimItem, SimLink> = () => separate(sims, gap);
  const simulation = forceSimulation<SimItem>(sims)
    .randomSource(seeded(0x51ab))
    .force(
      "link",
      forceLink<SimItem, SimLink>([...aggregated.values()])
        .id((item) => item.id)
        .distance((link) =>
          (nodeOf(link.source).w + nodeOf(link.target).w) / 2 + 44
        )
        .strength((link) => Math.min(0.9, 0.3 * link.weight)),
    )
    .force("charge", forceManyBody<SimItem>().strength(-120))
    .force("x", forceX<SimItem>(0).strength(0.03))
    .force("y", forceY<SimItem>(0).strength(0.05))
    .force("rect", rectForce)
    .stop();
  const iterations = options.iterations ?? 350;
  for (
    let tick = 0;
    tick < iterations && simulation.alpha() >= simulation.alphaMin();
    tick++
  ) simulation.tick();
  for (let pass = 0; pass < 60; pass++) separate(sims, gap);
  return new Map(
    sims.map((item) => [item.id, { x: item.x ?? 0, y: item.y ?? 0 }]),
  );
}

/**
 * Reading order from the force equilibrium: the shortest nearest-neighbour
 * walk over the equilibrium centres, so spatial adjacency survives as
 * sequence adjacency when the caller packs rows.
 */
export function forceOrder(
  items: ForceOrderItem[],
  links: ForceOrderLink[],
  options: { gap?: number; iterations?: number } = {},
): string[] {
  if (items.length < 2) return items.map((item) => item.id);
  const positions = forcePositions(items, links, options);
  const placed = items.map((item) => ({
    ...item,
    ...positions.get(item.id)!,
  }));
  const distance = (
    a: (typeof placed)[number],
    b: (typeof placed)[number],
  ) => Math.hypot(a.x - b.x, a.y - b.y);
  const walk = (start: (typeof placed)[number]) => {
    const rest = placed.filter((item) => item !== start);
    const path = [start];
    let length = 0;
    while (rest.length) {
      const last = path.at(-1)!;
      let best = 0, bestDistance = Infinity;
      rest.forEach((candidate, index) => {
        const candidateDistance = distance(candidate, last);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          best = index;
        }
      });
      length += bestDistance;
      path.push(rest.splice(best, 1)[0]);
    }
    return { path, length };
  };
  const starts = [...placed].sort((a, b) => a.id.localeCompare(b.id));
  let best = walk(starts[0]);
  for (const start of starts.slice(1)) {
    const candidate = walk(start);
    if (candidate.length < best.length - 1e-9) best = candidate;
  }
  return best.path.map((item) => item.id);
}
