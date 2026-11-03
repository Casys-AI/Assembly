import assert from "node:assert/strict";
import { createModelSourceTokensHandler } from "./source-tokens.ts";
import { MAX_TOKEN_SOURCE_BYTES } from "../../../../domain/model/consultation/source-tokens.ts";
const A = `commit:${"a".repeat(40)}`, B = `commit:${"b".repeat(40)}`;
function setup() {
  const calls: string[] = [];
  const handle = createModelSourceTokensHandler({
    repository: {
      header(version) {
        return Promise.resolve({
          version,
          sources: {
            "a.sysml": "package X;",
            "huge.sysml": " ".repeat(MAX_TOKEN_SOURCE_BYTES + 1),
          },
          sourceDigest: "digest",
        });
      },
    },
    tooling: {
      tokens(path, text) {
        calls.push(`${path}:${text}`);
        return Promise.resolve({
          legend: ["keyword"],
          tokens: [{ line: 0, start: 0, length: 7, type: 0 }],
        });
      },
    },
  });
  const read = (version = A, path = "a.sysml", init?: RequestInit) =>
    handle(
      new Request(
        `http://localhost/api/model/sources/tokens?${new URLSearchParams({
          version,
          path,
        })}`,
        init,
      ),
    );
  return { calls, handle, read };
}
Deno.test("tokens are pinned by exact version/path, cached, ETagged and immutable", async () => {
  const f = setup();
  const first = (await f.read())!;
  const body = await first.json();
  assert.equal(body.version, A);
  assert.equal(body.path, "a.sysml");
  assert.match(first.headers.get("cache-control")!, /immutable/);
  await f.read();
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.read(A, "a.sysml", {
      headers: { "if-none-match": first.headers.get("etag")! },
    }))!.status,
    304,
  );
  await f.read(B);
  assert.equal(f.calls.length, 2);
});
Deno.test("invalid version, missing path and oversized source fail before Toolkit", async () => {
  const f = setup();
  for (
    const [version, path, status, code] of [
      ["bad", "a.sysml", 400, "INVALID_VERSION"],
      [A, "missing.sysml", 404, "SOURCE_PATH_NOT_FOUND"],
      [A, "huge.sysml", 400, "INVALID_TOKEN_SOURCE_SIZE"],
    ] as const
  ) {
    const r = (await f.read(version, path))!;
    assert.equal(r.status, status);
    assert.equal((await r.json()).code, code);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.calls.length, 0);
});
Deno.test("the token cache is bounded", async () => {
  const f = setup();
  for (let i = 1; i <= 18; i++) {
    await f.read(`commit:${i.toString(16).padStart(40, "0")}`);
  }
  await f.read(`commit:${"1".padStart(40, "0")}`);
  assert.equal(f.calls.length, 19);
});
Deno.test("strict parameters, GET only and unrelated routes", async () => {
  const f = setup();
  assert.equal(await f.handle(new Request("http://localhost/other")), null);
  assert.equal((await f.read(A, "a.sysml", { method: "POST" }))!.status, 405);
  assert.equal(
    (await f.handle(
      new Request(
        `http://localhost/api/model/sources/tokens?version=${A}&path=a.sysml&path=b.sysml`,
      ),
    ))!.status,
    400,
  );
});

Deno.test("a failed projection never becomes a successful cached token document", async () => {
  let calls = 0;
  const handle = createModelSourceTokensHandler({
    repository: {
      header: (version) =>
        Promise.resolve({
          version,
          sources: { "a.sysml": "package X;" },
          sourceDigest: "digest",
        }),
    },
    tooling: {
      tokens() {
        calls++;
        if (calls === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ legend: ["keyword"], tokens: [] });
      },
    },
  });
  const request = () =>
    new Request(
      `http://localhost/api/model/sources/tokens?${new URLSearchParams({
        version: A,
        path: "a.sysml",
      })}`,
    );
  assert.equal((await handle(request()))!.status, 500);
  assert.equal((await handle(request()))!.status, 200);
  assert.equal(calls, 2);
});
