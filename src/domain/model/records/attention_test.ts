import assert from "node:assert/strict";
import {
  type AttentionItem,
  attentionSourceUnavailable,
  sortAttentionItems,
} from "./attention.ts";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    code: "EXAMPLE",
    severity: "warning",
    source: "board",
    context: {},
    recovery: "Fix it.",
    target: { page: "requirements" },
    ...overrides,
  };
}

Deno.test("attention items sort by severity, source, code, page and element", () => {
  const items: AttentionItem[] = [
    item({ code: "B", severity: "info", source: "doctor" }),
    item({
      code: "A",
      severity: "error",
      source: "doctor",
      target: { page: "team", elementId: "z" },
    }),
    item({ code: "A", severity: "warning", source: "board" }),
    item({
      code: "A",
      severity: "error",
      source: "authority-matrix",
      target: { page: "rights" },
    }),
    item({
      code: "A",
      severity: "error",
      source: "doctor",
      target: { page: "team", elementId: "a" },
    }),
  ];
  const sorted = sortAttentionItems(items);
  assert.deepEqual(
    sorted.map((entry) =>
      `${entry.severity}/${entry.source}/${entry.code}/${
        entry.target.elementId ?? ""
      }`
    ),
    [
      "error/authority-matrix/A/",
      "error/doctor/A/a",
      "error/doctor/A/z",
      "warning/board/A/",
      "info/doctor/B/",
    ],
  );
});

Deno.test("attention sort separates pairs differing by one criterion only", () => {
  const pairs: Array<[AttentionItem, AttentionItem, string]> = [
    [
      item({ source: "board", target: { page: "requirements" } }),
      item({ source: "doctor", target: { page: "requirements" } }),
      "source",
    ],
    [item({ code: "A" }), item({ code: "B" }), "code"],
    [
      item({ target: { page: "requirements" } }),
      item({ target: { page: "team" } }),
      "page",
    ],
    [item({ recovery: "A fix." }), item({ recovery: "B fix." }), "recovery"],
  ];
  for (const [first, second, criterion] of pairs) {
    const sorted = sortAttentionItems([second, first]);
    assert.deepEqual(sorted, [first, second], criterion);
  }
});

Deno.test("attention sort does not mutate the input list order", () => {
  const first = item({ code: "B" });
  const second = item({ code: "A" });
  const input = [first, second];
  const sorted = sortAttentionItems(input);
  assert.deepEqual(sorted, [second, first]);
  assert.deepEqual(input, [first, second], "input order is preserved");
});

Deno.test("attention sort is deterministic across input order and context keys", () => {
  const first = item({ context: { b: 2, a: 1 } });
  const second = item({ context: { a: 1, b: 3 } });
  const forward = sortAttentionItems([first, second]);
  const reversed = sortAttentionItems([second, first]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward[0].context, { a: 1, b: 2 });
  // The input list and its items are never mutated.
  assert.deepEqual(first.context, { b: 2, a: 1 });
});

Deno.test("an unavailable source is a coded warning item for its own page", () => {
  assert.deepEqual(
    attentionSourceUnavailable("board", {
      code: "TOOLKIT_TIMEOUT",
      message: "slow",
    }),
    {
      code: "ATTENTION_SOURCE_UNAVAILABLE",
      severity: "warning",
      source: "board",
      context: {
        source: "board",
        failureCode: "TOOLKIT_TIMEOUT",
        message: "slow",
      },
      recovery:
        "Restore the board read for this version, then read the attention list again.",
      target: { page: "requirements" },
    },
  );
  assert.equal(
    attentionSourceUnavailable("authority-matrix", { code: "X" }).target.page,
    "rights",
  );
  assert.equal(
    attentionSourceUnavailable("doctor", { code: "X" }).target.page,
    "team",
  );
});
