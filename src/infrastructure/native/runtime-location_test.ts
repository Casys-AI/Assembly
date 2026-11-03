import assert from "node:assert/strict";
import {
  isSafeNativeBasename,
  parseNativeRuntimePointer,
  semanticLegacyDirectory,
  semanticNativeDirectory,
  serializeNativeRuntimePointer,
  toolkitLegacyDirectory,
  toolkitNativeDirectory,
} from "./runtime-location.ts";

const HASH = "0123456789abcdef".repeat(4);

Deno.test("native target names carry platform and source fingerprint prefix", () => {
  assert.equal(
    toolkitNativeDirectory("darwin-arm64", HASH),
    "sysml-toolkit-native-v0.10.10+ase.2-darwin-arm64-0123456789abcdef",
  );
  assert.equal(
    semanticNativeDirectory("linux-x64-gnu", HASH),
    "semantic-index-native-v0.1.0-linux-x64-gnu-0123456789abcdef",
  );
  assert.equal(toolkitLegacyDirectory(), "sysml-toolkit-native-v0.10.10+ase.2");
  assert.equal(
    semanticLegacyDirectory("darwin-arm64"),
    "semantic-index-native-v0.1.0-darwin-arm64",
  );
  assert.throws(
    () => toolkitNativeDirectory("darwin-arm64", "XYZ"),
    /SHA-256/,
  );
});

Deno.test("native runtime pointer round-trips with exact fields only", () => {
  const text = serializeNativeRuntimePointer({
    schema: 1,
    runtime: "toolkit",
    platform: "darwin-arm64",
    directory:
      "sysml-toolkit-native-v0.10.10+ase.2-darwin-arm64-0123456789abcdef",
  });
  assert.deepEqual(parseNativeRuntimePointer(text, "toolkit"), {
    schema: 1,
    runtime: "toolkit",
    platform: "darwin-arm64",
    directory:
      "sysml-toolkit-native-v0.10.10+ase.2-darwin-arm64-0123456789abcdef",
  });
  // La sérialisation est déterministe : une réécriture identique est détectable.
  assert.equal(
    serializeNativeRuntimePointer(parseNativeRuntimePointer(text)),
    text,
  );
});

Deno.test("native runtime pointer refuses traversal, symlinks names and drift", () => {
  for (
    const directory of ["../escape", "a/b", "/abs", "..", ".", ".hidden", ""]
  ) {
    assert.equal(isSafeNativeBasename(directory), false, directory);
    assert.throws(() =>
      parseNativeRuntimePointer(JSON.stringify({
        schema: 1,
        runtime: "toolkit",
        platform: "darwin-arm64",
        directory,
      })), /nom de base sûr/);
  }
  assert.throws(
    () =>
      parseNativeRuntimePointer(JSON.stringify({
        schema: 1,
        runtime: "toolkit",
        platform: "darwin-arm64",
        directory: "ok-name",
        extra: true,
      })),
    /champs/,
  );
  assert.throws(
    () =>
      parseNativeRuntimePointer(
        JSON.stringify({
          schema: 1,
          runtime: "semantic-index",
          platform: "darwin-arm64",
          directory: "ok-name",
        }),
        "toolkit",
      ),
    /attendu/,
  );
  assert.throws(
    () =>
      parseNativeRuntimePointer(JSON.stringify({
        schema: 1,
        runtime: "toolkit",
        platform: "plan9-arm",
        directory: "ok-name",
      })),
    /Plateforme/,
  );
});
