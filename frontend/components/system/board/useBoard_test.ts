import { settle } from "../../../test/support/settle.ts";
import { equal } from "node:assert/strict";
import {
  boardHost,
  HEAD,
  initialBoard,
  OLDER,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import { createBoardApi } from "../../../lib/system/board/api.ts";
import {
  type BoardStore,
  createBoardStore,
} from "../../../lib/system/board/store.ts";
import { type BoardProps, useBoard } from "./useBoard.ts";

/** Lets the reads that a render started finish. */

function Probe(props: BoardProps & { seen?: (store: BoardStore) => void }) {
  const store = useBoard(props);
  props.seen?.(store);
  return null;
}

const paths = (host: ReturnType<typeof boardHost>) =>
  host.requests.map((request) => request.path.replace("/api/model/board", ""));

Deno.test("the place reads the head when it opens, and again only when a decision anywhere moves it", async () => {
  const probe = probeRoot();
  const host = boardHost();
  const api = createBoardApi({ fetch: host.fetch });
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0 });
    await settle(1);
    equal(host.requests.length, 1);
    // The place draws again for anything else (an agent chosen, the roster
    // moving): the board is not read again.
    await probe.show(Probe, { api, asked: undefined, moves: 0 });
    await probe.show(Probe, { api, asked: undefined, moves: 0 });
    await settle(1);
    equal(host.requests.length, 1);
    await probe.show(Probe, { api, asked: undefined, moves: 1 });
    await settle(1);
    equal(host.requests.length, 2);
  } finally {
    await probe.restore();
  }
});

Deno.test("a version the address names is read as it is, never again for the head's sake, and another is read in its turn", async () => {
  const probe = probeRoot();
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
  });
  const api = createBoardApi({ fetch: host.fetch });
  const asked = encodeURIComponent(OLDER);
  let store: BoardStore | undefined;
  const seen = (found: BoardStore) => (store = found);
  try {
    await probe.show(Probe, { api, asked: OLDER, moves: 0, seen });
    await settle(1);
    deepEqual(paths(host), [`?version=${asked}`]);
    await probe.show(Probe, { api, asked: OLDER, moves: 5, seen });
    await settle(1);
    equal(host.requests.length, 1, "a commit never moves");
    equal(store?.state.value.version, OLDER);
    // Back to the head, which is read at last.
    await probe.show(Probe, { api, asked: undefined, moves: 5, seen });
    await settle(1);
    deepEqual(paths(host), [`?version=${asked}`, ""]);
    equal(store?.state.value.version, HEAD);
    equal(store?.state.value.board?.columns[0].items.length, 1);
  } finally {
    await probe.restore();
  }
});

function deepEqual(actual: unknown, expected: unknown) {
  equal(JSON.stringify(actual), JSON.stringify(expected));
}

Deno.test("the place's own board is closed with it; a board it was given is not", async () => {
  const probe = probeRoot();
  const host = boardHost();
  let owned: BoardStore | undefined;
  try {
    await probe.show(Probe, {
      api: createBoardApi({ fetch: host.fetch }),
      asked: undefined,
      moves: 0,
      seen: (found) => (owned = found),
    });
    await settle(1);
    await probe.unmount();
    // Closed: it reads nothing more.
    await owned?.open();
    equal(host.requests.length, 1);

    const given = createBoardStore({
      api: createBoardApi({ fetch: host.fetch }),
    });
    await probe.show(Probe, { board: given, asked: undefined, moves: 0 });
    await settle(1);
    equal(host.requests.length, 2, "the board it was given was read");
    await probe.unmount();
    await given.open();
    equal(host.requests.length, 3, "and is still the caller's to read");
    given.dispose();
  } finally {
    await probe.restore();
  }
});

const NEXT = `commit:${"c".repeat(40)}`;
const next = encodeURIComponent(NEXT);

Deno.test("the host's word that the model moved reads the new head once, at its own address; the same head announced again reads nothing", async () => {
  const probe = probeRoot();
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [NEXT]: watchBoard() },
  });
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  let store: BoardStore | undefined;
  const seen = (found: BoardStore) => (store = found);
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0, live, seen });
    await settle(1);
    // The host begins by saying where it stands: the board has that head.
    tell(HEAD);
    await settle(1);
    equal(host.requests.length, 1);
    // An agent's proposal was accepted elsewhere: the head moved.
    tell(NEXT);
    await settle(1);
    deepEqual(paths(host), ["", `?version=${next}`]);
    equal(store?.state.value.version, NEXT);
    equal(store?.state.value.board?.columns[0].items.length, 3);
    // A proposal made with the head where it is: the board has nothing to read.
    tell(NEXT, { pending: 1, digest: "journal-1" });
    await settle(1);
    equal(host.requests.length, 2);
    // The place drawn again follows no second time.
    await probe.show(Probe, { api, asked: undefined, moves: 0, live, seen });
    tell(NEXT, { pending: 0, digest: "journal-2" });
    await settle(1);
    equal(host.requests.length, 2);
  } finally {
    await probe.restore();
  }
});

Deno.test("a decision made here and the host's word about it read the head once between them", async () => {
  const probe = probeRoot();
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [NEXT]: watchBoard() },
  });
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0, live });
    await settle(1);
    // The decision is confirmed: the head moved, and the place knows at once.
    host.state.head = NEXT;
    await probe.show(Probe, { api, asked: undefined, moves: 1, live });
    await settle(1);
    equal(host.requests.length, 2);
    // Then the host says so.
    tell(NEXT);
    await settle(1);
    equal(host.requests.length, 2, "the board already holds that head");
  } finally {
    await probe.restore();
  }
});

Deno.test("a version the address names stays as it is when the head moves", async () => {
  const probe = probeRoot();
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
  });
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  try {
    await probe.show(Probe, { api, asked: OLDER, moves: 0, live });
    await settle(1);
    tell(NEXT);
    await settle(1);
    equal(host.requests.length, 1, "a commit never moves");
  } finally {
    await probe.restore();
  }
});

/** A host whose request number `held` waits until the test lets it answer. */
function slowHost(held: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [NEXT]: watchBoard() },
    gate: (request) => request === held ? gate : undefined,
  });
  return { host, release };
}

Deno.test("the host's word that outruns the first read of the head waits for it: one request, not an aborted one and a second", async () => {
  const probe = probeRoot();
  const { host, release } = slowHost(1);
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  let store: BoardStore | undefined;
  const seen = (found: BoardStore) => (store = found);
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0, live, seen });
    // The host's first word comes before the first answer does.
    tell(HEAD);
    await settle(1);
    deepEqual(paths(host), [""]);
    release();
    await settle(1);
    deepEqual(paths(host), [""]);
    equal(store?.state.value.version, HEAD);
    equal(store?.state.value.loading, false);
  } finally {
    await probe.restore();
  }
});

Deno.test("the host's word of a newer head, while the first read is on its way, reads that head once the first answer has come", async () => {
  const probe = probeRoot();
  const { host, release } = slowHost(1);
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  let store: BoardStore | undefined;
  const seen = (found: BoardStore) => (store = found);
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0, live, seen });
    tell(NEXT);
    await settle(1);
    // The read in flight is not aborted for a second.
    deepEqual(paths(host), [""]);
    release();
    await settle(1);
    deepEqual(paths(host), ["", `?version=${next}`]);
    equal(store?.state.value.version, NEXT);
  } finally {
    await probe.restore();
  }
});

Deno.test("the host's word about a decision made here, while the place reads it, adds no read", async () => {
  const probe = probeRoot();
  const { host, release } = slowHost(2);
  const api = createBoardApi({ fetch: host.fetch });
  const { live, tell } = modelFeed();
  try {
    await probe.show(Probe, { api, asked: undefined, moves: 0, live });
    await settle(1);
    host.state.head = NEXT;
    await probe.show(Probe, { api, asked: undefined, moves: 1, live });
    tell(NEXT);
    await settle(1);
    equal(host.requests.length, 2, "the head is being read, and is the one");
    release();
    await settle(1);
    deepEqual(paths(host), ["", ""]);
  } finally {
    await probe.restore();
  }
});
