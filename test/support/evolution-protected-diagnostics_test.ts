import assert from "node:assert/strict";
import { protectedDifferences } from "./evolution-protected-diagnostics.ts";

Deno.test("protected diagnostic output is bounded and hashes changed values", async () => {
  const before = {
    facts: {
      literal: { value: "public-test-before" },
      unknown: { value: "public-test-after" },
    },
  };
  const after = {
    facts: { literal: { value: "public-test-after" }, unknown: { value: 17 } },
  };
  const diffs = await protectedDifferences(before, after, 1);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0]!.path, /literal.*value/);
  assert.equal(diffs[0]!.beforeType, "string");
  assert.equal(diffs[0]!.afterType, "string");
  assert.notEqual(diffs[0]!.beforeDigest, diffs[0]!.afterDigest);
  assert(!JSON.stringify(diffs).includes("public-test-before"));
  assert(!JSON.stringify(diffs).includes("public-test-after"));
});
