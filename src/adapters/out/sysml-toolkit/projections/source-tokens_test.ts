import assert from "node:assert/strict";
import { decodeSemanticTokens, toolkitSourceTokens } from "./source-tokens.ts";
import type { ToolkitRuntime } from "../runtime/loader.ts";

function fixture(fail = false, encoding?: string) {
  const messages: Record<string, unknown>[] = [];
  let freed = 0;
  const runtime = {
    createLspServer: () => ({
      free() {
        freed++;
      },
      handle(raw: string) {
        const message = JSON.parse(raw);
        messages.push(message);
        if (message.id === 1) {
          return [
            JSON.stringify({
              id: 1,
              result: {
                capabilities: {
                  ...(encoding ? { positionEncoding: encoding } : {}),
                  semanticTokensProvider: {
                    full: true,
                    legend: { tokenTypes: ["keyword"] },
                  },
                },
              },
            }),
          ];
        }
        if (message.id === 2) {
          return [JSON.stringify(
            fail
              ? { id: 2, error: { code: -1 } }
              : { id: 2, result: { data: [0, 0, 7, 0, 0] } },
          )];
        }
        return [];
      },
    }),
  } as unknown as ToolkitRuntime;
  return { runtime, messages, freed: () => freed };
}
Deno.test("syntax server opens exact text without workspace/stdlib, consumes native legend, and frees", () => {
  const f = fixture();
  const source = "package X;";
  assert.deepEqual(toolkitSourceTokens(f.runtime, "a.sysml", source), {
    legend: ["keyword"],
    tokens: [{ line: 0, start: 0, length: 7, type: 0 }],
  });
  const open = f.messages.find((m) => m.method === "textDocument/didOpen") as {
    params: { textDocument: { text: string } };
  };
  assert.equal(open.params.textDocument.text, source);
  assert.deepEqual(
    (f.messages[0].params as { workspaceFolders: unknown }).workspaceFolders,
    null,
  );
  assert.equal(f.freed(), 1);
});
Deno.test("failed native requests still dispose the LSP server", () => {
  const f = fixture(true);
  assert.throws(() => toolkitSourceTokens(f.runtime, "a.sysml", "package X;"));
  assert.equal(f.freed(), 1);
});

Deno.test("UTF16 negotiation is explicit and an incompatible announced encoding is refused", () => {
  const f = fixture(false, "utf-8");
  assert.throws(
    () => toolkitSourceTokens(f.runtime, "a.sysml", "package X;"),
    /UTF-16/,
  );
  assert.equal(f.freed(), 1);
  const params = f.messages[0].params as {
    capabilities: { general: { positionEncodings: string[] } };
  };
  assert.deepEqual(params.capabilities.general.positionEncodings, ["utf-16"]);
});

Deno.test("KerML files use the native KerML language identifier", () => {
  const f = fixture();
  toolkitSourceTokens(f.runtime, "a.kerml", "package X;");
  const opened = f.messages.find((message) =>
    message.method === "textDocument/didOpen"
  ) as { params: { textDocument: { languageId: string } } };
  assert.equal(opened.params.textDocument.languageId, "kerml");
});

Deno.test("native deltas decode UTF16 positions, reset per line, and allow adjacent spans", () => {
  assert.deepEqual(
    decodeSemanticTokens([0, 0, 2, 0, 0, 0, 2, 1, 1, 0, 1, 1, 2, 1, 0], [
      "keyword",
      "type",
    ], "😀x\n ab"),
    [
      { line: 0, start: 0, length: 2, type: 0 },
      { line: 0, start: 2, length: 1, type: 1 },
      { line: 1, start: 1, length: 2, type: 1 },
    ],
  );
});
Deno.test("malformed native deltas, overlaps, invalid types and surrogate splits are rejected", () => {
  for (
    const data of [
      [0],
      [0, -1, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 4, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 1, 0, 0],
      [2, 0, 1, 0, 0],
      [0, 0, 99, 0, 0],
      [0, 0, 2, 0, 0, 0, 1, 1, 0, 0],
      [0, 0, 1.5, 0, 0],
    ]
  ) {
    assert.throws(() => decodeSemanticTokens(data, ["keyword"], "😀a"));
  }
});
