import { doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { Empty } from "./Empty.tsx";
import { Icon, type IconName } from "./Icon.tsx";

const names: IconName[] = [
  "person",
  "wrench",
  "book",
  "eye",
  "archive",
  "file",
  "key",
  "arrows",
  "spark",
  "cube",
  "shield",
  "check",
  "ring",
  "dot",
  "open",
  "lock",
];

Deno.test("an icon is an outline on a 24 pixel square, hidden from whoever reads the page", () => {
  for (const name of names) {
    const html = renderToString(<Icon name={name} />);
    match(
      html,
      /^<svg viewBox="0 0 24 24" class="ic" aria-hidden="true" focusable="false">/,
    );
    match(html, /<(path|circle|rect) /);
    doesNotMatch(html, /fill=|stroke=|style=/);
  }
  match(renderToString(<Icon name="eye" class="big" />), /class="ic big"/);
});

Deno.test("what a page says when the model declares nothing is one line, with its code", () => {
  match(
    renderToString(<Empty code="no-agent">No agent declared</Empty>),
    /^<p class="view-empty" data-code="no-agent">No agent declared<\/p>$/,
  );
});
