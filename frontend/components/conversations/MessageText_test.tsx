import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { MessageText } from "./MessageText.tsx";
import {
  MARKDOWN_LIMIT,
  MAX_NESTING,
} from "../../lib/conversations/message-markdown.ts";

const version = `commit:${"a".repeat(40)}`;
const href = `/system?page=diagnostics&version=${encodeURIComponent(version)}`;
// The renderer leaves a space in a tag whose attributes are all absent.
const html = (text: string) =>
  renderToString(<MessageText text={text} />).replace(/<(\w+) >/g, "<$1>");

Deno.test("chat Diagnostics links are clickable at the exact Main or Request source", () => {
  for (const scope of ["", "&caseBranch=request_123"]) {
    const out = html(`Before\n[Diagnostics](${href}${scope})\nAfter`);
    match(
      out,
      /^<p>Before<br><a href="\/system\?page=diagnostics&amp;version=commit%3A[a-f0-9]{40}/,
    );
    match(out, /">Diagnostics<\/a><br>After<\/p>$/);
    if (scope) match(out, /&amp;caseBranch=request_123/);
    else doesNotMatch(out, /caseBranch/);
  }
});

Deno.test("a Request link reads as a chip to that exact Request", () => {
  equal(
    html("[Request 7](/cases?case=request%3A7) opened: Review"),
    '<p><a href="/cases?case=request%3A7" class="message-case-link">Request 7</a> opened: Review</p>',
  );
});

Deno.test("chat leaves unsafe, foreign and ambiguous destinations as literal text", () => {
  for (
    const destination of [
      `https://example.test${href}`,
      `//example.test${href}`,
      "javascript:alert(1)",
      "/system?page=diagnostics",
      "/system?page=diagnostics&version=branch:main",
      `${href}&version=${version}`,
      `${href}&page=diagnostics`,
      `${href}&caseBranch=a&caseBranch=b`,
      `${href}&caseBranch=`,
      `${href}&caseBranch=..%2Fforeign`,
      `${href}&extra=1`,
      `${href}#foreign`,
      "/model?page=diagnostics",
      "https://example.test/cases?case=request_1",
      "/cases?case=request_1&agent=x",
      "/cases?case=..%2Fforeign",
      "/cases?case=request_1#foreign",
      "/cases?case=",
    ]
  ) {
    doesNotMatch(html(`[Link](${destination})`), /<a\b/, destination);
  }
  // A bare address is text too, and an image is never loaded.
  doesNotMatch(html("See https://example.test ![x](/a.png)"), /<a\b|<img/);
});

Deno.test("chat keeps code, ordinary links and escaped markup literal", () => {
  const link = `[Diagnostics](${href})`;
  const escaped = link.replaceAll("&", "&amp;");
  const out = html(
    `Text <script>alert(1)</script> \`\`${link}\`\`\n\`\`\`ts\n${link}\n\`\`\`\n~~~\n${link}\n~~~\n\\${link} [ordinary](/system)`,
  );
  doesNotMatch(out, /<a\b|<script>/);
  match(out, /^<p>Text &lt;script>alert\(1\)&lt;\/script> <code>/);
  equal(out.includes(`<code>${escaped}</code></p>`), true, "inline code");
  equal(
    out.split(`<pre><code>${escaped}</code></pre>`).length,
    3,
    "both fenced blocks stay code",
  );
  // The backslash escapes the bracket, as in any Markdown reader.
  match(out, /<p>\[Diagnostics\]\([^)]+\) \[ordinary\]\(\/system\)<\/p>$/);
});

Deno.test("text around a clickable Diagnostics link is escaped once", () => {
  const out = html(`<before>& [Diagnostics](${href}) <after>&`);
  match(out, /&lt;before>&amp; /);
  match(out, /<a href="\/system\?page=diagnostics&amp;version=commit%3A/);
  match(out, / &lt;after>&amp;/);
  doesNotMatch(out, /&amp;lt;|&amp;amp;|<before>|<after>/);
});

Deno.test("an agent's Markdown reads as paragraphs, lists, headings, bold, italics and code", () => {
  equal(
    html(
      "The reviewer answered:\n1. « Vos cours » → « Fini »\n2. kept\n\n**Best:** _Notez vite_ and *now*, `run()`\n### Next\n- a\n- b",
    ),
    "<p>The reviewer answered:</p>" +
      "<ol><li>« Vos cours » → « Fini »</li><li>kept</li></ol>" +
      "<p><strong>Best:</strong> <em>Notez vite</em> and <em>now</em>, <code>run()</code></p>" +
      '<p class="message-heading">Next</p>' +
      "<ul><li>a</li><li>b</li></ul>",
  );
  match(html("3. third\n4. fourth"), /^<ol start="3">/);
});

Deno.test("code spans with three backticks keep the text after them", () => {
  equal(
    html("```inline``` text\nnext line"),
    "<p><code>inline</code> text<br>next line</p>",
  );
});

Deno.test("a star inside code does not close the emphasis around it", () => {
  equal(
    html("*see `a*b` here*"),
    "<p><em>see <code>a*b</code> here</em></p>",
  );
});

Deno.test("a nested list stays nested", () => {
  equal(
    html("- a\n  - b\n- c"),
    "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>",
  );
});

Deno.test("an escaped star stays a star", () => {
  equal(html("\\*not emphasis\\*"), "<p>*not emphasis*</p>");
});

Deno.test("snake_case, spaced stars and unclosed delimiters stay text", () => {
  const text = "read_web_page_outline costs 5 * 3, **open and `tick";
  equal(html(text), `<p>${text}</p>`);
});

Deno.test("a message too long to read safely stays plain text", () => {
  const text = "*a `b ".repeat(Math.ceil((MARKDOWN_LIMIT + 1) / 6));
  equal(html(text), `<p>${text}</p>`);
});

Deno.test("a message nested deeper than its limit stays plain text, however deep", () => {
  match(html(`${">".repeat(MAX_NESTING)} x`), /<blockquote>/);
  const list = Array.from(
    { length: MAX_NESTING + 1 },
    (_, level) => `${"  ".repeat(level)}- a`,
  ).join("\n");
  // The last one overflows marked's own recursion.
  for (
    const text of [
      `${">".repeat(MAX_NESTING + 1)} x`,
      list,
      `${">".repeat(8_000)} x`,
    ]
  ) {
    equal(html(text), `<p>${text}</p>`);
  }
});
