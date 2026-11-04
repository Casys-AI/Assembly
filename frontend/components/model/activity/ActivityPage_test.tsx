import { settle } from "../../../test/support/settle.ts";
import { textOf } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../../src/application/work/operators/conversation-types.ts";
import { createWorkbenchState } from "../../../lib/workbench/state.ts";
import { toolProposalHref } from "../../../lib/model/tool-proposal-location.ts";
import { snapshot as runtimeSnapshot } from "../../../test/support/workbench-fixture.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import type { ActivityPageProps } from "./useActivityPage.ts";
import { ActivityPage } from "./ActivityPage.tsx";
import { RevisionsPage } from "../revisions/RevisionsPage.tsx";
import { createModelHistory } from "../../../lib/model/revisions/history.ts";
import {
  createRevisionApi,
  type SourceCommit,
} from "../../../lib/model/revisions/api.ts";
import { localSources } from "../../../lib/model/sources/command.ts";
import { press } from "../../../test/support/press.ts";
import {
  DESIGNER,
  designer,
  HEAD,
  history,
  modelHost,
  PARENT,
  PROPOSED,
  ROOT,
} from "../../../test/support/revision-fixture.ts";

const NOW = Date.parse("2026-10-24T13:00:00Z");
const roster = [designer];

/**
 * The page over a host that serves the fixture, its history already read. The
 * page asks for the change of the line it opens; here the changes are read
 * first, unless `changes` says none is.
 */
async function open(
  options: Parameters<typeof modelHost>[0] & {
    read?: boolean;
    changes?: boolean;
    authorityForCommit?(commit: SourceCommit): ComponentChildren;
  } = {},
) {
  const host = modelHost(options);
  const sources = localSources();
  const changed: number[] = [];
  const onChanged = () => {
    changed.push(sources.generation.peek());
  };
  const store = createModelHistory({
    api: createRevisionApi(host.request),
    sources,
    selection: () => undefined,
    onChanged,
  });
  if (options.read !== false) {
    await store.refresh();
    const snapshot = store.snapshot.peek()!;
    if (options.changes !== false) {
      for (const commit of snapshot.history.commits) {
        if (commit.parentVersion) {
          await store.readDiff(commit.parentVersion, commit.version);
        }
      }
      for (const proposal of snapshot.revisions.proposals) {
        if (proposal.proposalVersion) {
          await store.readDiff(proposal.baseVersion, proposal.proposalVersion);
        }
      }
    }
  }
  const render = (opened?: string, names = roster) =>
    press(
      <ActivityPage
        sources={sources}
        onChanged={onChanged}
        operators={names}
        history={store}
        open={opened}
        now={NOW}
        authorityForCommit={options.authorityForCommit}
      />,
    );
  /** Waits until nothing is being read or decided. */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) {
      if (
        !store.reading.peek() && store.deciding.peek() === null &&
        !sources.inFlight.peek()
      ) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("still busy");
  };
  return { host, sources, store, changed, render, settle };
}

/** The markup of each line of the feed, with the change open under it. */
const lines = (html: string) => html.split('<li class="act-item"').slice(1);
const lineOf = (html: string, title: string) => {
  const found = lines(html).find((line) =>
    line.includes(`rev-title">${title}<`)
  );
  ok(found, `no line titled "${title}"`);
  return found;
};
/** The buttons of the change under an open line, not the lines themselves. */
const controls = (labels: string[]) =>
  labels.filter((label) =>
    ["Accept", "Decline", "Unified", "Split"].includes(label)
  );
const titles = (html: string) =>
  [...html.matchAll(/rev-title">([^<]*)</g)].map(([, title]) => title);

Deno.test("before the first read the page says it is reading, and shows nothing else", async () => {
  const { render } = await open({ read: false });
  const { html } = render();
  match(html, /<p class="rev-empty" role="status">Reading the history…<\/p>/);
  doesNotMatch(html, /act-group|act-item|Accept/);
});

Deno.test("the feed puts what waits for you first, then what main accepted, then what was declined: one line each, none open", async () => {
  const { html } = (await open()).render();
  deepStrictEqual(
    [...html.matchAll(/<h2 class="act-group-label">([^<]*)</g)].map((
      [, label],
    ) => label),
    ["Waiting for you", "Accepted", "Declined"],
  );
  deepStrictEqual(titles(html), [
    "Draft the reviewer",
    "Add a ranking step",
    "Accept a proposal",
    "Add the reader",
    "Admit the initial model",
    "Rename everything",
  ]);
  equal(lines(html).length, 6);
  // A line is a control that says whether it is open; nothing is open yet.
  equal((html.match(/aria-expanded="false"/g) || []).length, 6);
  doesNotMatch(html, /aria-expanded="true"|act-detail|proposal-code-diff/);
  // The title of the page is the frame's; the feed adds no paragraph of its own.
  doesNotMatch(html, /<h1|<p /);
});

Deno.test("a line has its marker, message, who and when, the commit and the size of the change", async () => {
  const { html } = (await open()).render();
  const reader = lineOf(html, "Add the reader");
  match(reader, /data-state="accepted"/);
  match(
    reader,
    /<span class="rev-dot is-accepted" role="img" aria-label="Accepted" title="Accepted">/,
  );
  match(
    reader,
    /<span class="act-by">proposed by Designer, accepted by You<\/span>/,
  );
  match(reader, /<time datetime="2026-10-23T10:30:00Z">yesterday<\/time>/);
  match(reader, new RegExp(`<code title="${PARENT}">bbbbbbb</code>`));
  match(textOf(reader), /\+11 −1 · 2 files/);
  // The head of main says so, and a commit nobody proposed is the host's.
  const head = lineOf(html, "Accept a proposal");
  match(head, /data-state="applied"/);
  match(head, /<span class="chip" title="The head of main">main<\/span>/);
  match(head, /admitted by You/);
  match(textOf(head), /\+2 −0 · 1 file/);
  doesNotMatch(reader, /class="chip"/);
  // A proposal that waits has no commit, and nothing is known of its size yet.
  const waiting = lineOf(
    (await open({ changes: false })).render().html,
    "Add a ranking step",
  );
  match(waiting, /data-state="pending"/);
  match(waiting, /role="img" aria-label="Pending"/);
  match(waiting, /proposed by Designer/);
  doesNotMatch(waiting, /<code|change-stats/);
});

Deno.test("a proposal still being prepared, and one being accepted, say what they wait for", async () => {
  const data = history();
  data.revisions.proposals.push({
    ...data.revisions.proposals[2],
    id: "p-accepting",
    reason: "Being merged",
    status: "accepting",
  });
  const { html } = (await open({ data })).render();
  match(
    lineOf(html, "Draft the reviewer"),
    /<span class="chip" title="The operator is still preparing it">preparing<\/span>/,
  );
  match(
    lineOf(html, "Being merged"),
    /<span class="chip">accepting<\/span>/,
  );
  doesNotMatch(lineOf(html, "Add a ranking step"), /class="chip"/);
});

Deno.test("a declined proposal is struck through and in its own group", async () => {
  const { html } = (await open()).render();
  const declined = lineOf(html, "Rename everything");
  match(declined, /class="rev-row act-row is-declined"/);
  match(declined, /data-state="declined"/);
  match(html.slice(html.indexOf("Declined</h2>")), /Rename everything/);
});

Deno.test("authors are named by the roster; an operator it lacks is never shown by its identity", async () => {
  const { render } = await open();
  match(render().html, /proposed by Designer/);
  const unnamed = render(undefined, []).html;
  doesNotMatch(unnamed, /Designer/);
  // The identity of an operator is not for a person to read.
  doesNotMatch(unnamed, new RegExp(DESIGNER));
  match(unnamed, /proposed by An operator/);
  match(unnamed, /proposed by An operator, accepted by You/);
});

Deno.test("an open line shows its change in place, through the shared presentation: its files, which are links, and its diff", async () => {
  const { html, labels } = (await open()).render("proposal:p-taken");
  // Only that line is open, and the change is under it.
  equal((html.match(/aria-expanded="true"/g) || []).length, 1);
  equal((html.match(/class="act-detail"/g) || []).length, 1);
  const reader = lineOf(html, "Add the reader");
  match(reader, /aria-expanded="true"/);
  match(reader, /<div class="act-detail"><section class="rev-detail/);
  match(reader, /class="chat-proposal model-change is-settled is-applied"/);
  // The files it touched, each a link to the file as the commit left it.
  const at = encodeURIComponent(PARENT);
  match(reader, /<ul class="act-files" aria-label="Changed files">/);
  match(
    reader,
    new RegExp(
      `<a class="act-path" href="/model\\?page=files&amp;version=${at}&amp;file=configuration\\.sysml" aria-current="false">configuration\\.sysml</a>`,
    ),
  );
  match(
    reader,
    /<li\s+data-status="added"><span class="act-status is-added">added<\/span>/,
  );
  match(
    textOf(reader),
    /changed configuration\.sysml \+3 −1 added reader\.sysml \+8 −0/,
  );
  // The exact diff, escaped, and the layout the person can choose.
  match(reader, /class="revision-diff-host proposal-code-diff"/);
  doesNotMatch(html, /<img src=x/);
  deepStrictEqual(controls(labels), ["Unified", "Split"]);
  // A commit decides nothing.
  doesNotMatch(html, />Accept<\/button>|>Decline<\/button>/);
  // Nothing else is open, so no other line has a change.
  doesNotMatch(lineOf(html, "Accept a proposal"), /act-detail/);
});

Deno.test("the head's files open on main, which moves with it; the others at their own version", async () => {
  const { html } = (await open()).render(`commit:${HEAD}`);
  match(
    lineOf(html, "Accept a proposal"),
    /href="\/model\?page=files&amp;file=configuration\.sysml" aria-current="false"/,
  );
  doesNotMatch(lineOf(html, "Accept a proposal"), /page=files&amp;version=/);
});

Deno.test("authority facts belong only to the exact open commit, never another line or proposal", async () => {
  const seen: string[] = [];
  const { render } = await open({
    authorityForCommit(commit) {
      seen.push(commit.version);
      return <p data-authority={commit.version}>Recorded authority</p>;
    },
  });
  // The feed keeps the proposal's row key after it became this exact commit.
  const receipt = render("proposal:p-taken");
  deepStrictEqual(seen, [PARENT]);
  match(lineOf(receipt.html, "Add the reader"), /Recorded authority/);
  doesNotMatch(lineOf(receipt.html, "Accept a proposal"), /Recorded authority/);
  deepStrictEqual(controls(receipt.labels), ["Unified", "Split"]);

  const head = render(`commit:${HEAD}`);
  match(lineOf(head.html, "Accept a proposal"), /Recorded authority/);
  doesNotMatch(lineOf(head.html, "Add the reader"), /Recorded authority/);
  deepStrictEqual(seen, [PARENT, HEAD]);

  const proposal = render("proposal:p-open");
  doesNotMatch(proposal.html, /Recorded authority/);
  const missing = render(`commit:commit:${"f".repeat(40)}`);
  doesNotMatch(missing.html, /Recorded authority/);
  const closed = render();
  doesNotMatch(closed.html, /Recorded authority/);
  deepStrictEqual(seen, [PARENT, HEAD]);
});

Deno.test("a proposal that waits can be accepted or declined from its line, once its changes are shown", async () => {
  const { render } = await open();
  const { html, labels } = render("proposal:p-open");
  deepStrictEqual(controls(labels), ["Accept", "Decline", "Unified", "Split"]);
  const line = lineOf(html, "Add a ranking step");
  match(line, /class="chat-proposal model-change is-pending"/);
  // The files come from the diff, at the version the proposal made.
  const at = encodeURIComponent(PROPOSED);
  match(
    line,
    new RegExp(
      `href="/model\\?page=files&amp;version=${at}&amp;file=configuration\\.sysml"`,
    ),
  );
  match(textOf(line), /\+2 −0 · 1 file/);
  // Not shown yet: the buttons are there, shut, and the files are not known.
  const unread = (await open({ changes: false })).render("proposal:p-open");
  match(unread.html, /class="proposal-accept"\s+disabled/);
  doesNotMatch(unread.html, /act-files/);
});

Deno.test("a proposal in the making can be neither accepted nor declined, and says why", async () => {
  const { html, labels } = (await open()).render("proposal:p-prepare");
  match(
    textOf(lineOf(html, "Draft the reviewer")),
    /The operator is still preparing this proposal\./,
  );
  deepStrictEqual(controls(labels), []);
  doesNotMatch(html, /proposal-code-diff|act-files/);
});

Deno.test("a declined proposal says why, and has nothing left to decide", async () => {
  const { html } = (await open()).render("proposal:p-declined");
  match(textOf(lineOf(html, "Rename everything")), /Reason: Too broad/);
  doesNotMatch(html, />Accept<\/button>|>Decline<\/button>/);
});

Deno.test("the initial commit has no parent: its files are listed, with no diff and none asked for", async () => {
  const { render, host } = await open();
  const { html, labels } = render(`commit:${ROOT}`);
  const initial = lineOf(html, "Admit the initial model");
  match(
    initial,
    /data-status="added"><span class="act-status is-added">added<\/span><a class="act-path"/,
  );
  deepStrictEqual(
    [...initial.matchAll(/class="act-path"[^>]*>([^<]*)</g)].map(([, path]) =>
      path
    ),
    ["configuration.sysml", "lib/units.sysml"],
  );
  doesNotMatch(initial, /proposal-code-diff|Reading the changes/);
  deepStrictEqual(controls(labels), []);
  // The page never asks for the comparison with nothing.
  equal(
    host.requests.filter((entry) => entry.path.includes(ROOT)).length,
    0,
  );
});

Deno.test("a file name is text, never markup, and a removed file is not a link", async () => {
  const data = history();
  data.history.commits[0].files = [
    { path: "<b>x</b>.sysml", status: "modified", additions: 1, deletions: 1 },
    { path: "gone.sysml", status: "deleted", additions: 0, deletions: 3 },
    {
      path: "lib/new name.sysml",
      previousPath: "lib/old.sysml",
      status: "renamed",
      additions: 0,
      deletions: 0,
    },
  ];
  const html = (await open({ data })).render(`commit:${HEAD}`).html;
  doesNotMatch(html, /<b>x<\/b>/);
  match(html, /&lt;b>x&lt;\/b>\.sysml<\/a>/);
  match(html, /<span class="act-path">gone\.sysml<\/span>/);
  match(
    html,
    /data-status="renamed"><span class="act-status is-renamed">renamed<\/span><a class="act-path"[^>]*>lib\/new name\.sysml<\/a><span class="act-from">from lib\/old\.sysml<\/span>/,
  );
  // A rename with no line changed has no counts to show.
  doesNotMatch(
    html.match(/<li\s+data-status="renamed">[\s\S]*?<\/li>/)![0],
    /change-stats/,
  );
});

Deno.test("a history that is cut says so, quietly", async () => {
  const data = history();
  data.history.truncated = true;
  match((await open({ data })).render().html, /Older commits are not shown\./);
  doesNotMatch((await open()).render().html, /Older commits/);
});

Deno.test("a history with nothing in it says so", async () => {
  const data = history();
  data.history.commits = [];
  data.revisions.proposals = [];
  match(
    (await open({ data })).render().html,
    /<p class="rev-empty">No activity yet\.<\/p>/,
  );
});

Deno.test("a history that cannot be read says so and can be asked for again", async () => {
  const host = modelHost();
  let down = true;
  const sources = localSources();
  const store = createModelHistory({
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
  await store.refresh();
  const render = () =>
    press(
      <ActivityPage
        sources={sources}
        onChanged={() => {}}
        history={store}
        now={NOW}
      />,
    );
  const failed = render();
  match(
    failed.html,
    /role="alert" data-code="read-failed">The history could not be read\./,
  );
  doesNotMatch(failed.html, /Reading the history/);
  down = false;
  failed.click("Try again");
  for (let turn = 0; turn < 50 && !store.snapshot.peek(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  equal(store.snapshot.peek()?.revisions.version, HEAD);
  doesNotMatch(render().html, /read-failed/);
});

Deno.test("Accept sends one decision for the head and sources shown, tells the other views and reads the history again", async () => {
  const { render, host, settle, changed, store, sources } = await open();
  const page = render("proposal:p-open");
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
  // To decide and the other pages are told once, after the host confirmed.
  deepStrictEqual(changed, [1]);
  equal(sources.generation.peek(), 1);
  equal(store.refusal.peek(), null);
  equal(store.canAct.peek(), true);
});

Deno.test("Decline sends the refusal of the proposal shown", async () => {
  const { render, host, settle } = await open();
  render("proposal:p-open").click("Decline");
  await settle();
  equal(host.writes().length, 1);
  equal((host.writes()[0].body as { verdict: string }).verdict, "refuse");
});

Deno.test("the decision is the one the Revisions page makes: a decision in flight there shuts this page, and the other way round", async () => {
  let release!: () => void;
  const answer = new Promise<Response>((resolve) =>
    release = () => resolve(Response.json({ accepted: true }))
  );
  const activity = await open({ decision: () => answer });
  // The Revisions page over the same sources and the same host.
  const other = createModelHistory({
    api: createRevisionApi(activity.host.request),
    sources: activity.sources,
    selection: () => undefined,
    onChanged: () => {},
  });
  await other.refresh();
  const snapshot = other.snapshot.peek()!;
  await other.readDiff(HEAD, PROPOSED);
  const revisions = () =>
    press(
      <RevisionsPage
        location={{ search: "?proposal=p-open" }}
        sources={activity.sources}
        onChanged={() => {}}
        history={other}
        operators={roster}
        now={NOW}
      />,
    );
  ok(snapshot.revisions.proposals.some((entry) => entry.id === "p-open"));
  const page = activity.render("proposal:p-open");
  page.click("Accept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(activity.host.writes().length, 1);
  // Shut there, and pressing it anyway sends nothing.
  const there = revisions();
  match(there.html, /class="proposal-accept"\s+disabled/);
  there.click("Accept");
  there.click("Decline");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(activity.host.writes().length, 1);
  // And here too, while it is in flight.
  match(
    activity.render("proposal:p-open").html,
    /class="proposal-accept"\s+disabled/,
  );
  release();
  await activity.settle();
  equal(activity.host.writes().length, 1);
  deepStrictEqual(activity.changed, [1]);
});

Deno.test("nothing is sent while a decision is in flight in another panel", async () => {
  const { render, host, sources } = await open();
  let finish!: () => void;
  const elsewhere = sources.track(() =>
    new Promise<void>((done) => finish = done)
  );
  const page = render("proposal:p-open");
  match(page.html, /class="proposal-accept"\s+disabled/);
  page.click("Accept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(host.writes().length, 0);
  finish();
  await elsewhere;
});

Deno.test("a decision the host refuses is told on the proposal, after the history is read again", async () => {
  const { render, host, settle, store, changed } = await open({
    decision: () =>
      Response.json({ error: "Le modèle courant a changé." }, { status: 409 }),
  });
  const reads = () =>
    host.requests.filter((entry) => entry.path === "/api/model-revisions")
      .length;
  const before = reads();
  render("proposal:p-open").click("Accept");
  await settle();
  ok(reads() > before, "the history is read again");
  const { html } = render("proposal:p-open");
  match(lineOf(html, "Add a ranking step"), /data-code="decision-conflict"/);
  match(
    textOf(lineOf(html, "Add a ranking step")),
    /The decision was refused\..*Le modèle courant a changé\./,
  );
  // Nothing was confirmed: no other view was told and nothing is in flight.
  deepStrictEqual(changed, []);
  equal(store.deciding.peek(), null);
  // The message belongs to the proposal that was refused.
  doesNotMatch(render(`commit:${HEAD}`).html, /data-code=/);
  doesNotMatch(render("proposal:p-prepare").html, /data-code=/);
});

function runtimeTools() {
  const state = createWorkbenchState({ initialState: runtimeSnapshot() });
  const conversations: AgentConversation[] = ["alpha", "beta"].map((
    agentId,
  ) => ({
    agentId,
    nativeId: `native:${agentId}`,
    name: `Operator ${agentId}`,
    responsibility: "",
    primary: agentId === "alpha",
    canSend: true,
    busy: false,
    revision: 7,
    modelDigest: "model",
    phase: "Ready",
    messages: [],
  }));
  const tools: OperatorTool[] = conversations.map((owner) => ({
    agentId: owner.agentId,
    agentName: owner.name,
    revision: 7,
    candidate: {
      ...runtimeSnapshot().candidates[0],
      name: `Tool ${owner.agentId}`,
      code: `return "${owner.agentId} exact code";`,
      requiredAuthority: "human",
      createdAt: "2026-10-24T12:00:00Z",
    },
  }));
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations,
  });
  state.operatorTools.accept({ systemId: "ui-fixture", version: "v1", tools });
  return { state, tools };
}

Deno.test("runtime tool notifications open their exact shared card while source history is still unavailable", async () => {
  const source = await open({ read: false });
  const f = runtimeTools();
  const query = new URL(toolProposalHref(f.tools[1]), "http://local").search;
  const html = press(
    <ActivityPage
      state={f.state}
      location={{ pathname: "/model", search: query }}
      sources={source.sources}
      onChanged={() => {}}
      history={source.store}
      now={NOW}
    />,
  ).html;
  match(html, /Reading the history/);
  equal((html.match(/data-group="waiting"/g) ?? []).length, 1);
  match(
    lineOf(html, "Tool beta"),
    /aria-expanded="true"[\s\S]*data-proposal-id="tool-beta-c1"/,
  );
  match(lineOf(html, "Tool alpha"), /aria-expanded="false"/);
  match(lineOf(html, "Tool beta"), /data-tool-state="Awaiting admission"/);
  doesNotMatch(
    lineOf(html, "Tool beta"),
    /data-state="applied"|aria-label="Applied"|aria-label="Accepted"/,
  );
  match(html, /beta exact code|Admit and integrate/);
  doesNotMatch(html, /alpha exact code|No activity yet/);
  equal(source.host.requests.length, 0);
  equal(f.state.selectedConversation.value?.agentId, "alpha");
  f.state.dispose();
});

Deno.test("Activity keeps tool selection guards independent of source revisions and never substitutes a changed candidate", async () => {
  const source = await open({ changes: false });
  const f = runtimeTools();
  const query = new URL(toolProposalHref(f.tools[1]), "http://local").search;
  const draw = (search = query) =>
    press(
      <ActivityPage
        state={f.state}
        location={{ pathname: "/model", search }}
        sources={source.sources}
        onChanged={() => {}}
        history={source.store}
        now={NOW}
      />,
    ).html;
  const before = source.host.requests.length;
  match(draw(), /Tool beta/);
  equal(source.host.requests.length, before);
  f.state.operatorTools.stale.value = true;
  const stale = draw();
  match(stale, /Last observed: Awaiting admission/);
  match(stale, /data-code="tool-proposal-catalogue-stale"/);
  doesNotMatch(stale, /beta exact code|Admit and integrate/);
  f.state.operatorTools.stale.value = false;
  for (
    const [search, code] of [
      [
        query.replace("operator=beta", "operator=missing"),
        "tool-proposal-owner-absent",
      ],
      [
        query.replace("digest=" + "a".repeat(64), "digest=changed"),
        "tool-proposal-digest-changed",
      ],
      [query + "&version=old", "tool-proposal-address-invalid"],
    ]
  ) {
    const html = draw(search);
    match(html, new RegExp(`data-code="${code}"`));
    doesNotMatch(html, /beta exact code|alpha exact code|Admit and integrate/);
  }
  f.state.operatorTools.snapshot.value = null;
  match(draw(), /data-code="tool-proposal-catalogue-absent"/);
  f.state.selectedRevision.value = 3;
  const historical = draw();
  match(historical, /data-code="tool-proposal-historical"/);
  doesNotMatch(historical, /Tool beta|Tool alpha|beta exact code/);
  f.state.dispose();
});

Deno.test("a changed Activity deep link opens its new exact notification through the real page lifecycle", async () => {
  const source = await open({ changes: false });
  const f = runtimeTools();
  const root = probeRoot();
  const { live } = modelFeed();
  let node!: VNode;
  function Probe(props: ActivityPageProps) {
    node = ActivityPage(props);
    return null;
  }
  const show = (tool: OperatorTool) =>
    root.show(Probe, {
      state: f.state,
      location: {
        pathname: "/model",
        search: new URL(toolProposalHref(tool), "http://local").search,
      },
      sources: source.sources,
      onChanged: () => {},
      history: source.store,
      now: NOW,
      live,
    });
  try {
    await show(f.tools[0]);
    let html = renderToString(node);
    match(lineOf(html, "Tool alpha"), /aria-expanded="true"/);
    match(html, /alpha exact code/);
    await act(() => press(node).click("Tool alpha"));
    doesNotMatch(renderToString(node), /alpha exact code/);
    // Redrawing the same address respects a manually closed notification.
    await show(f.tools[0]);
    match(lineOf(renderToString(node), "Tool alpha"), /aria-expanded="false"/);
    await show(f.tools[1]);
    html = renderToString(node);
    match(lineOf(html, "Tool beta"), /aria-expanded="true"/);
    match(lineOf(html, "Tool alpha"), /aria-expanded="false"/);
    match(html, /beta exact code/);
    doesNotMatch(html, /alpha exact code/);
  } finally {
    await root.restore();
    f.state.dispose();
  }
});

Deno.test("Waiting for you excludes settled tools and an opened receipt survives a catalogue transition outside that group", async () => {
  const source = await open({ changes: false });
  const f = runtimeTools();
  const mixed = [
    f.tools[0],
    ...(["active", "refused", "failed"] as const).map((stage) => ({
      ...f.tools[1],
      candidate: {
        ...f.tools[1].candidate,
        id: stage,
        name: `Settled ${stage}`,
        stage,
        binding: { elementId: "native:tool", graphPath: "model.tool" },
      },
    })),
  ];
  f.state.operatorTools.accept({
    systemId: "ui-fixture",
    version: "mixed",
    tools: mixed,
  });
  const root = probeRoot();
  const { live } = modelFeed();
  let node!: VNode;
  function Probe(props: ActivityPageProps) {
    node = ActivityPage(props);
    return null;
  }
  const show = () =>
    root.show(Probe, {
      state: f.state,
      sources: source.sources,
      onChanged: () => {},
      history: source.store,
      now: NOW,
      live,
    });
  const waitingTools = (html: string) =>
    /data-group="waiting">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
  try {
    await show();
    match(waitingTools(renderToString(node)), /Tool alpha/);
    doesNotMatch(
      waitingTools(renderToString(node)),
      /Settled active|Settled refused|Settled failed/,
    );
    await act(() => press(node).click("Tool alpha"));
    f.state.operatorTools.accept({
      systemId: "ui-fixture",
      version: "refused",
      tools: mixed.map((tool) =>
        tool.agentId === "alpha"
          ? { ...tool, candidate: { ...tool.candidate, stage: "refused" } }
          : tool
      ),
    });
    await show();
    const html = renderToString(node);
    doesNotMatch(
      waitingTools(html),
      /Tool alpha|Settled active|Settled refused|Settled failed/,
    );
    match(
      html,
      /data-group="tool-selection"[\s\S]*data-tool-state="Refused"[\s\S]*aria-expanded="true"/,
    );
    match(html, /data-proposal-id="tool-alpha-c1"/);
  } finally {
    await root.restore();
    f.state.dispose();
  }
});

Deno.test("an Activity adjustment survives refresh and refusal, retaining a failed message for a message-only retry", async () => {
  const source = await open({ changes: false });
  const f = runtimeTools();
  const root = probeRoot();
  const { live } = modelFeed();
  const frame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  let node!: VNode;
  function Probe(props: ActivityPageProps) {
    node = ActivityPage(props);
    return null;
  }
  const show = () =>
    root.show(Probe, {
      state: f.state,
      sources: source.sources,
      onChanged: () => {},
      history: source.store,
      now: NOW,
      live,
    });
  const decisions: string[] = [], messages: string[] = [];
  f.state.decideOperatorTool = async (owner, verdict) => {
    decisions.push(`${owner.agentId}:${verdict}`);
    f.state.operatorTools.loading.value = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.state.operatorTools.accept({
      systemId: "ui-fixture",
      version: "refused",
      tools: f.tools.map((tool) =>
        tool.agentId === "alpha"
          ? { ...tool, candidate: { ...tool.candidate, stage: "refused" } }
          : tool
      ),
    });
    f.state.operatorTools.loading.value = false;
    return true;
  };
  f.state.agentConversations.sendTo = (_agent, message) => {
    messages.push(message);
    return Promise.resolve(messages.length > 1);
  };
  try {
    await show();
    await act(() => press(node).click("Tool alpha"));
    await act(() => press(node).click("Adjust"));
    await act(() => {
      press(node).input?.({
        currentTarget: { value: "Preserve this request" },
      });
    });
    await act(() => {
      press(node).submit?.({ preventDefault() {} });
    });
    await settle();
    await show();
    let html = renderToString(node);
    match(html, /data-group="tool-selection"[\s\S]*proposal-adjustment/);
    match(html, /value="Preserve this request"/);
    match(html, /The proposal was declined, but the request was not sent/);
    equal(decisions.length, 1);
    equal(messages.length, 1);
    await act(() => {
      press(node).submit?.({ preventDefault() {} });
    });
    await settle();
    await show();
    html = renderToString(node);
    doesNotMatch(html, /proposal-adjustment|request was not sent/);
    deepStrictEqual(decisions, ["alpha:refuse"]);
    deepStrictEqual(messages, [
      "Adjust the proposal “Tool alpha” (c1):\nPreserve this request",
      "Adjust the proposal “Tool alpha” (c1):\nPreserve this request",
    ]);
  } finally {
    await root.restore();
    if (frame) {
      Object.defineProperty(globalThis, "requestAnimationFrame", frame);
    } else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    f.state.dispose();
  }
});
