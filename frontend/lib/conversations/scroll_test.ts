import { equal } from "node:assert/strict";
import {
  createScrollKeeper,
  FOLLOW_DISTANCE,
  isFollowingLatest,
  restingScrollTop,
} from "./scroll.ts";

const box = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 2000,
  clientHeight: 500,
});

Deno.test("a conversation opens on its latest message, just above the composer", () => {
  equal(restingScrollTop(box(0), { shown: true, following: true }), 1500);
  // A short conversation has nothing to scroll: it rests at the top.
  equal(
    restingScrollTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 }, {
      shown: true,
      following: true,
    }),
    0,
  );
});

Deno.test("new messages keep a following reader on the latest one and leave a reader of the history in place", () => {
  equal(restingScrollTop(box(1500), { shown: false, following: true }), 1500);
  equal(restingScrollTop(box(200), { shown: false, following: false }), null);
});

Deno.test("reopening a conversation restores the reader's place, or the latest message when they were following", () => {
  equal(
    restingScrollTop(box(0), {
      shown: true,
      following: true,
      memory: { top: 320, following: false },
    }),
    320,
  );
  equal(
    restingScrollTop(box(0), {
      shown: true,
      following: true,
      memory: { top: 320, following: true },
    }),
    1500,
  );
  // A remembered place beyond a shorter list falls back to its end.
  equal(
    restingScrollTop({ scrollTop: 0, scrollHeight: 600, clientHeight: 500 }, {
      shown: true,
      following: false,
      memory: { top: 900, following: false },
    }),
    100,
  );
});

Deno.test("a reader near the end follows the conversation; one further up does not", () => {
  equal(isFollowingLatest(box(1500)), true);
  equal(isFollowingLatest(box(1500 - FOLLOW_DISTANCE + 1)), true);
  equal(isFollowingLatest(box(1500 - FOLLOW_DISTANCE)), false);
  equal(isFollowingLatest(box(0)), false);
});

Deno.test("closing and reopening a conversation restores the reader's place in a new list", () => {
  const keeper = createScrollKeeper();
  const first = box(0);
  keeper.settle(first, "collector", true);
  equal(first.scrollTop, 1500);
  first.scrollTop = 240;
  keeper.record(first, "collector");
  // The panel closes: its list is hidden, then unmounted.
  keeper.settle(first, "collector", false);
  keeper.settle(null, "collector", false);
  const reopened = box(0);
  keeper.settle(reopened, "collector", true);
  equal(reopened.scrollTop, 240);
  // A new message does not pull a reader of the history down.
  reopened.scrollHeight = 2400;
  keeper.settle(reopened, "collector", true);
  equal(reopened.scrollTop, 240);
});

Deno.test("a following reader stays on the latest message as conversations grow and switch", () => {
  const keeper = createScrollKeeper();
  const list = box(0);
  keeper.settle(list, "coordinator", true);
  equal(list.scrollTop, 1500);
  list.scrollHeight = 2600;
  keeper.settle(list, "coordinator", true);
  equal(list.scrollTop, 2100);
  keeper.record(list, "coordinator");
  keeper.settle(list, "collector", true);
  equal(list.scrollTop, 2100);
});
