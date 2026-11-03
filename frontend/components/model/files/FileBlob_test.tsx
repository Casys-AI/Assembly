import assert from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { FileBlob, SourceLine } from "./FileBlob.tsx";
const VERSION = `commit:${"a".repeat(40)}`;
Deno.test("Files SSR preserves exact source whitespace, escaping and pinned line links without a token server", () => {
  const content = "  part def Demo;\n\t// 😀 <script>\n";
  const html = renderToString(
    <FileBlob
      entry={{
        path: "demo.sysml",
        lastChange: {
          version: VERSION,
          message: "Initial",
          createdAt: "2026-10-25T00:00:00Z",
        },
      }}
      text={{ status: "ready", text: content }}
      line={2}
      version={VERSION}
      sourceVersion={VERSION}
      onRetry={() => {}}
    />,
  );
  assert.match(html, /<span> {2}part def Demo;<\/span>/);
  assert.match(html, /<span>\t\/\/ 😀 &lt;script><\/span>/);
  assert.ok(
    html.includes(`version=${encodeURIComponent(VERSION)}&amp;file=demo.sysml`),
  );
  assert.match(html, /data-line="2"/);
  assert.doesNotMatch(html, /<script>|token-keyword/);
});

Deno.test("colored source spans escape markup once and preserve adjacent Unicode and whitespace", () => {
  const content = "  😀 <img> tail";
  const html = renderToString(
    <SourceLine
      content={content}
      line={0}
      tokens={{
        legend: ["comment"],
        tokens: [{ line: 0, start: 5, length: 5, type: 0 }],
      }}
    />,
  );
  assert.match(html, /class="token-comment">&lt;img><\/span>/);
  assert.doesNotMatch(html, /<img>|&amp;lt;/);
  assert.ok(html.includes("  😀 "));
  assert.ok(html.includes(" tail"));
});

Deno.test("a CRLF multiline-comment line stays colored without rendering a carriage return", () => {
  const source = "package Demo {\r\n  /* first\r\n     second */\r\n}\r\n";
  const rawLine = source.split("\n")[1];
  const content = rawLine.slice(0, -1);
  const html = renderToString(
    <SourceLine
      content={content}
      rawLine={rawLine}
      line={1}
      tokens={{
        legend: ["comment"],
        tokens: [{ line: 1, start: 2, length: 9, type: 0 }],
      }}
    />,
  );
  assert.match(html, /class="token-comment">\/\* first<\/span>/);
  assert.doesNotMatch(html, /\r/);
  assert.equal(
    source,
    "package Demo {\r\n  /* first\r\n     second */\r\n}\r\n",
  );
});
