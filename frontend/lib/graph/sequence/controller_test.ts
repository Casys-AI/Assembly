import { equal } from "node:assert/strict";
import { sequenceRetainedScrollTop } from "./controller.ts";

Deno.test("controller scroll anchoring retains the visible record and offset at non-unit zoom", () => {
  const rowHeight = 46 * 1.25;
  const previous = ["a", "b", "c", "d"];
  const next = ["b", "c", "d", "e"];
  const previousTop = rowHeight * 2 + 13;
  const nextTop = sequenceRetainedScrollTop(
    true,
    previousTop,
    rowHeight,
    previous,
    next,
  );
  equal(nextTop, rowHeight + 13);
  equal(
    previousTop - rowHeight * previous.indexOf("c"),
    nextTop - rowHeight * next.indexOf("c"),
  );
});

Deno.test("controller scroll anchoring resets on sequence switch and keeps position if its anchor expired", () => {
  equal(sequenceRetainedScrollTop(false, 59, 46, ["a", "b"], ["a", "b"]), 0);
  equal(sequenceRetainedScrollTop(true, 13, 46, ["a", "b"], ["b", "c"]), 13);
  equal(sequenceRetainedScrollTop(true, 59, 46, ["a", "b"], ["a", "b"]), 59);
});
