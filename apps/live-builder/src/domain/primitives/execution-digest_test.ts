import { equal } from "node:assert/strict";
import { canonicalDigest, isSha256Hex, sha256 } from "./execution-digest.ts";

Deno.test("string SHA preserves direct and canonical undefined TextEncoder boundaries", async () => {
  equal(
    await sha256(undefined as unknown as string),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  equal(
    await canonicalDigest(undefined),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("isSha256Hex accepts only exact lowercase string identities", () => {
  const digest = "0123456789abcdef".repeat(4);
  equal(isSha256Hex(digest), true);
  for (
    const value of [
      digest.toUpperCase(),
      digest.slice(1),
      digest + "0",
      "g".repeat(64),
      digest + "\n",
      undefined,
      { toString: () => digest },
    ]
  ) {
    equal(isSha256Hex(value), false);
  }
});
