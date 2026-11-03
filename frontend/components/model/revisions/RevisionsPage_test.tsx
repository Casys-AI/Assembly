import { textOf } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import type { ComponentChildren } from "preact";
import { RevisionsPage } from "./RevisionsPage.tsx";
import { runtimeRevisionOperators } from "../../../islands/Workbench.tsx";
import { createModelHistory } from "../../../lib/model/revisions/history.ts";
import {
  createRevisionApi,
  type RuntimeOperator,
  type SourceCommit,
} from "../../../lib/model/revisions/api.ts";
import { revisionView } from "../../../lib/model/revisions/rows.ts";
import { localSources } from "../../../lib/model/sources/command.ts";
import { press } from "../../../test/support/press.ts";
import {
  changed,
  DESIGNER,
  designer,
  DIGEST,
  HEAD,
  history as fixtureHistory,
  modelHost,
  OLD_DIGEST,
  operators,
  PARENT,
  REVIEWER,
  reviewer,
  ROOT,
  runtimes,
} from "../../../test/support/revision-fixture.ts";

const NOW = Date.parse("2026-10-24T13:00:00Z");
// The proposals are signed by the designer: the roster that names them.
const proposers = [designer];

/** The page over a host that serves the fixture, its history already read. */
async function open(
  search = "",
  options: Parameters<typeof modelHost>[0] & {
    read?: boolean;
    /** The operators that can have the model in service. */
    roster?: readonly RuntimeOperator[];
    authorityForCommit?(commit: SourceCommit): ComponentChildren;
  } = {},
) {
  const host = modelHost(options);
  const sources = localSources();
  const changed: number[] = [];
  const history = createModelHistory({
    api: createRevisionApi(host.request),
    sources,
    selection: () => undefined,
    onChanged: () => {
      changed.push(sources.generation.peek());
    },
    operators: () => options.roster ?? [],
  });
  if (options.read !== false) {
    await history.refresh();
    // The page asks for the changes of what it shows; here they are read first.
    const snapshot = history.snapshot.peek()!;
    for (const commit of snapshot.history.commits) {
      const view = revisionView(
        snapshot,
        { kind: "commit", id: commit.version },
        commit,
        proposers,
      );
      await history.readDiff(view.base, view.target!);
    }
    for (const proposal of snapshot.revisions.proposals) {
      const view = revisionView(
        snapshot,
        { kind: "proposal", id: proposal.id },
        proposal,
        proposers,
      );
      if (view.target) await history.readDiff(view.base, view.target);
    }
  }
  const render = (location = search, named = options.roster ?? proposers) =>
    press(
      <RevisionsPage
        location={{ search: location }}
        sources={sources}
        onChanged={() => {
          changed.push(sources.generation.peek());
        }}
        operators={named}
        history={history}
        now={NOW}
        authorityForCommit={options.authorityForCommit}
      />,
    );
  /** Waits until nothing is being read or decided. */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) {
      if (
        !history.reading.peek() && history.deciding.peek() === null &&
        history.adopting.peek() === null && !sources.inFlight.peek()
      ) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("still busy");
  };
  return { host, sources, history, changed, render, settle };
}
const detail = (html: string) =>
  html.slice(html.indexOf('<section class="rev-detail'));
const list = (html: string) =>
  html.slice(html.indexOf('<aside class="rev-list"'), html.indexOf("</aside>"));

Deno.test("before the first read the page says it is reading, and shows nothing else", async () => {
  const { render } = await open("", { read: false });
  const { html } = render();
  match(html, /<p class="rev-empty" role="status">Reading the history…<\/p>/);
  doesNotMatch(html, /rev-list|rev-detail|Accept/);
});

Deno.test("the bare address shows main's commits, the head selected, with its detail beside the list", async () => {
  const { render } = await open();
  const { html, labels } = render();
  match(html, /<div class="rev-page"><div class="rev">/);
  match(list(html), /aria-pressed="true"\s*>Commits/);
  match(
    list(html),
    new RegExp(
      `href="/model\\?commit=${encodeURIComponent(HEAD)}" aria-current="true"`,
    ),
  );
  match(detail(html), /<h3>Accept a proposal<\/h3>/);
  // A commit offers both diff modes and its separate tag action, not a decision.
  deepStrictEqual(labels.slice(-3), ["Unified", "Split", "Create tag"]);
  doesNotMatch(detail(html), /Accept<\/button>/);
  // No overview cards, no comparison form: the list and the detail only.
  doesNotMatch(
    html,
    /revision-overview|revision-comparison|Comparer|Voir ce modèle/,
  );
});

Deno.test("?commit= opens that commit under the Commits tab; the other commits stay in the list", async () => {
  const { render } = await open(`?commit=${encodeURIComponent(PARENT)}`);
  const { html } = render();
  match(list(html), /aria-pressed="true"\s*>Commits/);
  match(
    list(html),
    new RegExp(
      `href="/model\\?commit=${
        encodeURIComponent(PARENT)
      }" aria-current="true"`,
    ),
  );
  match(detail(html), /<h3>Add the reader<\/h3>/);
  match(
    detail(html),
    /class="chat-proposal model-change is-settled is-applied"/,
  );
  equal((list(html).match(/aria-current="true"/g) || []).length, 1);
});

Deno.test("authority facts are read only for the selected exact commit, never for proposals or absent commits", async () => {
  const seen: string[] = [];
  const { render } = await open("", {
    authorityForCommit(commit) {
      seen.push(commit.version);
      return <p data-authority={commit.version}>Recorded authority</p>;
    },
  });
  const selected = render(`?commit=${encodeURIComponent(PARENT)}`);
  deepStrictEqual(seen, [PARENT]);
  match(detail(selected.html), /Recorded authority/);
  doesNotMatch(list(selected.html), /Recorded authority/);
  deepStrictEqual(selected.labels.slice(-3), [
    "Unified",
    "Split",
    "Create tag",
  ]);

  const proposal = render("?proposal=p-open");
  doesNotMatch(proposal.html, /Recorded authority/);
  doesNotMatch(detail(proposal.html), />Create tag<\/button>/);
  const absent = render(
    `?commit=${encodeURIComponent(`commit:${"f".repeat(40)}`)}`,
  );
  doesNotMatch(absent.html, /Recorded authority/);
  deepStrictEqual(seen, [PARENT]);
});

Deno.test("?proposal= opens the Proposals tab on that proposal, the waiting ones first and counted on the tab", async () => {
  const { render } = await open("?proposal=p-open");
  const { html, labels } = render();
  match(
    list(html),
    /aria-pressed="true"\s*>Proposals <span class="count"[^>]*>1<\/span>/,
  );
  deepStrictEqual(
    [...list(html).matchAll(/rev-title">([^<]*)</g)].map(([, title]) => title),
    [
      "Draft the reviewer",
      "Add a ranking step",
      "Add the reader",
      "Rename everything",
    ],
  );
  match(list(html), /href="\/model\?proposal=p-open" aria-current="true"/);
  match(detail(html), /<h3>Add a ranking step<\/h3>/);
  match(textOf(detail(html)), /proposed by Designer/);
  deepStrictEqual(labels.slice(-4), ["Accept", "Decline", "Unified", "Split"]);
});

Deno.test("an accepted or declined proposal is shown as decided, with nothing left to decide", async () => {
  const { render } = await open("?proposal=p-taken");
  const taken = render().html;
  match(
    detail(taken),
    /<span class="change-chip is-accepted">Accepted<\/span>/,
  );
  match(detail(taken), /merged as bbbbbbb/);
  const declined = (await open("?proposal=p-declined")).render().html;
  match(
    detail(declined),
    /<span class="change-chip is-declined">Declined<\/span>/,
  );
  for (const html of [taken, declined]) doesNotMatch(detail(html), />Accept</);
});

Deno.test("an address that names a revision the history lacks says so, rather than showing another", async () => {
  const { render } = await open("?commit=commit%3Agone");
  const { html } = render();
  match(
    html,
    /<p class="rev-empty" data-code="revision-absent">This revision is not in the loaded history\.<\/p>/,
  );
  doesNotMatch(html, /<section class="rev-detail|aria-current="true"/);
  const proposal = (await open("?proposal=gone")).render().html;
  match(proposal, /This revision is not in the loaded history\./);
  match(list(proposal), /aria-pressed="true"\s*>Proposals/);
});

Deno.test("proposers are named by the roster; one it lacks is left unnamed", async () => {
  const { render } = await open("?proposal=p-open");
  doesNotMatch(
    textOf(detail(render("?proposal=p-open", []).html)),
    /proposed by/,
  );
});

Deno.test("Accept sends one decision for the head and sources shown, tells the other views and reads the history again", async () => {
  const { render, host, settle, changed, history, sources } = await open(
    "?proposal=p-open",
  );
  const page = render();
  page.click("Accept");
  // Pressed again while it is in flight: nothing more is sent.
  page.click("Accept");
  page.click("Decline");
  await settle();
  deepStrictEqual(host.writes(), [{
    path: "/api/model-revisions/p-open/decision",
    method: "POST",
    body: {
      verdict: "approve",
      expectedVersion: HEAD,
      sourceDigest: "p-open-digest",
    },
  }]);
  deepStrictEqual(changed, [1]);
  equal(sources.generation.peek(), 1);
  equal(history.refusal.peek(), null);
  // The history was read again; it can be decided on once more.
  equal(history.canAct.peek(), true);
});

Deno.test("Decline sends the refusal of the proposal shown", async () => {
  const { render, host, settle } = await open("?proposal=p-open");
  render().click("Decline");
  await settle();
  equal(host.writes().length, 1);
  deepStrictEqual(
    (host.writes()[0].body as { verdict: string }).verdict,
    "refuse",
  );
});

Deno.test("nothing is sent while a decision is in flight in another panel", async () => {
  const { render, host, sources } = await open("?proposal=p-open");
  let finish!: () => void;
  const elsewhere = sources.track(() =>
    new Promise<void>((done) => finish = done)
  );
  const page = render();
  // The buttons are disabled; pressed anyway, the page sends nothing.
  match(page.html, /class="proposal-accept"\s+disabled/);
  page.click("Accept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(host.writes().length, 0);
  finish();
  await elsewhere;
});

Deno.test("a decision the host refuses is told on the proposal, after the history is read again", async () => {
  const { render, host, settle, history } = await open("?proposal=p-open", {
    decision: () =>
      Response.json({ error: "Le modèle courant a changé." }, { status: 409 }),
  });
  const reads = () =>
    host.requests.filter((entry) => entry.path === "/api/model-revisions")
      .length;
  const before = reads();
  render().click("Accept");
  await settle();
  ok(reads() > before, "the history is read again");
  const { html } = render();
  match(detail(html), /data-code="decision-conflict"/);
  match(
    textOf(detail(html)),
    /The decision was refused\..*Le modèle courant a changé\./,
  );
  // Nothing was confirmed, so no other view was told and nothing is in flight.
  equal(history.deciding.peek(), null);
  // The message belongs to the proposal that was refused.
  doesNotMatch(
    detail(render("?commit=" + encodeURIComponent(HEAD)).html),
    /data-code=/,
  );
});

Deno.test("a history that cannot be read says so and can be asked for again", async () => {
  const host = modelHost();
  let down = true;
  const sources = localSources();
  const history = createModelHistory({
    api: createRevisionApi(
      ((path: string, init?: RequestInit) =>
        down
          ? Promise.resolve(
            Response.json({ error: "Hors ligne." }, { status: 503 }),
          )
          : host.request(path, init)) as typeof fetch,
    ),
    sources,
    selection: () => undefined,
    onChanged: () => {},
  });
  await history.refresh();
  const render = () =>
    press(
      <RevisionsPage
        location={{ search: "" }}
        sources={sources}
        onChanged={() => {}}
        history={history}
        now={NOW}
      />,
    );
  const failed = render();
  match(
    failed.html,
    /role="alert" data-code="read-failed">The history could not be read\./,
  );
  // One message: no "reading" line under it.
  doesNotMatch(failed.html, /Reading the history/);
  down = false;
  failed.click("Try again");
  for (let turn = 0; turn < 50 && !history.snapshot.peek(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  equal(history.snapshot.peek()?.revisions.version, HEAD);
  doesNotMatch(render().html, /read-failed/);
});

// Putting the accepted model in service, from the row of main.
/** The designer runs PARENT while main is HEAD; the reviewer already runs HEAD. */
const behind = (extra: Parameters<typeof open>[1] = {}) => ({
  runtimes: runtimes(),
  primary: DESIGNER,
  roster: operators,
  ...extra,
});
const mainRow = (html: string) =>
  list(html).match(/<li\b[^>]*>[\s\S]*?<\/li>/)![0];
const chips = (html: string) =>
  [...list(html).matchAll(/class="chip run" title="([^"]*)"/g)].map((
    [, title],
  ) => title);
const upToDate = (held: ReturnType<typeof runtimes>, id: string) =>
  held[id].active = held[id].available;

Deno.test("main's row carries the control when an operator runs something else, and only that row", async () => {
  const { render } = await open("", behind());
  const { html, labels } = render();
  const row = mainRow(html);
  match(row, /^<li[^>]*><a class="rev-row"[^>]*aria-current="true"/);
  // Under the link, not in it; the operator is named, one button acts.
  match(
    row,
    /<\/a><div class="adopt" role="group" aria-label="Put in service">/,
  );
  match(row, /<span class="adopt-who">Designer<\/span>/);
  deepStrictEqual(labels.filter((label) => label === "Put in service"), [
    "Put in service",
  ]);
  // The reviewer already runs main: it is not offered it.
  doesNotMatch(html, /Reviewer<\/span>|<select/);
  // The Commits tab says one operator waits, where the control is.
  match(list(html), /Commits <span class="count" title="Not in service yet/);
  // Other commits' rows carry no control, nor does the Proposals tab.
  doesNotMatch(list(html).slice(list(html).indexOf("</li>")), /adopt/);
  doesNotMatch(detail(html), /adopt/);
  const proposals = render("?proposal=p-open").html;
  doesNotMatch(list(proposals), /Put in service<\/button>/);
  match(list(proposals), /Commits <span class="count"/);
});

Deno.test("no control, and nothing counted, when every operator already runs main", async () => {
  const options = behind();
  upToDate(options.runtimes, DESIGNER);
  const { html } = (await open("", options)).render();
  doesNotMatch(html, /Put in service|class="adopt/);
  doesNotMatch(list(html), /Not in service yet/);
  // And none when there is no operator to put it in service for.
  doesNotMatch((await open("")).render().html, /Put in service/);
});

Deno.test("each commit says which operators run it", async () => {
  const { render } = await open("", behind());
  deepStrictEqual(chips(render().html), [
    "In service for Reviewer",
    "In service for Designer",
  ]);
});

Deno.test("Put in service sends the operator, with the version and contract its runtime was read to hold, and tells the other views", async () => {
  // The designer is up to date; the reviewer is the only one that waits.
  const options = behind();
  upToDate(options.runtimes, DESIGNER);
  options.runtimes[REVIEWER].active = {
    digest: OLD_DIGEST,
    repositoryVersion: PARENT,
  };
  const { render, host, settle, changed, sources } = await open("", options);
  const page = render();
  match(mainRow(page.html), /<span class="adopt-who">Reviewer<\/span>/);
  page.click("Put in service");
  await settle();
  deepStrictEqual(host.writes(), [{
    path: "/api/model-version/adopt",
    method: "POST",
    body: {
      expectedDigest: DIGEST,
      expectedVersion: HEAD,
      agentId: REVIEWER,
    },
  }]);
  deepStrictEqual(changed, [1]);
  equal(sources.generation.peek(), 1);
});

Deno.test("pressed twice at once, Put in service is sent once", async () => {
  const { render, host, settle } = await open("", behind());
  const page = render();
  page.click("Put in service");
  page.click("Put in service");
  page.click("Put in service");
  await settle();
  equal(host.writes().length, 1);
});

Deno.test("while another change is in flight the button is shut, and pressing it sends nothing", async () => {
  const { render, host, sources } = await open("", behind());
  let finish!: () => void;
  const elsewhere = sources.track(() =>
    new Promise<void>((done) => finish = done)
  );
  const page = render();
  match(mainRow(page.html), /class="proposal-accept"\s+disabled/);
  page.click("Put in service");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(host.writes().length, 0);
  finish();
  await elsewhere;
});

Deno.test("while an operator is running the button is shut and says why, and pressing it sends nothing", async () => {
  const roster = [{ ...designer }, { ...reviewer, busy: true }];
  const { render, host, history } = await open("", behind({ roster }));
  const page = render();
  const row = mainRow(page.html);
  // The host refuses while an operator runs: the button does not invite it.
  match(row, /class="proposal-accept"\s+disabled/);
  match(row, /title="An operator is running"/);
  page.click("Put in service");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(host.writes().length, 0);
  equal(history.adoptionRefusal.peek(), null);
  // The operator finished: the same button acts.
  roster[1].busy = false;
  const idle = render();
  doesNotMatch(mainRow(idle.html), /class="proposal-accept"\s+disabled/);
  doesNotMatch(mainRow(idle.html), /An operator is running/);
});

Deno.test("a refusal does not stay under main's row once the history shows nothing left to put in service", async () => {
  const f = await open(
    "",
    behind({
      adoption: () => {
        // Another session puts the designer in service first.
        f.host.runtimes[DESIGNER].active = f.host.runtimes[DESIGNER].available;
        return Response.json({ error: "Already done." }, { status: 409 });
      },
    }),
  );
  f.render().click("Put in service");
  await f.settle();
  const { html } = f.render();
  doesNotMatch(
    html,
    /Put in service|data-code="adoption-conflict"|class="adopt/,
  );
  deepStrictEqual(chips(html), ["In service for Designer, Reviewer"]);
});

Deno.test("after the history is read again, the running chip is on the version that now runs, and the control is gone", async () => {
  const { render, settle, host } = await open("", behind());
  deepStrictEqual(chips(render().html), [
    "In service for Reviewer",
    "In service for Designer",
  ]);
  render().click("Put in service");
  await settle();
  const { html } = render();
  // The designer moved to main with the reviewer; the old commit runs for none.
  deepStrictEqual(chips(html), ["In service for Designer, Reviewer"]);
  equal(host.runtimes[DESIGNER].active?.repositoryVersion, HEAD);
  doesNotMatch(html, /Put in service|class="adopt|Not in service yet/);
});

Deno.test("an adoption the host refuses is told under the control with its code, after the history is read again", async () => {
  const { render, host, settle, history } = await open(
    "",
    behind({
      adoption: () =>
        Response.json({ error: "Le contrat a changé." }, { status: 409 }),
    }),
  );
  const reads = () =>
    host.requests.filter((entry) => entry.path === "/api/model-revisions")
      .length;
  const before = reads();
  render().click("Put in service");
  await settle();
  ok(reads() > before, "the history is read again");
  const { html } = render();
  const row = mainRow(html);
  match(row, /role="alert" data-code="adoption-conflict"/);
  match(
    textOf(row),
    /Designer ?: Putting the model in service was refused\..*Le contrat a changé\./,
  );
  // The operator still waits: the button is there to try again after reading.
  match(row, /Put in service<\/button>/);
  equal(history.adopting.peek(), null);
  // Trying again starts clean.
  render().click("Put in service");
  equal(history.adoptionRefusal.peek(), null);
  await settle();
});

Deno.test("an operator whose runtime cannot be read is named with the code; the history and the other operators stand", async () => {
  const options = behind();
  delete options.runtimes[REVIEWER];
  const { html } = (await open("", options)).render();
  const row = mainRow(html);
  match(row, /data-code="runtime-failed"/);
  match(textOf(row), /Reviewer ?: What is in service could not be read\./);
  // The designer can still be given the model.
  match(row, /<span class="adopt-who">Designer<\/span>/);
  match(detail(html), /<h3>Accept a proposal<\/h3>/);
});

Deno.test("read-only operators are not asked what they run, and cannot be given the model", async () => {
  const peer = {
    agentId: "peer",
    nativeId: REVIEWER,
    name: "Reviewer",
    primary: false,
    runtimeOwned: true,
  };
  const audit = {
    ...peer,
    agentId: "audit",
    nativeId: "native:audit",
    name: "Audit",
    runtimeOwned: false,
  };
  const primary = {
    ...peer,
    agentId: "designer",
    nativeId: DESIGNER,
    name: "Designer",
    primary: true,
  };
  // What the workbench hands the page: the roster without the read-only ones.
  const roster = runtimeRevisionOperators([primary, peer, audit] as never);
  const options = behind({ roster });
  options.runtimes["native:audit"] = {
    ...options.runtimes[DESIGNER],
  };
  const { render, host } = await open("", options);
  const { html } = render();
  doesNotMatch(html, /Audit|native:audit/);
  equal(host.requests.some((entry) => entry.path.includes("audit")), false);
  match(mainRow(html), /<span class="adopt-who">Designer<\/span>/);
});

Deno.test("only the parentless commit matches the compact mock inventory with fourteen immutable Files links", async () => {
  const data = fixtureHistory();
  const initial = data.history.commits.find((commit) =>
    commit.version === ROOT
  )!;
  initial.additions = 1141;
  initial.deletions = 0;
  initial.message = "Imported baseline"; // Parentage decides, never the title.
  initial.files = Array.from(
    { length: 14 },
    (_, i) => changed(`sources/model-${i + 1}.sysml`, "added", 10, 0),
  );
  const { html } = (await open(`?commit=${encodeURIComponent(ROOT)}`, { data }))
    .render();
  const shown = detail(html);
  const files = shown.slice(
    shown.indexOf('<ul class="rev-initial-files"'),
    shown.indexOf("</ul>") + 5,
  );
  equal((files.match(/<a href=/g) ?? []).length, 14);
  equal((files.match(/class="plus">\+10<\/span>/g) ?? []).length, 14);
  equal((files.match(/class="minus">−0<\/span>/g) ?? []).length, 14);
  for (const file of initial.files) {
    ok(
      files.includes(
        `href="/model?page=files&amp;version=${
          encodeURIComponent(ROOT)
        }&amp;file=${encodeURIComponent(file.path)}"`,
      ),
      `missing pinned link for ${file.path}`,
    );
  }
  match(shown, /<h2>Imported baseline<\/h2>/);
  match(textOf(shown), /\+1141 −0 14 files/);
  match(shown, /class="rev-initial-status is-added">added/);
  match(shown, /<code>sources\/model-1\.sysml<\/code>/);
  match(shown, /aria-pressed="true"[^>]*>Unified/);
  match(shown, />Split<\/button>/);
  doesNotMatch(
    shown,
    /View diff|<details|d2h-|proposal-code-diff|Reading the changes/,
  );
});

Deno.test("an ordinary commit with an initial-looking title keeps the expanded diff and no added file list", async () => {
  const data = fixtureHistory();
  data.history.commits[0].message = "Admit initial validated model";
  const { html } = (await open(`?commit=${encodeURIComponent(HEAD)}`, { data }))
    .render();
  const shown = detail(html);
  doesNotMatch(shown, /class="change-diff"|aria-label="Changed files"/);
  match(shown, /proposal-code-diff/);
});
