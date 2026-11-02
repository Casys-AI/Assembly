import { useRef, useState } from "preact/hooks";
import {
  type Box,
  isDrag,
  keepInside,
  type TeamLayout,
} from "../../../lib/system/team/layout.ts";

/** Nodes the person has dragged, valid for the layout they were dragged in. */
interface Moved {
  key: string;
  at: Readonly<Record<string, { x: number; y: number }>>;
}

interface Press {
  pointer: number;
  from: { x: number; y: number };
  start: { x: number; y: number };
  dragged: boolean;
}

/** The part of a pointer event a drag reads. */
export interface PointerLike {
  button?: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: unknown;
}

const capture = (event: PointerLike, hold: boolean) => {
  const target = event.currentTarget as Partial<
    Record<"setPointerCapture" | "releasePointerCapture", (id: number) => void>
  >;
  (hold ? target.setPointerCapture : target.releasePointerCapture)?.call(
    target,
    event.pointerId,
  );
};

/**
 * Dragging the nodes of a layout, by pointer events and nothing else: a press
 * that moves further than a click is a drag, which moves the node and stays
 * inside the frame, and the click that ends it is not a choice: the click of
 * the node that was dragged, not the next one, which may come from the keyboard.
 * Where a node
 * was dragged is kept for the layout it was dragged in and goes with it; the
 * layout itself is never asked again. `boxes` are the nodes where they are now.
 */
export function useNodeDrag(layout: TeamLayout, key: string) {
  const [moved, setMoved] = useState<Moved>({ key, at: {} });
  const press = useRef<Press | null>(null);
  /** The node whose drag was just released: its click is the one not to follow. */
  const suppress = useRef<string | null>(null);
  const dragged = moved.key === key ? moved.at : {};
  const boxes = layout.boxes.map((box): Box => ({
    ...box,
    ...dragged[box.id],
  }));

  return {
    boxes,
    /** The handlers of one node, as it is now. */
    grab(box: Box) {
      return {
        onPointerDown(event: PointerLike) {
          if (event.button !== undefined && event.button !== 0) return;
          suppress.current = null;
          press.current = {
            pointer: event.pointerId,
            from: { x: box.x, y: box.y },
            start: { x: event.clientX, y: event.clientY },
            dragged: false,
          };
          capture(event, true);
        },
        onPointerMove(event: PointerLike) {
          const held = press.current;
          if (!held || held.pointer !== event.pointerId) return;
          const dx = event.clientX - held.start.x;
          const dy = event.clientY - held.start.y;
          if (!held.dragged && !isDrag(dx, dy)) return;
          held.dragged = true;
          const to = keepInside(
            { x: held.from.x + dx, y: held.from.y + dy },
            box,
            layout,
          );
          setMoved((now) => ({
            key,
            at: { ...(now.key === key ? now.at : {}), [box.id]: to },
          }));
        },
        onPointerUp(event: PointerLike) {
          const held = press.current;
          if (!held || held.pointer !== event.pointerId) return;
          capture(event, false);
          // The click that ends a drag is not a choice.
          suppress.current = held.dragged ? box.id : null;
          press.current = null;
        },
      };
    },
    /** For the click of a node that is a link: false when it ends that node's drag. */
    clicked(id: string): boolean {
      const ends = suppress.current === id;
      suppress.current = null;
      return !ends;
    },
  };
}
