import cytoscape, {
  type Core,
  type EdgeSingular,
  type NodeSingular,
  type Position,
} from "cytoscape";
import { flowCycleBreak, isItem, isPart, isSuccession } from "./projection.ts";
import type { GraphNode } from "./types.ts";
import { DiagramModel } from "./view-model.ts";
import {
  graphStyle,
  isStructuralView,
  STRUCTURAL_EDGE_CLASS,
} from "./style.ts";
import { forceOrder, type ForceOrderLink } from "./force-order.ts";

const ROOT_GROUP = "\0root";

export interface DiagramViewport {
  zoom: number;
  pan: Position;
  positions: Map<string, Position>;
}
export function diagramViewportVisible(cy: Core): boolean {
  const width = cy.width(),
    height = cy.height(),
    zoom = cy.zoom(),
    pan = cy.pan();
  if (
    width < 2 || height < 2 || !Number.isFinite(zoom) || zoom <= 0 ||
    !Number.isFinite(pan.x) || !Number.isFinite(pan.y)
  ) return false;
  return (cy.nodes().filter((node) =>
    !node.isParent() && !node.hasClass("port")
  ).toArray() as NodeSingular[]).some((node) => {
    const position = node.renderedPosition(),
      w = node.outerWidth() * zoom / 2,
      h = node.outerHeight() * zoom / 2;
    return Number.isFinite(position.x) && Number.isFinite(position.y) &&
      position.x + w >= 0 && position.x - w <= width && position.y + h >= 0 &&
      position.y - h <= height;
  });
}
export function diagramViewport(
  cy: Core,
  preserve: boolean,
): DiagramViewport | null {
  if (!preserve || !diagramViewportVisible(cy)) return null;
  return {
    zoom: cy.zoom(),
    pan: { ...cy.pan() },
    positions: new Map(
      (cy.nodes().filter((node) => !node.isParent())
        .toArray() as NodeSingular[]).map(
          (node) => [node.id(), { ...node.position() }],
        ),
    ),
  };
}
export function restoreDiagramViewport(
  cy: Core,
  viewport: DiagramViewport | null,
): void {
  if (!viewport) return;
  cy.nodes().filter((node) =>
    !node.isParent() && viewport.positions.has(node.id())
  ).positions((node) => viewport.positions.get(node.id())!);
  cy.zoom(viewport.zoom);
  cy.pan(viewport.pan);
}

/** Dense compound diagrams should open readable, even when panning is needed. */
export function readableFitZoom(view?: string): number {
  return view === "interconnection" || view === "general" ? .62 : 0;
}

/** Owns a single canvas and its lifecycle; no document-wide queries or application state. */
export class GraphController {
  readonly cy: Core;
  model: DiagramModel | null = null;
  #observer?: ResizeObserver;
  #frame: number | null = null;
  #disposed = false;
  #needsFit = true;
  #headless: boolean;
  // Last framing is also retained while a Fresh sibling view hides this canvas.
  #viewport: DiagramViewport | null = null;
  // Sibling orders computed once per tidy layout (measure and place share).
  #orderCache = new Map<string, string[]>();
  constructor(
    readonly container: HTMLElement | undefined,
    onSelect: (id: string, isEdge: boolean) => void,
    headless = false,
  ) {
    this.#headless = headless;
    this.cy = cytoscape({
      container,
      headless,
      styleEnabled: true,
      minZoom: .01,
      maxZoom: 3,
      style: graphStyle,
    });
    this.cy.on("tap", "node", (event) => onSelect(event.target.id(), false));
    this.cy.on(
      "tap",
      "edge",
      (event) => onSelect(event.target.id().slice(2), true),
    );
    this.cy.on("dragfree", "node.part", () => this.placePorts());
    this.cy.on("tap", (event) => {
      if (event.target === this.cy) this.clearSelection();
    });
    this.cy.on("pan zoom dragfree", () => {
      const viewport = diagramViewport(this.cy, true);
      if (viewport) this.#viewport = viewport;
    });
    if (container && !headless) {
      this.#observer = new ResizeObserver(() => this.resize());
      this.#observer.observe(container);
    }
  }
  render(model: DiagramModel, preserve = false): void {
    if (this.#disposed) return;
    const selectedIds = preserve
      ? this.cy.$(":selected").map((element) => element.id())
      : [];
    const viewport = preserve
      ? diagramViewport(this.cy, true) || this.#viewport
      : null;
    this.model = model;
    this.cy.elements().remove();
    if (["requirements", "sequence"].includes(model.options.view)) return;
    this.cy.resize();
    this.cy.add(model.elements);
    // Vues structurelles : classe posée selon la vue (voir graph-style.ts).
    if (isStructuralView(model.options.view)) {
      this.cy.edges().addClass(STRUCTURAL_EDGE_CLASS);
    }
    this.layout();
    restoreDiagramViewport(this.cy, viewport);
    if (viewport) {
      this.#viewport = viewport;
      this.placePorts();
      this.#needsFit = false;
    } else {
      this.#viewport = null;
      this.fit();
    }
    let restored = this.cy.collection();
    for (const id of selectedIds) {
      const selected = this.cy.getElementById(id);
      if (selected.length) restored = restored.union(selected);
    }
    this.#focusSelection(restored);
  }
  clearSelection(): void {
    this.cy.$(":selected").unselect();
    this.cy.elements().removeClass("hl faded");
  }
  #focusSelection(selection: ReturnType<Core["elements"]>): void {
    this.cy.elements().removeClass("hl faded");
    if (!selection.length) return;
    selection.select();
    let neighborhood = selection.closedNeighborhood();
    neighborhood = neighborhood.union(neighborhood.nodes().ancestors());
    this.cy.elements().difference(neighborhood).addClass("faded");
    selection.edges().addClass("hl");
    selection.nodes().connectedEdges().intersection(neighborhood).addClass(
      "hl",
    );
  }
  select(id: string, center = false): void {
    const element = this.cy.getElementById(id);
    this.cy.$(":selected").unselect();
    this.#focusSelection(element);
    if (element.length && center) {
      this.cy.animate({ center: { eles: element }, duration: 200 });
    }
  }
  zoom(factor: number): void {
    this.cy.zoom({
      level: this.cy.zoom() * factor,
      renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 },
    });
  }
  #frameGraph(): void {
    this.placePorts();
    this.cy.fit(this.cy.elements(), this.padding());
    const minimumZoom = readableFitZoom(this.model?.options.view);
    if (minimumZoom && this.cy.zoom() < minimumZoom) {
      this.cy.zoom(minimumZoom);
      const operators = this.cy.nodes(".operator");
      const focus = operators.length
        ? operators
        : this.cy.nodes(":childless").not(".port");
      if (focus.length) this.#centerReadably(focus);
    }
  }
  /**
   * Centre the focus at the readable zoom without pushing the graph into a
   * corner: per axis, if the graph fits it is centred as a whole, else the
   * focus centre is clamped so no empty margin opens on the near edge.
   */
  #centerReadably(focus: ReturnType<Core["nodes"]>): void {
    const zoom = this.cy.zoom(),
      width = this.cy.width(),
      height = this.cy.height();
    if (!(width > 0) || !(height > 0) || !Number.isFinite(zoom) || zoom <= 0) {
      this.cy.center(focus);
      return;
    }
    const graph = this.cy.elements().boundingBox({ includeLabels: false });
    const target = focus.boundingBox({ includeLabels: false });
    const axis = (centre: number, min: number, max: number, view: number) => {
      if ((max - min) * zoom <= view) return (min + max) / 2;
      const half = view / (2 * zoom);
      return Math.min(max - half, Math.max(min + half, centre));
    };
    const cx = axis((target.x1 + target.x2) / 2, graph.x1, graph.x2, width);
    const cy = axis((target.y1 + target.y2) / 2, graph.y1, graph.y2, height);
    this.cy.pan({ x: width / 2 - cx * zoom, y: height / 2 - cy * zoom });
  }
  fit(): void {
    this.#needsFit = true;
    this.#viewport = null;
    if (this.#headless) {
      this.#frameGraph();
      this.#needsFit = false;
      return;
    }
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      if (this.#disposed || !this.container || !this.cy.nodes().length) return;
      const rect = this.container.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      this.cy.resize();
      this.#frameGraph();
      this.#needsFit = !diagramViewportVisible(this.cy);
      this.#viewport = diagramViewport(this.cy, true);
    });
  }
  resize(): void {
    if (this.#disposed || this.#headless) return;
    const rect = this.container?.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return;
    const viewport = diagramViewport(this.cy, true) || this.#viewport;
    this.cy.resize();
    if (!this.#needsFit && viewport) {
      restoreDiagramViewport(this.cy, viewport);
      this.placePorts();
    } else this.fit();
  }
  destroy(): void {
    this.#disposed = true;
    this.#observer?.disconnect();
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.cy.destroy();
  }
  padding(): number {
    const view = this.model?.options.view;
    return view === "action-flow" || view === "state-transition"
      ? 36
      : view === "general"
      ? 50
      : 35;
  }
  placePorts(): void {
    const model = this.model;
    if (
      !model || !["interconnection", "general"].includes(model.options.view)
    ) return;
    const groups = new Map<string, NodeSingular[]>();
    this.cy.nodes(".port").forEach((port) => {
      const owner = model.map.get(port.id())?.parentId;
      if (owner && this.cy.getElementById(owner).length) {
        groups.set(owner, [...(groups.get(owner) || []), port]);
      }
    });
    for (const [id, ports] of groups) {
      const owner = this.cy.getElementById(id),
        box = owner.boundingBox({
          includeLabels: false,
          includeOverlays: false,
        });
      const sides: Record<"left" | "right", NodeSingular[]> = {
        left: [],
        right: [],
      };
      for (const port of ports) {
        let sum = 0, count = 0;
        port.connectedEdges().forEach((edge) => {
          const other = edge.source().id() === port.id()
            ? edge.target()
            : edge.source();
          const record = model.map.get(other.id()),
            otherOwner = record?.parentId
              ? this.cy.getElementById(record.parentId)
              : null;
          sum += otherOwner?.length
            ? otherOwner.position("x")
            : other.position("x");
          count++;
        });
        sides[count && sum / count < owner.position("x") ? "left" : "right"]
          .push(port);
      }
      for (const side of ["left", "right"] as const) {
        sides[side].forEach((port, index) => {
          port.position({
            x: side === "left" ? box.x1 : box.x2,
            y: box.y1 + 30 +
              (box.h - 38) * (index + 1) / (sides[side].length + 1),
          });
          const outside = owner.isParent();
          port.style({
            "text-halign": side === "left"
              ? (outside ? "left" : "right")
              : (outside ? "right" : "left"),
            "text-margin-x": side === "left"
              ? (outside ? -7 : 7)
              : (outside ? 7 : -7),
          });
        });
      }
    }
  }
  layoutStructure(): void {
    const model = this.model;
    if (!model) return;
    const counts = new Map<string, number>();
    this.cy.nodes(".port").forEach((port) => {
      const owner = model.map.get(port.id())?.parentId;
      if (owner) counts.set(owner, (counts.get(owner) || 0) + 1);
    });
    this.cy.nodes(".part:childless").forEach((part) => {
      const ports = counts.get(part.id()) || 0;
      part.style({
        width: 180,
        height: Math.max(72, 64 + ports * 8),
        "text-valign": ports ? "top" : "center",
        "text-margin-y": ports ? 28 : 0,
      });
    });
    this.layoutTidy();
  }
  /** Order siblings so connected parts sit near each other (deterministic). */
  tidyOrder(children: NodeSingular[]): NodeSingular[] {
    const degree = (node: NodeSingular) => node.connectedEdges().length;
    const links = (a: NodeSingular, b: NodeSingular) =>
      a.connectedEdges().filter((edge) =>
        edge.source().id() === b.id() || edge.target().id() === b.id()
      ).length;
    const remaining = [...children].sort((a, b) =>
      degree(b) - degree(a) || a.id().localeCompare(b.id())
    );
    if (!remaining.length) return remaining;
    const ordered = [remaining.shift()!];
    while (remaining.length) {
      let best = 0, bestScore = -1;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const score = ordered.reduce(
          (sum, placed) => sum + links(candidate, placed) * 100,
          degree(candidate),
        );
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      ordered.push(remaining.splice(best, 1)[0]);
    }
    return ordered;
  }
  /** Direct child of `group` whose subtree owns edge endpoint `id`. */
  #representative(id: string, group: string): string | null {
    const model = this.model;
    if (!model) return null;
    let node = this.cy.getElementById(id);
    if (!node.length) return null;
    if (node.hasClass("port")) {
      const owner = model.map.get(id)?.parentId;
      if (!owner) return null;
      node = this.cy.getElementById(owner);
      if (!node.length) return null;
    }
    let current = node.first() as NodeSingular;
    for (;;) {
      const parent = current.parent();
      const parentId = parent.length ? parent.first().id() : ROOT_GROUP;
      if (parentId === group) return current.id();
      if (!parent.length) return null;
      current = parent.first() as NodeSingular;
    }
  }
  /** Link weights between siblings, counting edges anywhere in subtrees. */
  #siblingLinks(
    children: NodeSingular[],
    group: string,
  ): ForceOrderLink[] {
    const childIds = new Set(children.map((child) => child.id()));
    const weights = new Map<string, ForceOrderLink>();
    this.cy.edges().forEach((edge) => {
      const source = this.#representative(edge.source().id(), group);
      const target = this.#representative(edge.target().id(), group);
      if (!source || !target || source === target) return;
      if (!childIds.has(source) || !childIds.has(target)) return;
      const pair = [source, target].sort();
      const key = pair.join("\0");
      const known = weights.get(key);
      if (known) known.weight += 1;
      else weights.set(key, { source: pair[0], target: pair[1], weight: 1 });
    });
    return [...weights.values()];
  }
  /**
   * Hybrid sibling order: a force equilibrium (D3) over subtree link
   * weights decides which siblings sit together; tidyPack then packs the
   * sequence into aligned rows. Falls back to the greedy order when the
   * group carries no usable link structure.
   */
  orderedSiblings(
    children: NodeSingular[],
    group: string,
    size: Map<string, { w: number; h: number }>,
  ): NodeSingular[] {
    const cacheKey = `${group}|${
      children.map((child) => child.id()).join(",")
    }`;
    const cached = this.#orderCache.get(cacheKey);
    const byId = new Map(children.map((child) => [child.id(), child]));
    if (cached) return cached.map((id) => byId.get(id)!).filter(Boolean);
    let ordered = this.tidyOrder(children);
    if (children.length >= 3 && children.length <= 60) {
      const links = this.#siblingLinks(children, group);
      if (links.length) {
        const ids = forceOrder(
          children.map((child) => ({
            id: child.id(),
            ...size.get(child.id())!,
          })),
          links,
        );
        const placed = ids.map((id) => byId.get(id)!).filter(Boolean);
        if (placed.length === children.length) ordered = placed;
      }
    }
    this.#orderCache.set(cacheKey, ordered.map((child) => child.id()));
    return ordered;
  }
  /**
   * Pack ordered children with a skyline: each child drops onto the lowest
   * free contour that fits its width, so small elements fill under short
   * neighbours instead of wasting a whole shared row height. The wrap width
   * is searched among sequence prefix widths, scored by area and aspect.
   */
  tidyPack(
    children: NodeSingular[],
    size: Map<string, { w: number; h: number }>,
    gapX: number,
    gapY: number,
    targetAspect: number,
  ): { at: Map<string, { x: number; y: number }>; w: number; h: number } {
    type Item = { id: string; w: number; h: number };
    const items: Item[] = children.map((child) => ({
      id: child.id(),
      ...size.get(child.id())!,
    }));
    const packAt = (maxW: number) => {
      type Seg = { x: number; w: number; y: number };
      let sky: Seg[] = [{ x: 0, w: Math.max(maxW, 1), y: 0 }];
      const at = new Map<string, { x: number; y: number }>();
      let w = 0, h = 0;
      for (const item of items) {
        const iw = item.w + gapX, ih = item.h + gapY;
        let bestX = 0, bestY = Infinity;
        for (const seg of sky) {
          const x = seg.x;
          if (x + iw > maxW + gapX && iw <= maxW + gapX) continue;
          let y = 0;
          for (const other of sky) {
            if (other.x < x + iw && x < other.x + other.w) {
              y = Math.max(y, other.y);
            }
          }
          if (y < bestY) {
            bestY = y;
            bestX = x;
          }
        }
        if (!Number.isFinite(bestY)) {
          bestX = 0;
          bestY = Math.max(...sky.map((seg) => seg.y));
        }
        at.set(item.id, { x: bestX, y: bestY });
        w = Math.max(w, bestX + item.w);
        h = Math.max(h, bestY + item.h);
        const end = bestX + iw, raised = bestY + ih;
        const next: Seg[] = [];
        for (const seg of sky) {
          const segEnd = seg.x + seg.w;
          if (segEnd <= bestX || seg.x >= end) {
            next.push(seg);
            continue;
          }
          if (seg.x < bestX) {
            next.push({ x: seg.x, w: bestX - seg.x, y: seg.y });
          }
          if (segEnd > end) next.push({ x: end, w: segEnd - end, y: seg.y });
        }
        next.push({ x: bestX, w: iw, y: raised });
        next.sort((a, b) => a.x - b.x);
        sky = next.filter((seg, index) => {
          const prev = next[index - 1];
          if (prev && prev.y === seg.y && prev.x + prev.w === seg.x) {
            prev.w += seg.w;
            return false;
          }
          return seg.w > 0;
        });
      }
      return { at, w, h };
    };
    const widest = Math.max(...items.map((item) => item.w));
    const candidates = new Set<number>([widest]);
    let prefix = 0;
    for (const item of items) {
      prefix += item.w + gapX;
      candidates.add(prefix - gapX);
    }
    const area = items.reduce(
      (sum, item) => sum + (item.w + gapX) * (item.h + gapY),
      0,
    );
    candidates.add(Math.max(widest, Math.sqrt(area * targetAspect)));
    let best: ReturnType<typeof packAt> | null = null, bestScore = Infinity;
    for (const maxW of [...candidates].sort((a, b) => a - b)) {
      if (maxW < widest) continue;
      const packed = packAt(maxW);
      const score = packed.w * packed.h *
        (1 +
          Math.abs(
            Math.log((packed.w / Math.max(1, packed.h)) / targetAspect),
          ));
      if (score < bestScore) {
        bestScore = score;
        best = packed;
      }
    }
    return best!;
  }
  /**
   * Nested-frame layout: every compound parent becomes a compact frame.
   * Sibling order comes from a deterministic D3 force equilibrium over
   * subtree link weights (orderedSiblings); the sequence is then
   * skyline-packed, aligned and overlap-free, so renders stay stable.
   * Ports stay on the owner border via placePorts.
   */
  layoutTidy(): void {
    const nodes = this.cy.nodes().not(".port");
    if (!nodes.length) return;
    this.#orderCache.clear();
    const size = new Map<string, { w: number; h: number }>();
    const measure = (node: NodeSingular): { w: number; h: number } => {
      const cached = size.get(node.id());
      if (cached) return cached;
      const children = node.children().not(".port").toArray() as NodeSingular[];
      let result: { w: number; h: number };
      if (!children.length) {
        result = {
          w: Math.max(60, node.width() || 160),
          h: Math.max(36, node.height() || 60),
        };
      } else {
        for (const child of children) measure(child);
        const ordered = this.orderedSiblings(children, node.id(), size);
        const pack = this.tidyPack(ordered, size, 26, 30, 1.5);
        result = { w: pack.w + 56, h: pack.h + 64 };
      }
      size.set(node.id(), result);
      return result;
    };
    const place = (
      node: NodeSingular,
      left: number,
      top: number,
    ): void => {
      const children = node.children().not(".port").toArray() as NodeSingular[];
      if (!children.length) {
        const own = size.get(node.id())!;
        node.position({ x: left + own.w / 2, y: top + own.h / 2 });
        return;
      }
      const ordered = this.orderedSiblings(children, node.id(), size);
      const pack = this.tidyPack(ordered, size, 26, 30, 1.5);
      for (const child of ordered) {
        const at = pack.at.get(child.id())!;
        place(child, left + 28 + at.x, top + 36 + at.y);
      }
    };
    const roots = nodes.filter(":orphan")
      .toArray() as NodeSingular[];
    for (const root of roots) measure(root);
    const orderedRoots = this.orderedSiblings(roots, ROOT_GROUP, size);
    const pack = this.tidyPack(orderedRoots, size, 44, 40, 1.6);
    for (const root of orderedRoots) {
      const at = pack.at.get(root.id())!;
      place(root, at.x, at.y);
    }
    this.centerCompoundLayout();
  }
  centerCompoundLayout(): void {
    const vertices = this.cy.nodes().not(".port");
    const box = vertices.boundingBox({ includeLabels: false });
    const center = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    vertices.nodes(":childless").positions((node) => ({
      x: node.position("x") - center.x,
      y: node.position("y") - center.y,
    }));
  }
  layoutNativeOverview(): void {
    const model = this.model!;
    const content = model.allocated,
      nodes = model.visibleNodes,
      shown = new Set(nodes.map((node) => node.id));
    const parts = nodes.filter((node) =>
      isPart(node) || model.context(node) ||
      isItem(node) && !content.outputs.some((output) => output.id === node.id)
    );
    const operators = parts.filter((node) => model.operator(node)),
      visible = new Set(parts.map((node) => node.id));
    // Operator blocks keep their operator -> actions -> outputs columns,
    // but blocks themselves wrap into rows instead of one tall stack.
    // A block with many actions splits them into two action columns.
    const ROW_LIMIT = 1420;
    let blockX = 0, blockTop = 20, rowBottom = 20;
    const placed = new Set<string>();
    for (const holder of operators) {
      const actions = content.actions.filter((action) =>
        content.owner.get(action.id) === holder.id && shown.has(action.id)
      );
      const blocks = actions.map((action) => ({
        action,
        outputs: content.outputs.filter((node) =>
          node.parentId === action.id && shown.has(node.id)
        ),
      }));
      const groupCount = blocks.length > 6 ? 2 : 1;
      const groups: (typeof blocks)[] = [];
      for (let g = 0; g < groupCount; g++) {
        groups.push(
          blocks.filter((_, index) => index % groupCount === g),
        );
      }
      const stackHeight = (group: typeof blocks) =>
        group.reduce(
          (sum, block) => sum + Math.max(68, block.outputs.length * 44 + 16),
          0,
        );
      const height = Math.max(80, ...groups.map(stackHeight));
      const blockW = groupCount === 2 ? 1065 : 640;
      if (blockX > 0 && blockX + blockW > ROW_LIMIT) {
        blockX = 0;
        blockTop = rowBottom + 60;
      }
      placed.add(holder.id);
      this.cy.getElementById(holder.id).position({
        x: blockX + 100,
        y: blockTop + height / 2,
      });
      groups.forEach((group, groupIndex) => {
        let row = blockTop;
        for (const block of group) {
          placed.add(block.action.id);
          const blockHeight = Math.max(68, block.outputs.length * 44 + 16);
          this.cy.getElementById(block.action.id).position({
            x: blockX + 315 + groupIndex * 425,
            y: row + blockHeight / 2,
          });
          block.outputs.forEach((output, index) => {
            placed.add(output.id);
            this.cy.getElementById(output.id).position({
              x: blockX + 510 + groupIndex * 425,
              y: row + (blockHeight - (block.outputs.length - 1) * 44) / 2 +
                index * 44,
            });
          });
          row += blockHeight;
        }
      });
      rowBottom = Math.max(rowBottom, blockTop + height);
      blockX += blockW + 60;
    }
    // Neutral parts: pack each subtree in rows below the operator blocks
    // instead of stacking the whole forest into one tall column.
    const neutralChildren = (part: GraphNode) =>
      parts.filter((node) => node.parentId === part.id && !placed.has(node.id));
    const nSize = new Map<string, { w: number; h: number }>();
    const nMeasure = (part: GraphNode): { w: number; h: number } => {
      const cached = nSize.get(part.id);
      if (cached) return cached;
      const children = neutralChildren(part);
      let result: { w: number; h: number };
      if (!children.length) {
        const element = this.cy.getElementById(part.id);
        result = { w: Math.max(170, element.width() || 170), h: 74 };
      } else {
        let w = 0, h = 0;
        const cols = children.length > 8 ? 3 : children.length > 3 ? 2 : 1;
        for (let i = 0; i < children.length; i += cols) {
          const row = children.slice(i, i + cols);
          w = Math.max(
            w,
            row.reduce((sum, child) => sum + nMeasure(child).w, 0) +
              24 * (row.length - 1),
          );
          h += Math.max(...row.map((child) => nMeasure(child).h)) + 20;
        }
        result = { w: w + 48, h: h - 20 + 56 };
      }
      nSize.set(part.id, result);
      return result;
    };
    const nPlace = (part: GraphNode, left: number, top: number): void => {
      placed.add(part.id);
      const children = neutralChildren(part);
      if (!children.length) {
        const own = nSize.get(part.id)!;
        this.cy.getElementById(part.id).position({
          x: left + own.w / 2,
          y: top + own.h / 2,
        });
        return;
      }
      const cols = children.length > 8 ? 3 : children.length > 3 ? 2 : 1;
      let y = top + 34;
      for (let i = 0; i < children.length; i += cols) {
        const row = children.slice(i, i + cols);
        let x = left + 24;
        const rowHeight = Math.max(
          ...row.map((child) => nMeasure(child).h),
        );
        for (const child of row) {
          nPlace(child, x, y);
          x += nMeasure(child).w + 24;
        }
        y += rowHeight + 20;
      }
    };
    let rootX = 0;
    for (
      const root of parts.filter((node) =>
        !model.operator(node) && !visible.has(node.parentId || "") &&
        !placed.has(node.id)
      )
    ) {
      const own = nMeasure(root);
      nPlace(root, rootX, rowBottom + 70);
      rootX += own.w + 44;
    }
  }
  layout(): void {
    const model = this.model;
    if (!model || !this.cy.nodes().length) return;
    const { view, filter, showAllocated } = model.options;
    if (["action-flow", "state-transition"].includes(view)) {
      this.layoutBehavior();
    } else if (
      view === "general" && filter === "usages" &&
      model.viewPlan?.parentByView.size
    ) {
      // The compound tree includes explicitly nested native views and actions
      // exposed outside judgment allocations. Pack that tree without replacing
      // the caller's existing viewport preservation behavior.
      this.layoutTidy();
    } else if (
      view === "general" && filter === "usages" && showAllocated &&
      model.allocated.actions.length
    ) this.layoutNativeOverview();
    else if (view === "interconnection") this.layoutStructure();
    else this.layoutTidy();
    this.placePorts();
  }
  layoutBehavior(): void {
    const nodes = this.cy.nodes(),
      nativeEdges = this.cy.edges().filter((edge) =>
        isSuccession({ kind: edge.data("kind") })
      );
    const cycle = this.model?.options.view === "action-flow"
      ? flowCycleBreak(
        nodes.map((node) => node.id()),
        (nativeEdges.toArray() as EdgeSingular[]).map((edge) => ({
          id: edge.id(),
          source: edge.source().id(),
          target: edge.target().id(),
        })),
      )
      : null;
    nativeEdges.removeClass("layout-return layout-bypass layout-bypass-left");
    if (cycle) {
      nativeEdges.filter((edge) => cycle.feedbackEdgeIds.has(edge.id()))
        .addClass("layout-return");
    }
    const edges = cycle
      ? nativeEdges.filter((edge) => !cycle.feedbackEdgeIds.has(edge.id()))
      : nativeEdges;
    const incoming = new Map<string, EdgeSingular[]>(
        nodes.map((node) => [node.id(), []]),
      ),
      outgoing = new Map<string, EdgeSingular[]>(
        nodes.map((node) => [node.id(), []]),
      );
    edges.forEach((edge) => {
      outgoing.get(edge.source().id())!.push(edge);
      incoming.get(edge.target().id())!.push(edge);
    });
    const remaining = new Map(
      nodes.map((node) => [node.id(), incoming.get(node.id())!.length]),
    );
    const queue = nodes.filter((node) => !remaining.get(node.id())).map(
        (node) => node.id(),
      ),
      ordered: string[] = [],
      rank = new Map(queue.map((id) => [id, 0]));
    while (queue.length) {
      const id = queue.shift()!;
      ordered.push(id);
      for (const edge of outgoing.get(id)!) {
        const target = edge.target().id();
        rank.set(
          target,
          Math.max(rank.get(target) || 0, (rank.get(id) || 0) + 1),
        );
        remaining.set(target, remaining.get(target)! - 1);
        if (!remaining.get(target)) queue.push(target);
      }
    }
    if (ordered.length !== nodes.length) {
      this.cy.layout({
        name: "breadthfirst",
        directed: true,
        spacingFactor: .85,
        avoidOverlap: true,
        animate: false,
        fit: false,
      }).run();
      return;
    }
    edges.forEach((edge) => {
      if (
        (rank.get(edge.target().id()) || 0) -
            (rank.get(edge.source().id()) || 0) > 1
      ) edge.addClass("layout-bypass");
    });
    const tail = new Map<string, number>();
    for (const id of [...ordered].reverse()) {
      tail.set(
        id,
        Math.max(
          0,
          ...outgoing.get(id)!.map((edge) =>
            1 + (tail.get(edge.target().id()) || 0)
          ),
        ),
      );
    }
    const primary = new Map<string, string>();
    for (const id of ordered) {
      const choices = [...outgoing.get(id)!].sort((a, b) => {
        const ai = incoming.get(a.target().id())!.length === 1 ? 1 : 0,
          bi = incoming.get(b.target().id())!.length === 1 ? 1 : 0;
        return bi - ai ||
          (tail.get(b.target().id()) || 0) - (tail.get(a.target().id()) || 0) ||
          a.id().localeCompare(b.id());
      });
      if (choices.length) primary.set(id, choices[0].id());
    }
    const lane = new Map<string, number>(),
      occupied = new Map<number, Set<number>>();
    let rootLane = 0;
    for (const id of ordered) {
      const incomingEdges = incoming.get(id)!;
      let col = incomingEdges.length
        ? Math.min(
          ...incomingEdges.map((edge) =>
            (lane.get(edge.source().id()) || 0) +
            (primary.get(edge.source().id()) === edge.id() ? 0 : 1)
          ),
        )
        : rootLane++;
      const row = rank.get(id) || 0;
      if (!occupied.has(row)) occupied.set(row, new Set());
      while (occupied.get(row)!.has(col)) col++;
      occupied.get(row)!.add(col);
      lane.set(id, col);
    }
    const heights = new Map<number, number>();
    for (const id of ordered) {
      const row = rank.get(id) || 0;
      heights.set(
        row,
        Math.max(
          heights.get(row) || 0,
          this.cy.getElementById(id).outerHeight(),
        ),
      );
    }
    const guarded = new Set(
      (nativeEdges.filter((edge) => Boolean(edge.data("label")))
        .toArray() as EdgeSingular[]).map((edge) =>
          rank.get(edge.source().id()) || 0
        ),
    );
    const rowY = new Map<number, number>();
    let top = 20;
    for (const row of [...heights.keys()].sort((a, b) => a - b)) {
      const height = heights.get(row)!;
      rowY.set(row, top + height / 2);
      top += height + (guarded.has(row) ? 46 : 18);
    }
    const laneWidth = this.model?.options.view === "state-transition"
      ? 310
      : 252;
    nodes.positions((node) => ({
      x: 190 + (lane.get(node.id()) || 0) * laneWidth,
      y: rowY.get(rank.get(node.id()) || 0)!,
    }));
    edges.forEach((edge) => {
      if (
        edge.hasClass("layout-bypass") &&
        lane.get(edge.source().id()) === lane.get(edge.target().id())
      ) edge.addClass("layout-bypass-left");
    });
  }
}
