import assert from "node:assert/strict";
import { loadAddon, resolveAddonPath } from "./toolkit.ts";

Deno.test("TS addon helper loads exactly the validated native path and checks public capabilities", async () => {
  const root = await Deno.makeTempDir();
  try {
    const addon = `${root}/explicit.node`;
    await Deno.writeTextFile(addon, "test fixture; never executed");
    const module = Object.fromEntries([
      "ToolkitLibrary",
      "ToolkitSession",
      "NativeLspServer",
      "toolkitVersion",
      "addonVersion",
      "checkSyntax",
      "checkSyntaxFindings",
      "nativeResourceCounts",
    ].map((name) => [name, () => undefined]));
    const paths: string[] = [];
    const actual = await loadAddon(addon, (path) => {
      paths.push(path);
      return module;
    });
    assert.equal(actual, module);
    assert.deepEqual(paths, [addon]);
    // A generated JS wrapper marker is not a native addon export contract.
    assert.equal("__napiBindingTarget" in module, false);
    await assert.rejects(() => loadAddon(addon, () => ({})), /missing exports/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("TS addon helper preserves a direct failure and never tries another loader", async () => {
  const root = await Deno.makeTempDir();
  try {
    const addon = `${root}/explicit.node`;
    await Deno.writeTextFile(addon, "test fixture; never executed");
    const failure = new Error("direct native binding rejected");
    let attempts = 0;
    await assert.rejects(() =>
      loadAddon(addon, () => {
        attempts++;
        throw failure;
      }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      assert.match(error.message, /direct .node load failed/);
      assert.ok(error.message.includes(addon));
      return true;
    });
    assert.equal(attempts, 1);
    const js = `${root}/index.js`;
    await Deno.writeTextFile(js, "throw new Error('must not execute');");
    assert.throws(() => resolveAddonPath(js), /expected a .node/);
    await Deno.symlink(addon, `${root}/alias.node`);
    assert.throws(
      () => resolveAddonPath(`${root}/alias.node`),
      /regular .node/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
