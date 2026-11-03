import assert from "node:assert/strict";
import { characterCount } from "./character-count.ts";

Deno.test("characterCount counts Unicode code points, not UTF-16 units", () => {
  assert.equal(characterCount(""), 0);
  assert.equal(characterCount("abc"), 3);
  // Precomposed accent: one code point.
  assert.equal(characterCount("é"), 1);
  // Base letter plus combining mark: two code points, as in JSON Schema.
  assert.equal(characterCount("é"), 2);
  assert.equal(characterCount("😀"), 1);
  assert.equal(characterCount("😀".repeat(200)), 200);
  // A ZWJ sequence is several code points joined for display.
  assert.equal(characterCount("👨‍👩‍👧"), 5);
});
