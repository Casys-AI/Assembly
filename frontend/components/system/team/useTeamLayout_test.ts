import { deepStrictEqual, equal, notEqual } from "node:assert/strict";
import type { RefObject } from "preact";
import { act } from "preact/test-utils";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { watchBoard } from "../../../test/support/board-fixture.ts";
import {
  edgesOf,
  layoutTeam,
  nodesOf,
  type TeamLayout,
} from "../../../lib/system/team/layout.ts";
import { teamOf } from "../../../lib/system/team/projection.ts";
import { useRoomWidth, useTeamLayout } from "./useTeamLayout.ts";

const team = teamOf(watchBoard());
const nodes = nodesOf(team), edges = edgesOf(team);

Deno.test("the layout is asked once for as long as its nodes, wires and width are the same", async () => {
  const probe = probeRoot();
  let asked = 0;
  const simulate: typeof layoutTeam = (...args) => {
    asked++;
    return layoutTeam(...args);
  };
  let seen: TeamLayout | undefined;
  function Probe(
    props: {
      nodes: typeof nodes;
      edges: typeof edges;
      width: number;
      tick: number;
    },
  ) {
    seen =
      useTeamLayout(props.nodes, props.edges, props.width, simulate).layout;
    return null;
  }
  try {
    await probe.show(Probe, { nodes, edges, width: 1056, tick: 0 });
    equal(asked, 1);
    const first = seen;
    // The page draws again (an agent was chosen, a node was dragged): same layout.
    await probe.show(Probe, { nodes, edges, width: 1056, tick: 1 });
    await probe.show(Probe, {
      nodes: [...nodes],
      edges: [...edges],
      width: 1056,
      tick: 2,
    });
    equal(asked, 1, "selecting never runs the simulation again");
    equal(seen, first);
    // The width changes: another layout.
    await probe.show(Probe, { nodes, edges, width: 720, tick: 3 });
    equal(asked, 2);
    notEqual(seen, first);
    equal(seen?.width, 720);
    // The team changes: another layout.
    await probe.show(Probe, {
      nodes: nodes.slice(0, 4),
      edges: [],
      width: 720,
      tick: 4,
    });
    equal(asked, 3);
    // And back to the one it was: asked again, to the same positions.
    await probe.show(Probe, { nodes, edges, width: 1056, tick: 5 });
    equal(asked, 4);
    deepStrictEqual(seen, first);
  } finally {
    await probe.restore();
  }
});

/** A room as a browser measures it: a width the test sets, and an observer it fires. */
function room(clientWidth: number) {
  const element = { clientWidth } as HTMLElement;
  const observers: { fire(): void; watching: boolean }[] = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  globalThis.ResizeObserver = class {
    readonly seen: { fire(): void; watching: boolean };
    constructor(callback: () => void) {
      this.seen = { fire: callback, watching: false };
      observers.push(this.seen);
    }
    observe() {
      this.seen.watching = true;
    }
    disconnect() {
      this.seen.watching = false;
    }
  } as never;
  return {
    element,
    ref: { current: element } as RefObject<HTMLElement>,
    observers,
    restore() {
      if (before) Object.defineProperty(globalThis, "ResizeObserver", before);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}

Deno.test("the width of the room is what it measures, in steps, never below the narrowest; unmeasured it is a full page's", async () => {
  const probe = probeRoot();
  const measured = room(700);
  let width = -1;
  function Probe(props: { room: RefObject<HTMLElement> }) {
    width = useRoomWidth(props.room);
    return null;
  }
  try {
    await probe.show(Probe, { room: measured.ref });
    equal(width, 696, "measured when it is shown: 700 in steps of 24");
    equal(measured.observers.length, 1);
    equal(measured.observers[0].watching, true);
    // The room is resized, within the step and beyond it.
    const resized = async (to: number) => {
      Object.assign(measured.ref.current!, { clientWidth: to });
      await act(() => measured.observers[0].fire());
    };
    await resized(710);
    equal(width, 696);
    await resized(1000);
    equal(width, 984);
    await resized(100);
    equal(width, 320, "never narrower than the narrowest room");
    // A room that is hidden has no width: the one it had stays.
    await resized(0);
    equal(width, 320);
    await probe.show(Probe, { room: measured.ref });
    equal(width, 320);
    // Unmounted, it watches nothing.
    await probe.unmount();
    equal(measured.observers[0].watching, false);
    // A page that is not in a room yet draws as a full page does.
    const empty = { current: null } as RefObject<HTMLElement>;
    await probe.show(Probe, { room: empty });
    equal(width, 1056);
  } finally {
    measured.restore();
    await probe.restore();
  }
});
