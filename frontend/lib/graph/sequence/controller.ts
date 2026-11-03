import cytoscape, { type Core, type StylesheetStyle } from "cytoscape";
import type { GraphSequence } from "../types.ts";
import {
  SEQUENCE_ROW_HEIGHT,
  sequenceDiagramElements,
  sequenceRecordKey,
} from "./layout.ts";
import { createSequenceInteractionGuard } from "./interaction.ts";

export interface SequenceViewport {
  zoom: number;
  panX: number;
  laneWidth: number;
}
interface SequenceCallbacks {
  onSelect(index: number): void;
  onHover(index: number | null): void;
  onUser(): void;
  onViewport(viewport: SequenceViewport): void;
  shouldFollow(): boolean;
}
const style: StylesheetStyle[] = [
  {
    selector: "node",
    style: {
      width: 1,
      height: 1,
      "background-opacity": 0,
      "border-width": 0,
      label: "",
    },
  },
  {
    selector: ".sequence-lifeline",
    style: {
      width: 1,
      "line-color": "#d3dee8",
      "curve-style": "straight",
      "target-arrow-shape": "none",
    },
  },
  {
    selector: ".sequence-grid-point",
    style: {
      width: 3,
      height: 3,
      "background-opacity": .55,
      "background-color": "#cbd9e5",
    },
  },
  {
    selector: ".sequence-event,.sequence-point",
    style: {
      width: 9,
      height: 9,
      "background-opacity": 1,
      "background-color": "#6f8aa3",
      "border-color": "#f8fafb",
      "border-width": 1.5,
    },
  },
  {
    selector: ".sequence-message",
    style: {
      width: 1.7,
      "line-color": "#7d99b3",
      "target-arrow-color": "#7d99b3",
      "target-arrow-shape": "triangle",
      "arrow-scale": 1,
      "curve-style": "unbundled-bezier",
      "control-point-distances": [-10, 10],
      "control-point-weights": [.3, .7],
      label: "",
    },
  },
  {
    selector: ".sequence-self",
    style: {
      "control-point-distances": [18, 18],
      "control-point-weights": [.25, .75],
    },
  },
  {
    selector: ".sequence-highlight",
    style: {
      "background-color": "#315b7a",
      "line-color": "#315b7a",
      "target-arrow-color": "#315b7a",
      "border-color": "#fff",
      width: 2.8,
    },
  },
  {
    selector: "node.sequence-highlight",
    style: { width: 11, height: 11, "border-width": 2 },
  },
];

/** Preserve the visible record and its within-row offset as retention advances. */
export function sequenceRetainedScrollTop(
  sameSequence: boolean,
  previousTop: number,
  rowHeight: number,
  previousKeys: readonly string[],
  nextKeys: readonly string[],
): number {
  if (!sameSequence) return 0;
  const key = previousKeys[Math.floor(previousTop / rowHeight)];
  const nextIndex = key === undefined ? -1 : nextKeys.indexOf(key);
  return nextIndex >= 0
    ? nextIndex * rowHeight + previousTop % rowHeight
    : previousTop;
}

/** A presentation-only canvas. It never owns application state or authority. */
export class SequenceController {
  readonly cy: Core;
  #sequence: GraphSequence | null = null;
  #keys: string[] = [];
  #laneWidth = 120;
  #disposed = false;
  #suppressed = false;
  #observer: ResizeObserver | undefined;
  #frame: number | null = null;
  #highlightIndex: number | null = null;
  #guard;
  #removeListeners: Array<() => void> = [];
  constructor(
    readonly canvas: HTMLElement,
    readonly body: HTMLElement,
    readonly callbacks: SequenceCallbacks,
  ) {
    this.#guard = createSequenceInteractionGuard(
      (callback) => requestAnimationFrame(callback),
      (id) => cancelAnimationFrame(id),
      (value) => {
        this.#suppressed = value;
      },
      () => callbacks.onUser(),
    );
    this.cy = cytoscape({
      container: canvas,
      elements: [],
      layout: { name: "preset" },
      minZoom: .7,
      maxZoom: 2.5,
      autoungrabify: true,
      autounselectify: true,
      userZoomingEnabled: false,
      style,
    });
    this.cy.on("tap", "node,edge", (event) => {
      const index = event.target.data("recordIndex");
      if (Number.isInteger(index)) callbacks.onSelect(index);
    });
    this.cy.on("mouseover", "node,edge", (event) => {
      const index = event.target.data("recordIndex");
      if (Number.isInteger(index)) callbacks.onHover(index);
    });
    this.cy.on("mouseout", "node,edge", () => callbacks.onHover(null));
    this.cy.on("pan zoom", () => {
      if (this.#suppressed || this.#disposed) return;
      this.#guard.programmatic();
      body.style.setProperty(
        "--sequence-row-height",
        `${SEQUENCE_ROW_HEIGHT * this.cy.zoom()}px`,
      );
      body.scrollTop = Math.max(0, -this.cy.pan().y);
      this.cy.pan({ x: this.cy.pan().x, y: -body.scrollTop });
      this.#publishViewport();
    });
    this.cy.on("dragpan", () => this.#guard.user());
    this.#listen(body, "scroll", () => {
      if (!this.#suppressed) this.#syncScroll();
    });
    this.#listen(body, "wheel", () => this.#guard.user(), {
      capture: true,
      passive: true,
    });
    this.#listen(body, "keydown", (event) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]
          .includes((event as KeyboardEvent).key)
      ) this.#guard.user();
    });
    this.#listen(body, "pointerdown", (event) => {
      if (
        event.target === body &&
        (event as PointerEvent).clientX >=
          body.getBoundingClientRect().left + body.clientWidth
      ) this.#guard.user();
    });
    this.#listen(canvas, "wheel", (input) => {
      const event = input as WheelEvent;
      event.preventDefault();
      if (event.ctrlKey) {
        const level = Math.max(
          .7,
          Math.min(2.5, this.cy.zoom() * Math.exp(-event.deltaY * .01)),
        );
        this.cy.zoom({
          level,
          renderedPosition: { x: event.offsetX, y: event.offsetY },
        });
      } else body.scrollTop += event.deltaY;
    }, { passive: false });
    this.#observer = new ResizeObserver(() => this.resize());
    this.#observer.observe(canvas);
    this.#observer.observe(body);
  }
  #listen(
    target: HTMLElement,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    this.#removeListeners.push(() =>
      target.removeEventListener(type, listener, options)
    );
  }
  #publishViewport() {
    this.callbacks.onViewport({
      zoom: this.cy.zoom(),
      panX: this.cy.pan().x,
      laneWidth: this.#laneWidth,
    });
  }
  #syncScroll() {
    this.#guard.programmatic();
    this.cy.pan({ x: this.cy.pan().x, y: -this.body.scrollTop });
    this.#publishViewport();
  }
  update(sequence: GraphSequence | null) {
    if (this.#disposed) return;
    this.#guard.programmatic();
    const same = this.#sequence?.id === sequence?.id;
    const zoom = same ? this.cy.zoom() : 1;
    const rowHeight = SEQUENCE_ROW_HEIGHT * zoom;
    const previousTop = this.body.scrollTop;
    const panX = this.cy.pan().x;
    this.#sequence = sequence;
    this.body.style.setProperty("--sequence-row-height", `${rowHeight}px`);
    const diagram = this.canvas.parentElement;
    if (diagram) diagram.style.height = `${this.body.clientHeight}px`;
    this.canvas.style.height = `${
      Math.max(160, this.body.clientHeight - 44)
    }px`;
    this.cy.resize();
    const drawable = sequence && sequence.ordering !== "cyclic"
      ? sequence
      : null;
    const layout = drawable
      ? sequenceDiagramElements(drawable, this.cy.width())
      : null;
    this.cy.batch(() => {
      this.cy.elements().remove();
      if (layout) this.cy.add(layout.elements);
    });
    this.#laneWidth = layout?.laneWidth ?? 120;
    const nextKeys = sequence?.messages.map(sequenceRecordKey) ?? [];
    const scrollTop = sequenceRetainedScrollTop(
      same,
      previousTop,
      rowHeight,
      this.#keys,
      nextKeys,
    );
    this.#keys = nextKeys;
    this.cy.zoom(zoom);
    this.body.scrollTop = scrollTop;
    this.cy.pan({
      x: same && layout && layout.width * zoom > this.cy.width() + 1 ? panX : 0,
      y: -this.body.scrollTop,
    });
    this.highlight(this.#highlightIndex);
    this.#publishViewport();
  }
  resize() {
    if (this.#disposed || this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      if (!this.#disposed) {
        this.update(this.#sequence);
        if (this.callbacks.shouldFollow()) this.follow();
      }
    });
  }
  follow() {
    if (this.#disposed) return;
    this.#guard.programmatic();
    this.body.scrollTop = this.body.scrollHeight - this.body.clientHeight;
    this.#syncScroll();
  }
  zoom(factor: number) {
    this.#guard.user();
    this.cy.zoom({
      level: this.cy.zoom() * factor,
      renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 },
    });
  }
  reset() {
    this.#guard.user();
    this.#guard.programmatic();
    this.cy.zoom(1);
    this.body.style.setProperty(
      "--sequence-row-height",
      `${SEQUENCE_ROW_HEIGHT}px`,
    );
    this.cy.pan({ x: 0, y: -this.body.scrollTop });
    this.#publishViewport();
  }
  highlight(index: number | null) {
    this.#highlightIndex = index;
    this.cy.elements().removeClass("sequence-highlight");
    if (index !== null) {
      this.cy.elements().filter((element) =>
        element.data("recordIndex") === index
      ).addClass("sequence-highlight");
    }
  }
  destroy() {
    this.#disposed = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#guard.dispose();
    this.#observer?.disconnect();
    for (const remove of this.#removeListeners) remove();
    this.cy.destroy();
  }
}
