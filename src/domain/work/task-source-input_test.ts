import assert from "node:assert/strict";
import {
  MAX_TASK_SOURCE_URLS,
  normalizeTaskSourceUrl,
  taskSourceUrls,
  validTaskSourceInputs,
} from "./task-source-input.ts";
Deno.test("task source URLs preserve exact HTTPS targets with bounded references", () => {
  assert.deepEqual(
    taskSourceUrls(
      "Read https://docs.deno.com/runtime/?a=1#section and https://docs.deno.com/runtime/?a=1",
    ),
    ["https://docs.deno.com/runtime/?a=1"],
  );
  assert.equal(normalizeTaskSourceUrl("https://user:secret@example.org/a"), "");
  assert.equal(normalizeTaskSourceUrl("http://example.org/a"), "");
  assert.equal(
    taskSourceUrls(
      Array.from({ length: 30 }, (_, index) => `https://example.org/${index}`)
        .join(" "),
    ).length,
    MAX_TASK_SOURCE_URLS,
  );
  assert.equal(
    validTaskSourceInputs([{
      kind: "human-selected-urls",
      rootRequestId: "other",
      source: {},
      urls: ["https://example.org/"],
    }], "request"),
    false,
  );
});
