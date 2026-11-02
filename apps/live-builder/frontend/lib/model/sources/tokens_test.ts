import assert from "node:assert/strict";
import { fetchSourceTokens, sourceTokenSegments } from "./tokens.ts";
const legend = ["keyword", "type", "comment", "future-category"];
Deno.test("native segments preserve every whitespace and Unicode code unit", () => {
  const text = "  😀 type\t// x";
  const value = {
    legend,
    tokens: [{ line: 2, start: 2, length: 2, type: 3 }, {
      line: 2,
      start: 5,
      length: 4,
      type: 1,
    }, { line: 2, start: 10, length: 4, type: 2 }],
  };
  const segments = sourceTokenSegments(text, 2, value);
  assert.equal(segments.map((s) => s.text).join(""), text);
  assert.equal(segments.find((s) => s.text === "type")?.class, "token-type");
  assert.equal(segments.find((s) => s.text === "😀")?.class, undefined);
});
Deno.test("overlap, out-of-range and surrogate-splitting spans fall back to exact plain text", () => {
  const text = "😀ab";
  for (
    const tokens of [[{ line: 0, start: 0, length: 1, type: 0 }], [{
      line: 0,
      start: 1,
      length: 1,
      type: 0,
    }], [{ line: 0, start: 0, length: 3, type: 0 }, {
      line: 0,
      start: 2,
      length: 1,
      type: 1,
    }], [{ line: 0, start: 3, length: 9, type: 1 }]]
  ) {
    assert.deepEqual(sourceTokenSegments(text, 0, { legend, tokens }), [{
      text,
    }]);
  }
  assert.deepEqual(sourceTokenSegments(text, 0, null), [{ text }]);
});
Deno.test("adjacent tokens have no lost or duplicated text and source markup remains text", () => {
  const text = "<img>";
  assert.equal(
    sourceTokenSegments(text, 0, {
      legend,
      tokens: [{ line: 0, start: 0, length: 2, type: 0 }, {
        line: 0,
        start: 2,
        length: 3,
        type: 1,
      }],
    }).map((s) => s.text).join(""),
    text,
  );
});
Deno.test("token fetch pins path/version and propagates abort; mismatched documents are refused", async () => {
  const version = `commit:${"a".repeat(40)}`,
    path = "a.sysml",
    abort = new AbortController();
  let seen = "";
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = (url, init) => {
    seen = String(url);
    signal = init?.signal;
    return Promise.resolve(
      Response.json({ version, path, legend, tokens: [] }),
    );
  };
  const doc = await fetchSourceTokens(version, path, abort.signal, fetcher);
  assert.equal(doc.version, version);
  assert.ok(seen.includes(encodeURIComponent(version)));
  assert.equal(signal, abort.signal);
  await assert.rejects(() =>
    fetchSourceTokens(
      version,
      path,
      abort.signal,
      () =>
        Promise.resolve(
          Response.json({ version: "wrong", path, legend, tokens: [] }),
        ),
    )
  );
});

Deno.test("CRLF native comment spans use exact raw bounds while the displayed line omits only CR", () => {
  const raw = "  /* first\r";
  const text = raw.slice(0, -1);
  const document = {
    legend: ["comment"],
    tokens: [{ line: 1, start: 2, length: 9, type: 0 }],
  };
  const segments = sourceTokenSegments(text, 1, document, raw);
  assert.deepEqual(segments, [{ text: "  " }, {
    text: "/* first",
    class: "token-comment",
  }]);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.equal(raw, "  /* first\r");
  // No raw evidence, extra bytes beyond CR, or a span beyond the real source:
  // all remain plain rather than accepting a generally out-of-range token.
  assert.deepEqual(sourceTokenSegments(text, 1, document), [{ text }]);
  assert.deepEqual(sourceTokenSegments(text, 1, document, raw + "x"), [{
    text,
  }]);
  assert.deepEqual(
    sourceTokenSegments(text, 1, {
      ...document,
      tokens: [{ line: 1, start: 2, length: 10, type: 0 }],
    }, raw),
    [{ text }],
  );
});
