import {
  deepStrictEqual,
  equal,
  notDeepStrictEqual,
  ok,
} from "node:assert/strict";
import {
  BUILDER,
  crowdBoard,
  initialBoard,
  rosterEntry,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import {
  type Box,
  boxSize,
  DRAG_SLOP,
  edgesOf,
  isDrag,
  keepInside,
  type LayoutEdge,
  layoutKey,
  type LayoutNode,
  layoutTeam,
  nodesOf,
  TEAM_ROOM,
  wireBetween,
} from "./layout.ts";
import { teamOf } from "./projection.ts";

const watch = () => teamOf(watchBoard());

/** Whether two boxes share any area (touching edges is not sharing). */
const overlap = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 &&
  Math.abs(a.y - b.y) < (a.h + b.h) / 2;

const overlaps = (boxes: readonly Box[]) =>
  boxes.flatMap((a, i) =>
    boxes.slice(i + 1).filter((b) => overlap(a, b)).map((b) =>
      `${a.id}/${b.id}`
    )
  );

Deno.test("the nodes of a team start in the order: the person, the agents they talk with, the others, then what the agents use", () => {
  const nodes = nodesOf(teamOf(watchBoard()));
  deepStrictEqual(nodes.map((node) => [node.kind, node.label]), [
    ["you", "You"],
    ["agent", "Coordinateur veille"],
    ["agent", "Analyste"],
    ["agent", "Collecteur"],
    ["resource", "read_web_page"],
    ["resource", "read_web_page_outline"],
    ["resource", "Decision context policy"],
    ["resource", "Governed memory policy"],
    ["resource", "qualificationPolicy"],
    ["resource", "sourcePolicy"],
  ]);
  // A shared resource carries how many agents share it; one used alone does not.
  deepStrictEqual(
    nodes.filter((node) => node.times).map((node) => node.times),
    [
      3,
      3,
    ],
  );
  // Without anyone to talk with there is no person in the network.
  const quiet = nodesOf(teamOf(initialBoard()));
  ok(quiet.every((node) => node.kind !== "you"));
  // The agents the person talks with come before the others, whatever the model's order.
  const roster = [rosterEntry(BUILDER, { primary: true, canSend: true })];
  equal(nodesOf(teamOf(initialBoard(), roster))[0].kind, "you");
  const behind = teamOf(watchBoard());
  behind.agents = [...behind.agents].reverse();
  deepStrictEqual(
    nodesOf(behind).filter((node) => node.kind === "agent").map((node) =>
      node.label
    ),
    ["Coordinateur veille", "Collecteur", "Analyste"],
  );
});

Deno.test("the same nodes in the same width settle on the same positions, every time", () => {
  const nodes = nodesOf(watch()), edges = edgesOf(watch());
  const first = layoutTeam(nodes, edges, 1056);
  deepStrictEqual(layoutTeam(nodes, edges, 1056), first);
  // Fresh copies of the same team, rebuilt from the board, are the same layout.
  deepStrictEqual(
    layoutTeam(
      nodesOf(teamOf(watchBoard())),
      edgesOf(teamOf(watchBoard())),
      1056,
    ),
    first,
  );
  // The default width is the full page's.
  deepStrictEqual(layoutTeam(nodes, edges), first);
  equal(TEAM_ROOM, 1056);
  // Another width is another layout, and another team is another layout.
  notDeepStrictEqual(layoutTeam(nodes, edges, 600).boxes, first.boxes);
  notDeepStrictEqual(
    layoutTeam(
      nodesOf(teamOf(crowdBoard(5))),
      edgesOf(teamOf(crowdBoard(5))),
      1056,
    ).boxes
      .map((box) => box.id),
    first.boxes.map((box) => box.id),
  );
  // Positions are tenths of a pixel: the same text on the server and in the browser.
  for (const box of first.boxes) {
    for (const value of [box.x, box.y]) {
      equal(Math.round(value * 10) / 10, value);
    }
  }
});

Deno.test("every node has a box, in the order given, and no two boxes overlap or leave the frame", () => {
  for (
    const team of [
      teamOf(initialBoard(), [rosterEntry(BUILDER)]),
      watch(),
      teamOf(crowdBoard(12)),
      teamOf(crowdBoard(1)),
    ]
  ) {
    const nodes = nodesOf(team);
    const layout = layoutTeam(nodes, edgesOf(team), TEAM_ROOM);
    deepStrictEqual(
      layout.boxes.map((box) => box.id),
      nodes.map((node) => node.id),
    );
    deepStrictEqual(overlaps(layout.boxes), []);
    for (const box of layout.boxes) {
      ok(box.x - box.w / 2 >= 0 && box.x + box.w / 2 <= layout.width, box.id);
      ok(box.y - box.h / 2 >= 0 && box.y + box.h / 2 <= layout.height, box.id);
    }
    equal(layout.width, TEAM_ROOM);
    // The frame is as high as what it holds, with the same air on both sides.
    const top = Math.min(...layout.boxes.map((box) => box.y - box.h / 2));
    const bottom = Math.max(...layout.boxes.map((box) => box.y + box.h / 2));
    ok(top >= 0 && layout.height - bottom >= 0);
    ok(layout.height <= bottom + 36 + 1);
  }
});

Deno.test("in every room width a page can have, nothing overlaps and nothing leaves the frame", () => {
  const boards = {
    watch: watch(),
    crowd6: teamOf(crowdBoard(6)),
    crowd12: teamOf(crowdBoard(12)),
    initial: teamOf(initialBoard(), [rosterEntry(BUILDER)]),
  };
  // From the narrowest room to the full page, in the steps the page measures in.
  for (let width = 320; width <= TEAM_ROOM; width += 24) {
    for (const [name, team] of Object.entries(boards)) {
      const layout = layoutTeam(nodesOf(team), edgesOf(team), width);
      const where = `${name} at ${width}`;
      deepStrictEqual(overlaps(layout.boxes), [], where);
      for (const box of layout.boxes) {
        ok(
          box.x - box.w / 2 >= 0 && box.x + box.w / 2 <= width,
          `${where}: ${box.id} leaves the frame sideways`,
        );
        ok(
          box.y - box.h / 2 >= 0 && box.y + box.h / 2 <= layout.height,
          `${where}: ${box.id} leaves the frame vertically`,
        );
      }
    }
  }
});

Deno.test("the network is centred, and narrowed to fit a room narrower than it", () => {
  const team = watch();
  const nodes = nodesOf(team), edges = edgesOf(team);
  const wide = layoutTeam(nodes, edges, 1056);
  const middle = (boxes: readonly Box[]) =>
    (Math.min(...boxes.map((b) => b.x - b.w / 2)) +
      Math.max(...boxes.map((b) => b.x + b.w / 2))) / 2;
  ok(Math.abs(middle(wide.boxes) - 528) < 1);
  const narrow = layoutTeam(nodes, edges, 360);
  equal(narrow.width, 360);
  for (const box of narrow.boxes) {
    ok(box.x - box.w / 2 >= 0 && box.x + box.w / 2 <= 360, box.id);
  }
  const span = (boxes: readonly Box[]) =>
    Math.max(...boxes.map((b) => b.x)) - Math.min(...boxes.map((b) => b.x));
  ok(span(narrow.boxes) < span(wide.boxes));
  // Nothing can be narrower than its own box: it is centred rather than cut.
  const tiny = layoutTeam(nodes, edges, 100);
  for (const box of tiny.boxes) equal(Math.abs(box.x - 50) <= 50, true);
});

Deno.test("a wire to a node that is not there is ignored, and nothing is nothing", () => {
  const nodes: LayoutNode[] = [
    { id: "a", kind: "agent", label: "A" },
    { id: "r", kind: "resource", label: "r" },
  ];
  const edges: LayoutEdge[] = [
    { id: "a>r", from: "a", to: "r", kind: "uses" },
    { id: "a>ghost", from: "a", to: "ghost", kind: "uses" },
    { id: "ghost>r", from: "ghost", to: "r", kind: "talk" },
  ];
  const layout = layoutTeam(nodes, edges, 800);
  equal(layout.boxes.length, 2);
  deepStrictEqual(layout, layoutTeam(nodes, edges.slice(0, 1), 800));
  deepStrictEqual(layoutTeam([], edges, 800), {
    width: 800,
    height: 0,
    boxes: [],
  });
  // One node alone sits in the middle.
  const alone = layoutTeam(nodes.slice(0, 1), [], 800);
  equal(alone.boxes[0].x, 400);
});

Deno.test("what a layout depends on is what its key says", () => {
  const nodes = nodesOf(watch()), edges = edgesOf(watch());
  const key = layoutKey(nodes, edges, 1056);
  equal(layoutKey([...nodes], [...edges], 1056), key);
  notDeepStrictEqual(layoutKey(nodes, edges, 1032), key);
  notDeepStrictEqual(layoutKey(nodes.slice(1), edges, 1056), key);
  notDeepStrictEqual(layoutKey(nodes, edges.slice(1), 1056), key);
  notDeepStrictEqual(
    layoutKey(
      nodes.map((node) => ({ ...node, label: `${node.label}!` })),
      edges,
      1056,
    ),
    key,
  );
  notDeepStrictEqual(
    layoutKey(nodes.map((node) => ({ ...node, times: 9 })), edges, 1056),
    key,
  );
  // The agent a page shows is not part of it: choosing one changes nothing here.
  equal(layoutKey(nodesOf(watch()), edgesOf(watch()), 1056), key);
});

Deno.test("the size of a box is estimated from its label, within limits", () => {
  const agent = (label: string) => boxSize({ kind: "agent", label });
  const pill = (label: string, times?: number) =>
    boxSize({ kind: "resource", label, times });
  equal(agent("A").w, 76);
  equal(agent("A").h, 91);
  equal(agent("x".repeat(60)).w, 150);
  ok(agent("Coordinateur veille").w > agent("Analyste").w);
  // The wires meet the avatar, which is above the middle of an agent's box.
  ok(agent("A").ay < 0);
  equal(pill("tool").h, 28);
  equal(pill("tool").ay, 0);
  ok(pill("tool", 3).w > pill("tool").w);
  equal(pill("x".repeat(100)).w, 230);
  deepStrictEqual(boxSize({ kind: "you", label: "You" }), agent("You"));
});

Deno.test("a box is kept inside the frame with a little air, and centred when it cannot fit", () => {
  const size = { w: 100, h: 50 };
  const frame = { width: 400, height: 200 };
  deepStrictEqual(keepInside({ x: 200, y: 100 }, size, frame), {
    x: 200,
    y: 100,
  });
  deepStrictEqual(keepInside({ x: -50, y: -50 }, size, frame), {
    x: 56,
    y: 31,
  });
  deepStrictEqual(keepInside({ x: 999, y: 999 }, size, frame), {
    x: 344,
    y: 169,
  });
  deepStrictEqual(keepInside({ x: 0, y: 0 }, { w: 500, h: 300 }, frame), {
    x: 200,
    y: 100,
  });
});

Deno.test("a wire runs from the avatar of one node to the avatar of another, from pill to pill", () => {
  const a = { x: 100, y: 100, ay: -11.5 }, b = { x: 300, y: 50, ay: 0 };
  deepStrictEqual(wireBetween(a, b), { x1: 100, y1: 88.5, x2: 300, y2: 50 });
});

Deno.test("a press that moves a few pixels is a click; beyond that it is a drag", () => {
  equal(isDrag(0, 0), false);
  equal(isDrag(DRAG_SLOP, 0), false);
  equal(isDrag(2, 2), false);
  equal(isDrag(3, 3), true);
  equal(isDrag(DRAG_SLOP + 1, 0), true);
  equal(isDrag(-3, -4), true);
});
