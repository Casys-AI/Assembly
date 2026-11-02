import { settle } from "../../../test/support/settle.ts";
import { equal } from "node:assert/strict";
import { act } from "preact/test-utils";
import {
  boardHost,
  HEAD,
  initialBoard,
  OLDER,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import {
  legacyBody,
  matrixHost,
  ownerModeledBody,
} from "../../../test/support/matrix-fixture.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import { createBoardApi } from "../../../lib/system/board/api.ts";
import { SYSTEM_TABS, type SystemPage } from "../../../lib/workbench/desk.ts";
import { createMatrixApi } from "../../../lib/system/rights/api.ts";
import {
  createMatrixStore,
  type MatrixState,
  type MatrixStore,
} from "../../../lib/system/rights/store.ts";
import { useBoard } from "../board/useBoard.ts";
import { MATRIX_PAGES, type MatrixProps, useMatrix } from "./useMatrix.ts";

/** Lets the reads that a render started finish. */

/** What the probe was given back: the store, and what it holds of the board's commit. */
interface Seen {
  store?: MatrixStore;
  read?: MatrixState;
}

type Props = MatrixProps & { seen?: Seen };

function Probe(props: Props) {
  const { store, read } = useMatrix(props);
  if (props.seen) Object.assign(props.seen, { store, read });
  return null;
}

const show = (probe: ReturnType<typeof probeRoot>, props: Props) =>
  probe.show(Probe, props);

const paths = (host: ReturnType<typeof matrixHost>) =>
  host.requests.map((request) =>
    decodeURIComponent(request.path.replace("/api/model/authority-matrix", ""))
  );

Deno.test("only the pages that draw the matrix read it: Rights does, and no other page of the place", () => {
  equal(MATRIX_PAGES.join(), "rights");
  // Every page of the place is either one that reads it or one that does not wait for it.
  for (const tab of SYSTEM_TABS) {
    equal(MATRIX_PAGES.includes(tab), tab === "rights");
  }
});

Deno.test("the matrix is read only for a page that draws it, and only once the board says which commit it describes", async () => {
  const probe = probeRoot();
  const host = matrixHost();
  const api = createMatrixApi({ fetch: host.fetch });
  try {
    // Another page: the slow projection is not asked for.
    await show(probe, { api, page: "team", board: { version: HEAD } });
    await settle(1);
    await show(probe, { api, page: "explore", board: { version: HEAD } });
    await settle(1);
    equal(host.requests.length, 0);
    // The page that draws it, before the board is read: nothing to read it for.
    await show(probe, { api, page: "rights", board: undefined });
    await settle(1);
    await show(probe, { api, page: "rights", board: {} });
    await settle(1);
    equal(host.requests.length, 0);
    // The board is read: the matrix of its commit, alone.
    await show(probe, { api, page: "rights", board: { version: HEAD } });
    await settle(1);
    equal(host.requests.length, 1);
    equal(paths(host)[0], `?version=${HEAD}`);
  } finally {
    await probe.restore();
  }
});

Deno.test("coming to Rights from another page reads the matrix then, not before", async () => {
  const probe = probeRoot();
  const host = matrixHost();
  const api = createMatrixApi({ fetch: host.fetch });
  try {
    await show(probe, { api, page: "team", board: { version: HEAD } });
    await settle(1);
    equal(host.requests.length, 0);
    await show(probe, { api, page: "rights", board: { version: HEAD } });
    await settle(1);
    equal(host.requests.length, 1);
    equal(paths(host)[0], `?version=${HEAD}`);
  } finally {
    await probe.restore();
  }
});

Deno.test("drawn again for anything else the matrix is not read again; the board's commit changing reads the new one", async () => {
  const probe = probeRoot();
  const host = matrixHost({
    bodies: { [HEAD]: ownerModeledBody(HEAD), [OLDER]: legacyBody(OLDER) },
  });
  const api = createMatrixApi({ fetch: host.fetch });
  const seen: Seen = {};
  try {
    const rights = (version: string): Props => ({
      api,
      page: "rights",
      board: { version },
      seen,
    });
    await show(probe, rights(HEAD));
    await settle(1);
    await show(probe, rights(HEAD));
    await show(probe, rights(HEAD));
    await settle(1);
    equal(host.requests.length, 1);
    equal(seen.store?.state.value.version, HEAD);
    // The head moved, or the address named another version: that commit's matrix.
    await show(probe, rights(OLDER));
    await settle(1);
    equal(host.requests.length, 2);
    equal(paths(host)[1], `?version=${OLDER}`);
    equal(seen.store?.state.value.version, OLDER);
    equal(seen.store?.state.value.matrix?.model.authoritySchema, "legacy-v1");
  } finally {
    await probe.restore();
  }
});

Deno.test("what the page is given is the matrix of the board's commit, never another's", async () => {
  const probe = probeRoot();
  const host = matrixHost({
    bodies: { [HEAD]: ownerModeledBody(HEAD), [OLDER]: legacyBody(OLDER) },
  });
  const api = createMatrixApi({ fetch: host.fetch });
  const seen: Seen = {};
  // Read when asked: what the assertions about it say does not narrow what it is later.
  const given = () => seen.read;
  try {
    const board = (version?: string): Props => ({
      api,
      page: "rights",
      board: { version },
      seen,
    });
    // Before it is read, the page is told it is being read, and has no matrix.
    await show(probe, board(HEAD));
    equal(given()?.matrix, undefined);
    equal(given()?.loading, true);
    await settle(1);
    equal(given()?.matrix?.model.authoritySchema, "owner-modeled");
    equal(given()?.version, HEAD);
    // The board moved to another commit: until its matrix is read the page is given none.
    await show(probe, board(OLDER));
    equal(given()?.matrix, undefined);
    await settle(1);
    equal(given()?.matrix?.model.authoritySchema, "legacy-v1");
    // The board is not read (any more): nothing is given.
    await show(probe, board(undefined));
    equal(given(), undefined);
  } finally {
    await probe.restore();
  }
});

Deno.test("the place's own matrix is closed with it; a matrix it was given is not", async () => {
  const probe = probeRoot();
  const host = matrixHost();
  const seen: Seen = {};
  try {
    await show(probe, {
      api: createMatrixApi({ fetch: host.fetch }),
      page: "rights",
      board: { version: HEAD },
      seen,
    });
    await settle(1);
    await probe.unmount();
    // Closed: it reads nothing more.
    await seen.store?.open(HEAD);
    equal(host.requests.length, 1);

    const given = createMatrixStore({
      api: createMatrixApi({ fetch: host.fetch }),
    });
    await show(probe, {
      matrix: given,
      page: "rights",
      board: { version: HEAD },
    });
    await settle(1);
    equal(host.requests.length, 2, "the matrix it was given was read");
    await probe.unmount();
    await given.open(HEAD);
    equal(host.requests.length, 3, "and is still the caller's to read");
    given.dispose();
  } finally {
    await probe.restore();
  }
});

const NEXT = `commit:${"c".repeat(40)}`;

/**
 * The place as SystemFrame composes it: the board of the address, following
 * the host's word on the model, and the matrix of the commit that board
 * describes, for the pages that draw it.
 */
function Place(
  props: {
    boardApi: Parameters<typeof useBoard>[0]["api"];
    matrixApi: MatrixProps["api"];
    live: Parameters<typeof useBoard>[0]["live"];
    asked: string | undefined;
    page: SystemPage;
    seen: Seen;
  },
) {
  const board = useBoard({
    api: props.boardApi,
    asked: props.asked,
    moves: 0,
    live: props.live,
  });
  const held = board.state.value;
  const { store, read } = useMatrix({
    api: props.matrixApi,
    page: props.page,
    board: held.asked === props.asked ? held : undefined,
  });
  Object.assign(props.seen, { store, read });
  return null;
}

/** The model at the head, the commit after it, and an older one, as both routes of the host know them. */
function hosts() {
  return {
    board: boardHost({
      boards: {
        [HEAD]: initialBoard(),
        [NEXT]: watchBoard(),
        [OLDER]: watchBoard(),
      },
    }),
    matrix: matrixHost({
      bodies: {
        [HEAD]: ownerModeledBody(HEAD),
        [NEXT]: legacyBody(NEXT),
        [OLDER]: legacyBody(OLDER),
      },
    }),
  };
}

/** Lets what a render or the host's word started finish, including the renders that follow. */
const flush = async (work: () => void = () => {}) => {
  await act(async () => {
    work();
    await settle(1);
  });
  await act(async () => void await settle(1));
};

const inPlace = (
  host: ReturnType<typeof hosts>,
  more: Pick<Parameters<typeof Place>[0], "live" | "asked" | "page" | "seen">,
) => ({
  boardApi: createBoardApi({ fetch: host.board.fetch }),
  matrixApi: createMatrixApi({ fetch: host.matrix.fetch }),
  ...more,
});

Deno.test("the host's word that the model moved: the board reads the new head, and the matrix then reads that commit, once each", async () => {
  const probe = probeRoot();
  const host = hosts();
  const { live, tell } = modelFeed();
  const seen: Seen = {};
  const place = inPlace(host, { live, asked: undefined, page: "rights", seen });
  try {
    await probe.show(Place, place);
    await flush();
    equal(host.matrix.requests.length, 1);
    equal(paths(host.matrix)[0], `?version=${HEAD}`);
    // The host begins by saying where it stands: both hold that head.
    await flush(() => tell(HEAD));
    equal(host.board.requests.length, 1);
    equal(host.matrix.requests.length, 1);
    // An agent's proposal was accepted elsewhere: the head moved.
    await flush(() => tell(NEXT));
    equal(host.board.requests.length, 2);
    equal(host.matrix.requests.length, 2);
    equal(paths(host.matrix)[1], `?version=${NEXT}`);
    equal(seen.read?.version, NEXT);
    equal(seen.read?.matrix?.model.authoritySchema, "legacy-v1");
    // A proposal made with the head where it is: nothing is read again.
    await flush(() => tell(NEXT, { pending: 1, digest: "journal-1" }));
    equal(host.board.requests.length, 2);
    equal(host.matrix.requests.length, 2);
  } finally {
    await probe.restore();
  }
});

Deno.test("a version the address names is read for the board and its matrix, and the host's word that the head moved changes neither", async () => {
  const probe = probeRoot();
  const host = hosts();
  const { live, tell } = modelFeed();
  const seen: Seen = {};
  const place = inPlace(host, { live, asked: OLDER, page: "rights", seen });
  try {
    await probe.show(Place, place);
    await flush();
    equal(host.board.requests.length, 1);
    equal(host.matrix.requests.length, 1);
    await flush(() => tell(NEXT));
    equal(host.board.requests.length, 1, "a commit never moves");
    equal(host.matrix.requests.length, 1);
    equal(seen.read?.version, OLDER);
  } finally {
    await probe.restore();
  }
});

Deno.test("the host's word that the model moved reads no matrix for a page that does not draw it", async () => {
  const probe = probeRoot();
  const host = hosts();
  const { live, tell } = modelFeed();
  const seen: Seen = {};
  const place = inPlace(host, { live, asked: undefined, page: "team", seen });
  try {
    await probe.show(Place, place);
    await flush();
    await flush(() => tell(NEXT));
    equal(host.board.requests.length, 2, "the board follows the head");
    equal(host.matrix.requests.length, 0, "the slow projection is not asked");
  } finally {
    await probe.restore();
  }
});
