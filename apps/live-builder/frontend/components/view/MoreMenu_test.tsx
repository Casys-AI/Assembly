import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { tidy } from "../../test/support/markup.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import type { PageTab } from "./PageNav.tsx";

const tabs: PageTab[] = [
  { id: "parts", label: "Parts", href: "/system?page=parts" },
  { id: "allocations", label: "Allocations", href: "/system?page=allocations" },
];

const menu = (current: string, label?: string) =>
  tidy(
    renderToString(<MoreMenu label={label} tabs={tabs} current={current} />),
  );

Deno.test("the menu is a disclosure of real links, closed, named More until one of its pages is shown", () => {
  const html = menu("team");
  match(html, /^<details class="view-more">/);
  doesNotMatch(html, /<details[^>]* open/);
  match(html, /<summary aria-current="false">More<\/summary>/);
  match(
    html,
    /<div class="view-more-list"><a href="\/system\?page=parts" aria-current="false">Parts<\/a><a href="\/system\?page=allocations" aria-current="false">Allocations<\/a><\/div>/,
  );
  // It acts without a script: no button, no handler to wait for.
  doesNotMatch(html, /<button|onclick/i);
  equal((html.match(/<a /g) ?? []).length, 2);
});

Deno.test("when one of its pages is shown the menu is called by it, and the page is marked in the list", () => {
  const html = menu("allocations");
  match(html, /<summary aria-current="page">Allocations<\/summary>/);
  match(
    html,
    /<a href="\/system\?page=allocations" aria-current="page">Allocations<\/a>/,
  );
  match(html, /<a href="\/system\?page=parts" aria-current="false">Parts<\/a>/);
  equal((html.match(/aria-current="page"/g) ?? []).length, 2);
});

Deno.test("the menu can be named otherwise, and has nothing to show without pages", () => {
  match(
    menu("team", "Others"),
    /<summary aria-current="false">Others<\/summary>/,
  );
  deepStrictEqual(
    renderToString(<MoreMenu tabs={[]} current="team" />),
    "",
  );
});
