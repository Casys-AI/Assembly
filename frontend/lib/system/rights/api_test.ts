import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { HEAD, OLDER } from "../../../test/support/board-fixture.ts";
import {
  BUILDER,
  legacyBody,
  matrixHost,
  OWNER,
  ownerModeledBody,
  withCell,
} from "../../../test/support/matrix-fixture.ts";
import {
  createMatrixApi,
  matrixCanRetry,
  MatrixParseError,
  matrixProblem,
  parseMatrix,
} from "./api.ts";
import { createMatrixStore, type MatrixStore } from "./store.ts";
import { RevisionRequestError } from "../../model/revisions/api.ts";
import { UnreadableAnswer } from "../../transport/unreadable-answer.ts";

/** The store's state as it is now: assertions do not narrow what a call returns. */
const stateOf = (store: MatrixStore) => store.state.value;

const apiOf = (host: ReturnType<typeof matrixHost>) =>
  createMatrixApi({ fetch: host.fetch });

/** What the page is told of a body that is not a matrix: where, and what it should have been. */
function refusal(body: unknown): MatrixParseError {
  try {
    parseMatrix(body);
  } catch (failure) {
    ok(failure instanceof MatrixParseError, String(failure));
    return failure;
  }
  throw new Error("the body was read");
}

Deno.test("the head is read without a version, never from a cache, and says which commit it is", async () => {
  const host = matrixHost();
  const read = await apiOf(host).read();
  equal(read.version, HEAD);
  equal(read.matrix.rows.length, 2);
  equal(read.matrix.model.authoritySchema, "owner-modeled");
  deepStrictEqual(host.requests, [{
    path: "/api/model/authority-matrix",
    cache: "no-store",
  }]);
});

Deno.test("a version is read as asked: its own commit never changes, so the cache may keep it", async () => {
  const host = matrixHost({
    bodies: { [HEAD]: ownerModeledBody(HEAD), [OLDER]: legacyBody(OLDER) },
  });
  const read = await apiOf(host).read(OLDER);
  equal(read.version, OLDER);
  equal(read.matrix.model.authoritySchema, "legacy-v1");
  deepStrictEqual(host.requests, [{
    path: `/api/model/authority-matrix?version=${encodeURIComponent(OLDER)}`,
    cache: undefined,
  }]);
});

Deno.test("a head that does not say which commit it describes is not drawn", async () => {
  const fetcher = () => Promise.resolve(Response.json(ownerModeledBody()));
  const failure = await createMatrixApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  ok(failure instanceof UnreadableAnswer);
  equal(matrixProblem(failure).code, "matrix-invalid");
});

Deno.test("a body that is not a matrix of this schema is refused, with where it went wrong", async () => {
  const fetcher = () =>
    Promise.resolve(
      Response.json(
        { ...ownerModeledBody(), schema: "ase.authority-matrix/9" },
        {
          headers: { "x-model-version": HEAD },
        },
      ),
    );
  const failure = await createMatrixApi({ fetch: fetcher as never }).read()
    .catch((reason) => reason);
  const problem = matrixProblem(failure);
  equal(problem.code, "matrix-invalid");
  equal(
    problem.message,
    "The rights were read in a form this page cannot use.",
  );
  equal(problem.detail, "matrix.schema: expected ase.authority-matrix/1");
  // Nothing to draw, and reading again would read the same.
  equal(matrixCanRetry(problem), false);
  const text = () => Promise.resolve(new Response("not json", { status: 200 }));
  const unparsed = await createMatrixApi({ fetch: text as never })
    .read(OLDER).catch((reason) => reason);
  equal(matrixProblem(unparsed).code, "matrix-invalid");
});

Deno.test("what identifies a row, a column or a cell must be there; the path of the first that is not is told", () => {
  const body = ownerModeledBody();
  equal(refusal(null).path, "matrix");
  equal(refusal({ ...body, rows: undefined }).path, "matrix.rows");
  equal(refusal({ ...body, columns: {} }).path, "matrix.columns");
  equal(refusal({ ...body, cells: "none" }).path, "matrix.cells");
  equal(
    refusal({ ...body, rows: [{ kind: "human" }] }).path,
    "matrix.rows[0].id",
  );
  equal(
    refusal({
      ...body,
      columns: [{ id: "tool.invoke", label: "Use active tools" }],
    }).path,
    "matrix.columns[0].group",
  );
  equal(
    refusal({ ...body, cells: [{ row: OWNER, column: "model.decide" }] }).path,
    "matrix.cells[0].state",
  );
  equal(
    refusal({ ...body, cells: [...body.cells, { column: "tool.invoke" }] })
      .path,
    `matrix.cells[${body.cells.length}].row`,
  );
});

Deno.test("a name the host adds is kept as it is, never an error: a state, a code, a basis, a kind of rule, a family", () => {
  const body = withCell(
    ownerModeledBody(),
    BUILDER,
    "tool.invoke",
    {
      state: "frozen",
      display: "denied",
      basis: "negotiated",
      codes: ["BRAND_NEW_CODE", "RIGHT_WITHOUT_OBJECT"],
      via: { kind: "telepathy", note: "sent", weight: 3, deep: { a: 1 } },
    },
  );
  const matrix = parseMatrix({
    ...body,
    caveats: [...body.caveats, "A_NEW_CAVEAT"],
    columns: [
      ...body.columns,
      { id: "ledger.read", group: "ledger", label: "Read the ledger" },
    ],
  });
  const cell = matrix.cells.find((one) =>
    one.row === BUILDER && one.column === "tool.invoke"
  )!;
  equal(cell.state, "frozen");
  equal(cell.basis, "negotiated");
  deepStrictEqual(cell.codes, ["BRAND_NEW_CODE", "RIGHT_WITHOUT_OBJECT"]);
  // The facts of a rule that are plain are kept; a nested object is not a fact.
  deepStrictEqual(cell.via, {
    kind: "telepathy",
    note: "sent",
    weight: 3,
  });
  equal(matrix.caveats.at(-1), "A_NEW_CAVEAT");
  equal(matrix.columns.at(-1)?.group, "ledger");
});

Deno.test("what the matrix does not say is absent, never made up, and what the page does not read is dropped", () => {
  const body = legacyBody();
  const matrix = parseMatrix({
    ...body,
    // An older projector sends `null` where the contract says "absent".
    rows: body.rows.map((row) => ({ ...row, element: null, extra: 1 })),
    version: undefined,
    groups: undefined,
    summary: { byState: {} },
    cells: body.cells.map((cell) => ({ ...cell, origin: "compiler" })),
  });
  const owner = matrix.rows.find((row) => row.id === OWNER)!;
  equal(owner.declared, false);
  equal("element" in owner, false);
  equal("extra" in owner, false);
  equal("version" in matrix, false);
  deepStrictEqual(matrix.groups, []);
  const cell = matrix.cells[0];
  equal("scope" in cell, false);
  equal("uncertain" in cell, false);
  equal("origin" in cell, false);
  // A label the host leaves out is the identifier the thing goes by.
  const bare = parseMatrix({
    ...body,
    rows: [{ id: "x", kind: "software" }],
    columns: [{ id: "c", group: "g" }],
    groups: [{ id: "g" }],
  });
  equal(bare.rows[0].label, "x");
  equal(bare.columns[0].label, "c");
  equal(bare.groups[0].label, "g");
});

Deno.test("what the host leaves out stays out, and what it says is kept as far as it goes: a row without a kind, a place without a role, a rule without a kind, an uncertainty without a code, a diagnostic without one", () => {
  const body = ownerModeledBody();
  const matrix = parseMatrix({
    ...body,
    rows: [{ id: "x", label: "Someone" }],
    cells: [{
      row: "x",
      column: "tool.invoke",
      state: "allowed",
      // The place has a file and a line, and no role: that is the link to the file.
      sources: [
        { file: "configuration.sysml", line: 12 },
        { role: "grant" },
        {},
        "nonsense",
      ],
      via: { rule: "only-the-owner", enforcedAt: "humanAdmission" },
      uncertain: { reason: "read from a fallback" },
    }, {
      row: "x",
      column: "tool.build:read_web_page",
      state: "denied",
      via: {},
      uncertain: {},
    }],
    diagnostics: [
      { recovery: "expose memory-review to a second operator" },
      { severity: "warning" },
      { code: "OWNER_IMPLICIT", severity: "info", extra: 1 },
      {},
      null,
    ],
  });
  // Nothing is made up: no kind, no severity.
  equal("kind" in matrix.rows[0], false);
  const [kept, bare] = matrix.cells;
  deepStrictEqual(kept.sources, [
    { file: "configuration.sysml", line: 12 },
    { role: "grant" },
  ]);
  deepStrictEqual(kept.via, {
    rule: "only-the-owner",
    enforcedAt: "humanAdmission",
  });
  deepStrictEqual(kept.uncertain, { reason: "read from a fallback" });
  // A rule or an uncertainty with nothing in it says nothing.
  equal("via" in bare, false);
  equal("uncertain" in bare, false);
  deepStrictEqual(matrix.diagnostics, [
    { recovery: "expose memory-review to a second operator" },
    { severity: "warning" },
    { code: "OWNER_IMPLICIT", severity: "info" },
  ]);
  equal("severity" in matrix.diagnostics[0], false);
  equal("code" in matrix.diagnostics[1], false);
});

Deno.test("the host's refusals are turned into the page's own codes, with the host's words kept", async () => {
  const code = async (
    fail: NonNullable<Parameters<typeof matrixHost>[0]>["fail"],
    version?: string,
  ) => {
    const host = matrixHost({ fail });
    const failure = await apiOf(host).read(version).catch((reason) => reason);
    ok(failure instanceof RevisionRequestError, String(failure));
    return matrixProblem(failure, version !== undefined);
  };
  const absent = await code(
    { status: 404, code: "MODEL_VERSION_NOT_FOUND" },
    OLDER,
  );
  equal(absent.code, "version-absent");
  equal(absent.recovery, "Read the authority matrix again.");
  equal(absent.hostCode, "MODEL_VERSION_NOT_FOUND");
  const timeout = await code({
    status: 502,
    code: "TOOLKIT_TIMEOUT",
    retryAfter: 4,
  });
  equal(timeout.code, "matrix-timeout");
  equal(timeout.retryAfter, 4);
  equal(matrixCanRetry(timeout), true);
  const failed = await code({ status: 500, code: "AUTHORITY_MATRIX_FAILED" });
  equal(failed.code, "matrix-failed");
  equal(matrixCanRetry(failed), true);
  const fetcher = () => Promise.reject(new TypeError("network down"));
  const down = matrixProblem(
    await createMatrixApi({ fetch: fetcher as never }).read()
      .catch((reason) => reason),
  );
  equal(down.code, "matrix-unavailable");
  equal(down.detail, "network down");
  equal(matrixCanRetry(down), true);
  equal(matrixCanRetry({ code: "version-invalid" }), false);
});

Deno.test("the store reads the matrix of the version it is asked, and the same matrix read again stays the same object", async () => {
  const host = matrixHost();
  const store = createMatrixStore({ api: apiOf(host) });
  deepStrictEqual(stateOf(store), { asked: undefined, loading: true });
  await store.open(HEAD);
  const first = stateOf(store);
  equal(first.version, HEAD);
  equal(first.asked, HEAD);
  equal(first.loading, false);
  ok(first.matrix);
  await store.open(HEAD);
  equal(
    stateOf(store).matrix,
    first.matrix,
    "nothing new, nothing drawn again",
  );
  // A version it does not have is told, and does not leave another's matrix.
  await store.open(OLDER);
  const missing = stateOf(store);
  equal(missing.matrix, undefined);
  equal(missing.problem?.code, "version-absent");
  equal(host.requests.length, 3);
  store.dispose();
  await store.open(HEAD);
  equal(host.requests.length, 3, "nothing is asked of a disposed store");
});

const NEXT = `commit:${"c".repeat(40)}`;

Deno.test("a matrix that follows the head reads the commit the host announces, once, at its own address; one asked for a commit stays where it is", async () => {
  const host = matrixHost({
    bodies: {
      [HEAD]: ownerModeledBody(HEAD),
      [OLDER]: legacyBody(OLDER),
      [NEXT]: ownerModeledBody(NEXT),
    },
  });
  const following = createMatrixStore({ api: apiOf(host) });
  await following.open();
  await following.moved(HEAD);
  equal(host.requests.length, 1, "it holds the head the host announces");
  await following.moved(NEXT);
  await following.moved(NEXT);
  deepStrictEqual(host.requests.map((request) => request.path), [
    "/api/model/authority-matrix",
    `/api/model/authority-matrix?version=${encodeURIComponent(NEXT)}`,
  ]);
  equal(stateOf(following).version, NEXT);
  ok(stateOf(following).matrix);

  // The Rights page asks for the commit its board describes: that is a version, and a version never moves.
  const asked = createMatrixStore({ api: apiOf(host) });
  await asked.open(OLDER);
  await asked.moved(NEXT);
  equal(host.requests.length, 3);
  equal(stateOf(asked).asked, OLDER);
  equal(stateOf(asked).version, OLDER);
});
