import { textOf } from "../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { PendingDecision } from "../../lib/decide/pending.ts";
import { press } from "../../test/support/press.ts";
import { DecidePage } from "./DecidePage.tsx";

/** One point of each kind, as lib/pending-decisions.ts hands them over. */
const proposal: PendingDecision = {
  id: "proposal:p1",
  kind: "proposal",
  label: "Review model proposal p1",
  agentId: "thread:researcher",
  agentName: "Researcher",
  href: "/revisions?proposal=p1",
};
const authorization: PendingDecision = {
  id: 'authorization:["thread:contact","change-1"]',
  kind: "authorization",
  label: "Authorize mandate change",
  agentId: "thread:contact",
  agentName: "Contact",
  caseId: "system:case:4",
  href: "/cases?case=system%3Acase%3A4",
};
const tool: PendingDecision = {
  id: 'tool:["thread:researcher","tool-1"]',
  kind: "tool",
  label: "Authorize tool: Read page",
  agentId: "thread:researcher",
  agentName: "Researcher",
  href: "/chat?agent=thread%3Aresearcher",
};

const page = (
  props: Partial<Parameters<typeof DecidePage>[0]> = {},
) =>
  renderToString(
    <DecidePage
      decisions={[proposal, authorization, tool]}
      loading={false}
      error=""
      onRefresh={() => {}}
      {...props}
    />,
  );

/** The rows as [kind, href, text]: what a person reads and where it leads. */
const rows = (html: string) =>
  [...html.matchAll(
    /<a class="decide-row" href="([^"]*)" data-kind="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
  )].map(([, href, kind, inner]) => [
    kind,
    href,
    textOf(inner),
  ]);

Deno.test("each kind of decision is one line: a dot, a short text, who asked, an arrow, and a link to its page", () => {
  const html = page();
  deepStrictEqual(rows(html), [
    [
      "proposal",
      "/revisions?proposal=p1",
      "Review model proposal p1 Researcher →",
    ],
    [
      "authorization",
      "/cases?case=system%3Acase%3A4",
      "Authorize mandate change Contact →",
    ],
    [
      "tool",
      "/chat?agent=thread%3Aresearcher",
      "Authorize tool: Read page Researcher →",
    ],
  ]);
  // The line is the link, and carries the exact phrase and the agent in its tooltip.
  match(
    html,
    /<a class="decide-row" href="\/revisions\?proposal=p1" data-kind="proposal" title="Review model proposal p1 · Researcher">/,
  );
  // The dot is decoration, the arrow too: the link reads as its text.
  equal(
    (html.match(/<span class="rev-dot is-pending" aria-hidden="true">/g) || [])
      .length,
    3,
  );
  equal(
    (html.match(/<span class="decide-go" aria-hidden="true">→<\/span>/g) || [])
      .length,
    3,
  );
  // A line is not a card, a button or a form.
  doesNotMatch(html, /<button|<form|<details|<input/);
});

Deno.test("the lines come in the order given, one per decision, and nothing is added or merged", () => {
  const reversed = [tool, authorization, proposal];
  deepStrictEqual(rows(page({ decisions: reversed })).map(([kind]) => kind), [
    "tool",
    "authorization",
    "proposal",
  ]);
  const html = page({ decisions: reversed });
  equal((html.match(/<li\s*>/g) || []).length, 3);
  match(html, /<ul class="decide-list" aria-label="Pending decisions">/);
  // Two decisions with the same words stay two lines: the id tells them apart.
  const twin = {
    ...authorization,
    id: "authorization:other",
    agentName: "Analyst",
  };
  deepStrictEqual(
    rows(page({ decisions: [authorization, twin] })).map(([, , text]) => text),
    [
      "Authorize mandate change Contact →",
      "Authorize mandate change Analyst →",
    ],
  );
  // A decision no agent is named for has no name to show.
  const anonymous: PendingDecision = {
    id: "tool:legacy",
    kind: "tool",
    label: "Authorize tool: Lire",
    href: "/chat",
  };
  const html2 = page({ decisions: [anonymous] });
  deepStrictEqual(rows(html2), [["tool", "/chat", "Authorize tool: Lire →"]]);
  doesNotMatch(html2, /decide-who/);
  match(html2, /title="Authorize tool: Lire"/);
});

Deno.test("with nothing waiting, the page says so and lists nothing", () => {
  const html = page({ decisions: [] });
  match(
    html,
    /<p class="view-empty" data-code="nothing-to-decide">Nothing to decide<\/p>/,
  );
  doesNotMatch(html, /decide-list|<a class="decide-row"|rev-empty|<button/);
});

Deno.test("an unread queue is never called empty: loading and failure say what they are", () => {
  const loading = page({ decisions: [], loading: true });
  match(
    loading,
    /<p class="rev-empty" role="status">Updating decisions…<\/p>/,
  );
  doesNotMatch(loading, /Nothing to decide|decide-list/);

  const failed = page({
    decisions: [],
    error: "Model proposals could not be loaded.",
  });
  // Told like every failure of a page: an alert, with its code.
  match(
    failed,
    /<p class="proposal-error" role="alert" data-code="decisions-unread">Model proposals could not be loaded\./,
  );
  match(
    failed,
    /<button type="button" class="rev-retry"\s*>Try again<\/button>/,
  );
  doesNotMatch(failed, /Nothing to decide|Updating decisions/);
});

Deno.test("what is known stays listed while a read runs or has failed, and the failure offers a retry", () => {
  const reading = page({ loading: true });
  equal(rows(reading).length, 3);
  // Rows are there to read: no "Updating" line in the way.
  doesNotMatch(reading, /Updating decisions/);

  const failed = page({ error: "Some decisions could not be loaded." });
  equal(rows(failed).length, 3);
  ok(failed.indexOf("decisions-unread") < failed.indexOf("decide-list"));
  match(failed, /Some decisions could not be loaded\./);

  // The retry is shut while a read is in flight, as the old menu's was.
  const busy = page({
    error: "Some decisions could not be loaded.",
    loading: true,
  });
  match(
    busy,
    /<button type="button" class="rev-retry" disabled\s*>Try again<\/button>/,
  );
});

Deno.test("Try again reads the decisions again", () => {
  let reads = 0;
  const shown = press(
    <DecidePage
      decisions={[]}
      loading={false}
      error="Model proposals could not be loaded."
      onRefresh={() => reads++}
    />,
  );
  deepStrictEqual(shown.labels, ["Try again"]);
  shown.click("Try again");
  equal(reads, 1);
});

Deno.test("labels and agent names are text, never markup", () => {
  const html = page({
    decisions: [{
      id: "proposal:unsafe",
      kind: "proposal",
      label: "<script>change()</script>",
      agentName: '<img src=x onerror="attack()">',
      href: "/revisions?proposal=unsafe",
    }],
  });
  match(html, /&lt;script/);
  match(html, /&lt;img/);
  doesNotMatch(html, /<script|<img/);
});

Deno.test("the page is framed like the others: its title first in the column, no tabs", () => {
  const html = page();
  match(html, /class="view-page is-column" data-page="decide"/);
  match(
    html,
    /<div class="view-column"><h1 class="view-title">To decide<\/h1>/,
  );
  equal((html.match(/<h1/g) || []).length, 1);
  doesNotMatch(html, /<nav|view-tabs/);
  // The list comes after the title.
  ok(html.indexOf("<h1") < html.indexOf("decide-list"));
});
