import { deepStrictEqual, doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { DiagnosticsMessageText } from "./DiagnosticsMessageText.tsx";

const version = `commit:${"a".repeat(40)}`;
const href = `/system?page=diagnostics&version=${encodeURIComponent(version)}`;
Deno.test("chat Diagnostics links are clickable at the exact Main or Request source", () => {
  for (const scope of ["", "&caseBranch=request_123"]) {
    const html = renderToString(
      <DiagnosticsMessageText
        text={`Before\n[Diagnostics](${href}${scope})\nAfter`}
      />,
    );
    match(
      html,
      /Before\n<\/span><a href="\/system\?page=diagnostics&amp;version=commit%3A[a-f0-9]{40}/,
    );
    match(html, /">Diagnostics<\/a><span\s*>\nAfter<\/span>$/);
    if (scope) match(html, /&amp;caseBranch=request_123/);
    else doesNotMatch(html, /caseBranch/);
  }
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
    ]
  ) {
    const html = renderToString(
      <DiagnosticsMessageText text={`[Diagnostics](${destination})`} />,
    );
    doesNotMatch(html, /<a\b/, destination);
  }
});
Deno.test("chat keeps code, ordinary links, escaped markup and line breaks unchanged", () => {
  const link = `[Diagnostics](${href})`;
  const text =
    `Text <script>alert(1)</script>\n\`\`${link}\`\`\n\`\`\`ts\n${link}\n\`\`\`\n~~~\n${link}\n~~~\n\\${link}\n[ordinary](/system)\nEnd`;
  const html = renderToString(<DiagnosticsMessageText text={text} />);
  doesNotMatch(html, /<a\b|<script>/);
  deepStrictEqual(html, renderToString(<>{text}</>));
});

Deno.test("text around a clickable Diagnostics link is escaped once", () => {
  const html = renderToString(
    <DiagnosticsMessageText
      text={`<before>& [Diagnostics](${href}) <after>&`}
    />,
  );
  match(html, /&lt;before>&amp; /);
  match(html, /<a href="\/system\?page=diagnostics&amp;version=commit%3A/);
  match(html, / &lt;after>&amp;/);
  doesNotMatch(html, /&amp;lt;|&amp;amp;|<before>|<after>/);
});
