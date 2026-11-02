import { doesNotMatch, equal, match, ok } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { BOARD_ITEM_KINDS } from "../../lib/system/board/parse.ts";
import { kindWord } from "../../lib/system/board/words.ts";
import { tidy } from "../../test/support/markup.ts";
import { Icon } from "../view/Icon.tsx";
import { KindMark } from "./KindMark.tsx";

const mark = (kind: string, sysml = false, keyword = "part") =>
  tidy(renderToString(<KindMark element={{ kind, keyword }} sysml={sysml} />));

Deno.test("every kind of item wears a mark of its own and says what it is in a person's words, never the SysML keyword", () => {
  const dot = tidy(renderToString(<Icon name="dot" />));
  for (const kind of BOARD_ITEM_KINDS) {
    const html = mark(kind);
    match(html, /^<span class="kind-icon" title="[^"]+">/, kind);
    ok(html.includes(`title="${kindWord({ kind, keyword: "part" })}"`), kind);
    doesNotMatch(html, /title="part"/, kind);
    ok(!html.includes(dot), `${kind} wears the dot of what has no mark`);
  }
});

Deno.test("what is not an item (a port, a step, a state) wears the dot; one with no word says its keyword", () => {
  const dot = tidy(renderToString(<Icon name="dot" />));
  for (const kind of ["port", "action", "state", "clause", "toString"]) {
    ok(mark(kind).includes(dot), kind);
  }
  match(mark("port", false, "port"), /title="port"/);
  // goto has no word: the tooltip is what the model calls it.
  match(mark("goto", false, "then"), /title="then"/);
});

Deno.test("in SysML's words it is the keyword of the declaration", () => {
  equal(
    mark("scope", true, "part"),
    '<span class="kind-kw">part</span>',
  );
  doesNotMatch(mark("scope", true), /kind-icon|<svg/);
});
