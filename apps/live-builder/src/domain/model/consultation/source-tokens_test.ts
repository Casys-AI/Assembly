import assert from "node:assert/strict";
import { decodeSemanticTokens } from "./source-tokens.ts";
Deno.test("native deltas decode UTF16 positions, reset per line, and allow adjacent spans", () => {
  assert.deepEqual(
    decodeSemanticTokens([0, 0, 2, 0, 0, 0, 2, 1, 1, 0, 1, 1, 2, 1, 0], [
      "keyword",
      "type",
    ], "😀x\n ab"),
    [
      { line: 0, start: 0, length: 2, type: 0 },
      { line: 0, start: 2, length: 1, type: 1 },
      { line: 1, start: 1, length: 2, type: 1 },
    ],
  );
});
Deno.test("malformed native deltas, overlaps, invalid types and surrogate splits are rejected", () => {
  for (
    const data of [
      [0],
      [0, -1, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 4, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 1, 0, 0],
      [2, 0, 1, 0, 0],
      [0, 0, 99, 0, 0],
      [0, 0, 2, 0, 0, 0, 1, 1, 0, 0],
      [0, 0, 1.5, 0, 0],
    ]
  ) {
    assert.throws(() => decodeSemanticTokens(data, ["keyword"], "😀a"));
  }
});
