import { deepStrictEqual, equal } from "node:assert/strict";
import { createModelLive, type ModelHead } from "./live.ts";
import { announcement as announce } from "../../test/support/model-feed.ts";

const HEAD = `commit:${"a".repeat(40)}`;
const NEXT = `commit:${"b".repeat(40)}`;

/** A tab's model and a follower that keeps every head it was told. */
function tab() {
  const failures: Array<{ failure: unknown; head: ModelHead }> = [];
  const live = createModelLive({
    report: (failure, head) => failures.push({ failure, head }),
  });
  const follow = () => {
    const heads: ModelHead[] = [];
    const stop = live.follow((head) => {
      heads.push(head);
    });
    return { heads, stop };
  };
  return { live, failures, follow };
}

Deno.test("a new head is told once to whoever follows, as the version the host names", () => {
  const { live, follow } = tab();
  const reader = follow();
  live.accept(announce(HEAD));
  deepStrictEqual(reader.heads, [{ version: HEAD }]);
  live.accept(announce(NEXT));
  deepStrictEqual(reader.heads.map((head) => head.version), [HEAD, NEXT]);
});

Deno.test("the same announcement again, as every connection begins with, tells nothing", () => {
  const { live, follow } = tab();
  const reader = follow();
  live.accept(announce(HEAD));
  live.accept(announce(HEAD));
  live.accept(announce(HEAD));
  equal(reader.heads.length, 1);
});

Deno.test("a proposal made or decided, with the head where it was, is something new; the same journal is not", () => {
  const { live, follow } = tab();
  const reader = follow();
  live.accept(announce(HEAD));
  live.accept(announce(HEAD, { pending: 1, digest: "journal-1" }));
  equal(reader.heads.length, 2);
  equal(reader.heads[1].version, HEAD);
  live.accept(announce(HEAD, { pending: 1, digest: "journal-1" }));
  equal(reader.heads.length, 2);
});

Deno.test("every follower is told, and one that left is not told again", () => {
  const { live, follow } = tab();
  const board = follow();
  const files = follow();
  live.accept(announce(HEAD));
  equal(board.heads.length + files.heads.length, 2);
  board.stop();
  live.accept(announce(NEXT));
  equal(board.heads.length, 1);
  equal(files.heads.length, 2);
  // The same function may follow twice, as two pages may.
  const twice: string[] = [];
  const read = (head: ModelHead) => twice.push(head.version);
  const [first, second] = [live.follow(read), live.follow(read)];
  live.accept(announce(HEAD));
  equal(twice.length, 2);
  first();
  second();
});

Deno.test("what is not an announcement is ignored, and what the host adds later does not break one", () => {
  const { live, follow } = tab();
  const reader = follow();
  for (
    const unreadable of [
      undefined,
      "",
      "not json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ head: 7 }),
      JSON.stringify({ head: "" }),
    ]
  ) {
    live.accept(unreadable);
  }
  equal(reader.heads.length, 0, "nothing was announced");
  // The head is all that is read: less than the host usually says is still a
  // head, and more than it says does not matter.
  live.accept(JSON.stringify({ head: HEAD, proposals: 3, novelty: true }));
  deepStrictEqual(reader.heads, [{ version: HEAD }]);
});

Deno.test("a follower that fails is reported with the head, and does not stop the others", async () => {
  const { live, failures, follow } = tab();
  const syncFailure = new Error("fails at once");
  const asyncFailure = new Error("fails later");
  live.follow(() => {
    throw syncFailure;
  });
  live.follow(() => Promise.reject(asyncFailure));
  const reader = follow();
  live.accept(announce(HEAD));
  await Promise.resolve();
  equal(reader.heads.length, 1);
  deepStrictEqual(failures, [
    { failure: syncFailure, head: { version: HEAD } },
    { failure: asyncFailure, head: { version: HEAD } },
  ]);
});

Deno.test("with no follower an announcement is told to nobody, and a page that opens later reads from where it stands", () => {
  const { live, follow } = tab();
  const first = follow();
  live.accept(announce(HEAD));
  first.stop();
  // Nobody follows: nothing is told, and nothing breaks.
  live.accept(announce(NEXT));
  const second = follow();
  equal(second.heads.length, 0, "a page reads when it opens");
  live.accept(announce(HEAD));
  deepStrictEqual(second.heads.map((head) => head.version), [HEAD]);
});
