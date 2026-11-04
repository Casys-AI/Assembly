import assert from "node:assert/strict";
import { sourcePublicationError } from "./request-source-publication-diagnostics.ts";

Deno.test("source publication diagnostics retain source coordinates without private paths or URL secrets", () => {
  const error = {
    code: "SOURCE_CONFLICT",
    message: "x".repeat(1300),
    stack: [
      "Error: source conflict",
      "    at guard (file:///Users/private-user/private-checkout/request-change-decision.ts:1298:19)",
      "    at next file:///private-directory/reader.mjs:24:3",
      "    at remote https://fixture-user:fixture-password@example.invalid/private?token=fixture-secret",
      "    at query file:///Users/private-user/query.ts:8:4?token=file-secret",
      "    at fragment file:///Users/private-user/fragment.ts:9:5#fragment-secret",
      "z".repeat(4100),
    ].join("\n"),
  };
  const result = sourcePublicationError(error);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /\[source request-change-decision\.ts:1298:19\]/);
  assert.match(serialized, /\[source reader\.mjs:24:3\]/);
  for (
    const privateValue of [
      "/Users/",
      "private-user",
      "private-checkout",
      "private-directory",
      "fixture-user",
      "fixture-password",
      "example.invalid",
      "fixture-secret",
      "query.ts",
      "file-secret",
      "fragment.ts",
      "fragment-secret",
      "token=",
      "file://",
      "https://",
    ]
  ) assert.equal(serialized.includes(privateValue), false, privateValue);
  assert.equal(result.causes[0].code, "SOURCE_CONFLICT");
  assert.equal((result.causes[0].message as string).length, 1200);
  assert.equal((result.causes[0].stack as string).length, 4000);
});
