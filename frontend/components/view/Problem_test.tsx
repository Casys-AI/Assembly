import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { Problem } from "./Problem.tsx";

Deno.test("a problem is an alert that carries its code, then its sentence", () => {
  const html = renderToString(
    <Problem
      problem={{ code: "read-failed", message: "It could not be read." }}
    />,
  );
  equal(
    html,
    '<p class="proposal-error" role="alert" data-code="read-failed">It could not be read.</p>',
  );
});

Deno.test("the subject comes first, what the host said under the sentence, and the children at the end", () => {
  const html = renderToString(
    <Problem
      problem={{ code: "x", message: "Refused.", detail: "Stale." }}
      subject="Designer"
    >
      <button type="button">Try again</button>
    </Problem>,
  );
  match(
    html,
    /<strong class="rev-subject">Designer<\/strong>: Refused\.<span class="rev-host-says">Stale\.<\/span><button type="button">Try again<\/button><\/p>/,
  );
});

Deno.test("what the host said is text, never markup", () => {
  const html = renderToString(
    <Problem
      problem={{ code: "x", message: "m", detail: "<img src=x onerror=a()>" }}
      subject="<b>name</b>"
    />,
  );
  match(html, /&lt;img src=x onerror=a\(\)>/);
  match(html, /&lt;b>name&lt;\/b>/);
  doesNotMatch(html, /<img|<b>/);
});

Deno.test("what the host gave, its code and what it says to do, comes after its words, and the code is on the paragraph", () => {
  const html = renderToString(
    <Problem
      problem={{
        code: "board-timeout",
        message: "The system took too long to read.",
        detail: "Too slow.",
        hostCode: "TOOLKIT_TIMEOUT",
        recovery: "Wait before retrying.",
      }}
    />,
  );
  equal(
    html,
    '<p class="proposal-error" role="alert" data-code="board-timeout" data-host-code="TOOLKIT_TIMEOUT">The system took too long to read.<span class="rev-host-says">Too slow.</span><span class="rev-host-says"><code class="rev-host-code">TOOLKIT_TIMEOUT</code>Wait before retrying.</span></p>',
  );
  // A recovery alone, or a code alone, is said alone.
  match(
    renderToString(
      <Problem problem={{ code: "x", message: "m", recovery: "Do this." }} />,
    ),
    /<span class="rev-host-says">Do this\.<\/span>/,
  );
  const coded = renderToString(
    <Problem problem={{ code: "x", message: "m", hostCode: "CODE" }} />,
  );
  match(coded, /data-host-code="CODE"/);
  doesNotMatch(coded, /rev-host-says"><code[^>]*>CODE<\/code><\/span><span/);
  // The host's words are text, as everything else.
  const hostile = renderToString(
    <Problem
      problem={{
        code: "x",
        message: "m",
        hostCode: "<b>C</b>",
        recovery: "<img src=x>",
      }}
    />,
  );
  doesNotMatch(hostile, /<img|<b>/);
});
