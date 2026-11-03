import assert from "node:assert/strict";
import { createModelDiagnosticsHandler } from "./diagnostics.ts";
import { ModelDiagnosticsError } from "../../../../application/model/diagnostics/service.ts";

function fixture() {
  const reads: Array<string | undefined> = [];
  const writes: unknown[] = [];
  const handler = createModelDiagnosticsHandler({
    list(version) {
      reads.push(version);
      return Promise.resolve({
        version: version ?? "commit:a",
        sourceDigest: "a",
        diagnostics: [],
      });
    },
    setMask(change) {
      writes.push(change);
      if (change.code === "UNKNOWN") {
        return Promise.reject(
          new ModelDiagnosticsError(
            "DIAGNOSTIC_NOT_FOUND",
            "No current diagnostic matches this mask.",
          ),
        );
      }
      return Promise.resolve(change);
    },
  });
  const get = (query = "") =>
    handler(new Request(`http://atelier.test/api/model/diagnostics${query}`));
  const post = (
    body: string,
    headers: HeadersInit = { "content-type": "application/json" },
  ) =>
    handler(
      new Request("http://atelier.test/api/model/diagnostics/masks", {
        method: "POST",
        headers,
        body,
      }),
    );
  return { handler, reads, writes, get, post };
}

Deno.test("diagnostics HTTP reads current or selected version and returns structured preferences", async () => {
  const { get, post, reads, writes } = fixture();
  const current = await get();
  assert.equal(current?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await current?.json(), {
    version: "commit:a",
    sourceDigest: "a",
    diagnostics: [],
  });
  assert.equal(
    (await (await get("?version=commit%3Ab"))?.json()).version,
    "commit:b",
  );
  assert.deepEqual(await (await get("?version=branch%3Aproposal"))?.json(), {
    version: "branch:proposal",
    sourceDigest: "a",
    diagnostics: [],
  });
  assert.deepEqual(reads, [undefined, "commit:b", "branch:proposal"]);
  const change = {
    code: "LOOP_WITHOUT_BUDGET",
    elementId: "operator-a",
    masked: true,
  };
  assert.deepEqual(await (await post(JSON.stringify(change)))?.json(), {
    mask: change,
  });
  assert.deepEqual(writes, [change]);
});

Deno.test("diagnostics HTTP rejects malformed selection and preference before invoking application", async () => {
  const { get, post, reads, writes } = fixture();
  for (
    const query of [
      "?version=",
      "?version=abc",
      "?version=commit:a&version=commit:b",
      "?unknown=a",
    ]
  ) {
    const response = await get(query);
    assert.equal(response?.status, 400);
    assert.equal((await response?.json()).code, "INVALID_VERSION");
  }
  for (
    const body of [
      "{",
      "null",
      "[]",
      '"text"',
      '{"code":"W","masked":1}',
      '{"code":"W","masked":true,"elementId":1}',
      '{"code":"W","masked":true,"elementId":" "}',
      '{"code":"W","masked":true,"extra":1}',
      JSON.stringify({ code: "W", masked: true, elementId: "a".repeat(9000) }),
    ]
  ) {
    const response = await post(body);
    assert.equal(response?.status, 400);
    assert.equal((await response?.json()).code, "INVALID_MASK");
  }
  assert.equal((await post("{}", {}))?.status, 415);
  for (
    const headers of [{ origin: "https://outside.test" }, {
      "sec-fetch-site": "cross-site",
    }]
  ) {
    const requestHeaders = new Headers({ "content-type": "application/json" });
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    const response = await post('{"code":"W","masked":true}', requestHeaders);
    assert.equal(response?.status, 403);
    assert.equal((await response?.json()).code, "ORIGIN_DENIED");
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);
});

Deno.test("diagnostics HTTP owns only its two routes and preserves machine readable failures", async () => {
  const { handler, post } = fixture();
  assert.equal(await handler(new Request("http://atelier.test/model")), null);
  const wrong = await handler(
    new Request("http://atelier.test/api/model/diagnostics", {
      method: "POST",
    }),
  );
  assert.equal(wrong?.status, 405);
  assert.equal(wrong?.headers.get("allow"), "GET");
  assert.equal((await wrong?.json()).code, "METHOD_NOT_ALLOWED");
  const unknown = await post('{"code":"UNKNOWN","masked":true}');
  assert.equal(unknown?.status, 404);
  assert.equal((await unknown?.json()).code, "DIAGNOSTIC_NOT_FOUND");
});

Deno.test("diagnostics HTTP accepts absent or null element IDs as model-wide code masks", async () => {
  const { post, writes } = fixture();
  const mask = { code: "SELF_ADMINISTERED", masked: true };
  assert.deepEqual(await (await post(JSON.stringify(mask)))?.json(), { mask });
  assert.deepEqual(
    await (await post(JSON.stringify({ ...mask, elementId: null })))?.json(),
    { mask },
  );
  assert.deepEqual(writes, [mask, mask]);
});

Deno.test("diagnostics HTTP reports failures in English without propagating upstream wording", async () => {
  for (
    const [code, status, error] of [
      ["NOT_FOUND", 404, "Model version not found."],
      ["DIAGNOSTIC_NOT_FOUND", 404, "No current diagnostic matches this mask."],
      ["DIAGNOSTIC_NOT_MASKABLE", 400, "Error diagnostics cannot be masked."],
      [
        "UPSTREAM_FAILURE",
        502,
        "Failed to load model diagnostics from the model source.",
      ],
      ["MODEL_DIAGNOSTICS_FAILED", 500, "Failed to read model diagnostics."],
    ] as const
  ) {
    const handler = createModelDiagnosticsHandler({
      list() {
        return Promise.reject(
          Object.assign(new Error("Erreur interne."), { code }),
        );
      },
      setMask: (change) => Promise.resolve(change),
    });
    const response = await handler(
      new Request("http://atelier.test/api/model/diagnostics"),
    );
    assert.equal(response?.status, status);
    assert.deepEqual(await response?.json(), { code, error });
  }
  const { get, post, handler } = fixture();
  assert.deepEqual(await (await get("?version=bad"))?.json(), {
    code: "INVALID_VERSION",
    error: "Invalid model version.",
  });
  assert.deepEqual(await (await post("{}"))?.json(), {
    code: "INVALID_MASK",
    error: "Invalid diagnostic mask preference.",
  });
  assert.deepEqual(
    await (await handler(
      new Request("http://atelier.test/api/model/diagnostics", {
        method: "POST",
      }),
    ))?.json(),
    { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
  );
});
