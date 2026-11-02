import { textOf } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import type { ComponentChildren } from "preact";
import { RevisionDetail } from "./RevisionDetail.tsx";
import { press } from "../../../test/support/press.ts";
import {
  DESIGNER,
  diffBetween,
  HEAD,
  history,
  PARENT,
  PROPOSED,
} from "../../../test/support/revision-fixture.ts";
import type {
  DiffState,
  HistoryProblem,
} from "../../../lib/model/revisions/history.ts";
import type {
  DiffMode,
  SourceCommit,
} from "../../../lib/model/revisions/api.ts";
import {
  type RevisionView,
  revisionView,
} from "../../../lib/model/revisions/rows.ts";

const NOW = Date.parse("2026-10-24T13:00:00Z");
const operators = [{ nativeId: DESIGNER, name: "Designer" }];

const proposalView = (id: string): RevisionView => {
  const snapshot = history();
  const item = snapshot.revisions.proposals.find((entry) => entry.id === id)!;
  return revisionView(snapshot, { kind: "proposal", id }, item, operators);
};
const commitView = (version: string): RevisionView => {
  const snapshot = history();
  const item = snapshot.history.commits.find((entry) =>
    entry.version === version
  )!;
  return revisionView(
    snapshot,
    { kind: "commit", id: version },
    item,
    operators,
  );
};
const ready = (view: RevisionView): DiffState => ({
  status: "ready",
  diff: diffBetween(view.base, view.target!),
});

interface Spy {
  decisions: ("approve" | "refuse")[];
  modes: DiffMode[];
  retries: number;
}
function detail(
  view: RevisionView,
  options: {
    diff?: DiffState;
    available?: boolean;
    deciding?: boolean;
    refusal?: HistoryProblem;
    mode?: DiffMode;
    sourceCommit?: SourceCommit;
    authority?: ComponentChildren;
  } = {},
) {
  const spy: Spy = { decisions: [], modes: [], retries: 0 };
  const page = press(
    <RevisionDetail
      view={view}
      sourceCommit={options.sourceCommit}
      authority={options.authority}
      diff={"diff" in options ? options.diff : ready(view)}
      mode={options.mode ?? "line-by-line"}
      onModeChange={(mode) => spy.modes.push(mode)}
      available={options.available ?? true}
      deciding={options.deciding ?? false}
      refusal={options.refusal}
      onDecide={(verdict) => spy.decisions.push(verdict)}
      onRetryDiff={() => spy.retries++}
      now={NOW}
    />,
  );
  return { ...page, spy };
}

Deno.test("recorded authority is a read-only commit fact and never appears on a proposal", () => {
  const authority = <p data-authority="recorded">Recorded authority</p>;
  const commit = detail(commitView(PARENT), { authority });
  match(commit.html, /Recorded authority/);
  deepStrictEqual(commit.labels, ["Unified", "Split"]);

  const proposal = detail(proposalView("p-open"), { authority });
  doesNotMatch(proposal.html, /Recorded authority/);
  deepStrictEqual(proposal.labels, ["Accept", "Decline", "Unified", "Split"]);
});

Deno.test("a proposal waiting shows who proposed it, the base it stands on, its size and the exact diff, with Accept and Decline on it", () => {
  const { html, labels } = detail(proposalView("p-open"));
  match(html, /<h3>Add a ranking step<\/h3>/);
  match(textOf(html), /proposed by Designer/);
  match(html, new RegExp(`<code title="Base commit ${HEAD}">ccccccc</code>`));
  match(textOf(html), /\+2 −0 · 1 file/);
  // The patch is Diff2Html output, escaped.
  match(html, /d2h-file-name">configuration\.sysml/);
  match(html, /&lt;img src=x onerror=attack\(\)&gt;/);
  doesNotMatch(html, /<img src=x/);
  deepStrictEqual(labels, ["Accept", "Decline", "Unified", "Split"]);
  match(html, /class="chat-proposal model-change is-pending"/);
  match(html, /aria-label="Proposal reason"/);
  match(html, /<h4>Reason<\/h4><p>Add a ranking step<\/p>/);
  match(html, /class="rev-status is-pending">Proposed/);
  // The title is first, where every title is.
  match(html, /<header class="proposal-heading change-heading"><div><h3>/);
});

Deno.test("Accept and Decline hand the verdict to the page, once each press", () => {
  const page = detail(proposalView("p-open"));
  page.click("Accept");
  page.click("Decline");
  deepStrictEqual(page.spy.decisions, ["approve", "refuse"]);
});

Deno.test("nothing is decided on changes that are not shown, or while a read or another decision is unsettled", () => {
  const view = proposalView("p-open");
  const disabled = (html: string) =>
    [...html.matchAll(/<button\b[^>]*>(Accept|Decline|Working…)<\/button>/g)]
      .map(([tag]) => /\bdisabled\b/.test(tag));
  deepStrictEqual(disabled(detail(view).html), [false, false]);
  // The host's read is not settled, or a decision is in flight somewhere.
  deepStrictEqual(disabled(detail(view, { available: false }).html), [
    true,
    true,
  ]);
  // The changes are still being read, or could not be.
  for (const diff of [undefined, { status: "loading" }] as DiffState[]) {
    deepStrictEqual(disabled(detail(view, { diff }).html), [true, true]);
  }
  const failed: DiffState = {
    status: "failed",
    problem: { code: "diff-failed", message: "The changes could not be read." },
  };
  deepStrictEqual(disabled(detail(view, { diff: failed }).html), [true, true]);
  // This proposal's own decision is in flight.
  const working = detail(view, { available: false, deciding: true }).html;
  match(working, /Working…/);
});

Deno.test("while the changes are read the page says so and shows no totals rather than zeros", () => {
  const view = proposalView("p-open");
  const reading = detail(view, { diff: { status: "loading" } });
  match(reading.html, /class="rev-detail is-unread"/);
  match(
    reading.html,
    /<p class="rev-reading" role="status">Reading the changes…<\/p>/,
  );
  // No diff yet, so no layout to choose.
  deepStrictEqual(reading.labels, ["Accept", "Decline"]);
  const shown = detail(view);
  match(shown.html, /class="rev-detail"/);
  doesNotMatch(shown.html, /Reading the changes/);
});

Deno.test("changes that cannot be read say why and can be asked for again", () => {
  const failed = detail(proposalView("p-open"), {
    diff: {
      status: "failed",
      problem: {
        code: "diff-failed",
        status: 500,
        message: "The changes could not be read.",
        detail: "Boom.",
      },
    },
  });
  match(
    failed.html,
    /role="alert" data-code="diff-failed">The changes could not be read\./,
  );
  match(failed.html, /<span class="rev-host-says">Boom\.<\/span>/);
  failed.click("Try again");
  equal(failed.spy.retries, 1);
});

Deno.test("a refused decision is told under the proposal, with what the host said", () => {
  const refused = detail(proposalView("p-open"), {
    refusal: {
      code: "decision-conflict",
      status: 409,
      message: "The decision was refused. The history was read again.",
      detail: "Le modèle courant a changé.",
    },
  });
  match(refused.html, /data-code="decision-conflict"/);
  match(
    textOf(refused.html),
    /The decision was refused\. The history was read again\. Le modèle courant a changé\./,
  );
});

Deno.test("Unified and Split are chosen by the page, which keeps the choice from one revision to the next", () => {
  const view = proposalView("p-open");
  const unified = detail(view, { mode: "line-by-line" });
  match(unified.html, /aria-pressed="true"\s*>Unified/);
  match(unified.html, /class="d2h-wrapper"|d2h-file-diff/);
  unified.click("Split");
  deepStrictEqual(unified.spy.modes, ["side-by-side"]);
  const split = detail(view, { mode: "side-by-side" });
  match(split.html, /aria-pressed="true"\s*>Split/);
  match(split.html, /proposal-code-diff is-split/);
});

Deno.test("a commit is applied: its author and date, the commit itself, its size, and nothing to decide", () => {
  const { html, labels } = detail(commitView(HEAD));
  match(html, /<h3>Accept a proposal<\/h3>/);
  match(html, /class="chat-proposal model-change is-settled is-applied"/);
  // Its author and its date lead; "proposed by" is for proposals.
  match(
    html,
    /<p class="change-byline"><span>You<\/span><time datetime="2026-10-24T09:00:00Z" title="[^"]+">4 hours ago<\/time><\/p>/,
  );
  doesNotMatch(html, /proposed by/);
  match(html, new RegExp(`<code title="Commit ${HEAD}">ccccccc</code>`));
  match(textOf(html), /\+2 −0 · 1 file/);
  deepStrictEqual(labels, ["Unified", "Split"]);
  doesNotMatch(html, /change-chip/);
});

Deno.test("an accepted proposal says it is accepted and which commit it became", () => {
  const { html, labels } = detail(proposalView("p-taken"));
  match(html, /<span class="change-chip is-accepted">Accepted<\/span>/);
  match(
    html,
    new RegExp(
      `<a href="/model\\?commit=${
        encodeURIComponent(PARENT)
      }" aria-current="false">merged as bbbbbbb</a>`,
    ),
  );
  deepStrictEqual(labels, ["Unified", "Split"]);
});

Deno.test("a declined proposal says so, with the reason it was given, and cannot be decided again", () => {
  const { html, labels } = detail(proposalView("p-declined"));
  match(html, /<span class="change-chip is-declined">Declined<\/span>/);
  match(
    html,
    /<p class="proposal-notice" role="status">Reason: Too broad<\/p>/,
  );
  doesNotMatch(html, /Accept|Decline<\/button>/);
  deepStrictEqual(labels, ["Unified", "Split"]);
});

Deno.test("a proposal in the making has no changes to show and cannot be decided yet", () => {
  const view = proposalView("p-prepare");
  equal(view.target, undefined);
  const { html, labels } = detail(view, { diff: undefined });
  match(html, /The operator is still preparing this proposal\./);
  // Its controls are not on offer at all: nothing visible that does nothing.
  deepStrictEqual(labels, []);
  doesNotMatch(html, /Accept/);
  doesNotMatch(html, new RegExp(PROPOSED));
});

Deno.test("a revision that changes no source says so, and the title, author and reason cannot inject markup", () => {
  const view = commitView(HEAD);
  const none: DiffState = {
    status: "ready",
    diff: {
      ...diffBetween(view.base, HEAD),
      patch: "",
      files: [],
      additions: 0,
      deletions: 0,
    },
  };
  const empty = detail(view, { diff: none });
  match(empty.html, /<p class="rev-reading">No source changes\.<\/p>/);
  deepStrictEqual(empty.labels, []);
  const hostile = detail({
    ...proposalView("p-open"),
    title: "<script>x()</script>",
    author: "<b>Eve</b>",
    notice: "<i>careful</i>",
  });
  match(hostile.html, /&lt;script>x\(\)&lt;\/script>/);
  match(hostile.html, /proposed by &lt;b>Eve&lt;\/b>/);
  match(hostile.html, /&lt;i>careful&lt;\/i>/);
  doesNotMatch(hostile.html, /<script|<b>|<i>/);
});

Deno.test("proposal details keep their diff expanded even if initial commit metadata is supplied", () => {
  const sourceCommit = history().history.commits.find((commit) =>
    commit.parents.length === 0
  )!;
  const shown = detail(proposalView("p-open"), { sourceCommit });
  doesNotMatch(shown.html, /class="change-diff"|aria-label="Changed files"/);
  match(shown.html, /proposal-code-diff/);
  deepStrictEqual(shown.labels, ["Accept", "Decline", "Unified", "Split"]);
});

Deno.test("initial admission uses Git counts and the page's layout preference without a patch or fold", () => {
  const sourceCommit = history().history.commits.find((commit) =>
    commit.parents.length === 0
  )!;
  const shown = detail(commitView(sourceCommit.version), {
    sourceCommit,
    diff: undefined,
    mode: "side-by-side",
  });
  match(shown.html, /class="rev-detail rev-initial"/);
  match(shown.html, /<h2>Admit the initial model<\/h2>/);
  match(textOf(shown.html), /\+14 −0 2 files/);
  match(shown.html, /aria-pressed="true"[^>]*>Split/);
  doesNotMatch(
    shown.html,
    /View diff|<details|d2h-|proposal-code-diff|is-unread|Reading the changes/,
  );
  shown.click("Unified");
  deepStrictEqual(shown.spy.modes, ["line-by-line"]);
});
