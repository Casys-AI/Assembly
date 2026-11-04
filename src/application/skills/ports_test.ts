import assert from "node:assert/strict";
import { BundledSkillReadError } from "./ports.ts";

Deno.test("bundled skill failures expose their fixed diagnostic for each expected code", () => {
  for (const code of ["unavailable", "invalid-content", "limit"] as const) {
    const error = new BundledSkillReadError(code);
    assert.deepEqual({
      code: error.code,
      name: error.name,
      message: error.message,
    }, {
      code,
      name: "BundledSkillReadError",
      message: `Bundled skill: ${code}`,
    });
  }
});
