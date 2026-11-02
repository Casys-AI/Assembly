import { deepStrictEqual, equal } from "node:assert/strict";
import {
  createVersionedStore,
  type VersionedStore,
} from "./versioned-store.ts";

/** What a reader of the model holds at one commit, here a name and the digest of what it read. */
interface Thing {
  digest: string;
}

const COMMIT = (letter: string) => `commit:${letter.repeat(40)}`;
const HEAD = COMMIT("a");
const NEXT = COMMIT("c");
const LATER = COMMIT("d");
const NAMED = COMMIT("b");

type Held = VersionedStore<"thing", Thing, string>;

/**
 * A store of "things" over a host that answers each read with the digest of
 * the commit it was asked for, and says the head is `head`. `gate` holds
 * request `n` (from 1) until it returns; `fail` answers the next reads with a
 * failure.
 */
function reader(
  options: {
    head?: string;
    gate?: (n: number) => Promise<void> | undefined;
  } = {},
) {
  const asked: (string | undefined)[] = [];
  const signals: AbortSignal[] = [];
  const host = { head: options.head ?? HEAD, fail: false };
  const store: Held = createVersionedStore({
    key: "thing",
    read: async (version, signal) => {
      asked.push(version);
      signals.push(signal);
      await options.gate?.(asked.length);
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (host.fail) throw new Error("down");
      const read = version ?? host.head;
      return { value: { digest: `of-${read}` }, version: read };
    },
    same: (kept, answer) => kept.digest === answer.digest,
    problem: (failure, named) =>
      `${named ? "named" : "head"}: ${(failure as Error).message}`,
  });
  return { store, asked, signals, host };
}

/** The reads a test lets go one by one. */
function gates() {
  const release: (() => void)[] = [];
  return {
    release,
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  };
}

Deno.test("the head the host announces is read once, at its own address, keeping what is shown until the answer", async () => {
  const { release, gate } = gates();
  const { store, asked } = reader({ gate });
  const opening = store.open();
  release[0]();
  await opening;
  const held = store.state.value.thing;
  equal(store.state.value.version, HEAD);
  const moving = store.moved(NEXT);
  equal(store.state.value.thing, held, "what it shows stays on show");
  equal(store.state.value.loading, true);
  equal(store.state.value.asked, undefined, "it still follows the head");
  release[1]();
  await moving;
  equal(store.state.value.version, NEXT);
  equal(store.state.value.thing?.digest, `of-${NEXT}`);
  equal(store.state.value.loading, false);
  deepStrictEqual(asked, [undefined, NEXT]);
  // The same head announced again, as a proposal is made, reads nothing.
  await store.moved(NEXT);
  equal(asked.length, 2);
});

Deno.test("a store that holds the head the host announces reads nothing, however the host spells it", async () => {
  const { store, asked } = reader();
  await store.open();
  await store.moved(HEAD);
  await store.moved(HEAD.slice("commit:".length));
  equal(asked.length, 1);
});

Deno.test("a version a person named never moves with the head, even while it is being read", async () => {
  const { release, gate } = gates();
  const { store, asked } = reader({ gate });
  const opening = store.open(NAMED);
  await store.moved(NEXT);
  equal(asked.length, 1, "nothing else is asked while the version is read");
  release[0]();
  await opening;
  await store.moved(LATER);
  deepStrictEqual(asked, [NAMED]);
  equal(store.state.value.asked, NAMED);
  equal(store.state.value.version, NAMED);
});

Deno.test("a head announced while the last was still being read drops that read, and only the newer answer is shown", async () => {
  const { release, gate } = gates();
  const { store, asked, signals } = reader({ gate });
  const first = store.open();
  release[0]();
  await first;
  const toNext = store.moved(NEXT);
  const toLater = store.moved(LATER);
  equal(signals[1].aborted, true, "the read for the old head is dropped");
  equal(signals[2].aborted, false);
  release[2]();
  await toLater;
  release[1]();
  await toNext;
  deepStrictEqual(asked, [undefined, NEXT, LATER]);
  equal(store.state.value.version, LATER);
  equal(store.state.value.thing?.digest, `of-${LATER}`);
});

Deno.test("a head announced while the first read of the head is on its way waits for it, and reads again only if the announced commit is newer", async () => {
  const same = gates();
  const reading = reader({ gate: same.gate });
  const opening = reading.store.open();
  const announced = reading.store.moved(HEAD);
  equal(reading.asked.length, 1, "no second request while the first is out");
  same.release[0]();
  await Promise.all([opening, announced]);
  equal(reading.asked.length, 1);
  equal(reading.signals[0].aborted, false, "the first read is not abandoned");
  equal(reading.store.state.value.version, HEAD);

  const newer = gates();
  const behind = reader({ gate: newer.gate });
  const first = behind.store.open();
  const toNext = behind.store.moved(NEXT);
  newer.release[0]();
  await first;
  // The host answered the head it was at; the announced commit is another.
  equal(behind.store.state.value.version, HEAD);
  equal(behind.asked.length, 2);
  newer.release[1]();
  await toNext;
  deepStrictEqual(behind.asked, [undefined, NEXT]);
  equal(behind.store.state.value.version, NEXT);
});

Deno.test("the head announced again while its read is on its way starts no other read", async () => {
  const { release, gate } = gates();
  const { store, asked } = reader({ gate });
  const opening = store.open();
  release[0]();
  await opening;
  const first = store.moved(NEXT);
  const again = store.moved(NEXT);
  equal(asked.length, 2);
  release[1]();
  await Promise.all([first, again]);
  equal(asked.length, 2);
  equal(store.state.value.version, NEXT);
});

Deno.test("a read that failed is made again when the host speaks again, even of the same head, and the value it had stays on show", async () => {
  const { store, asked, host } = reader();
  await store.open();
  const held = store.state.value.thing;
  host.fail = true;
  await store.moved(NEXT);
  equal(store.state.value.problem, "head: down", "it follows the head");
  equal(store.state.value.thing, held, "and keeps what it had");
  host.fail = false;
  await store.moved(NEXT);
  equal(asked.length, 3, "the commit was not held: it is read again");
  equal(store.state.value.problem, undefined);
  equal(store.state.value.version, NEXT);
});

Deno.test("a disposed store reads no announced head", async () => {
  const { store, asked } = reader();
  store.dispose();
  await store.moved(NEXT);
  equal(asked.length, 0);
});
