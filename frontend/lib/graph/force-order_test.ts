import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  forceOrder,
  type ForceOrderItem,
  forcePositions,
  seeded,
  separate,
  type SimItem,
} from "./force-order.ts";

const items: ForceOrderItem[] = [
  { id: "a", w: 120, h: 56 },
  { id: "b", w: 120, h: 56 },
  { id: "c", w: 120, h: 56 },
  { id: "d", w: 120, h: 56 },
  { id: "e", w: 120, h: 56 },
  { id: "f", w: 120, h: 56 },
];
const links = [{ source: "a", target: "f", weight: 3 }];

Deno.test("force equilibrium pulls strongly linked siblings together", () => {
  const positions = forcePositions(items, links);
  const distance = (p: string, q: string) => {
    const a = positions.get(p)!, b = positions.get(q)!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  ok(
    distance("a", "f") < distance("a", "d"),
    "linked sibling did not end nearer than an unlinked one",
  );
  const order = forceOrder(items, links);
  ok(
    Math.abs(order.indexOf("a") - order.indexOf("f")) <= 3,
    `linked siblings far apart in reading order: ${order.join(",")}`,
  );
});

Deno.test("force equilibrium leaves no overlapping rectangles", () => {
  const positions = forcePositions(items, links, { gap: 18 });
  let overlaps = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = { ...items[i], ...positions.get(items[i].id)! };
      const b = { ...items[j], ...positions.get(items[j].id)! };
      const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) -
        Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) -
        Math.max(a.y - a.h / 2, b.y - b.h / 2);
      if (ox > 0.5 && oy > 0.5) overlaps++;
    }
  }
  equal(overlaps, 0);
});

Deno.test("force ordering is deterministic and complete", () => {
  const first = forceOrder(items, links);
  deepStrictEqual(forceOrder(items, links), first);
  deepStrictEqual(
    [...first].sort(),
    items.map((item) => item.id).sort(),
  );
  deepStrictEqual(forceOrder([], []), []);
  deepStrictEqual(forceOrder([{ id: "x", w: 10, h: 10 }], []), ["x"]);
});

Deno.test("the seeded random source gives the same draws for a seed, others for another", () => {
  const draw = (seed: number) => {
    const next = seeded(seed);
    return [next(), next(), next()];
  };
  deepStrictEqual(draw(0x7ea3), draw(0x7ea3));
  ok(draw(0x7ea3).every((value) => value >= 0 && value < 1));
  ok(draw(0x7ea3).join() !== draw(0x51ab).join());
});

Deno.test("separate pushes boxes apart along the smallest penetration, or along the axis it is told", () => {
  const pair = (): SimItem[] => [
    { id: "a", x: 0, y: 0, w: 100, h: 40 },
    { id: "b", x: 30, y: 10, w: 100, h: 40 },
  ];
  // Free: the vertical penetration (40 + 6 - 10 = 36 against 106 - 30) is the smaller.
  const free = pair();
  separate(free, 6);
  equal(free[0].x, 0);
  equal(free[1].x, 30);
  ok((free[1].y ?? 0) - (free[0].y ?? 0) >= 46);
  // Along x, even though x is the larger penetration.
  const sideways = pair();
  separate(sideways, 6, "x");
  equal(sideways[0].y, 0);
  equal(sideways[1].y, 10);
  ok((sideways[1].x ?? 0) - (sideways[0].x ?? 0) >= 106);
  // Along y, even where x is the smaller one.
  const near = [
    { id: "a", x: 0, y: 0, w: 100, h: 40 },
    { id: "b", x: 90, y: 0, w: 100, h: 40 },
  ];
  separate(near, 6, "y");
  equal(near[0].x, 0);
  equal(near[1].x, 90);
  ok((near[1].y ?? 0) - (near[0].y ?? 0) >= 46);
  // Boxes that do not touch stay where they are.
  const apart = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 100, y: 100, w: 10, h: 10 },
  ];
  separate(apart, 6, "y");
  deepStrictEqual(apart.map((item) => [item.x, item.y]), [[0, 0], [
    100,
    100,
  ]]);
});
