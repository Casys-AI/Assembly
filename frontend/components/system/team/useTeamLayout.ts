import { type RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type LayoutEdge,
  layoutKey,
  type LayoutNode,
  layoutTeam,
  TEAM_ROOM,
  type TeamLayout,
} from "../../../lib/system/team/layout.ts";

/**
 * The layout of the network, kept for as long as what it depends on is the
 * same (the nodes, the wires, the width): a page that draws again because a
 * node was selected, or dragged, asks the same layout and gets it, and the
 * simulation does not run again. `layout` is the simulation; a test passes its
 * own to count the runs.
 */
export function useTeamLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  width: number,
  layout: typeof layoutTeam = layoutTeam,
): { layout: TeamLayout; key: string } {
  const kept = useRef<{ key: string; layout: TeamLayout }>();
  const key = layoutKey(nodes, edges, width);
  if (kept.current?.key !== key) {
    kept.current = { key, layout: layout(nodes, edges, width) };
  }
  return { layout: kept.current.layout, key };
}

/** A width is rounded down to this, so a window being resized settles on few layouts. */
const STEP = 24;
const NARROWEST = 320;

/**
 * The width of the room the network is drawn in. Until it is measured (on the
 * server, and in the first frame) it is the width a full page has; a room
 * that is hidden, or not measurable, keeps the width it had.
 */
export function useRoomWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(TEAM_ROOM);
  useLayoutEffect(() => {
    const room = ref.current;
    if (!room || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const measured = room.clientWidth;
      if (measured > 0) {
        setWidth(Math.max(NARROWEST, Math.floor(measured / STEP) * STEP));
      }
    };
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(room);
    return () => watching.disconnect();
  }, [ref]);
  return width;
}
