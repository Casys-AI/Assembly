import { textOf, within } from "../../test/support/dom.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import { seedRequestCases } from "../../test/support/request-fixture.ts";
import { AgentPanel } from "../conversations/AgentPanel.tsx";
import { ChatView } from "../conversations/ChatView.tsx";
import { CaseView } from "./CaseView.tsx";
import { caseHasPendingDecision } from "../../lib/decide/pending.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
import type { PendingDecision } from "../../lib/decide/pending.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import {
  caseRecord,
  jobRecord,
  watchRecord,
} from "../../test/support/case-fixture.ts";
import { renderLinks } from "../../test/support/links.ts";
import { press } from "../../test/support/press.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { CasesPage } from "./CasesPage.tsx";
import {
  localSkillRelease,
  RELEASE_VERSION,
} from "../../test/support/release-opening-fixture.ts";
import { grant, operatorRoster } from "../../test/support/operator-fixture.ts";

const NOW = Date.parse("2026-10-24T15:00:00Z");

Deno.test("Request header, list, tree and compact panel share the named operator and scoped version actions", () => {
  const state = pageState();
  const record = state.requests.cases.byId("ui-fixture:case:1")!;
  const current = state.agentConversations.snapshot.value!;
  state.agentConversations.accept({
    ...current,
    conversations: current.conversations.map((agent) => ({
      ...agent,
      name: agent.nativeId === record.owner ? "Branch Operator" : agent.name,
      repositoryVersion: RELEASE_VERSION,
    })),
  });
  const baseVersion = `commit:${"b".repeat(40)}`;
  const admitted = `commit:${"c".repeat(40)}`;
  state.requests.scopes.value = new Map([[record.id, {
    caseId: record.id,
    branchId: "exact-branch",
    executionSpaceId: "space",
    baseVersion,
    version: RELEASE_VERSION,
    executionVersion: RELEASE_VERSION,
    branchVersion: admitted,
    readOnly: true,
    release: null,
  }]]);
  for (const compact of [false, true]) {
    const html = renderToString(
      page(state, { selectedId: record.id, compact, agentId: "collector" }),
    );
    const text = textOf(html);
    match(text, new RegExp(branchOperatorName(record)));
    doesNotMatch(
      textOf(within(html).byRole("tree", { name: "Agents" })),
      /Branch Operator/,
    );
    match(html, /aria-label="Request 1 · modified · In service · Read-only"/);
    const release = within(html).byRole("link", { name: "Create release" });
    const url = new URL(release.getAttribute("href")!, "http://localhost");
    equal(url.searchParams.get("caseBranch"), record.id);
    equal(url.searchParams.get("agent"), "collector");
    equal(url.searchParams.get("version"), admitted);
    equal(url.searchParams.get("create"), "1");
    doesNotMatch(
      html.slice(html.indexOf('<aside class="agent-panel"')),
      />Create release</,
    );
  }
  match(
    renderToString(page(state)),
    /aria-label="Request 1 · modified · In service · Read-only"/,
  );
  state.dispose();
});

Deno.test("Request header names its exact origin Release and reports an unavailable name without inferring from the model version", () => {
  const state = pageState();
  const caseId = "ui-fixture:case:1";
  const release = localSkillRelease("origin");
  release.metadata.name = "Training research v1";
  release.assetAvailability = "unavailable";
  state.requests.scopes.value = new Map([[caseId, {
    caseId,
    branchId: "branch",
    executionSpaceId: "space",
    branchVersion: RELEASE_VERSION,
    executionVersion: RELEASE_VERSION,
    version: RELEASE_VERSION,
    readOnly: true,
    release: { id: release.id, digest: release.digest! },
  }]]);
  state.requests.releaseCatalogue.value = [release];
  match(
    textOf(renderToString(page(state, { selectedId: caseId }))),
    /From Release Training research v1/,
  );
  state.requests.releaseCatalogue.value = [{
    ...release,
    digest: "f".repeat(64),
  }];
  const unmatched = textOf(renderToString(page(state, { selectedId: caseId })));
  match(unmatched, /Origin Release · name unavailable/);
  doesNotMatch(unmatched, /From Release Training research v1/);
  state.dispose();
});

/** The central agent and a specialist, with messages attached to two Cases. */
function roster(): ConversationsSnapshot {
  const base = {
    responsibility: "Coordinate",
    revision: 1,
    busy: false,
    phase: "Ready",
    modelDigest: "digest",
    canSend: true,
  };
  return {
    systemId: "ui-fixture",
    defaultAgentId: "coordinator",
    version: "roster-1",
    conversations: [{
      ...base,
      agentId: "coordinator",
      nativeId: "native:coordinator",
      name: "Coordinateur",
      primary: true,
      messages: [{
        id: "m1",
        role: "user",
        text: "Find AI training offers",
        at: "2026-10-24T11:00:00Z",
        caseId: "ui-fixture:case:1",
      }, {
        id: "m2",
        role: "assistant",
        text: "I asked Collecteur to gather sources.",
        at: "2026-10-24T11:01:00Z",
        caseId: "ui-fixture:case:1",
      }, {
        id: "m3",
        role: "assistant",
        text: "Unrelated earlier note",
        at: "2026-10-24T10:00:00Z",
      }, {
        id: "m4",
        role: "user",
        text: "Watch the prices",
        at: "2026-10-24T12:00:00Z",
        caseId: "ui-fixture:case:2",
      }] as never,
    }, {
      ...base,
      agentId: "collector",
      nativeId: "native:collector",
      name: "Collecteur",
      primary: false,
      messages: [{
        id: "w1",
        role: "assistant",
        text: "Twelve offers found.",
        at: "2026-10-24T11:00:30Z",
        caseId: "ui-fixture:case:1",
      }, {
        id: "w2",
        role: "assistant",
        text: "Sources ranked.",
        at: "2026-10-24T11:00:50Z",
        caseId: "ui-fixture:case:1",
      }, {
        id: "w3",
        role: "assistant",
        text: "Price page read.",
        at: "2026-10-24T12:00:30Z",
        caseId: "ui-fixture:case:2",
      }] as never,
    }],
  };
}

/** A message an agent heard as delegated work from the agent `callerId`. */
const delegated = (message: object, callerId: string) => ({
  ...message,
  work: {
    callerId,
    correlationId: "correlation",
    invocationId: "invocation",
    behaviorId: "behavior",
    targetNativeId: "native:target",
    modelVersion: { digest: "digest", repositoryVersion: "commit:abc" },
  },
});

/** Two open Requests (one waiting), a closed one, a Job and a Watch. */
function pageState(
  options: {
    cases?: unknown[];
    fetch?: (path: string, init?: RequestInit) => Promise<Response>;
    effort?: boolean;
  } = {},
) {
  const current = snapshot();
  if (options.effort) {
    current.workBudget = {
      budgetId: "budget",
      scopeId: "ui-fixture:case:1",
      unit: "agent-invocation",
      limit: 12,
      consumed: 3,
      reserved: 0,
      remaining: 9,
      exhausted: false,
      suspended: false,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
    };
  }
  const state = createWorkbenchState({
    initialState: current,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  state.agentConversations.accept(roster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: (options.cases as never[]) ?? [
      caseRecord(1),
      caseRecord(2, { status: "waiting" }),
      caseRecord(3, {
        status: "closed-done",
        closedAt: "2026-10-24T13:00:00Z",
      }),
      jobRecord(),
      watchRecord(),
    ],
  });
  seedRequestCases(state, state.cases.snapshot.value!, roster(), {
    presentationPeers: true,
  });
  return state;
}

function page(
  state: ReturnType<typeof pageState>,
  props: {
    selectedId?: string | null;
    agentId?: string | null;
    compact?: boolean;
    decisions?: PendingDecision[];
    onBack?: () => void;
  } = {},
): VNode {
  if (state.requests.cases.snapshot.value) {
    seedRequestCases(
      state,
      state.requests.cases.snapshot.value,
      state.agentConversations.snapshot.value,
      { presentationPeers: true },
    );
  }
  return (
    <CasesPage
      state={state}
      active
      selectedId={props.selectedId ?? null}
      agentId={props.agentId ?? null}
      compact={props.compact}
      decisions={props.decisions ?? []}
      onStarted={() => {}}
      onBack={props.onBack ?? (() => {})}
      now={NOW}
    />
  );
}

const list = (html: string) =>
  html.slice(html.indexOf('<nav class="cases-list"'), html.indexOf("</nav>"));
const detail = (html: string) =>
  html.slice(html.indexOf('<section class="cases-detail'));
const head = (html: string) =>
  html.slice(
    html.indexOf('<header class="cases-detail-head"'),
    html.indexOf("</header>"),
  );
const row = (html: string, number: number) =>
  list(html).match(
    new RegExp(`<a class="rev-row"[^>]*case%3A${number}"[\\s\\S]*?</a>`),
  )?.[0] ?? "";
const tree = (html: string) =>
  html.slice(html.indexOf('<nav class="case-tree"'), html.indexOf("</nav>"));
/** The tree's rows in order: where they sit, where they lead, what they say. */
const conversations = (html: string) =>
  [
    ...tree(html).matchAll(
      /<li\s+role="treeitem"([^>]*)>\s*<div class="tree-row"[\s\S]*?<a class="tree-link" href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g,
    ),
  ]
    .map(([, item, href, attributes, inner]) => ({
      level: Number(item.match(/aria-level="(\d+)"/)?.[1]),
      expanded: item.match(/aria-expanded="(\w+)"/)?.[1],
      href,
      current: attributes.includes('aria-current="true"'),
      text: textOf(
        inner.replace(/<span class="agent-tile"[^>]*>[^<]*<\/span>/, ""),
      ),
    }));
/** The panel beside the conversation, with its markup flattened to text. */
const panel = (html: string) =>
  html.match(/<aside class="agent-panel"[\s\S]*?<\/aside>/)?.[0] ?? "";

Deno.test("without a selection the page lists every Request: open ones first, newest first, then the done ones", () => {
  const state = pageState();
  const html = renderToString(page(state));
  match(html, /<h1>Requests<\/h1>/);
  match(html, /aria-label="New request"/);
  // No filter to click: two groups, Open then Done.
  doesNotMatch(html, /class="seg"/);
  const open = list(html);
  ok(
    open.indexOf('class="feed-group">Open<') <
      open.indexOf('class="feed-group">Done<'),
  );
  ok(
    open.indexOf("case%3A2") > 0 && open.indexOf("case%3A2") <
        open.indexOf("case%3A1"),
  );
  ok(open.indexOf("case%3A1") < open.indexOf("case%3A3"));
  // Jobs and Watches keep their own page.
  doesNotMatch(open, /Monthly market report|New AI training offers/);
  // A title on two lines at most, the time since it started, a link per Request.
  match(
    row(html, 2),
    /<a class="rev-row" href="\/cases\?case=ui-fixture%3Acase%3A2"[^>]*title="Objective 2"[\s\S]*<span class="rev-title">Objective 2<\/span>[\s\S]*<span>3 hours ago<\/span>/,
  );
  // A Done row says when it ended, not when it started.
  match(row(html, 3), /<span>2 hours ago<\/span>/);
  // Nothing is selected, and nothing else heads the list.
  doesNotMatch(list(html), /aria-current|<button|Coordinateur/);
  state.cases.dispose();
});

Deno.test("the list ends with the field that starts a Case, and nothing of any conversation", () => {
  const state = pageState();
  const html = renderToString(page(state));
  const right = detail(html);
  match(right, /id="cases-input"[^>]*placeholder="What do you need\?"/);
  doesNotMatch(right, /<h2|class="cases-bar"|class="message |Pin|Close/);
  doesNotMatch(html, /Find AI training offers|Unrelated earlier note/);
  // No way back from the list, and no Case head.
  doesNotMatch(html, /cases-back|cases-detail-head/);
  state.cases.dispose();
});

Deno.test("a Case view has no list of Cases: a way back, its head, then its agents", () => {
  const state = pageState();
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:1" }));
  // The way back to the list, above the Case.
  match(
    html,
    /<a class="cases-back" href="\/cases">[\s\S]*?<path d="[^"]*"[\s\S]*?<\/svg>\s*Requests<\/a>[\s\S]*<header class="cases-detail-head">/,
  );
  doesNotMatch(html, /<h1>Requests<\/h1>/);
  // The left column holds this Case's agents, never the Cases.
  match(html, /<nav class="case-tree" aria-label="Conversations">/);
  doesNotMatch(html, /<nav class="cases-list"/);
  doesNotMatch(tree(html), /feed-group|Objective|case%3A[23]"|needs you/);
  state.cases.dispose();
});

Deno.test("the way back to the list says it was followed in this tab, from a Case or from one that is not there", () => {
  const state = pageState();
  for (const selectedId of ["ui-fixture:case:1", "ui-fixture:case:99"]) {
    let back = 0;
    const view = renderLinks(
      page(state, { selectedId, onBack: () => back++ }),
    );
    match(view.html, /<a class="cases-back" href="\/cases">/);
    // A new tab or window leaves this one on its Case.
    view.click("cases-back", { metaKey: true });
    view.click("cases-back", { shiftKey: true });
    view.click("cases-back", { button: 1 });
    equal(back, 0);
    view.click("cases-back");
    equal(back, 1);
  }
  state.cases.dispose();
});

Deno.test("the left column is a tree: the Case's owner at the root, a sub-agent under it with its messages", () => {
  const state = pageState();
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:1" }));
  deepStrictEqual(conversations(html), [
    {
      level: 1,
      expanded: "true",
      href: "/cases?case=ui-fixture%3Acase%3A1",
      current: true,
      text: "Coordinateur 2 messages",
    },
    {
      level: 2,
      expanded: undefined,
      href: "/cases?case=ui-fixture%3Acase%3A1&amp;agent=collector",
      current: false,
      text: "Collecteur 2 messages",
    },
  ]);
  // A tree, its items, and one group per branch; names stay readable.
  match(tree(html), /<ul role="tree" aria-label="Agents">/);
  match(tree(html), /<li\s+role="treeitem"[^>]*aria-label="Collecteur"/);
  equal(tree(html).match(/role="group"/g)?.length, 1);
  match(tree(html), /<span class="agent-tile" aria-hidden="true">Co<\/span>/);
  // Another Case has its own agents, and one message is singular.
  const second = renderToString(
    page(state, { selectedId: "ui-fixture:case:2" }),
  );
  deepStrictEqual(conversations(second).map((entry) => entry.text), [
    "Coordinateur 1 message",
    "Collecteur 1 message",
  ]);
  state.cases.dispose();
});

Deno.test("an agent sits under the one that asked it for work; an unknown caller leaves it under the owner", () => {
  const state = pageState();
  const everyone = roster();
  const [, collector] = everyone.conversations;
  const base = {
    responsibility: "Rank",
    revision: 1,
    busy: false,
    phase: "Ready",
    modelDigest: "digest",
    canSend: true,
    primary: false,
  };
  const said = (id: string, at: string) => ({
    id,
    role: "assistant",
    text: id,
    at,
    caseId: "ui-fixture:case:1",
  });
  // The collector was asked by the coordinator; the ranker by the collector;
  // the stranger by an agent the Case never heard of.
  collector.messages = [
    delegated(said("w1", "2026-10-24T11:00:30Z"), "native:coordinator"),
    said("w2", "2026-10-24T11:00:50Z"),
  ] as never;
  everyone.conversations.push({
    ...base,
    agentId: "ranker",
    nativeId: "native:ranker",
    name: "Classeur",
    busy: true,
    messages: [
      delegated(said("r1", "2026-10-24T11:00:40Z"), "native:collector"),
    ] as never,
  }, {
    ...base,
    agentId: "stranger",
    nativeId: "native:stranger",
    name: "Inconnu",
    messages: [
      delegated(said("s1", "2026-10-24T11:00:20Z"), "native:elsewhere"),
    ] as never,
  });
  state.agentConversations.accept(everyone);
  const html = renderToString(
    page(state, { selectedId: "ui-fixture:case:1", agentId: "ranker" }),
  );
  deepStrictEqual(
    conversations(html).map((entry) => [entry.level, entry.text]),
    [
      [1, "Coordinateur 2 messages"],
      // Siblings follow their first message: the stranger spoke first.
      [2, "Inconnu 1 message"],
      [2, "Collecteur 2 messages"],
      [3, "Classeur 1 message"],
    ],
  );
  deepStrictEqual(
    conversations(html).map((entry) => entry.expanded),
    ["true", undefined, "true", undefined],
  );
  deepStrictEqual(conversations(html).map((entry) => entry.current), [
    false,
    false,
    false,
    true,
  ]);
  // The busy agent carries a small static dot, nobody else.
  equal(tree(html).match(/class="tree-busy"/g)?.length, 1);
  match(
    tree(html),
    /aria-label="Classeur"[\s\S]*?class="tree-busy" role="img" aria-label="Working"/,
  );
  // The panel is the selected agent's.
  match(panel(html), /<h2>Classeur<\/h2>/);
  state.cases.dispose();
});

Deno.test("a Case no sub-agent took part in still shows its owner alone, and a closed one has no field", () => {
  const state = pageState({
    cases: [
      caseRecord(3, {
        status: "closed-done",
        closedAt: "2026-10-24T13:00:00Z",
      }),
      caseRecord(5, { owner: "native:nobody" }),
    ],
  });
  const done = renderToString(
    page(state, { selectedId: "ui-fixture:case:3" }),
  );
  // A root without a message has no count; with no child it has no chevron.
  deepStrictEqual(conversations(done), [{
    level: 1,
    expanded: undefined,
    href: "/cases?case=ui-fixture%3Acase%3A3",
    current: true,
    text: "Coordinateur",
  }]);
  doesNotMatch(
    tree(done),
    /<button|tree-count|tree-phase|tree-busy|role="group"/,
  );
  doesNotMatch(detail(done), /id="cases-input"/);
  // Present activity elsewhere cannot make this closed history look active.
  const present = roster();
  present.conversations[0].busy = true;
  state.agentConversations.accept(present);
  const stillDone = renderToString(
    page(state, { selectedId: "ui-fixture:case:3" }),
  );
  doesNotMatch(tree(stillDone), /tree-phase|tree-busy|aria-label="Working"/);
  // An owner the roster does not know is the Coordinator, and has no chip nor
  // panel: nothing is known of it.
  const stranger = renderToString(
    page(state, { selectedId: "ui-fixture:case:5" }),
  );
  deepStrictEqual(conversations(stranger).map((entry) => entry.text), [
    "Coordinator",
  ]);
  doesNotMatch(head(stranger), /class="chip ghost"/);
  doesNotMatch(stranger, /class="agent-panel"/);
  state.cases.dispose();
});

Deno.test("the agent of the address selects that sub-agent's messages, read-only", () => {
  const state = pageState();
  const html = renderToString(
    page(state, { selectedId: "ui-fixture:case:1", agentId: "collector" }),
  );
  deepStrictEqual(conversations(html).map((entry) => entry.current), [
    false,
    true,
  ]);
  const right = detail(html);
  match(right, /aria-label="Collecteur"/);
  // Its messages in this Case, oldest first, and nothing from other Cases.
  match(right, /Twelve offers found\.[\s\S]*Sources ranked\./);
  doesNotMatch(right, /Price page read/);
  match(right, /<article\s+class="message assistant">/);
  doesNotMatch(right, /href="\/chat\?agent=collector">Open conversation</);
  // Nothing to write in, and nothing of the main thread.
  doesNotMatch(right, /<textarea|<form|id="cases-input"/);
  doesNotMatch(right, /Find AI training offers|I asked Collecteur/);
  // The head stays: it is still this Case.
  match(head(html), /<h2>Objective 1<\/h2>/);
  state.cases.dispose();
});

Deno.test("the existing Main agent panel retains mission, Mandate, Tools and Skills", () => {
  const state = pageState();
  const initial = snapshot();
  const everyone = roster();
  const collector = everyone.conversations[1];
  collector.responsibility = "Gather and rank sources";
  collector.proposalContext = {
    configurationRevision: 1,
    before: {
      network: { allowedHosts: ["offers.example", "prices.example"] },
      builder: { admissionAuthority: "reviewer" },
      urlSelectionMode: "authorized-host",
    },
    changes: [],
  };
  collector.skills = [
    {
      id: "pricing",
      name: "Price reading",
      description: "Reads price pages",
      loaded: true,
    },
    {
      id: "ranking",
      name: "Ranking",
      description: "Ranks sources",
      loaded: false,
    },
  ];
  state.agentConversations.accept(everyone);
  state.operatorTools.accept({
    systemId: initial.id,
    version: "v1",
    tools: [{
      agentId: "collector",
      agentName: "Collecteur",
      revision: 1,
      candidate: {
        ...initial.candidates[0],
        id: "fetch-page",
        name: "Fetch page",
        stage: "active",
      },
    }, {
      agentId: "collector",
      agentName: "Collecteur",
      revision: 1,
      candidate: {
        ...initial.candidates[0],
        id: "read-feed",
        name: "Read feed",
        stage: "reviewing",
      },
    }],
    modelTools: [],
  });
  const right = renderToString(
    <AgentPanel state={state} conversation={collector} />,
  );
  // The agent and its mission, whole in the tooltip.
  match(
    right,
    /<span class="agent-tile" aria-hidden="true">Co<\/span><h2>Collecteur<\/h2><p title="Gather and rank sources">Gather and rank sources<\/p>/,
  );
  // Sections in order, each a small label then compact rows.
  const labels = [...right.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  deepStrictEqual(labels, ["Mandate", "Tools", "Skills"]);
  const [mandate, tools, skills] = right.split(/<h3>/).slice(1).map((part) =>
    textOf(part)
  );
  match(mandate, /^Mandate Allowed hosts offers\.example, prices\.example/);
  match(mandate, /URL selection Pages of allowed hosts/);
  match(mandate, /Tool admission Reviewer$/);
  // One server row, opened on its tools; only the pending one shows a stage.
  match(tools, /^Tools web 1 pending 2 Fetch page .+ Read feed Under review /);
  match(skills, /^Skills Price reading Ranking$/);
  match(right, /<li[^>]*title="Reads price pages"[^>]*data-skill-id="pricing"/);
  // Read only: no button, no form; only the server opens on its tools.
  doesNotMatch(right, /<button|<form|<input/);
  equal(right.match(/<details/g)?.length, 1);

  // The owner has no skill catalog: no Skills section; nothing known: None.
  const owner = panel(
    renderToString(
      <AgentPanel state={state} conversation={everyone.conversations[0]} />,
    ),
  );
  deepStrictEqual(
    [...owner.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]),
    ["Mandate", "Tools"],
  );
  match(textOf(owner), /Mandate None Tools None$/);
  doesNotMatch(owner, /Skills/);
  state.cases.dispose();
});

Deno.test("an agent with an empty skill catalog says None; one without a catalog shows no Skills", () => {
  const state = pageState();
  const everyone = roster();
  everyone.conversations[1].skills = [];
  state.agentConversations.accept(everyone);
  const html = renderToString(
    <AgentPanel state={state} conversation={everyone.conversations[1]} />,
  );
  match(textOf(panel(html)), /Skills None$/);
  state.cases.dispose();
});

Deno.test("the Case reads tree, conversation, then panel, so a stacked layout keeps that order", () => {
  const state = pageState();
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:1" }));
  ok(
    html.indexOf('<nav class="case-tree"') <
        html.indexOf('<section class="cases-detail') &&
      html.indexOf('<section class="cases-detail') <
        html.indexOf('<aside class="agent-panel"'),
  );
  state.cases.dispose();
});

Deno.test("a sub-agent's messages are read in the order they were said", () => {
  const state = pageState();
  const everyone = roster();
  everyone.conversations[1].messages.reverse();
  state.agentConversations.accept(everyone);
  const html = renderToString(
    page(state, { selectedId: "ui-fixture:case:1", agentId: "collector" }),
  );
  match(html, /Twelve offers found\.[\s\S]*Sources ranked\./);
  state.cases.dispose();
});

Deno.test("the owner remains selected explicitly while an unavailable scoped conversation never becomes its composer", () => {
  const state = pageState();
  for (const agentId of ["nobody", "coordinator"]) {
    const html = renderToString(
      page(state, { selectedId: "ui-fixture:case:1", agentId }),
    );
    deepStrictEqual(conversations(html).map((entry) => entry.current), [
      true,
      false,
    ]);
    if (agentId === "coordinator") {
      match(detail(html), /id="cases-input"[^>]*placeholder="Reply…"/);
    } else {
      match(detail(html), /selected Request conversation is unavailable/);
      doesNotMatch(detail(html), /id="cases-input"/);
    }
    // The tree still knows the Case owner; unavailable selection grants nothing.
    match(panel(html), /<h2>Coordinateur<\/h2>/);
  }
  state.cases.dispose();
});

Deno.test("a decision recorded in a Request lights its row and no other; a pin stays local to the row", () => {
  const state = pageState();
  state.pins.toggle("ui-fixture:case:2");
  const decision: PendingDecision = {
    id: "authorization:x",
    kind: "authorization",
    label: "Authorize mandate change",
    agentId: "coordinator",
    caseId: "ui-fixture:case:1",
    href: "/chat?agent=coordinator",
  };
  const html = renderToString(page(state, { decisions: [decision] }));
  equal(
    caseHasPendingDecision(
      state.cases.byId("ui-fixture:case:1")!,
      state.cases.open.value,
      "coordinator",
      [decision],
    ),
    true,
  );
  equal(
    caseHasPendingDecision(
      state.cases.byId("ui-fixture:case:2")!,
      state.cases.open.value,
      "coordinator",
      [decision],
    ),
    false,
  );
  match(row(html, 1), /<span class="chip warn">needs you<\/span>/);
  // A filled dot says there is something to see; a quiet Case keeps it hollow.
  match(
    row(html, 1),
    /class="rev-dot is-filled" aria-label="Something to see"/,
  );
  match(row(html, 2), /class="rev-dot"/);
  doesNotMatch(row(html, 2), /is-filled/);
  doesNotMatch(row(html, 1), /aria-label="Pinned"/);
  doesNotMatch(row(html, 2), /needs you/);
  match(row(html, 2), /aria-label="Pinned"/);
  state.cases.dispose();
});

Deno.test("the selected Request has its own head and pins without borrowing Main budget or lifecycle actions", () => {
  const state = pageState({
    effort: true,
    cases: [
      caseRecord(1, {
        objective:
          "Can you find AI training offers? Compare them by price and send me the list.",
      }),
      caseRecord(2, { status: "waiting" }),
    ],
  });
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:1" }));
  const top = head(html);
  match(top, /<h2>Find AI training offers<\/h2>/);
  // The full objective, calm, when it says more than the name; no label.
  match(
    top,
    /<p class="cases-objective" title="Can you find AI training offers\? Compare them by price and send me the list\.">Can you find/,
  );
  doesNotMatch(top, /Goal/);
  const chips = top.match(/<div class="cases-chips">[\s\S]*?<\/div>/)?.[0] ??
    "";
  deepStrictEqual(
    [...chips.matchAll(/<span class="chip[^"]*"[^>]*>([^<]*)</g)].map((m) =>
      m[1]
    ),
    ["Open", "Coordinateur"],
  );
  match(top, /aria-label="Keep in Dock" aria-pressed="false"/);
  doesNotMatch(top, /<button[^>]*>Close<\/button>|Effort/);
  const mainBudget = renderToString(
    <CaseView state={state} record={state.cases.byId("ui-fixture:case:1")} />,
  );
  match(mainBudget, /Effort 3 \/ 12/);
  // The name is the whole objective: nothing to add. Another Case's budget is
  // not this one's effort. A waiting Request is still to close.
  const other = head(
    renderToString(page(state, { selectedId: "ui-fixture:case:2" })),
  );
  doesNotMatch(other, /cases-objective|Effort/);
  match(other, /<span class="chip">Waiting<\/span>/);
  doesNotMatch(other, /<button[^>]*>Close<\/button>/);
  state.cases.dispose();
});

Deno.test("scoped Pin and Unpin stay local; the existing Main close port still closes its Case as done", async () => {
  const posts: { path: string; body: unknown }[] = [];
  const closed = caseRecord(1, {
    status: "closed-done",
    closedAt: "2026-10-24T14:00:00Z",
  });
  const state = pageState({
    cases: [caseRecord(1)],
    fetch: (path, init) => {
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(
        Response.json({ systemId: "ui-fixture", cases: [closed] }),
      );
    },
  });
  const node = () => page(state, { selectedId: "ui-fixture:case:1" });
  press(node()).click("Keep in Dock");
  deepStrictEqual(state.pins.ids.value, ["ui-fixture:case:1"]);
  match(
    head(renderToString(node())),
    /aria-label="Keep in Dock" aria-pressed="true"/,
  );
  press(node()).click("Keep in Dock");
  deepStrictEqual(state.pins.ids.value, []);

  doesNotMatch(renderToString(node()), /<button[^>]*>Close<\/button>/);
  await state.cases.close("ui-fixture:case:1", "done");
  deepStrictEqual(posts, [{
    path: "/api/cases/ui-fixture%3Acase%3A1/close",
    body: { outcome: "done" },
  }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  seedRequestCases(
    state,
    { systemId: "ui-fixture", cases: [closed] },
    roster(),
    { presentationPeers: true },
  );
  // The next explicit scoped read reports closure: no composer, retained history.
  const after = renderToString(node());
  match(head(after), /<span class="chip">Done<\/span>/);
  doesNotMatch(head(after), /<button[^>]*>Close<\/button>/);
  doesNotMatch(detail(after), /id="cases-input"/);
  const groups = list(renderToString(page(state)));
  ok(groups.indexOf('class="feed-group">Done<') < groups.indexOf("case%3A1"));
  state.cases.dispose();
});

Deno.test("the selected Request stays isolated while Main still folds sub-operator exchanges", () => {
  const state = pageState();
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:1" }));
  const scopedThread = detail(html);
  match(scopedThread, /Find AI training offers/);
  doesNotMatch(scopedThread, /class="exchange"|Twelve offers found/);
  const thread = renderToString(
    <ChatView
      state={state}
      active
      conversation={state.agentConversations.snapshot.value!.conversations[0]}
      target={{ caseId: "ui-fixture:case:1" }}
      idPrefix="cases-"
      placeholder="Reply…"
    />,
  );
  match(thread, /Find AI training offers/);
  match(thread, /I asked Collecteur to gather sources\./);
  // Not the designer's conversation, not another Request's.
  doesNotMatch(
    thread,
    /Unrelated earlier note|Watch the prices|Price page read/,
  );
  // The specialist's exchange is one line that opens in place.
  match(
    thread,
    /<details class="exchange"[^>]*><summary class="change-row">[\s\S]*?<span class="ctitle">Collecteur · 2 messages<\/span>/,
  );
  match(thread, /Twelve offers found\.[\s\S]*Sources ranked\./);
  match(thread, /href="\/chat\?agent=collector">Open conversation</);
  // The composer answers in this Request, with its own ids.
  match(thread, /id="cases-input"[^>]*placeholder="Reply…"/);
  // The other Request has its own, one message long.
  const second = renderToString(
    <ChatView
      state={state}
      active
      conversation={state.agentConversations.snapshot.value!.conversations[0]}
      target={{ caseId: "ui-fixture:case:2" }}
    />,
  );
  match(second, /Watch the prices/);
  match(second, /Collecteur · 1 message</);
  doesNotMatch(second, /Find AI training offers|Twelve offers found/);
  state.cases.dispose();
});

Deno.test("a Case named by the address and not read yet shows no field", () => {
  const state = pageState();
  const html = renderToString(page(state, { selectedId: "ui-fixture:case:9" }));
  match(detail(html), /class="cases-note" role="status">Loading…</);
  doesNotMatch(detail(html), /<textarea/);
  // The way back stays, so a missing Case is never a dead end.
  match(html, /<a class="cases-back" href="\/cases">/);
  doesNotMatch(html, /cases-detail-head|cases-list/);
  state.cases.dispose();
});

Deno.test("before the Cases are read, the list says so", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(page(state as never));
  match(list(html), /class="cases-note" role="status">Loading…</);
  state.cases.dispose();
});

/** Research owns Request 2, opened by the designer; it asks for one more host. */
function operatorPage(options: { status?: string } = {}) {
  const request = "ui-fixture:case:2";
  const asks = grant({
    id: "network",
    requestedBy: "native:research",
    caseId: request,
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const roster = operatorRoster([], [asks]);
  roster.conversations[0].messages = [{
    id: "designer-request-objective",
    role: "user",
    text: "A separate Request owned by Designer.",
    at: "2026-10-24T10:00:00Z",
    caseId: "ui-fixture:case:1",
  }];
  roster.conversations[1].messages = [{
    id: `${request}:objective`,
    role: "tool",
    text: "Ask the designer for permission to read example.org.",
    at: "2026-10-24T11:00:00Z",
    caseId: request,
  }];
  state.agentConversations.accept(roster);
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [
      caseRecord(1, { owner: "native:designer", openedBy: "native:designer" }),
      caseRecord(2, {
        owner: "native:research",
        openedBy: "native:designer",
        objective: "Ask the designer for permission to read example.org.",
        ...(options.status ? { status: options.status } : {}),
      }),
    ],
  });
  seedRequestCases(state, state.cases.snapshot.value!, roster);
  // What the Request's operator asked is read from the Request's conversation.
  const decisions = state.requestDecisions.value;
  const render = (selectedId: string | null) =>
    renderToString(
      <CasesPage
        state={state}
        active
        selectedId={selectedId}
        decisions={decisions}
        onStarted={() => {}}
        onBack={() => {}}
        now={NOW}
      />,
    );
  return { state, decisions, render };
}

Deno.test("an operator's Request shows its owner's conversation: its change, and a field to reply", () => {
  const { state, decisions, render } = operatorPage();
  // The decision is recorded in the Request and leads there.
  deepStrictEqual(
    decisions.map((entry) => [entry.agentId, entry.caseId, entry.href]),
    [[
      "research",
      "ui-fixture:case:2",
      "/cases?case=ui-fixture%3Acase%3A2&agent=research",
    ]],
  );
  const html = render("ui-fixture:case:2");
  const thread = detail(html);
  // The owner is Research, not the designer whose thread is selected.
  deepStrictEqual(conversations(html).map((entry) => entry.text), [
    "Research 1 message",
  ]);
  match(thread, /aria-label="Research"/);
  match(thread, /Ask the designer for permission to read example\.org\./);
  match(thread, /<h3>Extend web access<\/h3>/);
  doesNotMatch(thread, />Accept<\/button>/);
  const mainThread = renderToString(
    <ChatView
      state={state}
      active
      conversation={state.agentConversations.snapshot.value!.conversations[1]}
      target={{ caseId: "ui-fixture:case:2" }}
    />,
  );
  match(mainThread, /<h3>Extend web access<\/h3>/);
  match(mainThread, /proposed by Research/);
  match(mainThread, />Accept<\/button>/);
  // Research has no general human entry, yet its open Request takes a reply.
  match(thread, /<textarea[^>]*id="cases-input"/);
  doesNotMatch(thread, /<textarea[^>]*disabled|conversation-readonly/);
  // The row of that Request, and no other, says it needs the person.
  const list = render(null);
  match(row(list, 2), /<span class="chip warn">needs you<\/span>/);
  match(row(list, 2), /class="rev-dot is-filled"/);
  doesNotMatch(row(list, 1), /needs you/);
  doesNotMatch(row(list, 1), /is-filled/);
  state.cases.dispose();
});

Deno.test("a closed operator Request has no field, and the other Request keeps the designer's thread", () => {
  const { state, render } = operatorPage({
    status: "closed-done",
  });
  doesNotMatch(detail(render("ui-fixture:case:2")), /<textarea/);
  const first = detail(render("ui-fixture:case:1"));
  equal(
    state.requests.conversation("ui-fixture:case:1")?.nativeId,
    "native:designer",
  );
  equal(
    state.requests.conversation("ui-fixture:case:2")?.nativeId,
    "native:research",
  );
  match(first, /aria-label="Designer"/);
  match(first, /A separate Request owned by Designer\./);
  doesNotMatch(
    first,
    /Extend web access|Ask the designer for permission to read example/,
  );
  state.cases.dispose();
});

Deno.test("a sub-agent's change waits in the Request it was asked in, beside its messages", () => {
  const state = pageState();
  const threads = structuredClone(state.agentConversations.snapshot.value!);
  threads.conversations[1].proposalContext = {
    configurationRevision: 1,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: ["ui-fixture:case:1", "ui-fixture:case:2"].map((caseId, index) =>
      grant({
        id: `change-${index}`,
        requestedBy: "native:collector",
        caseId,
      })
    ),
  };
  state.agentConversations.accept(threads);
  const html = renderToString(
    page(state, { selectedId: "ui-fixture:case:1", agentId: "collector" }),
  );
  const scoped = detail(html);
  match(scoped, /Twelve offers found\./);
  equal((scoped.match(/model-change is-pending/g) ?? []).length, 1);
  match(scoped, /data-proposal-id="change-collector-change-0"/);
  doesNotMatch(
    scoped,
    /data-proposal-id="change-collector-change-1"|>Accept<\/button>|>Decline<\/button>/,
  );
  const other = detail(renderToString(
    page(state, { selectedId: "ui-fixture:case:2", agentId: "collector" }),
  ));
  match(other, /Price page read\./);
  match(other, /data-proposal-id="change-collector-change-1"/);
  doesNotMatch(
    other,
    /data-proposal-id="change-collector-change-0"|>Accept<\/button>|>Decline<\/button>/,
  );
  const right = renderToString(
    <ChatView
      state={state}
      active
      conversation={state.agentConversations.snapshot.value!.conversations[1]}
      target={{ caseId: "ui-fixture:case:1" }}
    />,
  );
  match(right, /Twelve offers found\./);
  // Only the change asked in this Request, with its proposer's name.
  equal((right.match(/model-change is-pending/g) ?? []).length, 1);
  match(right, /proposed by Collecteur/);
  state.cases.dispose();
});

Deno.test("compact Request keeps the exact sub-operator read-only and a link back to the same selection", () => {
  const state = pageState();
  const html = renderToString(page(state, {
    selectedId: "ui-fixture:case:1",
    agentId: "collector",
    compact: true,
  }));
  match(html, /cases-page is-case is-compact/);
  match(
    html,
    /href="\/cases\?case=ui-fixture%3Acase%3A1&amp;agent=collector">Open full Request/,
  );
  match(html, /cases-selected-conversation">Collecteur/);
  match(detail(html), /Twelve offers found/);
  doesNotMatch(detail(html), /id="cases-input"|placeholder="Reply/);
  match(
    html,
    /href="\/model\?page=files&amp;caseBranch=ui-fixture%3Acase%3A1&amp;agent=collector">View model/,
  );
  // The existing tree and AgentPanel remain mounted, hidden by compact CSS.
  match(html, /class="case-tree"/);
  match(html, /class="agent-panel"/);
  state.cases.dispose();
});

Deno.test("selected Request initial refusal chip follows refreshed conversation presence and absence over stale cases cache", async () => {
  const state = pageState({
    cases: [
      caseRecord(1, { status: "waiting", initialExecutionOutcome: "refused" }),
    ],
    fetch: () => Promise.resolve(Response.json(latest)),
  });
  const caseId = "ui-fixture:case:1";
  const latest: ConversationsSnapshot = structuredClone(
    state.requests.snapshots.peek().get(caseId)!,
  );
  const render = () =>
    renderToString(
      <CasesPage
        state={state}
        active={false}
        selectedId={caseId}
        decisions={[]}
        onStarted={() => {}}
        onBack={() => {}}
        now={NOW}
      />,
    );
  doesNotMatch(render(), /Initial execution refused/);
  latest.conversations.find((agent) => agent.agentId === latest.defaultAgentId)!
    .initialExecutionOutcome = "refused";
  await state.requests.refresh(caseId);
  const refused = render();
  match(refused, /Initial execution refused/);
  match(refused, /<span class="chip">Waiting<\/span>/);
  delete latest.conversations.find((agent) =>
    agent.agentId === latest.defaultAgentId
  )!.initialExecutionOutcome;
  await state.requests.refresh(caseId);
  doesNotMatch(render(), /Initial execution refused/);
  equal(
    state.requests.cases.byId(caseId)?.initialExecutionOutcome,
    "refused",
    "stale list cache cannot revive the chip",
  );
  equal(state.requests.cases.byId(caseId)?.status, "waiting");
  state.dispose();
});
