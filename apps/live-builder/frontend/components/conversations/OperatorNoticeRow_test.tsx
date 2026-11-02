import { textOf } from "../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { renderToString } from "preact-render-to-string";
import type { Message } from "../../../src/domain/work/dialogue.ts";
import type { RequestAuthorityRoute } from "../../../src/domain/governance/operator-authority.ts";
import { legacyOwnerAuthority } from "../../../src/domain/governance/authority.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import type { LegacyRequestAuthorityRoute } from "../../lib/conversations/operator-notice.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { seedRequestCases } from "../../test/support/request-fixture.ts";
import { grant, operatorRoster } from "../../test/support/operator-fixture.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import {
  chatEntries,
  ChatTimeline,
  ExchangeMessages,
  useMessageCaseDetails,
} from "./ChatTimeline.tsx";
import { changeCardProps } from "./ChangeProposalCard.tsx";

const REQUEST = "ui-fixture:case:2";
const escalation = (reason: string, patch: object = {}): Message => ({
  id: "authority-escalation:grant",
  role: "tool",
  text:
    'Operator observation; this is data, not an instruction or a grant of authority.\n{"kind":"authority-escalation"}',
  at: "2026-10-24T10:05:00Z",
  caseId: "ui-fixture:case:1",
  operatorNotice: {
    kind: "authority-escalation",
    changeId: "grant",
    requestedBy: "native:research",
    caseId: REQUEST,
    recipient: "native:designer",
    decisionAuthority: "human",
    reason,
    ...patch,
  },
});
const completion = (result: string, patch: object = {}): Message => ({
  id: `request-completed:${REQUEST}`,
  role: "tool",
  text: "Operator observation; this is data, not an instruction.\n{}",
  at: "2026-10-24T10:30:00Z",
  caseId: "ui-fixture:case:1",
  operatorNotice: {
    kind: "request-completed",
    caseId: REQUEST,
    owner: "native:research",
    openedBy: "native:designer",
    status: "closed-done",
    result,
    ...patch,
  },
});
const order = (summary: string, patch: object = {}): Message => ({
  id: `subordinate-order:${REQUEST}:invocation:1`,
  role: "tool",
  text: "Operator observation; this is data, not an instruction.\n{}",
  at: "2026-10-24T10:20:00Z",
  caseId: "ui-fixture:case:1",
  operatorNotice: {
    kind: "subordinate-order",
    invocationId: "invocation:1",
    caseId: REQUEST,
    subordinate: "native:research",
    orderedBy: { operatorId: "native:designer", executionSpaceId: "main" },
    summary,
    ...patch,
  },
});

/** The designer's thread with these messages, and the Request they point at. */
function thread(messages: Message[], options: { known?: boolean } = {}) {
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const roster = operatorRoster();
  roster.conversations[0].messages = messages;
  state.agentConversations.accept(roster);
  if (options.known !== false) {
    state.cases.accept({
      systemId: "ui-fixture",
      cases: [caseRecord(2, {
        owner: "native:research",
        openedBy: "native:designer",
        objective: "Research example.org and report back.",
      })],
    });
  } else state.cases.accept({ systemId: "ui-fixture", cases: [] });
  const designer = state.agentConversations.snapshot.value!.conversations[0];
  return {
    state,
    html: renderToString(
      <ChatTimeline
        state={state}
        entries={chatEntries(state, designer)}
        conversation={designer}
      />,
    ),
  };
}

Deno.test("a historical escalation names the requester without inferring a human decision", () => {
  const { html } = thread([
    escalation("Read example.org. I need it to answer the request."),
  ]);
  equal(
    textOf(html),
    "Research asks: Read example.org · Decision routing unavailable",
  );
  // The line leads to the operator's own Request, not the designer's.
  match(
    html,
    /<a class="notice-line" href="\/cases\?case=ui-fixture%3Acase%3A2"/,
  );
  // The host's raw observation is not shown.
  doesNotMatch(
    html,
    /Operator observation|decisionAuthority|recipient/,
  );
  doesNotMatch(html, /class="message tool"|<details/);
});

Deno.test("recorded hierarchy routing names exact operators and distinguishes a route from current rights", () => {
  const route: LegacyRequestAuthorityRoute = {
    version: 1,
    changeId: "grant",
    caseId: REQUEST,
    requestedBy: "native:research",
    targetOperatorId: "native:research",
    baseRevision: 1,
    modelDigest: "digest",
    responsibleOperatorId: "native:research-owner",
    status: "actor-decision",
    designatedDecider: {
      operatorId: "native:designer",
      policyId: "grant:network",
      policyRevision: 2,
    },
    trace: [
      { operatorId: "native:research-owner", eligibility: "not-covered" },
      {
        operatorId: "native:designer",
        eligibility: "eligible",
        policyId: "grant:network",
        policyRevision: 2,
      },
    ],
  };
  const { html } = thread([escalation("Read example.org", {
    route,
    decisionAuthority: "operator",
  })]);
  match(textOf(html), /Forwarded by native:research-owner to Designer/);
  match(textOf(html), /Route recorded; eligibility is rechecked on decision/);
  match(
    textOf(html),
    /native:research-owner: no covering grant → Designer: grant:network revision 2/,
  );
  doesNotMatch(
    html,
    /waiting for you|Human decision|<button|>Accept<|>Decline</,
  );
  const human = thread([escalation("Read example.org", {
    decisionAuthority: "human",
    route: {
      ...route,
      status: "human-decision",
      designatedDecider: undefined,
      trace: route.trace.map((hop) => ({ ...hop, eligibility: "not-covered" })),
    },
  })]).html;
  match(textOf(human), /Human decision requested/);
  doesNotMatch(human, /waiting for you|Forwarded/);
  const unresolved = thread([escalation("Read example.org", {
    decisionAuthority: "unresolved",
    route: {
      ...route,
      status: "needs-resolution",
      designatedDecider: undefined,
      trace: [],
    },
  })]).html;
  match(textOf(unresolved), /Routing needs resolution/);
  doesNotMatch(unresolved, /Human decision|waiting for you/);
});

/** The same hierarchy as version 1, in the main space of version 2. */
const MAIN_SPACE = { projectId: "project", systemId: "system" };
const mainRoute = (patch: Partial<RequestAuthorityRoute> = {}) => ({
  version: 2,
  changeId: "grant",
  caseId: REQUEST,
  requestedBy: "native:research",
  requester: {
    ...MAIN_SPACE,
    executionSpaceId: "main",
    operatorId: "native:research",
  },
  targetOperatorId: "native:research",
  baseRevision: 1,
  modelDigest: "digest",
  responsibleOperatorId: "native:research-owner",
  status: "actor-decision",
  designatedDecider: {
    operatorId: "native:designer",
    executionSpaceId: "main",
    policyId: "grant:network",
    policyRevision: 2,
  },
  trace: [
    {
      operatorId: "native:research-owner",
      executionSpaceId: "main",
      eligibility: "not-covered",
    },
    {
      operatorId: "native:designer",
      executionSpaceId: "main",
      eligibility: "eligible",
      policyId: "grant:network",
      policyRevision: 2,
    },
  ],
  ...patch,
} satisfies RequestAuthorityRoute);

Deno.test("a version 2 route of the main space shows as a version 1 route does", () => {
  const route = mainRoute();
  const { html } = thread([escalation("Read example.org", {
    route,
    decisionAuthority: "operator",
  })]);
  match(
    textOf(html),
    /Research asks: Read example.org · Forwarded by native:research-owner to Designer/,
  );
  match(textOf(html), /Route recorded; eligibility is rechecked on decision/);
  match(
    textOf(html),
    /native:research-owner: no covering grant → Designer: grant:network revision 2/,
  );
  doesNotMatch(
    html,
    /Decision routing unavailable|waiting for you|Human decision|<button/,
  );
  const human = thread([escalation("Read example.org", {
    decisionAuthority: "human",
    route: {
      ...route,
      status: "human-decision",
      designatedDecider: undefined,
      trace: route.trace.map((hop) => ({ ...hop, eligibility: "not-covered" })),
    },
  })]).html;
  match(textOf(human), /Human decision requested/);
  doesNotMatch(human, /Decision routing unavailable|Forwarded/);
  // A version 2 route that is not exactly bound to its notice reads as none.
  const forged = thread([escalation("Read example.org", {
    route: { ...route, requester: { ...route.requester, operatorId: "other" } },
    decisionAuthority: "operator",
  })]).html;
  match(textOf(forged), /Decision routing unavailable/);
  doesNotMatch(forged, /Forwarded|<details/);
});

Deno.test("a route that needs resolution says why in words, never as its code", () => {
  const route = mainRoute({
    status: "needs-resolution",
    code: "MAIN_POLICY_UNREADABLE",
    reason: "Main's current policy is unavailable.",
    designatedDecider: undefined,
    trace: [],
  });
  const { html } = thread([escalation("Read example.org", {
    route,
    decisionAuthority: "unresolved",
  })]);
  match(
    textOf(html),
    /^Research asks: Read example.org · Routing needs resolution: Main's policy cannot be read/,
  );
  // The host's own reason stays in the route detail.
  match(textOf(html), /Main's current policy is unavailable\./);
  doesNotMatch(html, /MAIN_POLICY_UNREADABLE|Human decision/);
  // A code the route may not carry is no route.
  const stray = thread([escalation("Read example.org", {
    route: { ...route, code: "OTHER" },
    decisionAuthority: "unresolved",
  })]).html;
  match(textOf(stray), /Decision routing unavailable/);
  doesNotMatch(stray, /Routing needs resolution/);
});

Deno.test("a notice says on one line what was asked, as text only", () => {
  const asked = (hosts: string[]) =>
    thread([escalation("Read example.org", {
      changeKind: "mandate-change",
      requestedRights: { addNetworkHosts: hosts },
    })]).html;
  const html = asked(["example.org", "example.net"]);
  match(
    html,
    /<p class="notice-result" title="Extend web access: example.org, example.net">/,
  );
  match(
    textOf(html),
    /^Research asks: Read example.org · Decision routing unavailable Extend web access: example.org, example.net$/,
  );
  doesNotMatch(asked(["<img src=x onerror=attack()>"]), /<img/);
  // Recorded before the rights: no line.
  doesNotMatch(thread([escalation("Read example.org")]).html, /notice-result/);
});

Deno.test("initial configuration routes render on both responsible and decider notice copies", () => {
  const change = grant({
    id: "network:initial-team",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "native:leaf",
    caseId: REQUEST,
    baseRevision: 0,
    baseModelDigest: "initial-team-model",
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const route: LegacyRequestAuthorityRoute = {
    version: 1,
    changeId: change.id,
    caseId: REQUEST,
    requestedBy: change.requestedBy!,
    targetOperatorId: change.requestedBy!,
    baseRevision: change.baseRevision,
    modelDigest: change.baseModelDigest!,
    responsibleOperatorId: "native:research",
    status: "actor-decision",
    designatedDecider: {
      operatorId: "native:designer",
      policyId: "research-network",
      policyRevision: 1,
    },
    trace: [
      { operatorId: "native:research", eligibility: "not-covered" },
      {
        operatorId: "native:designer",
        eligibility: "eligible",
        policyId: "research-network",
        policyRevision: 1,
      },
    ],
  };
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const roster = operatorRoster();
  roster.conversations[0].name = "Main";
  roster.conversations[1].name = "Research owner";
  const leaf = structuredClone(roster.conversations[1]);
  leaf.agentId = "leaf";
  leaf.nativeId = "native:leaf";
  leaf.name = "Leaf analyst";
  leaf.proposalContext!.changes = [change];
  roster.conversations.push(leaf);
  for (const recipient of roster.conversations.slice(0, 2)) {
    const message = escalation("Read example.org", {
      changeId: change.id,
      requestedBy: change.requestedBy,
      recipient: recipient.nativeId,
      decisionAuthority: "operator",
      route,
    });
    // The producer places the responsible copy on the Request and the Main
    // copy in its originating conversation; both carry the same exact route.
    message.caseId = recipient.primary ? undefined : REQUEST;
    recipient.messages = [message];
  }
  state.agentConversations.accept(roster);
  state.cases.accept({ systemId: current.id, cases: [] });
  for (
    const conversation of state.conversationSnapshot.value!.conversations.slice(
      0,
      2,
    )
  ) {
    const html = renderToString(
      <ChatTimeline
        state={state}
        conversation={conversation}
        entries={chatEntries(state, conversation)}
      />,
    );
    match(
      textOf(html),
      /Leaf analyst asks: Read example.org · Forwarded by Research owner to Main/,
    );
    match(textOf(html), /base revision 0/);
    match(textOf(html), /Main: research-network revision 1/);
    doesNotMatch(
      html,
      /Decision routing unavailable|waiting for you|Human decision/,
    );
  }
  state.dispose();
});

Deno.test("a thread presents only the latest notice assignment while retaining every journal message", () => {
  const route: LegacyRequestAuthorityRoute = {
    version: 1,
    changeId: "grant",
    caseId: REQUEST,
    requestedBy: "native:research",
    targetOperatorId: "native:research",
    baseRevision: 0,
    modelDigest: "digest",
    responsibleOperatorId: "native:owner",
    status: "actor-decision",
    designatedDecider: {
      operatorId: "native:designer",
      policyId: "network",
      policyRevision: 1,
    },
    trace: [{ operatorId: "native:owner", eligibility: "not-covered" }, {
      operatorId: "native:designer",
      eligibility: "eligible",
      policyId: "network",
      policyRevision: 1,
    }],
  };
  const nextRoute: LegacyRequestAuthorityRoute = {
    ...route,
    designatedDecider: {
      ...route.designatedDecider!,
      operatorId: "native:next",
    },
    trace: [route.trace[0]!, { ...route.trace[1]!, operatorId: "native:next" }],
  };
  const legacy = escalation("Legacy notice");
  const first = escalation("First route", {
    route,
    decisionAuthority: "operator",
  });
  const latest = escalation("Latest route", {
    route: nextRoute,
    decisionAuthority: "operator",
  });
  const olderLast = escalation("Older route appended last", {
    route,
    decisionAuthority: "operator",
  });
  const otherChange = escalation("Other change", {
    changeId: "other",
    route: { ...nextRoute, changeId: "other" },
    decisionAuthority: "operator",
  });
  const otherRecipient = escalation("Other recipient", {
    recipient: "native:owner",
    route: nextRoute,
    decisionAuthority: "operator",
  });
  legacy.at = "2026-10-24T10:00:00Z";
  first.at = latest.at = "2026-10-24T10:01:00Z";
  olderLast.at = "2026-10-24T10:00:30Z";
  const messages = [
    legacy,
    first,
    latest,
    olderLast,
    otherChange,
    otherRecipient,
  ];
  messages.forEach((message, index) => message.id = `notice:${index}`);
  const { html, state } = thread(messages);
  const assertLatest = (rendered: string) => {
    equal(rendered.match(/data-notice="authority-escalation"/g)?.length, 3);
    match(
      textOf(rendered),
      /Research asks: Latest route · Forwarded by native:owner to native:next/,
    );
    match(textOf(rendered), /Other change/);
    match(textOf(rendered), /Other recipient/);
    doesNotMatch(
      textOf(rendered),
      /Legacy notice|First route|Older route appended last|Decision routing unavailable/,
    );
  };
  assertLatest(html);
  assertLatest(
    renderToString(<ExchangeMessages messages={messages} state={state} />),
  );
  equal(messages.length, 6);
  equal(state.conversationSnapshot.value!.conversations[0].messages.length, 6);
  equal(
    first.operatorNotice?.kind === "authority-escalation" &&
      first.operatorNotice.route,
    route,
  );
  state.dispose();
});

Deno.test("an escalation says what became of the change once the person decided it", () => {
  const declined = grant({
    id: "grant",
    status: "refused",
    requestedBy: "native:research",
    caseId: REQUEST,
  });
  const roster = operatorRoster([], [declined]);
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  roster.conversations[0].messages = [escalation("Read example.org")];
  state.agentConversations.accept(roster);
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  const designer = state.agentConversations.snapshot.value!.conversations[0];
  const html = renderToString(
    <ChatTimeline
      state={state}
      entries={chatEntries(state, designer)}
      conversation={designer}
    />,
  );
  equal(textOf(html), "Research asks: Read example.org · Declined");
});

Deno.test("an escalation names a delegated decider only from the exact recorded receipt", () => {
  const digest = "a".repeat(64);
  const requestedRights = { addNetworkHosts: ["example.org"] };
  const change = grant({
    id: "grant",
    requestedBy: "native:research",
    caseId: REQUEST,
    status: "approved",
    authority: "builder",
    baseModelDigest: digest,
    requestedRights,
    decidedAt: "2026-10-26T00:00:00Z",
    publishedCommit: "commit:" + "b".repeat(40),
    authorityExercise: {
      ...legacyOwnerAuthority("research-system"),
      ownerSource: "modeled",
      authoritySchema: 2,
      action: "mandate-change",
      baseModelDigest: digest,
      outOfMandate: false,
      delegation: {
        actorId: "native:designer",
        policyId: "research-network",
        policyRevision: 1,
        policyElementId: "policy:1",
        policyIssuer: {
          ...legacyOwnerAuthority("main-system"),
          ownerSource: "modeled",
        },
        requestedBy: "native:research",
        changeId: "grant",
        caseId: REQUEST,
        requestedRights,
      },
    },
  });
  const draw = (noticePatch: object = {}, duplicate = false) => {
    const current = snapshot();
    current.candidates = [];
    const state = createWorkbenchState({ initialState: current });
    const roster = operatorRoster([], [change]);
    roster.conversations[0].name = "Main Operator";
    roster.conversations[0].messages = [
      escalation("Read example.org", noticePatch),
    ];
    if (duplicate) {
      roster.conversations[1].proposalContext!.changes.push(
        structuredClone(change),
      );
    }
    state.agentConversations.accept(roster);
    state.cases.accept({ systemId: current.id, cases: [] });
    const conversation = state.conversationSnapshot.value!.conversations[0];
    const html = renderToString(
      <ChatTimeline
        state={state}
        conversation={conversation}
        entries={chatEntries(state, conversation)}
      />,
    );
    state.dispose();
    return html;
  };
  const exact = draw();
  match(
    textOf(exact),
    /Decided by Main Operator · research-network revision 1/,
  );
  doesNotMatch(exact, /<button|>Accept<|>Decline<|>Adjust</);
  for (
    const patch of [
      { requestedBy: "native:designer" },
      { caseId: "foreign-request" },
      { changeId: "foreign-change" },
    ]
  ) {
    const forged = draw(patch);
    match(textOf(forged), /Decision routing unavailable/);
    doesNotMatch(textOf(forged), /Decided by|Applied/);
  }
  const ambiguous = draw({}, true);
  match(textOf(ambiguous), /Decision routing unavailable/);
  doesNotMatch(textOf(ambiguous), /Decided by|Applied/);
  change.authorityExercise!.delegation!.requestedRights = {
    addNetworkHosts: ["example.net"],
  };
  doesNotMatch(
    textOf(draw()),
    /Decided by Main Operator|research-network revision 1/,
  );
});

/**
 * The designer's thread, with the notice of a Request the interface opened:
 * its operator runs apart from main, in the Request's own conversation, under
 * the native identity the roster gives the Main Operator.
 */
function branchThread(
  notice: Message,
  read: "pending" | "refused" = "pending",
) {
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const asked = (status: "pending" | "refused") =>
    grant({
      id: "grant",
      status,
      requestedBy: "native:research",
      caseId: REQUEST,
    });
  const main = operatorRoster([], [asked("pending")]);
  main.conversations[0].messages = [notice];
  main.conversations[1].name = "Main Operator";
  state.agentConversations.accept(main);
  // Main holds no Case of this Request: it is read in the Requests' space.
  state.cases.accept({ systemId: current.id, cases: [] });
  const branch = operatorRoster([], [asked(read)]);
  branch.conversations[1].name = "Branch Operator";
  seedRequestCases(
    state,
    {
      systemId: current.id,
      cases: [caseRecord(2, {
        owner: "native:research",
        openedBy: "native:designer",
        objective: "Research example.org and report back.",
      })],
    },
    branch,
  );
  const designer = state.agentConversations.snapshot.value!.conversations[0];
  return {
    state,
    name: branchOperatorName(state.requests.cases.byId(REQUEST)!),
    html: renderToString(
      <ChatTimeline
        state={state}
        entries={chatEntries(state, designer)}
        conversation={designer}
      />,
    ),
  };
}

Deno.test("an escalation from a Branch Operator names it, not the Main Operator, and leads to its Request", () => {
  const { html, name } = branchThread(escalation("Read example.org"));
  ok(name && name !== "Main Operator");
  equal(
    textOf(html),
    `${name} asks: Read example.org · Decision routing unavailable`,
  );
  match(
    html,
    /<a class="notice-line" href="\/cases\?case=ui-fixture%3Acase%3A2"/,
  );
  doesNotMatch(html, /Main Operator/);
});

Deno.test("an escalation says what became of the change in the Request's own conversation, not in main's", () => {
  const { html, name } = branchThread(
    escalation("Read example.org"),
    "refused",
  );
  // Main's roster still holds the change pending; the Request recorded it refused.
  equal(textOf(html), `${name} asks: Read example.org · Declined`);
  const pending = branchThread(escalation("Read example.org"), "pending");
  equal(
    textOf(pending.html),
    `${pending.name} asks: Read example.org · Decision routing unavailable`,
  );
});

/** The Request's own space, and the Request owner: a Branch Operator in it. */
const BRANCH_SPACE = "request:2";
const branchRoute = (patch: Partial<RequestAuthorityRoute> = {}) => ({
  version: 2,
  changeId: "grant",
  caseId: REQUEST,
  requestedBy: "native:research",
  requester: {
    ...MAIN_SPACE,
    executionSpaceId: BRANCH_SPACE,
    operatorId: "native:research",
  },
  openingId: "opening:1",
  targetOperatorId: "native:research",
  baseRevision: 1,
  modelDigest: "digest",
  status: "human-decision",
  trace: [],
  reason: "Existing native-ID policies do not grant cross-space authority.",
  ...patch,
} satisfies RequestAuthorityRoute);

Deno.test("a version 2 route of a Branch Operator names it by its space, and leads to its Request", () => {
  const { html, name } = branchThread(escalation("Read example.org", {
    route: branchRoute(),
    decisionAuthority: "human",
    changeKind: "mandate-change",
    requestedRights: { addNetworkHosts: ["example.org"] },
  }));
  ok(name && name !== "Main Operator");
  match(
    textOf(html),
    new RegExp(
      `^${name} asks: Read example.org · Human decision requested Extend web access: example.org Decision route`,
    ),
  );
  match(textOf(html), /Route recorded; eligibility is rechecked on decision\./);
  match(
    html,
    /<a class="notice-line" href="\/cases\?case=ui-fixture%3Acase%3A2"/,
  );
  doesNotMatch(html, /Main Operator|Decision routing unavailable/);
});

Deno.test("a route through a Branch Operator to its Main Operator tells them apart by space", () => {
  // The Branch Operator and the Main Operator share one native ID; a leaf asks.
  const route = branchRoute({
    requestedBy: "native:leaf",
    requester: {
      ...MAIN_SPACE,
      executionSpaceId: BRANCH_SPACE,
      operatorId: "native:leaf",
    },
    targetOperatorId: "native:leaf",
    status: "actor-decision",
    responsibleOperatorId: "native:research",
    designatedDecider: {
      operatorId: "native:research",
      executionSpaceId: "main",
      policyId: "grant:network",
      policyRevision: 2,
    },
    trace: [{
      operatorId: "native:research",
      executionSpaceId: BRANCH_SPACE,
      eligibility: "not-covered",
    }, {
      operatorId: "native:research",
      executionSpaceId: "main",
      eligibility: "eligible",
      policyId: "grant:network",
      policyRevision: 2,
    }],
    reason: undefined,
  });
  const { html, name } = branchThread(escalation("Read example.org", {
    requestedBy: "native:leaf",
    route,
    decisionAuthority: "operator",
  }));
  ok(name && name !== "Main Operator");
  match(
    textOf(html),
    new RegExp(
      `^native:leaf asks: Read example.org · Forwarded by ${name} to Main Operator `,
    ),
  );
  match(
    textOf(html),
    new RegExp(
      `${name}: no covering grant → Main Operator: grant:network revision 2`,
    ),
  );
  doesNotMatch(html, /<button|waiting for you|Human decision/);
  // The same route with no space on its hops is not a route: the Request's
  // owner could not be told from its Main Operator.
  const spaceless = branchThread(escalation("Read example.org", {
    requestedBy: "native:leaf",
    route: {
      ...route,
      trace: route.trace.map(({ executionSpaceId: _, ...hop }) => hop),
    },
    decisionAuthority: "operator",
  })).html;
  match(textOf(spaceless), /Decision routing unavailable/);
  doesNotMatch(spaceless, /Forwarded/);
});

Deno.test("a Branch Operator's route that needs resolution says why in words", () => {
  const { html, name } = branchThread(escalation("Read example.org", {
    route: branchRoute({
      status: "needs-resolution",
      code: "MAIN_UNAVAILABLE",
      reason: "Main is unavailable; availability is not absence of authority",
    }),
    decisionAuthority: "unresolved",
  }));
  match(
    textOf(html),
    new RegExp(
      `^${name} asks: Read example.org · Routing needs resolution: Main is unavailable `,
    ),
  );
  doesNotMatch(html, /MAIN_UNAVAILABLE/);
});

Deno.test("a Branch Operator's completion names it and its Request", () => {
  const { html, name } = branchThread(completion("Both hosts answered."));
  equal(
    textOf(html),
    `${name} finished Research example.org and report back · Done Both hosts answered.`,
  );
});

Deno.test("a completion names the operator, the Request and its outcome, with the result clamped", () => {
  const result = "Both hosts answered. " + "The details are long. ".repeat(40);
  const { html } = thread([completion(result)]);
  match(
    textOf(html),
    /^Research finished Research example\.org and report back · Done Both hosts answered\./,
  );
  match(html, /href="\/cases\?case=ui-fixture%3Acase%3A2"/);
  // Two lines on screen, the whole text in the tooltip.
  match(
    html,
    /<p class="notice-result" title="Both hosts answered\. The details/,
  );
  const full = html.match(/<p class="notice-result" title="([^"]*)"/)?.[1];
  equal(full?.length, result.length);
  const abandoned = thread([completion("Stopped early", {
    status: "closed-abandoned",
  })]).html;
  match(textOf(abandoned), /finished .* · Abandoned Stopped early$/);
  doesNotMatch(thread([completion("")]).html, /notice-result/);
});

Deno.test("an order given to a sub-operator names both operators and its first sentence, and leads to its Request", () => {
  const text = "Read example.org. Then compare it with example.net.";
  const { html } = thread([order(text)]);
  equal(
    textOf(html),
    "Designer gave Research an order · Read example.org",
  );
  match(html, /data-notice="subordinate-order"/);
  match(
    html,
    /<a class="notice-line" href="\/cases\?case=ui-fixture%3Acase%3A2" title="Read example\.org\. Then compare it with example\.net\."/,
  );
  // The host's raw observation is not shown, and no second line.
  doesNotMatch(
    html,
    /Operator observation|<details|notice-result|class="message tool"/,
  );
  // An order with no text still names who gave it to whom.
  equal(textOf(thread([order("")]).html), "Designer gave Research an order");
});

Deno.test("an order names the Main Operator by its space, not the Branch Operator that shares its identity", () => {
  // In a Request thread, the Branch Operator and the Main Operator share one
  // native ID; the space of the one who ordered tells them apart.
  const fromMain = branchThread(order("Read example.org", {
    subordinate: "native:designer",
    orderedBy: { operatorId: "native:research", executionSpaceId: "main" },
  }));
  equal(
    textOf(fromMain.html),
    "Main Operator gave Designer an order · Read example.org",
  );
  const local = branchThread(order("Read example.org", {
    subordinate: "native:designer",
    orderedBy: { operatorId: "native:research" },
  }));
  ok(local.name && local.name !== "Main Operator");
  equal(
    textOf(local.html),
    `${local.name} gave Designer an order · Read example.org`,
  );
  match(
    local.html,
    /<a class="notice-line" href="\/cases\?case=ui-fixture%3Acase%3A2"/,
  );
});

Deno.test("an operator or Request the page does not know yet is named neutrally", () => {
  const { html } = thread([
    completion("Done", { owner: "native:ghost" }),
  ], { known: false });
  equal(textOf(html), "An operator finished its Request · Done Done");
  match(html, /href="\/cases\?case=ui-fixture%3Acase%3A2"/);
});

Deno.test("what the operator wrote is shown as text, never as markup", () => {
  const hostile = "<script>attack()</script> <img src=x onerror=attack()>";
  const { html } = thread([
    escalation(hostile),
    completion(hostile, { owner: "native:research" }),
    order(hostile),
  ]);
  doesNotMatch(html, /<script|<img/);
  match(html, /&lt;script(?:>|&gt;)attack\(\)&lt;\/script(?:>|&gt;)/);
  // The tooltip holds the text escaped as well.
  match(html, /title="&lt;script/);
});

Deno.test("a record that is not exactly a notice stays an ordinary tool message", () => {
  const odd = escalation("Read example.org");
  (odd.operatorNotice as { kind: string }).kind = "something-else";
  const { html } = thread([odd]);
  doesNotMatch(html, /operator-notice/);
  match(html, /View result/);
  const missing = escalation("Read example.org", { caseId: "" });
  doesNotMatch(thread([missing]).html, /operator-notice/);
  // An order that does not name who gave it is shown as it is recorded.
  doesNotMatch(
    thread([order("Read example.org", { orderedBy: {} })]).html,
    /operator-notice/,
  );
});

Deno.test("another agent's exchange shows a report as the same line", () => {
  const { state } = thread([]);
  const reports = [escalation("Read example.org")];
  const plain = renderToString(<ExchangeMessages messages={reports} />);
  match(plain, /Operator observation/);
  const rows = renderToString(
    <ExchangeMessages messages={reports} state={state} />,
  );
  equal(
    textOf(rows),
    "Research asks: Read example.org · Decision routing unavailable",
  );
});

Deno.test("the Request a report names is read when the page does not have it yet", async () => {
  const current = snapshot();
  current.candidates = [];
  current.messages = [escalation("Read example.org")];
  const paths: string[] = [];
  const state = createWorkbenchState({
    initialState: current,
    fetch: (path) => {
      paths.push(path);
      return Promise.resolve(Response.json(caseRecord(2)));
    },
  });
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  const documentBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {},
  });
  const root = {} as HTMLElement;
  function Probe() {
    useMessageCaseDetails(state, chatEntries(state));
    return null;
  }
  try {
    await act(() => render(h(Probe, {}), root));
    // The message's own Case, and the one of the operator's report.
    deepStrictEqual(paths.sort(), [
      "/api/cases/ui-fixture%3Acase%3A1",
      "/api/cases/ui-fixture%3Acase%3A2",
    ]);
  } finally {
    await act(() => render(null, root));
    state.cases.dispose();
    if (documentBefore) {
      Object.defineProperty(globalThis, "document", documentBefore);
    } else Reflect.deleteProperty(globalThis, "document");
  }
});

/** The Main Operator's thread with a v2 notice of a Branch Operator's network
 * request, and that request recorded in the Request's own conversation. */
function relayedThread(
  decisionAuthority: "human" | "operator",
  notices = 1,
) {
  const network = (status: "pending" | "approved") =>
    grant({
      id: "grant",
      status,
      requestedBy: "native:research",
      caseId: REQUEST,
      baseModelDigest: "a".repeat(64),
      requestedRights: { addNetworkHosts: ["example.org"] },
    });
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  const main = operatorRoster([], []);
  const notice = (index: number) =>
    escalation("Read example.org", {
      route: branchRoute({
        status: decisionAuthority === "human"
          ? "human-decision"
          : "actor-decision",
        ...(decisionAuthority === "operator"
          ? {
            designatedDecider: {
              operatorId: "native:designer",
              executionSpaceId: "main",
              policyId: "bo-network",
              policyRevision: 1,
            },
            responsibleOperatorId: "native:designer",
            trace: [{
              operatorId: "native:designer",
              executionSpaceId: "main",
              eligibility: "eligible" as const,
              policyId: "bo-network",
              policyRevision: 1,
            }],
          }
          : {}),
        baseRevision: index,
      }),
      decisionAuthority,
      changeKind: "mandate-change",
      requestedRights: { addNetworkHosts: ["example.org"] },
    });
  main.conversations[0].messages = Array.from(
    { length: notices },
    (_, index) => ({
      ...notice(index + 1),
      id: `authority-escalation:grant:v2:${index}`,
      at: `2026-10-24T10:0${index + 5}:00Z`,
    }),
  );
  state.agentConversations.accept(main);
  state.cases.accept({ systemId: current.id, cases: [] });
  const branch = operatorRoster([], [network("pending")]);
  // A Request's conversation names its operator by its native identity.
  branch.conversations[1].agentId = "native:research";
  seedRequestCases(
    state,
    {
      systemId: current.id,
      cases: [caseRecord(2, {
        owner: "native:research",
        openedBy: "native:designer",
        objective: "Research example.org and report back.",
      })],
    },
    branch,
  );
  const designer = state.agentConversations.snapshot.value!.conversations[0];
  return {
    state,
    name: branchOperatorName(state.requests.cases.byId(REQUEST)!),
    html: renderToString(
      <ChatTimeline
        state={state}
        entries={chatEntries(state, designer)}
        conversation={designer}
      />,
    ),
  };
}

Deno.test("4.8d D5: a relayed request for the person shows the Case's own card, with the BO's name and its decision", () => {
  const { html, name } = relayedThread("human");
  const cards = html.match(/id="change-native:research-grant"/g) ?? [];
  equal(cards.length, 1, "the Case card, once");
  match(textOf(html), new RegExp(name));
  match(html, />Accept</);
  doesNotMatch(html, /not available for decision here/);
});

Deno.test("4.8d D5: a request the MO decides under its mandate is relayed read-only", () => {
  const { html } = relayedThread("operator");
  equal((html.match(/id="change-native:research-grant"/g) ?? []).length, 1);
  match(html, /Main Operator decides this request under its mandate/);
});

Deno.test("4.8d D5: two notices of one change relay one card", () => {
  const { html } = relayedThread("human", 2);
  equal((html.match(/id="change-native:research-grant"/g) ?? []).length, 1);
});

Deno.test("4.8d D5: the relayed card decides through the Case card's own command", async () => {
  const { state } = relayedThread("human");
  const calls: unknown[][] = [];
  state.decideOperatorChange = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(true);
  };
  const conversation = state.requests.snapshots.value.get(REQUEST)!
    .conversations.find((agent) => agent.nativeId === "native:research")!;
  const change = conversation.proposalContext!.changes[0];
  await changeCardProps(state, conversation, change, REQUEST, true)
    .onDecide("approve");
  deepStrictEqual(calls, [[conversation, "grant", "approve", REQUEST]]);
});
