import { deepStrictEqual, equal } from "node:assert/strict";
import { act } from "preact/test-utils";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { watchBoard } from "../../../test/support/board-fixture.ts";
import {
  edgesOf,
  layoutKey,
  layoutTeam,
  nodesOf,
  type TeamLayout,
} from "../../../lib/system/team/layout.ts";
import { teamOf } from "../../../lib/system/team/projection.ts";
import { useNodeDrag } from "./useNodeDrag.ts";

const team = teamOf(watchBoard());
const nodes = nodesOf(team), edges = edgesOf(team);

const pointer = (id: number, x: number, y: number, over = {}) => ({
  button: 0,
  pointerId: id,
  clientX: x,
  clientY: y,
  currentTarget: {
    held: [] as string[],
    setPointerCapture(this: { held: string[] }, pointer: number) {
      this.held.push(`hold ${pointer}`);
    },
    releasePointerCapture(this: { held: string[] }, pointer: number) {
      this.held.push(`release ${pointer}`);
    },
  },
  ...over,
});

Deno.test("a node that is dragged moves, inside the frame, and the layout is not asked again; its click is not a choice", async () => {
  const probe = probeRoot();
  const layout = layoutTeam(nodes, edges, 1056);
  const key = layoutKey(nodes, edges, 1056);
  let drag: ReturnType<typeof useNodeDrag> | undefined;
  function Probe(props: { layout: TeamLayout; key: string }) {
    drag = useNodeDrag(props.layout, props.key);
    return null;
  }
  const analyst = layout.boxes.find((box) => box.id === team.agents[1].id)!;
  try {
    await probe.show(Probe, { layout, key });
    const at = () => drag!.boxes.find((box) => box.id === analyst.id)!;
    deepStrictEqual(drag!.boxes, layout.boxes);
    const handlers = () => drag!.grab(analyst);

    // A press that does not move is a click: nothing moves, the link is followed.
    const press = pointer(1, 100, 100);
    await act(() => handlers().onPointerDown(press));
    deepStrictEqual(press.currentTarget.held, ["hold 1"]);
    await act(() => handlers().onPointerMove(pointer(1, 102, 101)));
    deepStrictEqual(at(), analyst);
    await act(() => handlers().onPointerUp(press));
    deepStrictEqual(press.currentTarget.held, ["hold 1", "release 1"]);
    equal(drag!.clicked(analyst.id), true);

    // A press that moves is a drag: the node follows the pointer.
    await act(() => handlers().onPointerDown(pointer(2, 100, 100)));
    await act(() => handlers().onPointerMove(pointer(2, 130, 80)));
    equal(at().x, analyst.x + 30);
    equal(at().y, analyst.y - 20);
    // The others stay where the layout put them.
    deepStrictEqual(
      drag!.boxes.filter((box) => box.id !== analyst.id),
      layout.boxes.filter((box) => box.id !== analyst.id),
    );
    // Dragged out of the frame, it stops at its edge, with a little air.
    await act(() => handlers().onPointerMove(pointer(2, 99_999, -99_999)));
    equal(at().x, layout.width - analyst.w / 2 - 6);
    equal(at().y, analyst.h / 2 + 6);
    // The click that ends the drag is not a choice, once.
    await act(() => handlers().onPointerUp(pointer(2, 99_999, -99_999)));
    equal(drag!.clicked(analyst.id), false);
    equal(drag!.clicked(analyst.id), true);

    // Another pointer, a secondary button, or a move without a press does nothing.
    const before = at();
    await act(() => handlers().onPointerMove(pointer(3, 500, 500)));
    await act(() => handlers().onPointerDown(pointer(4, 1, 1, { button: 2 })));
    await act(() => handlers().onPointerMove(pointer(4, 90, 90)));
    deepStrictEqual(at(), before);
    await act(() => handlers().onPointerDown(pointer(5, 1, 1)));
    await act(() => handlers().onPointerMove(pointer(6, 90, 90)));
    await act(() => handlers().onPointerUp(pointer(6, 90, 90)));
    deepStrictEqual(at(), before);
    equal(drag!.clicked(analyst.id), true, "a stray pointer ends nothing");
    await act(() => handlers().onPointerUp(pointer(5, 1, 1)));

    // A new press forgets a drag whose click never came.
    await act(() => handlers().onPointerDown(pointer(7, 1, 1)));
    await act(() => handlers().onPointerMove(pointer(7, 50, 50)));
    await act(() => handlers().onPointerUp(pointer(7, 50, 50)));
    await act(() => handlers().onPointerDown(pointer(8, 1, 1)));
    equal(drag!.clicked(analyst.id), true);
    await act(() => handlers().onPointerUp(pointer(8, 1, 1)));

    // A node that is no link is dragged: nothing follows its release, so the
    // next activation of a link (the keyboard's, with no press before it) is
    // a choice and is followed.
    const pill = layout.boxes.find((box) => box.kind === "resource")!;
    await act(() => drag!.grab(pill).onPointerDown(pointer(9, 1, 1)));
    await act(() => drag!.grab(pill).onPointerMove(pointer(9, 60, 60)));
    await act(() => drag!.grab(pill).onPointerUp(pointer(9, 60, 60)));
    equal(drag!.clicked(analyst.id), true);
    // The click of a link released from its own drag is still not a choice,
    // and another node's click does not take it.
    await act(() => handlers().onPointerDown(pointer(10, 1, 1)));
    await act(() => handlers().onPointerMove(pointer(10, 60, 60)));
    await act(() => handlers().onPointerUp(pointer(10, 60, 60)));
    equal(drag!.clicked(analyst.id), false);

    // The same layout drawn again keeps where the node was dragged...
    const dragged = at();
    await probe.show(Probe, { layout, key });
    deepStrictEqual(at(), dragged);
    // ...and another layout puts every node where it puts it.
    const narrow = layoutTeam(nodes, edges, 720);
    await probe.show(Probe, {
      layout: narrow,
      key: layoutKey(nodes, edges, 720),
    });
    deepStrictEqual(drag!.boxes, narrow.boxes);
  } finally {
    await probe.restore();
  }
});
