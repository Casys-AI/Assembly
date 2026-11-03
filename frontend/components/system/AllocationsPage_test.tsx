import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import {
  allocatedBoard,
  ANALYST,
  board,
  COORDINATOR,
  HEAD,
  link,
  unit,
  withLinks,
} from "../../test/support/board-fixture.ts";
import { asides, childrenOf } from "../../test/support/markup.ts";
import {
  type PageOptions,
  renderSystemPage,
} from "../../test/support/system-page.ts";
import { AllocationsPage } from "./AllocationsPage.tsx";

const PROMOTION = `${COORDINATOR}.promotion`;

const allocations = (model: ModelBoard, over: PageOptions = {}) =>
  renderSystemPage(AllocationsPage, "allocations", model, over);

const rowOf = (html: string, id: string) =>
  html.match(
    new RegExp(
      `<tr class="el[^"]*" data-id="${id.replaceAll(".", "\\.")}">.*?</tr>`,
      "s",
    ),
  )
    ?.[0];
const header = (html: string) =>
  html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));

Deno.test("the performers head the columns, grouped by unit under the unit's name; those no unit claims are under a ?", () => {
  const html = allocations(allocatedBoard());
  match(
    header(html),
    /<tr class="groups"><th><\/th><th colspan="2">Coordinateur<\/th><th colspan="1">Analyste<\/th><th colspan="1">\?<\/th><\/tr>/,
  );
  deepStrictEqual(
    [
      ...header(html).matchAll(
        /<th class="vert[^"]*" scope="col"><span>([^<]+)<\/span>/g,
      ),
    ]
      .map(([, name]) => name),
    // Said as the page says everything it names: a phrase, not the identifier.
    ["Builder", "Test sandbox", "Builder", "Loose machine"],
  );
});

Deno.test("the rows are grouped by flow and unit, and an action that is no step is under 'Actions'", () => {
  const html = allocations(allocatedBoard());
  deepStrictEqual(
    [...html.matchAll(/<th colspan="5" scope="colgroup">([^<]*)<\/th>/g)].map(
      ([, label]) => label,
    ),
    [
      "Promotion · in Coordinateur",
      "Actions · in Analyste",
      // What the board cannot place is not left out: its unit is a question mark.
      "Actions · in ?",
    ],
  );
  deepStrictEqual(
    [...html.matchAll(/<tr class="el[^"]*" data-id="([^"]+)">/g)].map((
      [, id],
    ) => id),
    [
      `${PROMOTION}.step0`,
      `${PROMOTION}.step1`,
      `${PROMOTION}.step2`,
      `${PROMOTION}.step3`,
      `${ANALYST}.reply`,
      "ghost",
    ],
  );
});

Deno.test("a dot is an allocation: one in every cell the model allocates, and in no other", () => {
  const html = allocations(allocatedBoard());
  equal((html.match(/<span class="dot allowed">/g) ?? []).length, 7);
  const cells = (id: string) =>
    [...rowOf(html, id)!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell]) =>
      cell.includes("dot allowed")
    );
  // builder, testSandbox, analyst's builder, looseMachine.
  deepStrictEqual(cells(`${PROMOTION}.step0`), [true, false, false, false]);
  deepStrictEqual(cells(`${PROMOTION}.step1`), [true, false, false, true]);
  deepStrictEqual(cells(`${PROMOTION}.step2`), [false, true, false, false]);
  // A performer of another unit than the flow's.
  deepStrictEqual(cells(`${PROMOTION}.step3`), [false, false, true, false]);
  deepStrictEqual(cells(`${ANALYST}.reply`), [false, false, true, false]);
  // Each unit's columns open with a line.
  deepStrictEqual(
    [...rowOf(html, `${PROMOTION}.step0`)!.matchAll(/<td( class="g0")?/g)].map(
      ([, start]) => Boolean(start),
    ),
    [true, false, true, true],
  );
});

Deno.test("a row's name and every dot of it open it: the dot says who performs it", () => {
  const html = allocations(allocatedBoard());
  const row = rowOf(html, `${PROMOTION}.step1`)!;
  const links = [...row.matchAll(/<a [^>]*href="([^"]*)"/g)].map(([, href]) =>
    href
  );
  deepStrictEqual(
    links,
    Array(3).fill(
      `/system?page=allocations&amp;select=${PROMOTION}.step1`,
    ),
  );
  match(row, /aria-label="Step 2, performed by Builder"/);
  match(row, /aria-label="Step 2, performed by Loose machine"/);
  // An element the board does not hold has nothing to open.
  const ghost = rowOf(html, "ghost")!;
  doesNotMatch(ghost, /<a /);
  match(ghost, /<span class="faint" title="Not in the model">ghost<\/span>/);
  match(ghost, /<span class="dot allowed"><\/span>/);
});

Deno.test("the detail of a row is a row of the table, as wide as the table's container, right under it", () => {
  const html = allocations(allocatedBoard(), {
    selected: `${PROMOTION}.step1`,
  });
  equal(asides(html), 1);
  // The row, then the row of its detail, over every column.
  match(
    html,
    /<tr class="el is-selected" data-id="unit-coordinator\.promotion\.step1">.*?<\/tr><tr class="detail-row"><td colspan="5"><div class="detail-hold"><aside class="detail" aria-label="Detail" data-element="unit-coordinator\.promotion\.step1">/s,
  );
  // The table is in the container the detail measures itself against.
  match(
    html,
    /<div class="detail-table"><div class="matrix-scroll"><table class="matrix">/,
  );
  // Rows of a table are the children of its body: no <aside> or <div> in it.
  for (const children of childrenOf(html, "tbody")) {
    ok(children.every((tag) => tag === "tr"), `${children}`);
  }
  for (const children of childrenOf(html, "tr")) {
    ok(children.every((tag) => tag === "th" || tag === "td"), `${children}`);
  }
  // Another row's detail replaces it: one at a time, in the row asked for.
  const other = allocations(allocatedBoard(), {
    selected: `${PROMOTION}.step3`,
  });
  equal(asides(other), 1);
  match(
    other,
    /data-id="unit-coordinator\.promotion\.step3">.*?<\/tr><tr class="detail-row">/s,
  );
  // Choosing the row again closes it.
  match(
    rowOf(html, `${PROMOTION}.step1`)!,
    /href="\/system\?page=allocations" aria-current="true"/,
  );
});

Deno.test("the performers of the chosen row are lit, the others step back", () => {
  const html = allocations(allocatedBoard(), {
    selected: `${PROMOTION}.step1`,
  });
  match(html, /<div class="allocations has-selection">/);
  deepStrictEqual(
    [...header(html).matchAll(/<th class="vert (el[^"]*)"/g)].map(([, state]) =>
      state
    ),
    ["el is-lit", "el", "el", "el is-lit"],
  );
  // The detail says who performs it, by the page that shows each.
  match(html, /<h5>performed by<\/h5>/);
  // Nothing chosen, nothing stepped back.
  doesNotMatch(
    allocations(allocatedBoard()),
    /has-selection|is-lit|is-selected|<aside/,
  );
});

Deno.test("a selection no row carries follows the title", () => {
  // A performer is a column, not a row.
  const html = allocations(allocatedBoard(), {
    selected: `${COORDINATOR}.operator`,
  });
  equal(asides(html), 1);
  match(html, /^<div class="allocations has-selection"><aside /);
  // The rows allocated to it are lit; the column is not a row.
  match(rowOf(html, `${PROMOTION}.step0`)!, /^<tr class="el is-lit"/);
  doesNotMatch(rowOf(html, `${PROMOTION}.step2`)!, /is-lit/);
  // An unknown name opens nothing.
  equal(asides(allocations(allocatedBoard(), { selected: "nothing" })), 0);
});

Deno.test("units are called by the team's names, and in SysML's words by their identifiers, with the keyword of each row", () => {
  const readable = allocations(allocatedBoard());
  match(readable, />Coordinateur<\/th>/);
  match(readable, /Promotion · in Coordinateur/);
  doesNotMatch(readable, /kind-kw/);
  const sysml = allocations(allocatedBoard(), { sysml: true });
  match(sysml, />liveBuilder<\/th>/);
  match(sysml, /promotion · in liveBuilder/);
  doesNotMatch(sysml, /Coordinateur/);
  match(sysml, /<a class="matrix-row"[^>]*><span class="kind-kw">/);
});

Deno.test("a model that allocates nothing says so in one line", () => {
  equal(
    allocations(board({ team: [unit({ id: "u", title: "u" })] })),
    '<p class="view-empty" data-code="no-allocation">No allocations yet</p>',
  );
  equal(
    allocations(withLinks(board({ team: [unit({ id: "u", title: "u" })] }), [
      link("connect", "u.sandbox", "u.catalog"),
    ])),
    '<p class="view-empty" data-code="no-allocation">No allocations yet</p>',
  );
});

Deno.test("the version being read is kept by every link of the page", () => {
  const html = allocations(allocatedBoard(), { version: HEAD });
  const hrefs = [...html.matchAll(/ href="([^"]*)"/g)].map(([, href]) => href);
  ok(hrefs.length > 0);
  for (const href of hrefs) {
    match(href, new RegExp(`version=${encodeURIComponent(HEAD)}`));
  }
});
