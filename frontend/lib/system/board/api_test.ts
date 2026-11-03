import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  board,
  boardHost,
  HEAD,
  initialBoard,
  item,
  OLDER,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import {
  type BoardApi,
  boardCanRetry,
  boardProblem,
  createBoardApi,
} from "./api.ts";
import { RevisionRequestError } from "../../model/revisions/api.ts";
import { UnreadableAnswer } from "../../transport/unreadable-answer.ts";
import { type BoardStore, createBoardStore } from "./store.ts";

/** The store's state as it is now: assertions do not narrow what a call returns. */
const stateOf = (store: BoardStore) => store.state.value;

const apiOf = (host: ReturnType<typeof boardHost>) =>
  createBoardApi({ fetch: host.fetch });

Deno.test("the head is read without a version, never from a cache, and says which commit it is", async () => {
  const host = boardHost();
  const read = await apiOf(host).read();
  equal(read.version, HEAD);
  deepStrictEqual(read.board, initialBoard());
  deepStrictEqual(host.requests, [{
    path: "/api/model/board",
    cache: "no-store",
  }]);
});

Deno.test("a version is read as asked: its own commit never changes, so the cache may keep it", async () => {
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
  });
  const read = await apiOf(host).read(OLDER);
  equal(read.version, OLDER);
  equal(read.board.columns[0].items.length, 3);
  deepStrictEqual(host.requests, [{
    path: `/api/model/board?version=${encodeURIComponent(OLDER)}`,
    cache: undefined,
  }]);
});

Deno.test("a head that does not say which commit it describes is not drawn", async () => {
  const fetcher = () => Promise.resolve(Response.json(initialBoard()));
  const failure = await createBoardApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  ok(failure instanceof UnreadableAnswer);
  equal(boardProblem(failure).code, "board-invalid");
});

Deno.test("a body that is not a board is told with where it went wrong", async () => {
  const wrong = initialBoard() as unknown as Record<string, unknown>;
  const fetcher = () =>
    Promise.resolve(
      Response.json({ ...wrong, schema: "ase.board/9" }, {
        headers: { "x-model-version": HEAD },
      }),
    );
  const failure = await createBoardApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  const problem = boardProblem(failure);
  equal(problem.code, "board-invalid");
  equal(problem.message, "The system was read in a form this page cannot use.");
  equal(problem.detail, "board.schema: expected one of ase.board/1");
  equal(problem.status, undefined);
  // The page has nothing to draw: reading again would read the same.
  const text = () => Promise.resolve(new Response("not json", { status: 200 }));
  const unparsed = await createBoardApi({ fetch: text as never })
    .read(OLDER).catch((reason) => reason);
  equal(boardProblem(unparsed).code, "board-invalid");
});

Deno.test("the host's refusals are turned into the page's own codes, with the host's words kept", async () => {
  const code = async (
    fail: NonNullable<Parameters<typeof boardHost>[0]>["fail"],
    version?: string,
  ) => {
    const host = boardHost({ fail });
    const failure = await apiOf(host).read(version).catch((reason) => reason);
    ok(failure instanceof RevisionRequestError, String(failure));
    return boardProblem(failure, version !== undefined);
  };
  const invalid = await code({
    status: 400,
    code: "INVALID_VERSION",
    context: { version: "main", message: "Not a commit." },
  }, "main");
  equal(invalid.code, "version-invalid");
  equal(invalid.status, 400);
  equal(invalid.hostCode, "INVALID_VERSION");
  equal(invalid.detail, "Not a commit.");
  equal(invalid.recovery, "Read the board again.");
  for (const absent of ["NOT_FOUND", "MODEL_VERSION_NOT_FOUND"]) {
    const problem = await code({ status: 404, code: absent }, OLDER);
    equal(problem.code, "version-absent", absent);
    equal(problem.status, 404);
    // Without a message of its own, the host's recovery is still its own line.
    equal(problem.detail, "The request failed.");
    equal(problem.hostCode, absent);
    equal(problem.recovery, "Read the board again.");
  }
  const timeout = await code({
    status: 502,
    code: "TOOLKIT_TIMEOUT",
    retryAfter: 3,
  });
  equal(timeout.code, "board-timeout");
  equal(timeout.retryAfter, 3);
  equal(timeout.status, 502);
  const failed = await code({ status: 500, code: "MODEL_BOARD_FAILED" });
  equal(failed.code, "board-failed");
  equal(failed.hostCode, "MODEL_BOARD_FAILED");
  equal("retryAfter" in failed, false);
});

Deno.test("a head that is not found is the host's failure, not a version the person got wrong", async () => {
  const host = boardHost({
    fail: {
      status: 404,
      code: "NOT_FOUND",
      context: {
        selection: "head",
        message: "Model repository is not initialized",
      },
    },
  });
  const failure = await apiOf(host).read().catch((reason) => reason);
  const head = boardProblem(failure, false);
  equal(head.code, "board-failed");
  equal(head.status, 404);
  equal(head.hostCode, "NOT_FOUND");
  equal(head.detail, "Model repository is not initialized");
  // The same answer to a version that was asked for is that version missing.
  equal(boardProblem(failure, true).code, "version-absent");
  // And a refusal of the version's form is only ever about a version.
  const refused = new RevisionRequestError("Not a commit.", 400, {
    code: "INVALID_VERSION",
  });
  equal(boardProblem(refused, true).code, "version-invalid");
  equal(boardProblem(refused, false).code, "board-failed");
});

Deno.test("an error body that is not the host's envelope is a failure all the same, with no code of the host's to show", async () => {
  const fetcher = () =>
    Promise.resolve(new Response("<html>gateway</html>", { status: 503 }));
  const failure = await createBoardApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  ok(failure instanceof RevisionRequestError);
  equal(failure.code, undefined);
  equal(failure.status, 503);
  const problem = boardProblem(failure);
  equal(problem.code, "board-failed");
  equal("hostCode" in problem, false);
  equal("recovery" in problem, false);
});

Deno.test("a host that cannot be reached is told as such, and nothing else is mistaken for it", async () => {
  const fetcher = () => Promise.reject(new TypeError("network down"));
  const failure = await createBoardApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  const problem = boardProblem(failure);
  equal(problem.code, "board-unavailable");
  equal(problem.detail, "network down");
  equal(problem.status, undefined);
});

/** A board that stands for a commit: one item more than the last. */
const boardAt = (n: number, digest = `digest-${n}`) =>
  board({
    team: Array.from({ length: n }, (_, k) => item(`u${k}`, "scope", `u${k}`)),
  }, { digest });

const COMMIT = (letter: string) => `commit:${letter.repeat(40)}`;

Deno.test("reading the board again helps when the host or the Toolkit did not answer, not when the version is refused or the answer is not a board", () => {
  for (const code of ["board-timeout", "board-unavailable", "board-failed"]) {
    equal(boardCanRetry({ code } as never), true, code);
  }
  for (
    const code of ["board-invalid", "version-absent", "version-invalid"]
  ) {
    equal(boardCanRetry({ code } as never), false, code);
  }
});

Deno.test("the store reads the head, and says it is reading until it has", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  deepStrictEqual(stateOf(store), { asked: undefined, loading: true });
  const reading = store.open();
  equal(stateOf(store).loading, true);
  equal(stateOf(store).board, undefined);
  await reading;
  const state = stateOf(store);
  equal(state.loading, false);
  equal(state.version, HEAD);
  deepStrictEqual(state.board, initialBoard());
  equal("problem" in state, false);
});

Deno.test("the head read again keeps what it shows until the answer, and the same board stays the same object", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const first = stateOf(store).board;
  const again = store.open();
  // While it reads, the board is still there.
  equal(stateOf(store).board, first);
  equal(stateOf(store).loading, true);
  await again;
  equal(stateOf(store).board, first, "nothing new, nothing drawn again");
  // The head moved: its board replaces the old one, and the version follows.
  const next = COMMIT("c");
  host.boards[next] = boardAt(2);
  host.state.head = next;
  await store.open();
  equal(stateOf(store).version, next);
  equal(stateOf(store).board?.columns[0].items.length, 2);
});

Deno.test("a read that fails keeps the board it had, with the reason; reading again clears the reason while it reads", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const held = stateOf(store).board;
  host.state.fail = { status: 502, code: "TOOLKIT_TIMEOUT", retryAfter: 2 };
  await store.open();
  let state = stateOf(store);
  equal(state.board, held);
  equal(state.version, HEAD);
  equal(state.loading, false);
  equal(state.problem?.code, "board-timeout");
  equal(state.problem?.retryAfter, 2);
  host.state.fail = undefined;
  const retry = store.open();
  equal(stateOf(store).problem, undefined, "the reason goes while it reads");
  equal(stateOf(store).board, held);
  await retry;
  state = stateOf(store);
  equal(state.problem, undefined);
  equal(state.board, held);
});

Deno.test("a failure before any board leaves nothing to draw but the reason", async () => {
  const host = boardHost({ fail: { status: 500, code: "MODEL_BOARD_FAILED" } });
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const state = stateOf(store);
  equal(state.board, undefined);
  equal(state.version, undefined);
  equal(state.problem?.code, "board-failed");
  equal(state.loading, false);
});

Deno.test("a board is the board of one version: another version starts over, and the head does not borrow it", async () => {
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
  });
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const pending = store.open(OLDER);
  // The head's board is not shown for the version that was asked for.
  deepStrictEqual(stateOf(store), { asked: OLDER, loading: true });
  await pending;
  equal(stateOf(store).asked, OLDER);
  equal(stateOf(store).version, OLDER);
  equal(stateOf(store).board?.columns[0].items.length, 3);
  // A version that is not there is told, and does not leave the head's board.
  const missing = COMMIT("9");
  await store.open(missing);
  const state = stateOf(store);
  equal(state.asked, missing);
  equal(state.board, undefined);
  equal(state.problem?.code, "version-absent");
  await store.open();
  equal(stateOf(store).board?.columns[0].items.length, 1);
  equal(stateOf(store).asked, undefined);
});

Deno.test("an answer that is no longer the latest asked is dropped, and a read that was overtaken is aborted", async () => {
  const release: (() => void)[] = [];
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  const signals: (AbortSignal | undefined)[] = [];
  const api: Pick<BoardApi, "read"> = {
    read: (version, signal) => {
      signals.push(signal);
      return apiOf(host).read(version, signal);
    },
  };
  const store = createBoardStore({ api });
  const first = store.open();
  const second = store.open(OLDER);
  equal(signals[0]?.aborted, true);
  equal(signals[1]?.aborted, false);
  // The second answers first, then the first, late.
  release[1]();
  await second;
  release[0]();
  await first;
  const state = stateOf(store);
  equal(state.asked, OLDER);
  equal(state.version, OLDER);
  equal(state.loading, false);
  equal(state.board?.columns[0].items.length, 3);
});

Deno.test("an answer that arrives after its read was overtaken is dropped even when the transport ignores the abort", async () => {
  const late: (() => void)[] = [];
  const api: Pick<BoardApi, "read"> = {
    // A transport that answers whatever was asked of it, when it is told to.
    read: (version) =>
      new Promise((resolve) =>
        late.push(() =>
          resolve({
            board: version ? watchBoard() : initialBoard(),
            version: version ?? HEAD,
          })
        )
      ),
  };
  const store = createBoardStore({ api });
  const first = store.open();
  const second = store.open(OLDER);
  late[1]();
  await second;
  late[0]();
  await first;
  equal(stateOf(store).asked, OLDER);
  equal(stateOf(store).version, OLDER);
  equal(stateOf(store).board?.columns[0].items.length, 3);
  equal(stateOf(store).loading, false);
});

Deno.test("a failure of a read that was overtaken says nothing", async () => {
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  host.state.fail = { status: 500, code: "MODEL_BOARD_FAILED" };
  const store = createBoardStore({ api: apiOf(host) });
  const first = store.open();
  const second = store.open();
  // The first read is released after it was overtaken: it was going to fail.
  release[0]();
  await first;
  equal(stateOf(store).problem, undefined);
  equal(stateOf(store).loading, true);
  host.state.fail = undefined;
  release[1]();
  await second;
  equal(stateOf(store).problem, undefined);
  equal(stateOf(store).version, HEAD);
});

Deno.test("a store that is disposed reads nothing more and publishes nothing", async () => {
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  const store = createBoardStore({ api: apiOf(host) });
  const reading = store.open();
  store.dispose();
  release[0]?.();
  await reading;
  equal(stateOf(store).board, undefined);
  await store.open();
  equal(host.requests.length, 1, "nothing is asked of a disposed store");
});

const asked = (version: string) =>
  `/api/model/board?version=${encodeURIComponent(version)}`;

Deno.test("the head the host announces is read once, at its own address, keeping the board on show until the answer", async () => {
  const next = COMMIT("c");
  const release: (() => void)[] = [];
  let gated = false;
  const host = boardHost({
    gate: () =>
      gated ? new Promise<void>((resolve) => release.push(resolve)) : undefined,
  });
  host.boards[next] = boardAt(2);
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const held = stateOf(store).board;
  gated = true;
  const reading = store.moved(next);
  equal(stateOf(store).board, held, "the board it has stays on show");
  equal(stateOf(store).loading, true);
  equal(stateOf(store).asked, undefined, "it still follows the head");
  release[0]();
  await reading;
  equal(stateOf(store).version, next);
  equal(stateOf(store).board?.columns[0].items.length, 2);
  equal(stateOf(store).loading, false);
  // The commit never changes: the cache may keep it.
  deepStrictEqual(host.requests.at(-1), {
    path: asked(next),
    cache: undefined,
  });
  // The same head announced again, a proposal made, reads nothing.
  await store.moved(next);
  equal(host.requests.length, 2);
});

Deno.test("a board that holds the head the host announces reads nothing", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  await store.moved(HEAD);
  // The host spells it as it likes: the commit is the same.
  await store.moved(HEAD.slice("commit:".length));
  equal(host.requests.length, 1);
});

Deno.test("a version the page names never moves with the head", async () => {
  const host = boardHost({
    boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() },
  });
  const store = createBoardStore({ api: apiOf(host) });
  await store.open(OLDER);
  await store.moved(COMMIT("c"));
  equal(host.requests.length, 1);
  equal(stateOf(store).asked, OLDER);
  equal(stateOf(store).version, OLDER);
});

Deno.test("a head announced while the last was still being read drops that read, and only the newer answer is shown", async () => {
  const [c, d] = [COMMIT("c"), COMMIT("d")];
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  host.boards[c] = boardAt(2);
  host.boards[d] = boardAt(3);
  const signals: (AbortSignal | undefined)[] = [];
  const api: Pick<BoardApi, "read"> = {
    read: (version, signal) => {
      signals.push(signal);
      return apiOf(host).read(version, signal);
    },
  };
  const store = createBoardStore({ api });
  const first = store.open();
  release[0]();
  await first;
  const toC = store.moved(c);
  const toD = store.moved(d);
  equal(signals[1]?.aborted, true, "the read for the old head is dropped");
  release[2]();
  await toD;
  release[1]();
  await toC;
  equal(stateOf(store).version, d);
  equal(stateOf(store).board?.columns[0].items.length, 3);
  deepStrictEqual(
    host.requests.map((request) => request.path),
    ["/api/model/board", asked(c), asked(d)],
  );
});

Deno.test("a read that failed is made again when the host speaks again, even of the same head", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  await store.open();
  const held = stateOf(store).board;
  host.state.fail = { status: 502, code: "TOOLKIT_TIMEOUT" };
  await store.open();
  equal(stateOf(store).problem?.code, "board-timeout");
  host.state.fail = undefined;
  await store.moved(HEAD);
  equal(stateOf(store).problem, undefined);
  equal(stateOf(store).board, held);
  equal(host.requests.length, 3);
  // A read of the announced head that fails keeps the board and says why.
  const next = COMMIT("c");
  host.state.fail = { status: 500, code: "MODEL_BOARD_FAILED" };
  await store.moved(next);
  equal(stateOf(store).board, held);
  equal(stateOf(store).version, HEAD);
  equal(stateOf(store).problem?.code, "board-failed");
  equal(stateOf(store).asked, undefined);
});

Deno.test("a disposed store reads no announced head", async () => {
  const host = boardHost();
  const store = createBoardStore({ api: apiOf(host) });
  store.dispose();
  await store.moved(COMMIT("c"));
  equal(host.requests.length, 0);
});

Deno.test("a head announced while the first read of the head is on its way waits for it: the commit it brings is the announced one, so there is one request", async () => {
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  const aborted: boolean[] = [];
  const api: Pick<BoardApi, "read"> = {
    read: (version, signal) => {
      signal?.addEventListener("abort", () => aborted.push(true));
      return apiOf(host).read(version, signal);
    },
  };
  const store = createBoardStore({ api });
  const opening = store.open();
  const announced = store.moved(HEAD);
  equal(host.requests.length, 1, "no second request while the first is out");
  release[0]();
  await Promise.all([opening, announced]);
  equal(host.requests.length, 1);
  deepStrictEqual(aborted, [], "the first read is not abandoned");
  equal(stateOf(store).version, HEAD);
  equal(stateOf(store).loading, false);
});

Deno.test("a head announced while the first read is on its way, and newer than what that read brings, is read once the first answer has come", async () => {
  const next = COMMIT("c");
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  host.boards[next] = boardAt(2);
  const store = createBoardStore({ api: apiOf(host) });
  const opening = store.open();
  const announced = store.moved(next);
  release[0]();
  await opening;
  // The host answered the head it was at; the announced commit is another.
  equal(stateOf(store).version, HEAD);
  equal(host.requests.length, 2);
  release[1]();
  await announced;
  deepStrictEqual(
    host.requests.map((request) => request.path),
    ["/api/model/board", asked(next)],
  );
  equal(stateOf(store).version, next);
  equal(stateOf(store).board?.columns[0].items.length, 2);
});

Deno.test("the head announced again while its read is on its way, as a proposal is made, starts no other read", async () => {
  const next = COMMIT("c");
  const release: (() => void)[] = [];
  const host = boardHost({
    gate: () => new Promise<void>((resolve) => release.push(resolve)),
  });
  host.boards[next] = boardAt(2);
  const store = createBoardStore({ api: apiOf(host) });
  const opening = store.open();
  release[0]();
  await opening;
  const first = store.moved(next);
  const again = store.moved(next);
  equal(host.requests.length, 2);
  release[1]();
  await Promise.all([first, again]);
  equal(host.requests.length, 2);
  equal(stateOf(store).version, next);
});
