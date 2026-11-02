import assert from "node:assert/strict";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
Deno.test({
  name:
    "native syntax-only LSP advertises legend and colors exact UTF16 source through the worker",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const text =
      'package Demo {\n    // café 😀\n    attribute label = "😀"; part def Vehicle;\n    part bike : Vehicle;\n}\n';
    const value = await tooling.tokens("unicode.sysml", text);
    const lines = text.split("\n");
    const tokens = value.tokens.map((token) => ({
      type: value.legend[token.type],
      text: lines[token.line].slice(token.start, token.start + token.length),
    }));
    assert.ok(
      tokens.some((token) =>
        token.type === "keyword" && token.text === "package"
      ),
      JSON.stringify(tokens),
    );
    assert.ok(
      tokens.some((token) => token.type === "type" && token.text === "Vehicle"),
      JSON.stringify(tokens),
    );
    assert.ok(
      tokens.some((token) =>
        token.type === "comment" && token.text.includes("😀")
      ),
      JSON.stringify(tokens),
    );
    const afterEmoji = value.tokens.find((token) =>
      token.line === 2 && value.legend[token.type] === "type"
    );
    assert.ok(afterEmoji);
    assert.equal(
      afterEmoji.start,
      lines[2].indexOf("Vehicle"),
      "a token after an emoji uses UTF16, not UTF8 bytes or Unicode scalar count",
    );
    assert.deepEqual(await tooling.tokens("unicode.sysml", text), value);
  },
});
