import assert from "node:assert/strict";
import { parseSetupArgs } from "./setup.ts";

Deno.test("combined setup keeps each authorized runtime bundle distinct", () => {
  assert.deepEqual(
    parseSetupArgs([
      "--catalog=/candidate/catalog.json",
      "--toolkit-bundle=/candidate/toolkit.tar.gz",
      "--semantic-bundle=/candidate/semantic-index.tar.gz",
      "--toolchains-dir=/installation",
    ]),
    {
      catalogPath: "/candidate/catalog.json",
      toolkitBundlePath: "/candidate/toolkit.tar.gz",
      semanticBundlePath: "/candidate/semantic-index.tar.gz",
      toolchainsDirectory: "/installation",
    },
  );
  assert.deepEqual(parseSetupArgs([]), {});
  assert.deepEqual(parseSetupArgs(["--source"]), { mode: "source" });
  assert.throws(() => parseSetupArgs(["--bundle=ambiguous.tar.gz"]), /Unknown/);
});
