import { deepStrictEqual, equal } from "node:assert/strict";
import { behindHead, headReader, type HeldVersion } from "./head-reader.ts";

const HEAD = `commit:${"a".repeat(40)}`;
const NEXT = `commit:${"b".repeat(40)}`;
const OLDER = `commit:${"c".repeat(40)}`;

Deno.test("only a reader that follows the head can be behind it, and one that holds it is not", () => {
  const held = { asked: undefined, version: HEAD };
  equal(behindHead(held, NEXT), true);
  equal(behindHead(held, HEAD), false);
  // The host spells a commit with its prefix or without it.
  equal(behindHead({ ...held, version: "a".repeat(40) }, HEAD), false);
  // Nothing held yet: the head is to be read.
  equal(behindHead({ asked: undefined, version: undefined }, HEAD), true);
  // A failed read holds nothing newer, even of the head it names.
  equal(behindHead({ ...held, failed: true }, HEAD), true);
  // A version a person named never moves.
  equal(behindHead({ asked: NEXT, version: NEXT }, HEAD), false);
  equal(
    behindHead({ asked: NEXT, version: undefined, failed: true }, HEAD),
    false,
  );
});

/**
 * A reader whose reads wait until the test lets them answer. As the stores do,
 * it takes the version it asked at once and holds the commit when the answer
 * comes; the host answers the head it is at, `now`, unless a commit is named.
 */
function reader(now = HEAD) {
  const reads: Array<{ asked?: string; at?: string }> = [];
  const answers: Array<() => void> = [];
  let held: HeldVersion = { asked: undefined, version: undefined };
  let host = now;
  const follower = headReader({
    held: () => held,
    read: (asked, at) => {
      reads.push({ ...(asked ? { asked } : {}), ...(at ? { at } : {}) });
      held = { ...held, asked };
      return new Promise<void>((resolve) =>
        answers.push(() => {
          held = { asked, version: at ?? asked ?? host };
          resolve();
        })
      );
    },
  });
  return {
    ...follower,
    reads,
    /** The nth read answers. */
    answer: (index: number) => answers[index](),
    /** The host moves on, as a read still to be answered will find out. */
    hostAt: (head: string) => host = head,
    held: () => held,
  };
}

Deno.test("an announcement that outruns the first read of the head waits for it: the commit it brings is the announced one, so it is read once", async () => {
  const page = reader();
  const opening = page.open();
  const announced = page.moved(HEAD);
  deepStrictEqual(page.reads, [{}], "the read in flight is not aborted");
  page.answer(0);
  await Promise.all([opening, announced]);
  deepStrictEqual(page.reads, [{}]);
  equal(page.held().version, HEAD);
});

Deno.test("the first read of the head brought an older commit than the one announced: exactly one more read, at the announced commit", async () => {
  const page = reader(HEAD);
  const opening = page.open();
  const announced = page.moved(NEXT);
  page.answer(0);
  await opening;
  // The announcement is judged by the commit the read brought.
  deepStrictEqual(page.reads, [{}, { at: NEXT }]);
  page.hostAt(NEXT);
  page.answer(1);
  await announced;
  equal(page.held().version, NEXT);
  deepStrictEqual(page.reads, [{}, { at: NEXT }]);
});

Deno.test("a read of the announced commit already on its way is the one that answers: the head announced again, as a proposal is made, starts nothing", async () => {
  const page = reader();
  const opening = page.open();
  page.answer(0);
  await opening;
  const first = page.moved(NEXT);
  const again = page.moved(NEXT);
  // The host spells the commit as it likes.
  const spelled = page.moved(NEXT.slice("commit:".length));
  deepStrictEqual(page.reads, [{}, { at: NEXT }]);
  page.answer(1);
  await Promise.all([first, again, spelled]);
  equal(page.held().version, NEXT);
  // The head is held: there is nothing more to read.
  await page.moved(NEXT);
  equal(page.reads.length, 2);
});

Deno.test("a newer announcement replaces the read of an older one", async () => {
  const page = reader();
  const opening = page.open();
  page.answer(0);
  await opening;
  const toNext = page.moved(NEXT);
  const toOlder = page.moved(OLDER);
  deepStrictEqual(page.reads, [{}, { at: NEXT }, { at: OLDER }]);
  page.answer(2);
  page.answer(1);
  await Promise.all([toNext, toOlder]);
});

Deno.test("a version a person named never moves, even while it is being read", async () => {
  const page = reader();
  const opening = page.open(OLDER);
  await page.moved(NEXT);
  deepStrictEqual(page.reads, [{ asked: OLDER }]);
  page.answer(0);
  await opening;
  await page.moved(NEXT);
  deepStrictEqual(page.reads, [{ asked: OLDER }]);
});

Deno.test("a read of the head that failed is made again when the host speaks, even of the head it asked for", async () => {
  let failed = true;
  const reads: Array<{ at?: string }> = [];
  const page = headReader({
    held: () => ({ asked: undefined, version: HEAD, failed }),
    read: (_asked, at) => {
      reads.push(at ? { at } : {});
      failed = false;
      return Promise.resolve();
    },
  });
  await page.moved(HEAD);
  deepStrictEqual(reads, [{ at: HEAD }]);
  await page.moved(HEAD);
  equal(reads.length, 1, "it holds the head now");
});
