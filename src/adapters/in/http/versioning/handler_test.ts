/** HTTP contract of the versioned projection routes, run through each real
 * route factory: board, authority matrix and model views list. Route-specific
 * behavior stays beside each route (views diagrams and PlantUML, matrix
 * version checks). */
import assert from "node:assert/strict";
import { createModelBoardHandler } from "../model/board.ts";
import { createModelViewsHandler } from "../model/views.ts";
import { createAuthorityMatrixHandler } from "../governance/authority-matrix.ts";
import type { ModelBoard } from "../../../../domain/model/records/board.ts";
import type { ModelViewList } from "../../../../domain/model/records/diagram-views.ts";
import type { AuthorityMatrix } from "../../../../domain/governance/records/authority-matrix.ts";
import {
  MATRIX_DIGEST,
  matrixFixture,
} from "../../../../../test/support/authority-matrix-fixtures.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const NEXT = `commit:${"d".repeat(40)}`;

type Read = (version: string) => Promise<unknown>;
type Head = () => Promise<string>;
type Handler = (request: Request) => Promise<Response | null>;

interface Route {
  name: string;
  path: string;
  failureCode: string;
  digest: string;
  value(version: string): unknown;
  create(read: Read, head?: Head): Handler;
  /** Whether the route may be composed without a head resolver. */
  optionalHead: boolean;
}

const board = (): ModelBoard => ({
  schema: "ase.board/1",
  meta: {
    model: "test",
    mode: "ase",
    sourceDigest: "s".repeat(64),
    diagnostics: [],
    digest: "c".repeat(64),
  },
  columns: [],
  links: [],
  index: {},
});
const views = (): ModelViewList => ({
  toolkit: "0.10.10",
  views: [],
  diagnostics: [],
  digest: "a".repeat(64),
});
const unused = () => Promise.reject(new Error("unused"));

const ROUTES: Route[] = [
  {
    name: "board",
    path: "/api/model/board",
    failureCode: "MODEL_BOARD_FAILED",
    digest: "c".repeat(64),
    value: board,
    create: (read, head) =>
      createModelBoardHandler(
        { read: read as () => Promise<ModelBoard> },
        head,
      ),
    optionalHead: true,
  },
  {
    name: "authority matrix",
    path: "/api/model/authority-matrix",
    failureCode: "AUTHORITY_MATRIX_FAILED",
    digest: MATRIX_DIGEST,
    value: matrixFixture,
    create: (read, head) =>
      createAuthorityMatrixHandler(
        { read: read as () => Promise<AuthorityMatrix> },
        head ?? unused,
      ),
    optionalHead: false,
  },
  {
    name: "model views",
    path: "/api/model/views",
    failureCode: "MODEL_VIEWS_FAILED",
    digest: "a".repeat(64),
    value: views,
    create: (read, head) =>
      createModelViewsHandler({
        list: { read: read as () => Promise<ModelViewList> },
        diagram: { read: unused },
        plantuml: { read: unused },
        head,
      }),
    optionalHead: true,
  },
];

/** One route with counted reads, a moving head and an injectable failure. */
function serve(route: Route, options: { head?: Head | null } = {}) {
  const reads: string[] = [];
  let headReads = 0;
  let failure: unknown;
  const heads = [VERSION, NEXT];
  const head: Head = () => {
    headReads++;
    return Promise.resolve(heads[(headReads - 1) % heads.length]);
  };
  const handle = route.create(
    (version) => {
      reads.push(version);
      return failure === undefined
        ? Promise.resolve(route.value(version))
        : Promise.reject(failure);
    },
    options.head === null ? undefined : options.head ?? head,
  );
  return {
    reads,
    get headReads() {
      return headReads;
    },
    fail(error: unknown) {
      failure = error;
    },
    get(query = "", init?: RequestInit) {
      return handle(
        new Request(`http://atelier.test${route.path}${query}`, init),
      );
    },
    handle,
  };
}

const explicit = `?version=${VERSION}`;

Deno.test("projection routes serve an explicit version as an immutable body with an ETag", async () => {
  for (const route of ROUTES) {
    const s = serve(route);
    const response = await s.get(explicit);
    assert.equal(response?.status, 200, route.name);
    assert.equal(response?.headers.get("etag"), `"${route.digest}"`);
    assert.equal(
      response?.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.deepEqual(await response?.json(), route.value(VERSION));
    assert.deepEqual(s.reads, [VERSION]);
    assert.equal(s.headReads, 0, route.name);
  }
});

Deno.test("projection routes answer 304 to a matching If-None-Match and 200 to a stale one", async () => {
  for (const route of ROUTES) {
    const s = serve(route);
    const etag = `"${route.digest}"`;
    for (const sent of [etag, `W/${etag}`, "*", `"other", ${etag}`]) {
      const response = await s.get(explicit, {
        headers: { "if-none-match": sent },
      });
      assert.equal(response?.status, 304, `${route.name} ${sent}`);
      assert.equal(await response?.text(), "");
      assert.equal(response?.headers.get("etag"), etag);
    }
    const stale = await s.get(explicit, {
      headers: { "if-none-match": '"stale"' },
    });
    assert.equal(stale?.status, 200, route.name);
    await stale?.body?.cancel();
  }
});

Deno.test("projection routes refuse invalid queries and methods before any read", async () => {
  for (const route of ROUTES) {
    const s = serve(route);
    for (
      const query of [
        "?version=",
        "?version",
        "?version=branch:main",
        "?version=commit:abc",
        `?version=commit:${"B".repeat(40)}`,
        `?version=commit:${"g".repeat(40)}`,
        `${explicit}&version=${VERSION}`,
        `${explicit}&extra=1`,
        "?extra=1",
        "?modelVersion=commit%3Aabc",
      ]
    ) {
      const response = await s.get(query);
      assert.equal(response?.status, 400, `${route.name} ${query}`);
      assert.equal(response?.headers.get("cache-control"), "no-store");
      const body = await response?.json();
      assert.deepEqual(Object.keys(body).sort(), [
        "code",
        "context",
        "recovery",
      ]);
      assert.ok(["INVALID_VERSION", "INVALID_REQUEST"].includes(body.code));
    }
    const post = await s.get(explicit, { method: "POST" });
    assert.equal(post?.status, 405, route.name);
    assert.equal(post?.headers.get("allow"), "GET");
    assert.equal(post?.headers.get("cache-control"), "no-store");
    assert.deepEqual(await post?.json(), {
      code: "METHOD_NOT_ALLOWED",
      context: { method: "POST" },
      recovery: `Read the ${route.name} with GET.`,
    });
    assert.equal(
      await s.handle(new Request(`http://atelier.test${route.path}-events`)),
      null,
    );
    assert.equal(
      await s.handle(new Request("http://atelier.test/model")),
      null,
    );
    assert.deepEqual(s.reads, [], route.name);
    assert.equal(s.headReads, 0, route.name);
  }
});

Deno.test("projection routes without a head resolver require a version", async () => {
  for (const route of ROUTES.filter((route) => route.optionalHead)) {
    const response = await serve(route, { head: null }).get();
    assert.equal(response?.status, 400, route.name);
    assert.equal((await response?.json()).code, "INVALID_REQUEST");
  }
});

Deno.test("projection routes resolve the head on every unversioned read and never cache it", async () => {
  for (const route of ROUTES) {
    const s = serve(route);
    for (const version of [VERSION, NEXT]) {
      const response = await s.get("", { headers: { "if-none-match": "*" } });
      assert.equal(response?.status, 200, route.name);
      assert.equal(response?.headers.get("cache-control"), "no-store");
      assert.equal(response?.headers.get("etag"), null);
      assert.equal(response?.headers.get("x-model-version"), version);
      assert.deepEqual(await response?.json(), route.value(version));
    }
    assert.deepEqual(s.reads, [VERSION, NEXT], route.name);
  }
});

Deno.test("projection routes forward coded failures, mask uncoded ones and never cache them", async () => {
  for (const route of ROUTES) {
    const s = serve(route);
    for (
      const [code, status] of [
        ["MODEL_VERSION_NOT_FOUND", 404],
        ["TOOLKIT_TIMEOUT", 502],
        ["TOOLKIT_UNAVAILABLE", 502],
        ["MODEL_UPSTREAM_FAILURE", 502],
        ["INVALID_REQUEST", 400],
      ] as const
    ) {
      const failure = {
        code,
        context: { version: VERSION },
        recovery: "Retry this read.",
      };
      s.fail(failure);
      const response = await s.get(explicit);
      assert.equal(response?.status, status, `${route.name} ${code}`);
      assert.equal(response?.headers.get("cache-control"), "no-store");
      assert.equal(response?.headers.get("etag"), null);
      assert.deepEqual(await response?.json(), failure);
    }
    s.fail(new Error("boom"));
    const masked = await s.get(explicit);
    assert.equal(masked?.status, 500, route.name);
    assert.deepEqual(await masked?.json(), {
      code: route.failureCode,
      context: { version: VERSION, message: "boom" },
      recovery:
        `Inspect context.message and correct the ${route.name} read failure before requesting it again.`,
    });
    s.fail(undefined);
    const retried = await s.get(explicit);
    assert.equal(retried?.status, 200, route.name);
    await retried?.body?.cancel();
    assert.equal(s.reads.length, 7, route.name);
  }
});

Deno.test("projection failures keep their version, add code-specific recovery and expose timeout backoff", async () => {
  for (const route of ROUTES) {
    for (
      const [code, status, recovery] of [
        [
          "NOT_FOUND",
          404,
          "Choose an existing commit from /api/model-history.",
        ],
        [
          "MODEL_VERSION_NOT_FOUND",
          404,
          "Choose an existing commit from /api/model-history.",
        ],
        [
          "INVALID_REPOSITORY",
          500,
          "Inspect the model repository and restore a valid snapshot before reading this version.",
        ],
        [
          "TOOLKIT_TIMEOUT",
          502,
          `The ${route.name} exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop.`,
        ],
        [
          "MODEL_TOOLKIT_FAILED",
          500,
          "Correct the reported model or Toolkit problem; use a corrected commit if sources change.",
        ],
      ] as const
    ) {
      const s = serve(route, { head: () => Promise.resolve(VERSION) });
      s.fail({
        code,
        message: "read failure",
        context: { retryAfterMs: 29_001 },
      });
      for (const query of ["", explicit]) {
        const response = await s.get(query);
        assert.equal(response?.status, status, `${route.name} ${code}`);
        assert.equal(response?.headers.get("cache-control"), "no-store");
        assert.equal(
          response?.headers.get("retry-after"),
          code === "TOOLKIT_TIMEOUT" ? "30" : null,
        );
        assert.deepEqual(await response?.json(), {
          code,
          context: {
            version: VERSION,
            message: "read failure",
            retryAfterMs: 29_001,
          },
          recovery,
        });
      }
    }
  }
});

Deno.test("projection routes report head resolution failures without reading or caching", async () => {
  for (const route of ROUTES) {
    for (
      const [head, check] of [
        [
          () => Promise.reject(new Error("head unavailable")),
          (body: Record<string, unknown>) =>
            assert.deepEqual(body, {
              code: route.failureCode,
              context: { selection: "head", message: "head unavailable" },
              recovery:
                `Inspect context.message and correct the ${route.name} read failure before requesting it again.`,
            }),
        ],
        [
          () =>
            Promise.reject({
              code: "HEAD_UNAVAILABLE",
              recovery: "Retry later.",
            }),
          (body: Record<string, unknown>) =>
            assert.deepEqual(body, {
              code: "HEAD_UNAVAILABLE",
              context: { selection: "head" },
              recovery: "Retry later.",
            }),
        ],
        [
          () => Promise.resolve("branch:main"),
          (body: Record<string, unknown>) =>
            assert.equal(
              (body.context as { version: string }).version,
              "branch:main",
            ),
        ],
      ] as const
    ) {
      const s = serve(route, { head });
      const response = await s.get();
      assert.ok(response && response.status >= 500, route.name);
      assert.equal(response?.headers.get("cache-control"), "no-store");
      assert.equal(response?.headers.get("etag"), null);
      check(await response?.json());
      assert.deepEqual(s.reads, [], route.name);
    }
  }
});
