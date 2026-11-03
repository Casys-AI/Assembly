import { textOf } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { RevisionList } from "./RevisionList.tsx";
import { renderToString } from "preact-render-to-string";
import { press } from "../../../test/support/press.ts";
import {
  HEAD,
  history,
  PARENT,
} from "../../../test/support/revision-fixture.ts";
import type { RevisionTab } from "../../../lib/model/revisions/rows.ts";
import {
  commitRows,
  openProposals,
  proposalRows,
} from "../../../lib/model/revisions/rows.ts";
import type { RevisionSelection } from "../../../lib/model/revisions/api.ts";

const NOW = Date.parse("2026-10-24T13:00:00Z");

function list(
  tab: RevisionTab,
  shown?: RevisionSelection,
  onTab: (tab: RevisionTab) => void = () => {},
) {
  const snapshot = history();
  return (
    <RevisionList
      tab={tab}
      onTab={onTab}
      rows={tab === "commit" ? commitRows(snapshot) : proposalRows(snapshot)}
      open={openProposals(snapshot)}
      shown={shown}
      now={NOW}
    />
  );
}
const rows = (html: string) =>
  [...html.matchAll(/<a class="rev-row[^"]*"[\s\S]*?<\/a>/g)].map(([row]) =>
    row
  );

Deno.test("two tabs, Commits and Proposals, with the proposals waiting for a decision counted on their tab", () => {
  const { html, labels } = press(list("commit"));
  deepStrictEqual(labels, ["Commits", "Proposals 1"]);
  match(
    html,
    /<button\s+type="button"\s+aria-pressed="true"\s*>Commits<\/button>/,
  );
  match(
    html,
    /aria-pressed="false"\s*>Proposals <span class="count" title="1 waiting for a decision">1<\/span>/,
  );
  // Nothing waiting, nothing counted.
  const snapshot = history();
  const quiet = press(
    <RevisionList
      tab="proposal"
      onTab={() => {}}
      rows={proposalRows(snapshot)}
      open={0}
      shown={undefined}
      now={NOW}
    />,
  );
  deepStrictEqual(quiet.labels, ["Commits", "Proposals"]);
  doesNotMatch(quiet.html, /class="count"/);
});

Deno.test("a tab is pressed to be shown, and says which one it is", () => {
  const shown: RevisionTab[] = [];
  const page = press(list("commit", undefined, (tab) => shown.push(tab)));
  page.click("Proposals");
  page.click("Commits");
  deepStrictEqual(shown, ["proposal", "commit"]);
  match(press(list("proposal")).html, /aria-pressed="true"\s*>Proposals/);
});

Deno.test("commits are links to their own address, the shown one marked, with main and running on the commit they belong to", () => {
  const html = renderToString(
    list("commit", { kind: "commit", id: PARENT }),
  );
  const [head, parent, root] = rows(html);
  match(
    head,
    new RegExp(`href="/model\\?commit=${encodeURIComponent(HEAD)}"`),
  );
  // Every row says whether it is the one shown: Fresh would mark them itself.
  match(head, /aria-current="false"/);
  match(parent, /aria-current="true"/);
  match(root, /aria-current="false"/);
  match(head, /<span class="chip" title="The head of main">main<\/span>/);
  match(parent, /<span class="chip run"[^>]*>\s*running\s*<\/span>/);
  equal((html.match(/>main</g) || []).length, 1);
  equal((html.match(/>\s*running\s*</g) || []).length, 1);
  // Title, author and a date; the whole commit only in the row's tooltip.
  match(textOf(head), /^Accept a proposal You 4 hours ago main$/);
  match(head, new RegExp(`aria-current="false" title="${HEAD}"`));
  doesNotMatch(textOf(head), /ccccccc/);
  doesNotMatch(head, /<code/);
  match(textOf(root), /^Admit the initial model Assembly 2 days ago$/);
});

Deno.test("proposals wait first, then the accepted, then the declined, each saying where it stands", () => {
  const html = renderToString(
    list("proposal", { kind: "proposal", id: "p-open" }),
  );
  const [preparing, open, taken, declined] = rows(html);
  match(open, /href="\/model\?proposal=p-open"[^>]*aria-current="true"/);
  match(open, /rev-dot is-pending" role="img" aria-label="Pending"/);
  match(taken, /rev-dot is-accepted" role="img" aria-label="Accepted"/);
  match(declined, /^<a class="rev-row is-declined"/);
  match(declined, /rev-dot is-declined" role="img" aria-label="Declined"/);
  match(open, /class="rev-status is-pending">Proposed/);
  match(taken, /class="rev-status is-accepted">Accepted/);
  match(declined, /class="rev-status is-declined">Declined/);
  // A proposal in the making says so.
  match(textOf(preparing), /Draft the reviewer .* preparing$/);
  doesNotMatch(open, /preparing|accepting/);
  deepStrictEqual(
    rows(html).map((row) => row.match(/rev-title">([^<]*)</)![1]),
    [
      "Draft the reviewer",
      "Add a ranking step",
      "Add the reader",
      "Rename everything",
    ],
  );
  // main and running belong to commits.
  doesNotMatch(html, />main<|running/);
});

Deno.test("an empty list says so, and a title cannot inject markup", () => {
  const empty = renderToString(
    <RevisionList
      tab="proposal"
      onTab={() => {}}
      rows={[]}
      open={0}
      shown={undefined}
    />,
  );
  match(empty, /<p class="rev-empty">No proposals\.<\/p>/);
  doesNotMatch(empty, /<ol>/);
  const hostile = renderToString(
    <RevisionList
      tab="commit"
      onTab={() => {}}
      rows={[{
        kind: "commit",
        id: "commit:x",
        title: "<img src=x onerror=attack()>",
        short: "x",
        createdAt: "2026-10-24T09:00:00Z",
        main: false,
        running: false,
        runningFor: [],
      }]}
      open={0}
      shown={undefined}
      now={NOW}
    />,
  );
  match(hostile, /&lt;img src=x onerror=attack\(\)>/);
  doesNotMatch(hostile, /<img/);
});

Deno.test("a proposal row shows its supplied author and branch without treating them as markup", () => {
  const snapshot = history();
  const proposal = snapshot.revisions.proposals.find((entry) =>
    entry.id === "p-open"
  )!;
  proposal.branch = "branch/<unsafe>";
  const html = renderToString(
    <RevisionList
      tab="proposal"
      onTab={() => {}}
      rows={proposalRows(snapshot, [{
        nativeId: "designer",
        name: "Designer",
      }])}
      open={1}
      shown={undefined}
      now={NOW}
    />,
  );
  match(html, /Designer/);
  match(
    html,
    /<span class="rev-branch" title="branch\/&lt;unsafe>">branch\/&lt;unsafe><\/span>/,
  );
  doesNotMatch(html, /<unsafe>/);
});

Deno.test("what puts main in service sits under the row of main, outside its link, and on no other row", () => {
  const snapshot = history();
  const service = <p class="marker">Put it in service</p>;
  const html = renderToString(
    <RevisionList
      tab="commit"
      onTab={() => {}}
      rows={commitRows(snapshot)}
      open={0}
      service={service}
      shown={undefined}
      now={NOW}
    />,
  );
  const items = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(([item]) =>
    item
  );
  equal(items.length, 3);
  match(items[0], /<\/a><p class="marker">Put it in service<\/p><\/li>$/);
  doesNotMatch(items[1] + items[2], /marker/);
  // Never inside a link: a control in a link is not a control.
  doesNotMatch(rows(html).join(""), /marker/);
  // The proposals have no main to put in service.
  doesNotMatch(
    renderToString(
      <RevisionList
        tab="proposal"
        onTab={() => {}}
        rows={proposalRows(snapshot)}
        open={0}
        service={service}
        shown={undefined}
        now={NOW}
      />,
    ),
    /marker/,
  );
});

Deno.test("the operators still waiting for main are counted on the Commits tab, where the control is", () => {
  const waiting = (outOfService?: number) =>
    press(
      <RevisionList
        tab="proposal"
        onTab={() => {}}
        rows={[]}
        open={1}
        outOfService={outOfService}
        shown={undefined}
      />,
    );
  deepStrictEqual(waiting(2).labels, ["Commits 2", "Proposals 1"]);
  match(
    waiting(2).html,
    /<span class="count" title="Not in service yet for 2 operators">2<\/span>/,
  );
  match(waiting(1).html, /title="Not in service yet for 1 operator"/);
  // Nobody waiting, nothing counted: the Proposals tab is the only count.
  for (const none of [0, undefined]) {
    deepStrictEqual(waiting(none).labels, ["Commits", "Proposals 1"]);
  }
});

Deno.test("a running commit names the operators it is in service for", () => {
  const snapshot = history();
  const chip = (running: Parameters<typeof commitRows>[1]) =>
    rows(
      renderToString(
        <RevisionList
          tab="commit"
          onTab={() => {}}
          rows={commitRows(snapshot, running)}
          open={0}
          shown={undefined}
          now={NOW}
        />,
      ),
    ).map((row) => /class="chip run" title="([^"]*)"/.exec(row)?.[1]);
  deepStrictEqual(
    chip([
      { name: "Designer", version: PARENT },
      { name: "Archivist", version: PARENT },
      { name: "Reviewer", version: HEAD },
    ]),
    [
      "In service for Reviewer",
      "In service for Designer, Archivist",
      undefined,
    ],
  );
  // Without a read of the operators, the host's own runtime stands in.
  deepStrictEqual(chip(undefined), [
    undefined,
    "The version the operator runs",
    undefined,
  ]);
});
