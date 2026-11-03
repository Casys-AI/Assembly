import assert from "node:assert/strict";
import { versionedError, versionedJson } from "./responses.ts";

const DIGEST = "d".repeat(64);
const request = (ifNoneMatch?: string) =>
  new Request("http://atelier.test/api/model/board", {
    headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
  });

Deno.test("explicit versions are immutable and conditional; the head is not stored", () => {
  const versioned = versionedJson(request(), { digest: DIGEST }, {
    version: `commit:${"e".repeat(40)}`,
    digest: DIGEST,
  });
  assert.equal(versioned.status, 200);
  assert.equal(versioned.headers.get("etag"), `"${DIGEST}"`);
  assert.equal(
    versioned.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  const fresh = versionedJson(request(`"${DIGEST}"`), {}, {
    version: `commit:${"e".repeat(40)}`,
    digest: DIGEST,
  });
  assert.equal(fresh.status, 304);
  const head = versionedJson(request(), { digest: DIGEST }, {
    digest: DIGEST,
  });
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(head.headers.get("etag"), null);
});

Deno.test("immutable:false keeps the ETag and 304 but revalidates with no-cache", () => {
  const version = `commit:${"e".repeat(40)}`;
  const response = versionedJson(request(), { digest: DIGEST }, {
    version,
    digest: DIGEST,
    immutable: false,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), `"${DIGEST}"`);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  const fresh = versionedJson(request(`"${DIGEST}"`), {}, {
    version,
    digest: DIGEST,
    immutable: false,
  });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get("cache-control"), "no-cache");
  assert.equal(fresh.headers.get("etag"), `"${DIGEST}"`);
});

Deno.test("an unsafe digest never becomes an ETag", () => {
  const response = versionedJson(request(), {}, {
    version: `commit:${"e".repeat(40)}`,
    digest: '"; inject',
  });
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

Deno.test("shared failures use code, context and recovery without caching", async () => {
  const response = versionedError(
    "INVALID_VERSION",
    { version: "branch:main" },
    "Pass ?version=commit:<40 lowercase hex digits>.",
    400,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "INVALID_VERSION",
    context: { version: "branch:main" },
    recovery: "Pass ?version=commit:<40 lowercase hex digits>.",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

Deno.test("versioned errors preserve every HeadersInit form and enforce no-store", () => {
  for (
    const headers of [
      new Headers({ allow: "GET", "cache-control": "public" }),
      [["allow", "GET"], ["cache-control", "public"]] as [string, string][],
      { allow: "GET", "cache-control": "public" },
    ]
  ) {
    const response = versionedError(
      "INVALID_REQUEST",
      {},
      "Use GET.",
      405,
      headers,
    );
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("0"), null);
  }
});

Deno.test("non-string digests cannot be coerced into immutable ETags or 304", () => {
  for (
    const digest of [undefined, null, 123, true, [], {}, {
      toString: () => "valid-digest",
    }]
  ) {
    const response = versionedJson(request("*"), {}, {
      version: `commit:${"e".repeat(40)}`,
      digest,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
