import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { tidy } from "../../test/support/markup.ts";
import { PageFrame } from "./PageFrame.tsx";
import { PageNav, type PageTab } from "./PageNav.tsx";

const tabs: PageTab[] = [
  { id: "revisions", label: "Revisions", href: "/revisions" },
  { id: "graph", label: "Graph", href: "/revisions?page=graph" },
];

const frame = (props: Partial<Parameters<typeof PageFrame>[0]> = {}) =>
  renderToString(
    <PageFrame
      label="Model pages"
      title="Graph"
      tabs={tabs}
      current="graph"
      {...props}
    >
      <p id="page-content">The page</p>
    </PageFrame>,
  );

Deno.test("the pages of a place are real links, and the page shown says so", () => {
  const html = renderToString(
    <PageNav label="Model pages" tabs={tabs} current="graph" />,
  );
  match(html, /<nav class="view-tabs" aria-label="Model pages">/);
  match(html, /<a href="\/revisions" aria-current="false">Revisions<\/a>/);
  match(
    html,
    /<a href="\/revisions\?page=graph" aria-current="page">Graph<\/a>/,
  );
  // Exactly one tab is current, and no tab is a button. The others say they
  // are not: Fresh would otherwise mark every tab that shares the page's path.
  equal((html.match(/aria-current="page"/g) || []).length, 1);
  equal((html.match(/aria-current="false"/g) || []).length, 1);
  equal((html.match(/<a /g) || []).length, 2);
  doesNotMatch(html, /<button|role="tab"|aria-selected/);
});

Deno.test("no tab is current when the page is not one of them", () => {
  const html = renderToString(
    <PageNav label="Pages" tabs={tabs} current="elsewhere" />,
  );
  doesNotMatch(html, /aria-current="page"/);
  equal((html.match(/aria-current="false"/g) || []).length, 2);
});

Deno.test("the title shows once, first in the page, whichever the layout", () => {
  for (const layout of ["column", "wide", "fill"] as const) {
    const html = frame({ layout });
    equal((html.match(/<h1/g) || []).length, 1, layout);
    match(html, /<h1 class="view-title">Graph<\/h1>/);
    // The tabs come first, then the title, then the page.
    ok(html.indexOf('class="view-tabs"') < html.indexOf("<h1"), layout);
    ok(html.indexOf("<h1") < html.indexOf('id="page-content"'), layout);
    // The title is the first thing of the page's column.
    match(html, /<div class="view-column"><h1 class="view-title">/);
    // The tabs do not repeat it as a heading.
    doesNotMatch(html.slice(0, html.indexOf('class="view-body"')), /<h1/);
  }
});

Deno.test("the layout is a class of the frame, the column by default", () => {
  match(frame(), /class="view-page is-column" data-page="graph"/);
  match(frame({ layout: "wide" }), /class="view-page is-wide"/);
  match(frame({ layout: "fill" }), /class="view-page is-fill"/);
});

Deno.test("what belongs on the right of the tabs sits in the head, only when given", () => {
  const html = frame({ actions: <input aria-label="Search" /> });
  const head = html.slice(
    html.indexOf('<header class="view-head">'),
    html.indexOf("</header>"),
  );
  match(head, /<div class="view-head-end"><input aria-label="Search"/);
  ok(head.indexOf("view-tabs") < head.indexOf("view-head-end"));
  doesNotMatch(frame(), /view-head-end/);
});

Deno.test("the frame leaves the window's close button to the window around it", () => {
  const html = frame();
  doesNotMatch(html, /desk-close|aria-label="Close/);
  deepStrictEqual(
    [...html.matchAll(/<nav /g)].length,
    1,
  );
});

Deno.test("a place with a single page has no tabs, and its title still falls where the others' do", () => {
  const html = renderToString(
    <PageFrame title="To decide" current="decide">
      <p id="page-content">The page</p>
    </PageFrame>,
  );
  // No empty navigation landmark, but the head keeps the close button's room.
  doesNotMatch(html, /<nav|view-tabs/);
  match(html, /<header class="view-head"><\/header>/);
  match(html, /<div class="view-column"><h1 class="view-title">To decide</);
  match(html, /class="view-page is-column" data-page="decide"/);
  // The tabbed frame is untouched.
  equal((frame().match(/<nav /g) || []).length, 1);
});

Deno.test("pages kept in a menu follow the tabs in the head, outside the strip that would clip them", () => {
  const html = tidy(frame({
    current: "parts",
    more: {
      tabs: [{ id: "parts", label: "Parts", href: "/revisions?page=parts" }],
    },
  }));
  const head = html.slice(
    html.indexOf('<header class="view-head">'),
    html.indexOf("</header>"),
  );
  // The menu is not in the nav: the tab strip scrolls and would cut it.
  ok(head.indexOf("</nav>") < head.indexOf('<details class="view-more">'));
  match(head, /<summary aria-current="page">Parts<\/summary>/);
  // No tab is current while a page of the menu is.
  doesNotMatch(head.slice(0, head.indexOf("</nav>")), /aria-current="page"/);
  // Without pages for it there is no menu.
  doesNotMatch(frame(), /view-more/);
  doesNotMatch(frame({ more: { tabs: [] } }), /view-more/);
});
