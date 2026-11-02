import assert from "node:assert/strict";
import { ModelAttentionService } from "../../../../application/model/projections/attention.ts";
import type { ModelAttention } from "../../../../domain/model/records/attention.ts";
import { createModelAttentionHandler } from "./attention.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const DIGEST = "d".repeat(64);

function attention(version: string): ModelAttention {
  return {
    schema: "ase.model-attention/1",
    version: version as ModelAttention["version"],
    count: 1,
    items: [{
      code: "REQUIREMENT_WITHOUT_OWNER",
      severity: "warning",
      source: "board",
      context: { elementId: "el-req", title: "Be safe", owners: 0 },
      recovery: "Declare in the model what satisfies this requirement.",
      target: { page: "requirements", elementId: "el-req" },
    }],
    digest: DIGEST,
  };
}

function handler(
  service?: { read: (version: string) => Promise<ModelAttention> },
  head?: () => Promise<string>,
) {
  const calls: string[] = [];
  const handle = createModelAttentionHandler(
    service ?? {
      read(version) {
        calls.push(version);
        return Promise.resolve(attention(version));
      },
    },
    head,
  );
  const get = (path: string, init?: RequestInit) =>
    handle(new Request(`http://atelier.test${path}`, init));
  return { calls, get };
}

function realService() {
  return new ModelAttentionService({
    matrix: {
      read: () =>
        Promise.reject(
          Object.assign(new Error("slow"), { code: "TOOLKIT_TIMEOUT" }),
        ),
    },
    board: {
      read: () =>
        Promise.resolve({
          schema: "ase.board/1",
          meta: {
            model: "test",
            mode: "ase",
            sourceDigest: "s",
            diagnostics: [],
            digest: "board",
          },
          columns: [],
          links: [],
          index: {},
        }),
    },
    diagnostics: {
      list: () =>
        Promise.resolve({
          version: VERSION,
          sourceDigest: "s",
          diagnostics: [],
        }),
    },
  });
}

Deno.test("attention route serves a versioned list with no-cache, an ETag and 304", async () => {
  const { calls, get } = handler();
  const response = await get(`/api/model/attention?version=${VERSION}`);
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("etag"), `"${DIGEST}"`);
  assert.equal(response?.headers.get("cache-control"), "no-cache");
  const body = await response?.json();
  assert.equal(body.schema, "ase.model-attention/1");
  assert.equal(body.count, 1);
  assert.equal(body.items[0].code, "REQUIREMENT_WITHOUT_OWNER");
  assert.equal(body.items[0].target.page, "requirements");
  assert.deepEqual(calls, [VERSION]);
  const cached = await get(`/api/model/attention?version=${VERSION}`, {
    headers: { "if-none-match": `"${DIGEST}"` },
  });
  assert.equal(cached?.status, 304);
  assert.equal(cached?.headers.get("cache-control"), "no-cache");
  assert.equal(cached?.headers.get("etag"), `"${DIGEST}"`);
  assert.equal(await cached?.text(), "");
});

Deno.test("attention route rejects invalid versions, unknown parameters and methods by code", async () => {
  const { calls, get } = handler();
  for (
    const query of [
      "version=branch:main",
      "version=commit:abc",
      `version=commit:${"B".repeat(40)}`,
      "version=",
      "",
      `version=${VERSION}&extra=1`,
      "modelVersion=commit%3Aabc",
    ]
  ) {
    const response = await get(`/api/model/attention?${query}`);
    // The head-less handler used here refuses a missing version like an
    // unknown parameter; an invalid version keeps its dedicated code.
    assert.equal(response?.status, 400, query);
    const body = await response?.json();
    assert.ok(typeof body.code === "string" && body.code.length > 0);
    assert.ok(body.context && typeof body.context === "object");
    assert.ok(typeof body.recovery === "string" && body.recovery.length > 0);
    assert.equal(response?.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(calls, []);
  const invalid = await get("/api/model/attention?version=branch:main");
  assert.equal((await invalid?.json()).code, "INVALID_VERSION");
  const post = await get(`/api/model/attention?version=${VERSION}`, {
    method: "POST",
  });
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.get("allow"), "GET");
  assert.equal(await get("/api/model/attention-events"), null);
});

Deno.test("attention route resolves the head with no-store and keeps coded failures", async () => {
  const { calls, get } = handler(undefined, () => Promise.resolve(VERSION));
  const headResponse = await get("/api/model/attention");
  assert.equal(headResponse?.status, 200);
  assert.equal(headResponse?.headers.get("cache-control"), "no-store");
  assert.equal(headResponse?.headers.get("x-model-version"), VERSION);
  assert.equal((await headResponse?.json()).version, VERSION);
  assert.deepEqual(calls, [VERSION]);

  const failing = handler({
    read: (version) =>
      Promise.reject({
        code: "MODEL_VERSION_NOT_FOUND",
        context: { version },
        recovery: "Read an admitted commit.",
      }),
  });
  const missing = await failing.get(`/api/model/attention?version=${VERSION}`);
  assert.equal(missing?.status, 404);
  assert.deepEqual(await missing?.json(), {
    code: "MODEL_VERSION_NOT_FOUND",
    context: { version: VERSION },
    recovery: "Read an admitted commit.",
  });
});

function maskedRealService(state: { masked: boolean }) {
  return new ModelAttentionService({
    matrix: {
      read: () =>
        Promise.resolve({
          schema: "ase.authority-matrix/1",
          version: VERSION,
          rows: [],
          columns: [],
          cells: [],
          diagnostics: [],
          digest: "m",
        } as never),
    },
    board: {
      read: () =>
        Promise.resolve({
          schema: "ase.board/1",
          meta: {
            model: "test",
            mode: "ase",
            sourceDigest: "s",
            diagnostics: [],
            digest: "board",
          },
          columns: [],
          links: [],
          index: {},
        } as never),
    },
    diagnostics: {
      list: () =>
        Promise.resolve({
          version: VERSION,
          sourceDigest: "s",
          diagnostics: [{
            code: "LOOP_WITHOUT_BUDGET",
            severity: "warning",
            finding: "absent",
            message: "No budget.",
            masked: state.masked,
            elementId: "el-1",
          }],
        } as never),
    },
  });
}

Deno.test("attention route: a mask between two GETs of one version changes the ETag and is never immutable", async () => {
  const state = { masked: false };
  const handle = createModelAttentionHandler(maskedRealService(state));
  const url = `http://atelier.test/api/model/attention?version=${VERSION}`;
  const before = await handle(new Request(url));
  assert.equal(before?.status, 200);
  assert.equal(before?.headers.get("cache-control"), "no-cache");
  const beforeBody = await before?.json();
  assert.equal(beforeBody.count, 1);
  const beforeEtag = before?.headers.get("etag");
  assert.ok(beforeEtag);
  state.masked = true;
  const after = await handle(new Request(url));
  assert.equal(after?.status, 200);
  assert.equal(after?.headers.get("cache-control"), "no-cache");
  assert.ok(!after?.headers.get("cache-control")?.includes("immutable"));
  const afterBody = await after?.json();
  assert.equal(afterBody.count, 0);
  const afterEtag = after?.headers.get("etag");
  assert.ok(afterEtag);
  assert.notEqual(afterEtag, beforeEtag, "masking changes digest and ETag");
  assert.equal(afterBody.digest, afterEtag.replaceAll('"', ""));
  const revalidated = await handle(
    new Request(url, { headers: { "if-none-match": afterEtag } }),
  );
  assert.equal(revalidated?.status, 304);
  assert.equal(revalidated?.headers.get("cache-control"), "no-cache");
  assert.equal(revalidated?.headers.get("etag"), afterEtag);
});

Deno.test("attention route with the real service: an unknown version is a strict 404, not a degraded list", async () => {
  const notFound = Object.assign(new Error("no such commit"), {
    code: "MODEL_VERSION_NOT_FOUND",
    context: { version: VERSION },
    recovery: "Choose an existing commit.",
  });
  const svc = new ModelAttentionService({
    matrix: { read: () => Promise.reject(notFound) },
    board: { read: () => Promise.reject(notFound) },
    diagnostics: { list: () => Promise.reject(notFound) },
  });
  const handle = createModelAttentionHandler(svc as never);
  const response = await handle(
    new Request(`http://atelier.test/api/model/attention?version=${VERSION}`),
  );
  assert.equal(response?.status, 404);
  const body = await response?.json();
  assert.equal(body.code, "MODEL_VERSION_NOT_FOUND");
  assert.equal(body.items, undefined, "no degraded list is served");
});

Deno.test("attention route maps an error without a code to the default failure code", async () => {
  const failing = handler({
    read: () => Promise.reject(new Error("boom")),
  });
  const response = await failing.get(
    `/api/model/attention?version=${VERSION}`,
  );
  assert.equal(response?.status, 500);
  const body = await response?.json();
  assert.equal(body.code, "MODEL_ATTENTION_FAILED");
  assert.match(body.recovery, /attention/);
});

Deno.test("attention route exposes a coded unavailable item instead of failing the list", async () => {
  const handle = createModelAttentionHandler(realService() as never);
  const response = await handle(
    new Request(`http://atelier.test/api/model/attention?version=${VERSION}`),
  );
  assert.equal(response?.status, 200);
  const body = await response?.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].code, "ATTENTION_SOURCE_UNAVAILABLE");
  assert.equal(body.items[0].source, "authority-matrix");
});
