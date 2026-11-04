import { parse, within } from "../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import {
  caseExchanges,
  changedSource,
  chatEntries,
  type ChatEntry,
  ChatTimeline,
  entriesFor,
  ExchangeMessages,
  ToolProposalCard,
  useMessageCaseDetails,
  withExchanges,
} from "./ChatTimeline.tsx";
import {
  cannotAdjust,
  changeCardProps,
  ChangeProposalCard,
  sendAdjustment,
} from "./ChangeProposalCard.tsx";
import type { SourceProposal } from "../../lib/model/revisions/api.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import {
  creation,
  grant,
  operatorRoster,
} from "../../test/support/operator-fixture.ts";
import { changeDifferences } from "../../lib/conversations/proposal-differences.ts";
import {
  ChatProposalCard,
  type ChatProposalCardProps,
} from "./ChatProposalCard.tsx";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { recordingState } from "../../test/support/recording-state.ts";
import { withAdjustment } from "../../test/support/adjustment-probe.tsx";
import { MAX_USER_MESSAGE_CHARS } from "../../../src/domain/work/records/conversations.ts";

const conversation = (id: string): AgentConversation => ({
  agentId: id,
  nativeId: id,
  name: id,
  primary: id === "alpha",
  canSend: true,
  busy: false,
  revision: 7,
  modelDigest: "digest",
  responsibility: "",
  phase: "Prêt",
  messages: [],
});

Deno.test("Main keeps questions and human decisions, hides information, and leaves other threads and the journal intact", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const main = conversation("alpha");
  main.messages = [
    {
      id: "question",
      role: "assistant",
      at: "2026-11-03T10:00:00Z",
      text: "Which audience?",
    },
    {
      id: "done",
      role: "tool",
      at: "2026-11-03T10:01:00Z",
      text: "completion data",
      operatorNotice: {
        kind: "request-completed",
        caseId: "request-1",
        owner: "beta",
        openedBy: "alpha",
        status: "closed-done",
        result: "All done",
      },
    },
    {
      id: "order",
      role: "tool",
      at: "2026-11-03T10:02:00Z",
      text: "order data",
      operatorNotice: {
        kind: "subordinate-order",
        caseId: "request-1",
        invocationId: "invocation-1",
        subordinate: "beta",
        orderedBy: { operatorId: "alpha" },
        summary: "Read the page",
      },
    },
    {
      id: "human",
      role: "tool",
      at: "2026-11-03T10:03:00Z",
      text: "decision data",
      operatorNotice: {
        kind: "authority-escalation",
        caseId: "request-1",
        changeId: "human",
        recipient: "alpha",
        requestedBy: "beta",
        decisionAuthority: "human",
        reason: "Allow web access",
      },
    },
    {
      id: "operator",
      role: "tool",
      at: "2026-11-03T10:04:00Z",
      text: "operator decision data",
      operatorNotice: {
        kind: "authority-escalation",
        caseId: "request-1",
        changeId: "operator",
        recipient: "alpha",
        requestedBy: "beta",
        decisionAuthority: "operator",
        reason: "Delegate review",
      },
    },
  ];
  main.messages.push({
    id: "unresolved",
    role: "tool",
    text: "unresolved data",
    at: "2026-11-03T10:04:10Z",
    operatorNotice: {
      kind: "authority-escalation",
      caseId: "request-2",
      changeId: "unresolved",
      recipient: "alpha",
      requestedBy: "beta",
      decisionAuthority: "unresolved",
      reason: "Resolve this route",
    },
  }, {
    id: "abandoned",
    role: "tool",
    text: "abandoned data",
    at: "2026-11-03T10:04:20Z",
    operatorNotice: {
      kind: "request-completed",
      caseId: "request-3",
      owner: "beta",
      openedBy: "alpha",
      status: "closed-abandoned",
      result: "Attention required",
    },
  }, {
    id: "member",
    role: "tool",
    at: "2026-11-03T10:05:00Z",
    text: "Member return",
    work: {
      callerId: "alpha",
      targetNativeId: "beta",
      correlationId: "correlation",
      invocationId: "invocation",
      modelVersion: { digest: "digest", repositoryVersion: "commit" },
    },
  });
  const before = structuredClone(main.messages);
  const show = (primary: boolean, independentRequest = false) =>
    renderToString(
      <ChatTimeline
        state={state}
        entries={chatEntries(state, main)}
        conversation={{ ...main, primary }}
        independentRequest={independentRequest}
      />,
    );
  const html = show(true);
  match(html, /Which audience\?/);
  match(html, /Allow web access/);
  match(html, /Resolve this route/);
  match(html, /Attention required/);
  doesNotMatch(
    html,
    /All done|gave .* an order|Delegate review|completion data|Member return/,
  );
  match(show(false), /All done/);
  match(show(false), /Delegate review/);
  match(show(true, true), /completion data/);
  deepStrictEqual(main.messages, before);
});

Deno.test("an operator reassignment removes the superseded human request from Main", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const main = conversation("alpha");
  main.messages = (["human", "operator"] as const).map((authority, index) => ({
    id: authority,
    role: "tool",
    text: "record",
    at: `2026-11-04T00:0${index}:00Z`,
    operatorNotice: {
      kind: "authority-escalation",
      caseId: "request",
      changeId: "change",
      recipient: "alpha",
      requestedBy: "beta",
      decisionAuthority: authority,
      reason: `${authority} assignment`,
    },
  }));
  const html = renderToString(
    <ChatTimeline
      state={state}
      conversation={main}
      entries={chatEntries(state, main)}
    />,
  );
  doesNotMatch(html, /human assignment|operator assignment/);
  equal(main.messages.length, 2);
  state.dispose();
});

Deno.test("hidden Main notices neither split tool steps nor change the next message's Case chip", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const main = conversation("alpha");
  const step = (id: string) => ({
    id,
    role: "tool" as const,
    caseId: "request-1",
    text: `Step ${id}`,
    at: "2026-11-03T10:00:00Z",
  });
  const hidden = {
    id: "hidden",
    role: "tool" as const,
    caseId: "request-2",
    text: "done",
    at: "2026-11-03T10:01:00Z",
    operatorNotice: {
      kind: "request-completed" as const,
      caseId: "request-2",
      owner: "beta",
      openedBy: "alpha",
      status: "closed-done" as const,
      result: "Done",
    },
  };
  const messages = [step("one"), hidden, step("two"), {
    ...hidden,
    id: "another",
  }, {
    id: "answer",
    role: "assistant" as const,
    caseId: "request-1",
    text: "Answer",
    at: "2026-11-03T10:02:00Z",
  }];
  const html = renderToString(
    <ChatTimeline
      state={state}
      conversation={main}
      entries={messages.map((message) => ({
        kind: "message",
        at: message.at,
        id: message.id,
        message,
      }))}
    />,
  );
  equal((html.match(/class="tool-steps"/g) ?? []).length, 1);
  match(html, /2 steps/);
  equal((html.match(/class="case-chip"/g) ?? []).length, 1);
  doesNotMatch(html, /request-2/);
  state.dispose();
});

Deno.test("Retry applying acts once when ready, and says on hover why it waits for the session, a decision or the operator", async () => {
  const reply = Promise.withResolvers<Response>();
  let writes = 0;
  const status = {
    caseId: "C",
    changeId: "network",
    status: "blocked",
    canResume: true,
  };
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (_path, init) => {
      if (init?.method === "POST") {
        writes++;
        return reply.promise;
      }
      return Promise.resolve(Response.json(status));
    },
  });
  const change = grant({
    id: "network",
    status: "approved",
    requestedBy: "alpha",
    caseId: "C",
    baseModelDigest: "a".repeat(64),
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const owner = conversation("alpha");
  owner.proposalContext = {
    configurationRevision: 1,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [change],
  };
  const html = () =>
    renderToString(
      <ChangeProposalCard
        state={state}
        change={change}
        conversation={owner}
        caseId="C"
        independentRequest
      />,
    );
  state.requests.sessionReady.value = true;
  await state.loadCaseChangeStatus("C", "alpha", change.id);
  match(
    html(),
    /class="change-retry" disabled title="Reload the Request conversation before retrying/,
  );
  equal(await state.resumeCaseChange("C", "alpha", change.id), false);
  equal(writes, 0);
  const threads = {
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [{ ...owner, busy: true }],
  };
  state.requests.snapshots.value = new Map([["C", threads]]);
  match(
    html(),
    /class="change-retry" disabled title="The operator is processing a contribution/,
  );
  equal(await state.resumeCaseChange("C", "alpha", change.id), false);
  equal(writes, 0);
  state.requests.snapshots.value = new Map([["C", {
    ...threads,
    conversations: [owner],
  }]]);
  match(html(), /class="change-retry"\s*>Retry applying<\/button>/);
  state.pending.value = true;
  match(
    html(),
    /class="change-retry" disabled title="Another decision is in progress/,
  );
  equal(await state.resumeCaseChange("C", "alpha", change.id), false);
  equal(writes, 0);
  state.pending.value = false;
  state.requests.sessionReady.value = false;
  // Without the session the record is unread: no retry is offered at all.
  const unread = parse(html());
  equal(within(unread).queryByRole("button", { name: "Retry applying" }), null);
  const checking = within(unread).byText("Checking…");
  match(checking.getAttribute("title")!, /Connect the local session/);
  equal(checking.querySelector(".chip-steps"), null);
  state.requests.sessionReady.value = true;
  await state.loadCaseChangeStatus("C", "alpha", change.id);
  const applying = state.resumeCaseChange("C", "alpha", change.id);
  match(
    html(),
    /class="change-retry" disabled title="Applying is already in progress/,
  );
  equal(await state.resumeCaseChange("C", "alpha", change.id), false);
  equal(writes, 1);
  reply.resolve(
    Response.json({ ...status, status: "adopted", canResume: false }),
  );
  await applying;
  state.dispose();
});
Deno.test("timeline includes only owned candidates, preserving exact pending controls", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [conversation("alpha"), conversation("beta")],
  });
  state.operatorTools.accept({
    systemId: "ui-fixture",
    version: "v1",
    tools: ["alpha", "beta"].map((agentId) => ({
      agentId,
      agentName: agentId,
      revision: 7,
      candidate: {
        ...snapshot().candidates[0],
        name: `Outil ${agentId}`,
        requiredAuthority: "human",
      },
    })),
  });
  state.agentConversations.select("beta");
  const entries = chatEntries(state);
  equal(entries.length, 1);
  const html = renderToString(<ChatTimeline state={state} entries={entries} />);
  match(html, /Outil beta/);
  doesNotMatch(html, /Outil alpha/);
  match(html, />Before</);
  match(html, />After</);
  match(html, />Admit and integrate</);
  match(
    html,
    /This single admission records your agreement and starts automatic integration into the SysML model in a new Git revision, followed by activation\./,
  );
  equal(
    html.indexOf("This single admission") < html.indexOf("proposal-code-diff"),
    true,
  );
  doesNotMatch(html, />Accept<|>Publish</);
  match(html, />Decline</);
  match(html, />Adjust</);
  doesNotMatch(html, /href="\/revisions/);
});

Deno.test("the reusable tool card dispatches the exact owner's decision and Case adjustment", async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const conversations = {
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [conversation("alpha"), conversation("beta")],
  };
  const catalogue = {
    systemId: "ui-fixture",
    version: "v1",
    tools: ["alpha", "beta"].map((agentId) => ({
      agentId,
      agentName: agentId,
      revision: 7,
      candidate: {
        ...snapshot().candidates[0],
        name: `Tool ${agentId}`,
        caseId: "ui-fixture:case:3",
        requiredAuthority: "human" as const,
      },
    })),
  };
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path, init) => {
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return Promise.resolve(
          Response.json({ accepted: !path.endsWith("/decisions") }),
        );
      }
      return Promise.resolve(
        Response.json(
          path === "/api/operator-tools" ? catalogue : conversations,
        ),
      );
    },
  });
  state.agentConversations.accept(conversations);
  state.operatorTools.accept(catalogue);
  state.agentConversations.select("alpha");
  const props = ToolProposalCard({
    owner: catalogue.tools[1],
    conversation: conversations.conversations[1],
    state,
  }).props as ChatProposalCardProps;
  equal(props.disabled, false);
  equal(props.acceptLabel, "Admit and integrate");
  equal(await props.onDecide("refuse", "Exact request"), false);
  deepStrictEqual(posts[0], {
    path: "/api/conversations/beta/decisions",
    body: {
      candidateId: "c1",
      candidateDigest: "a".repeat(64),
      expectedRevision: 7,
      verdict: "refuse",
      reason: "Exact request",
    },
  });
  equal(
    await props.onAdjustment(props.adjustmentMessage("Narrow the scope")),
    true,
  );
  deepStrictEqual(posts[1], {
    path: "/api/conversations/beta/messages",
    body: {
      text: "Adjust the proposal “Tool beta” (c1):\nNarrow the scope",
      expectedRevision: 7,
      caseId: "ui-fixture:case:3",
    },
  });
  equal(state.selectedConversation.value?.agentId, "alpha");
});
Deno.test("historical before values never borrow the current network configuration", () => {
  const context: NonNullable<AgentConversation["proposalContext"]> = {
    configurationRevision: 2,
    before: {
      network: { allowedHosts: ["example.org"] },
      builder: { admissionAuthority: "human" },
    },
    changes: [],
  };
  const pending = {
    id: "network",
    kind: "mandate-change" as const,
    status: "pending" as const,
    baseRevision: 2,
    requestedAt: "now",
    reason: "Lire la source",
    requestedRights: { addNetworkHosts: ["example.net"] },
  };
  deepStrictEqual(changeDifferences(pending, context), [{
    id: "hosts",
    label: "Allowed sites",
    before: "example.org",
    after: "example.org\nexample.net",
  }]);
  deepStrictEqual(
    changeDifferences({ ...pending, status: "approved" }, context),
    [],
  );
  deepStrictEqual(
    changeDifferences({ ...pending, baseRevision: 1 }, context),
    [],
  );
});
Deno.test("proposal presentation escapes model content and keeps completed receipts collapsed", () => {
  const html = renderToString(
    <ChatProposalCard
      id="p"
      title="<script>title()</script>"
      status="Accepted"
      open={false}
      rows={[{
        id: "x",
        label: "Quota",
        before: "1",
        after: "<img onerror=x>",
      }]}
      onDecide={() => Promise.resolve(false)}
      adjustmentMessage={(text) => text}
      onAdjustment={() => Promise.resolve(false)}
    />,
  );
  doesNotMatch(html, /<script|<img|<details[^>]* open|>Accept</);
  match(html, /Accepted/);
  match(html, /&lt;img/);
});
Deno.test("source excerpts preserve every changed line and trim only equal surroundings", () => {
  deepStrictEqual(changedSource("a\nb\n1\nd\ne", "a\nb\n25\nd\ne"), {
    before: "b\n1\nd",
    after: "b\n25\nd",
  });
  deepStrictEqual(changedSource(undefined, "new\nfile"), {
    before: "",
    after: "new\nfile",
  });
});

Deno.test("timeline preserves a neutral Case link before a closed Case detail is read", async () => {
  const record = caseRecord(12, {
    status: "closed-done",
    closedAt: "2026-10-24T12:00:00Z",
    createdAt: "2026-10-24T10:00:00Z",
  });
  const current = snapshot();
  current.messages = [
    {
      ...current.messages[0],
      caseId: record.id,
    } as typeof current.messages[number],
  ];
  current.candidates = [];
  const paths: string[] = [];
  const state = createWorkbenchState({
    initialState: current,
    fetch: (path) => {
      paths.push(path);
      return Promise.resolve(Response.json(record));
    },
  });
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  const timeline = () =>
    renderToString(<ChatTimeline state={state} entries={chatEntries(state)} />);
  match(
    timeline(),
    /<a class="case-chip" href="\/cases\?case=ui-fixture%3Acase%3A12">Case<\/a>/,
  );
  doesNotMatch(timeline(), /Case #/);
  await state.cases.ensure(record.id);
  deepStrictEqual(paths, ["/api/cases/ui-fixture%3Acase%3A12"]);
  match(timeline(), />Objective 12<\/a>/);
});

Deno.test("message Case references load their missing detail through the Preact lifecycle", async () => {
  const record = caseRecord(12, {
    status: "closed-done",
    closedAt: "2026-10-24T12:00:00Z",
    createdAt: "2026-10-24T10:00:00Z",
  });
  const current = snapshot();
  current.messages = current.messages.map((message) => ({
    ...message,
    caseId: record.id,
  }));
  current.candidates = [];
  const paths: string[] = [];
  const state = createWorkbenchState({
    initialState: current,
    fetch: (path) => {
      paths.push(path);
      return Promise.resolve(Response.json(record));
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
    deepStrictEqual(paths, ["/api/cases/ui-fixture%3Acase%3A12"]);
    await state.cases.ensure(record.id);
    equal(state.cases.byId(record.id)?.number, 12);
    equal(state.cases.byId(record.id)?.status, "closed-done");
    const html = renderToString(
      <ChatTimeline state={state} entries={chatEntries(state)} />,
    );
    equal((html.match(/class="case-chip"/g) ?? []).length, 1);
    match(html, />Objective 12<\/a>/);
    await act(() => render(h(Probe, {}), root));
    equal(paths.length, 1);
  } finally {
    await act(() => render(null, root));
    state.cases.dispose();
    if (documentBefore) {
      Object.defineProperty(globalThis, "document", documentBefore);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

Deno.test("stale mandate proposal disables only acceptance and can still be refused", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const owner = conversation("alpha");
  owner.runtimeOwned = true;
  owner.proposalContext = {
    configurationRevision: 2,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [{
      id: "stale",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 1,
      requestedAt: "now",
      reason: "Host",
      requestedRights: { addNetworkHosts: ["example.org"] },
    }],
  };
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [owner],
  });
  const html = renderToString(
    <ChatTimeline state={state} entries={chatEntries(state)} />,
  );
  match(html, /<button[^>]*disabled[^>]*>Accept<\/button>/);
  match(html, /<button[^>]*>Decline<\/button>/);
  doesNotMatch(html, /<button[^>]*disabled[^>]*>Decline<\/button>/);
});

Deno.test("a Case's exchanges fold what the other agents said for it, one entry per agent", () => {
  const said = (id: string, at: string, caseId?: string) => ({
    id,
    role: "assistant" as const,
    text: `Text ${id}`,
    at,
    ...(caseId ? { caseId } : {}),
  });
  const alpha = conversation("alpha");
  alpha.messages = [said("a1", "2026-10-24T10:00:00Z", "case-1")];
  const beta = conversation("beta");
  beta.messages = [
    said("b0", "2026-10-24T09:00:00Z"),
    said("b1", "2026-10-24T10:05:00Z", "case-1"),
    said("b2", "2026-10-24T10:06:00Z", "case-1"),
    said("b3", "2026-10-24T10:07:00Z", "case-2"),
  ];
  const gamma = conversation("gamma");
  gamma.messages = [said("g1", "2026-10-24T11:00:00Z", "case-2")];
  const all = [alpha, beta, gamma];
  // The shown conversation is not its own exchange; only this Case's messages.
  const exchanges = caseExchanges(all, "case-1", alpha);
  deepStrictEqual(
    exchanges.map((entry) => [
      entry.id,
      entry.agent.agentId,
      entry.at,
      entry.messages.map((message) => message.id),
    ]),
    [["exchange:beta:case-1", "beta", "2026-10-24T10:05:00Z", ["b1", "b2"]]],
  );
  deepStrictEqual(caseExchanges(all, "case-3", alpha), []);

  // Placed where it started among the shown conversation's own entries.
  const entries = [10, 20].map((minute) => ({
    kind: "message" as const,
    id: `message:a${minute}`,
    at: `2026-10-24T10:${minute}:00Z`,
    message: said(`a${minute}`, `2026-10-24T10:${minute}:00Z`, "case-1"),
  }));
  deepStrictEqual(
    withExchanges(entries, exchanges).map((entry) => entry.id),
    ["exchange:beta:case-1", "message:a10", "message:a20"],
  );
  deepStrictEqual(withExchanges(entries, []).map((entry) => entry.id), [
    "message:a10",
    "message:a20",
  ]);
});

Deno.test("an exchange reads as one line, opens in place and offers the agent's own conversation", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const beta = conversation("beta");
  beta.name = "Collecteur <script>";
  beta.messages = ["one", "two", "three"].map((id, index) => ({
    id,
    role: "assistant" as const,
    text: `Message ${id} <b>`,
    at: `2026-10-24T10:0${index}:00Z`,
    caseId: "case-1",
  }));
  const html = renderToString(
    <ChatTimeline
      state={state}
      entries={caseExchanges([beta], "case-1", null)}
      conversation={conversation("alpha")}
    />,
  );
  match(
    html,
    /<details class="exchange" data-key="exchange:beta:case-1"><summary class="change-row">/,
  );
  match(html, /Collecteur &lt;script(?:>|&gt;) · 3 messages/);
  match(html, /Message one &lt;b(?:>|&gt;)/);
  doesNotMatch(html, /<details[^>]* open|<script|<b>/);
  match(html, /<a class="exchange-open" href="\/chat\?agent=beta">/);
});

Deno.test("a Case's own page links to no Case on its first message", () => {
  const current = snapshot();
  current.messages = [
    {
      ...current.messages[0],
      caseId: "ui-fixture:case:1",
    } as typeof current.messages[number],
  ];
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  const entries = chatEntries(state);
  match(
    renderToString(<ChatTimeline state={state} entries={entries} />),
    /class="case-chip"/,
  );
  doesNotMatch(
    renderToString(
      <ChatTimeline state={state} entries={entries} caseLinks={false} />,
    ),
    /case-chip/,
  );
});

/** Operators: changes with their diff, placed in their Case, adjusted there. */
const timeline = (
  state: ReturnType<typeof createWorkbenchState>,
  agentId: string,
) => {
  const agent = state.agentConversations.snapshot.value!.conversations.find((
    entry,
  ) => entry.agentId === agentId)!;
  return renderToString(
    <ChatTimeline
      state={state}
      entries={chatEntries(state, agent)}
      conversation={agent}
    />,
  );
};
const operatorState = (
  designer: PendingChange[] = [grant()],
  research: PendingChange[] = [creation({
    id: "network",
    requestedBy: "native:research",
    caseId: "ui-fixture:case:2",
  })],
) => {
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  state.agentConversations.accept(operatorRoster(designer, research));
  return state;
};

Deno.test("a change with its diff reads as a pull request; one without keeps Before and After", () => {
  const state = operatorState([
    grant(),
    {
      id: "hosts",
      kind: "mandate-change",
      status: "pending",
      baseRevision: 1,
      requestedAt: "2026-10-24T09:00:00Z",
      reason: "Read example.org",
      requestedRights: { addNetworkHosts: ["example.org"] },
    },
  ]);
  const html = timeline(state, "designer");
  // The pull request: kind, who proposed it, the diff and the controls.
  match(html, /<article class="chat-proposal model-change is-pending"/);
  match(html, /<h3>Allow model editing<\/h3>/);
  match(html, /proposed by Designer/);
  match(html, /d2h-wrapper/);
  // The change that carries no diff keeps the rows, in English.
  match(html, /<h3>Extend web access<\/h3>/);
  match(html, />Before<[\s\S]*>After</);
  match(html, /Allowed sites/);
  doesNotMatch(html, /Avant|Après|Accepter|Refuser|Ajuster/);
  equal((html.match(/>Accept<\/button>/g) ?? []).length, 2);
});

Deno.test("an operator's change is attributed to the operator named in the roster", () => {
  const state = operatorState();
  const html = timeline(state, "research");
  match(html, /<h3>Create operator Research<\/h3>/);
  match(html, /proposed by Research/);
  match(html, /Research request/);
  doesNotMatch(html, /native:research/);
});

const message = (id: string, at: string, caseId?: string): ChatEntry => ({
  kind: "message",
  id: `message:${id}`,
  at,
  message: {
    id,
    role: "assistant",
    text: id,
    at,
    ...(caseId ? { caseId } : {}),
  },
});

Deno.test("changes, tools and source proposals are placed by their recorded Case, then by adjacency", () => {
  const candidate = (patch: object) =>
    ({ ...snapshot().candidates[0], ...patch }) as never;
  const source = (id: string, patch: object) =>
    Object.assign({
      id,
      author: "agent:x",
      reason: "",
      baseVersion: "",
      createdAt: "",
      status: "proposed",
      sourceDigest: "",
    }, patch) as SourceProposal;
  const entries: ChatEntry[] = [
    message("a", "2026-10-24T10:00:00Z", "case-1"),
    // Adjacent to a message of case-1, yet recorded in case-2.
    {
      kind: "change",
      id: "change:other-case",
      at: "2026-10-24T10:01:00Z",
      change: { ...grant(), id: "other-case", caseId: "case-2" },
    },
    // Asked in the designer's own conversation, after a message of case-1.
    {
      kind: "change",
      id: "change:designer",
      at: "2026-10-24T10:02:00Z",
      change: {
        ...grant(),
        id: "designer",
        caseId: undefined,
        designerScopeId: "scope:1",
      },
    },
    // A historical record names nothing: it follows the message before it.
    {
      kind: "change",
      id: "change:historical",
      at: "2026-10-24T10:03:00Z",
      change: {
        ...grant(),
        id: "historical",
        caseId: undefined,
        requestedBy: undefined,
      },
    },
    {
      kind: "source",
      id: "source:in-case-2",
      at: "2026-10-24T10:04:00Z",
      proposal: source("in-case-2", { caseId: "case-2" }),
    },
    {
      kind: "source",
      id: "source:adjacent",
      at: "2026-10-24T10:05:00Z",
      proposal: source("adjacent", {}),
    },
    {
      kind: "tool",
      id: "tool:in-case-2",
      at: "2026-10-24T10:06:00Z",
      candidate: candidate({ caseId: "case-2" }),
    },
    {
      kind: "tool",
      id: "tool:designer",
      at: "2026-10-24T10:07:00Z",
      candidate: candidate({ designerScopeId: "scope:1" }),
    },
    message("b", "2026-10-24T10:08:00Z"),
    {
      kind: "change",
      id: "change:after-designer-message",
      at: "2026-10-24T10:09:00Z",
      change: {
        ...grant(),
        id: "late",
        caseId: undefined,
        requestedBy: undefined,
      },
    },
  ];
  const ids = (target: Parameters<typeof entriesFor>[1]) =>
    entriesFor(entries, target).map((entry) => entry.id.replace(/^\w+:/, ""));
  deepStrictEqual(ids({ caseId: "case-1" }), [
    "a",
    "historical",
    "adjacent",
  ]);
  deepStrictEqual(ids({ caseId: "case-2" }), [
    "other-case",
    "in-case-2",
    "in-case-2",
  ]);
  deepStrictEqual(ids("designer"), [
    "designer",
    "designer",
    "b",
    "after-designer-message",
  ]);
  deepStrictEqual(ids("new-case"), []);
});

Deno.test("an adjustment goes back to the Case of the change, and to no Case when it records none", async () => {
  const request = creation({
    id: "network",
    requestedBy: "native:research",
    caseId: "ui-fixture:case:2",
  });
  const scoped = grant({
    id: "scoped",
    caseId: undefined,
    designerScopeId: "scope:1",
  });
  const { state, posts } = recordingState(operatorRoster([scoped], [request]));
  const [designer, research] = state.agentConversations.snapshot.value!
    .conversations;
  // Research takes no message of its own, only in the Request it owns.
  equal(research.canSend, false);
  equal(cannotAdjust(research, undefined), true);
  equal(cannotAdjust(research, "ui-fixture:case:2"), false);
  const asking = changeCardProps(state, research, request);
  equal(
    await asking.onAdjustment(asking.adjustmentMessage("Fewer hosts")),
    true,
  );
  deepStrictEqual(posts.at(-1), {
    path: "/api/conversations/research/messages",
    body: {
      text:
        "Adjust the proposal “Create operator Research” (network):\nFewer hosts",
      expectedRevision: 3,
      caseId: "ui-fixture:case:2",
    },
  });
  // The designer's own scope has no Case: its thread, as before.
  const narrowing = changeCardProps(state, designer, scoped);
  equal(
    await narrowing.onAdjustment(narrowing.adjustmentMessage("Narrower")),
    true,
  );
  const body = posts.at(-1)!.body;
  equal(posts.at(-1)!.path, "/api/conversations/designer/messages");
  equal("caseId" in body, false);
  equal(
    body.text,
    "Adjust the proposal “Allow model editing” (scoped):\nNarrower",
  );
  // A named Case is never replaced by the draft or the selected thread.
  posts.length = 0;
  equal(
    await sendAdjustment(state, designer, "Again", "ui-fixture:case:1"),
    true,
  );
  deepStrictEqual(posts[0].body.caseId, "ui-fixture:case:1");
  equal(
    await sendAdjustment(state, null, "Nobody", "ui-fixture:case:1"),
    false,
  );
  // A busy agent cannot take it, and the card says so before it is tried.
  equal(cannotAdjust({ ...research, busy: true }, "ui-fixture:case:2"), true);
  equal(cannotAdjust(null, undefined), true);
});

/**
 * A change held by Research, its real card props over a real state, and the
 * declines the card makes noted with how many messages the host had by then.
 * The host refuses the messages when `accepting` is false; Research is busy
 * from the moment it is declined when `busyAfterDecline` is true.
 */
function researchAdjustment(
  { accepting = true, busyAfterDecline = false } = {},
) {
  const request = creation({
    id: "network",
    requestedBy: "native:research",
    caseId: "ui-fixture:case:2",
  });
  const roster = operatorRoster([], [request]);
  const { state, posts } = recordingState(roster, accepting);
  const research = state.agentConversations.snapshot.value!.conversations[1];
  const busy = {
    ...roster,
    conversations: roster.conversations.map((entry) =>
      entry.agentId === "research" ? { ...entry, busy: true } : entry
    ),
  };
  const declined: Array<{ reason?: string; messages: number }> = [];
  const props = {
    ...changeCardProps(state, research, request),
    onDecide: (_verdict: "approve" | "refuse", reason?: string) => {
      declined.push({ reason, messages: posts.length });
      if (busyAfterDecline) state.agentConversations.accept(busy);
      return Promise.resolve(true);
    },
  };
  return { props, state, roster, posts, declined };
}

const NOT_SENT =
  "The proposal was declined, but the request was not sent. Send it again.";

Deno.test("an adjustment is measured as the message the host receives, declined, then sent", async () => {
  const { props, posts, declined } = researchAdjustment();
  const prefix = props.adjustmentMessage("").length;
  const room = MAX_USER_MESSAGE_CHARS - prefix;
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    // The field alone is below the bound; with the sentence that names the
    // proposal the message is one character past it: nothing is declined or sent.
    await adjustment.type("y".repeat(room + 1));
    match(adjustment.form().html, /Message too long: 100,001 \/ 100,000/);
    match(adjustment.form().html, /type="submit"[^>]*disabled/);
    await adjustment.send();
    equal(posts.length, 0);
    equal(declined.length, 0);
    // At the bound exactly, the card declines with a short reason that
    // copies nothing, and the host then receives the whole message.
    await adjustment.type("y".repeat(room));
    await adjustment.send();
    deepStrictEqual(declined, [{
      reason: "Adjustment requested in the conversation.",
      messages: 0,
    }]);
    equal(posts.length, 1);
    equal(posts[0].path, "/api/conversations/research/messages");
    equal((posts[0].body.text as string).length, MAX_USER_MESSAGE_CHARS);
    equal(
      (posts[0].body.text as string).startsWith(
        "Adjust the proposal “Create operator Research” (network):\ny",
      ),
      true,
    );
    equal(adjustment.flow().error, "");
    equal(adjustment.flow().sent, true);
  });
});

Deno.test("a message the host refuses after the decline keeps the text, and a second press sends it without declining again", async () => {
  const { props, posts, declined } = researchAdjustment({ accepting: false });
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    await adjustment.type("Fewer hosts");
    await adjustment.send();
    equal(declined.length, 1);
    equal(posts.length, 1);
    equal(adjustment.flow().error, NOT_SENT);
    equal(adjustment.flow().adjusting, true);
    equal(adjustment.flow().sent, false);
    equal(adjustment.flow().adjustment, "Fewer hosts");
    await adjustment.send();
    equal(posts.length, 2);
    equal(declined.length, 1);
  });
});

Deno.test("an agent that became busy after the decline takes no message yet: the text waits in the form until it can", async () => {
  const { props, state, roster, posts, declined } = researchAdjustment({
    busyAfterDecline: true,
  });
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    await adjustment.type("Fewer hosts");
    await adjustment.send();
    equal(declined.length, 1);
    equal(posts.length, 0);
    equal(adjustment.flow().error, NOT_SENT);
    equal(adjustment.flow().adjusting, true);
    equal(adjustment.flow().adjustment, "Fewer hosts");
    // Idle again: the same press sends it, and the change is not declined twice.
    state.agentConversations.accept(roster);
    await adjustment.send();
    equal(declined.length, 1);
    equal(posts.length, 1);
    equal(posts[0].body.text, props.adjustmentMessage("Fewer hosts"));
    equal(adjustment.flow().sent, true);
  });
});

Deno.test("the Adjust control of a change follows what its conversation can take", () => {
  const request = creation({
    id: "network",
    requestedBy: "native:research",
    caseId: "ui-fixture:case:2",
  });
  const withoutCase = { ...request, caseId: undefined };
  const adjust = (change: typeof request) =>
    timeline(operatorState([], [change]), "research").match(
      /<button[^>]*class="proposal-adjust"[^>]*>/,
    )?.[0] ?? "";
  // In its Request, Research can be told what to change.
  equal(/disabled/.test(adjust(request)), false);
  // Outside any Case it has no general human entry.
  equal(/disabled/.test(adjust(withoutCase)), true);
});

Deno.test("team creation cards keep their originating Request and publication state", () => {
  const team = creation({
    name: "Evidence",
    diff: undefined,
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
      provision: {
        budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: {
      operatorId: "native:designer",
      requestId: "ui-fixture:case:1",
    },
  });
  const pending = timeline(operatorState([team], []), "designer");
  match(pending, /Create team operator Evidence/);
  match(pending, /To decide/);
  match(pending, /Originating Request: ui-fixture:case:1/);
  doesNotMatch(pending, /Request type/);
  const accepted = timeline(
    operatorState([{ ...team, status: "approved" }], []),
    "designer",
  );
  // Accepted, not yet published: applying, in the words every decision uses.
  const chip = parse(accepted).querySelector(".change-chip")!;
  equal(chip.textContent, "Applying");
  equal(chip.getAttribute("title"), "Decided ✓ · Saved · In service");
  equal(chip.querySelectorAll(".chip-steps span").length, 3);
  doesNotMatch(accepted, />Applied<|Accepted/);
  match(accepted, /Originating Request: ui-fixture:case:1/);
  const published = timeline(
    operatorState([{
      ...team,
      status: "approved",
      publishedCommit: "commit:published",
    }], []),
    "designer",
  );
  match(published, /Applied/);
  match(published, /Contributes within the same Request; no new Request/);
});

Deno.test("Main and Request timeline replies render exact-source Diagnostics anchors", () => {
  const version = `commit:${"a".repeat(40)}`;
  for (const caseId of [undefined, "request_123"]) {
    const state = createWorkbenchState({ initialState: snapshot() });
    const href = `/system?page=diagnostics&version=${
      encodeURIComponent(version)
    }${caseId ? `&caseBranch=${caseId}` : ""}`;
    const message = {
      id: "diagnostic-reply",
      role: "assistant" as const,
      text: `View [Diagnostics](${href}).`,
      at: "2026-10-30T00:00:00Z",
      ...(caseId ? { caseId } : {}),
    };
    const html = renderToString(
      <ChatTimeline
        state={state}
        caseLinks={false}
        entries={[
          { kind: "message", id: message.id, at: message.at, message },
        ]}
      />,
    );
    match(
      html,
      /<a href="\/system\?page=diagnostics&amp;version=commit%3A[a-f0-9]{40}/,
    );
    match(html, />Diagnostics<\/a>/);
    if (caseId) match(html, /&amp;caseBranch=request_123/);
    else doesNotMatch(html, /caseBranch/);
  }
});

Deno.test("a Case change without an exact Case scope cannot decide or adjust through Main", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const owner = conversation("alpha");
  const change: PendingChange = {
    id: "network",
    kind: "mandate-change",
    status: "pending",
    baseRevision: 1,
    requestedAt: "now",
    reason: "Host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  };
  owner.proposalContext = {
    configurationRevision: 1,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [change],
  };
  const props = changeCardProps(state, owner, change, undefined, true);
  equal(props.disabled, true);
  equal(props.adjustDisabled, true);
});

Deno.test("Case actions are offered only for the exact supported network proposal", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const owner = conversation("alpha");
  const network = grant({
    id: "network",
    requestedBy: "alpha",
    caseId: "case/C",
    baseModelDigest: "a".repeat(64),
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  owner.proposalContext = {
    configurationRevision: network.baseRevision,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" },
    },
    changes: [network],
  };
  const html = (change: PendingChange) =>
    renderToString(
      <ChatTimeline
        state={state}
        entries={[{
          kind: "change",
          id: change.id,
          at: change.requestedAt,
          change,
        }]}
        conversation={owner}
        independentRequest
        caseId="case/C"
      />,
    );
  match(html(network), />Accept<\/button>/);
  doesNotMatch(
    html(
      grant({
        requestedBy: "alpha",
        caseId: "case/C",
        baseModelDigest: "a".repeat(64),
      }),
    ),
    />Accept<\/button>|>Decline<\/button>/,
  );
  doesNotMatch(
    html({ ...network, caseId: "case/D" }),
    />Accept<\/button>|>Decline<\/button>/,
  );
  doesNotMatch(
    html({ ...network, requestedBy: "other" }),
    />Accept<\/button>|>Decline<\/button>/,
  );
});

const said = (
  id: string,
  role: "user" | "assistant" | "tool",
  text: string,
  caseId?: string,
): ChatEntry => ({
  kind: "message",
  id: `message:${id}`,
  at: "2026-11-03T10:00:00Z",
  message: {
    id,
    role,
    text,
    at: "2026-11-03T10:00:00Z",
    ...(caseId ? { caseId } : {}),
  },
});

Deno.test("host and tool records in a row fold into one line that keeps their exact texts", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(
    <ChatTimeline
      state={state}
      entries={[
        said("t1", "tool", '{"status":"waiting"}'),
        said("t2", "tool", "<b>**raw**</b>"),
        said("reply", "assistant", "**Done**"),
        said("t3", "tool", "later"),
      ]}
    />,
  );
  match(
    html,
    /<details class="tool-steps" data-key="message:t1"><summary><span aria-hidden="true">···<\/span> 2 steps<\/summary>/,
  );
  match(html, /<pre>\{&quot;status&quot;:&quot;waiting&quot;\}<\/pre>/);
  match(html, /<pre>&lt;b>\*\*raw\*\*&lt;\/b><\/pre>/);
  match(
    html,
    /<strong\s*>Done<\/strong>[\s\S]*data-key="message:t3"[\s\S]*1 step/,
  );
  doesNotMatch(html, /Tool result|View result|<details[^>]* open/);
});

Deno.test("a fold of host and tool records ends where the Case changes", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(
    <ChatTimeline
      state={state}
      caseLinks={false}
      entries={[
        said("a1", "tool", "first", "case-a"),
        said("a2", "tool", "second", "case-a"),
        said("b1", "tool", "third", "case-b"),
      ]}
    />,
  );
  match(html, /data-key="message:a1"><summary>[\s\S]*? 2 steps</);
  match(html, /data-key="message:b1"><summary>[\s\S]*? 1 step</);
});

Deno.test("the person's words stay as written; an agent's read as Markdown", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(
    <ChatTimeline
      state={state}
      entries={[
        said("asked", "user", "Keep **these** stars"),
        said("answered", "assistant", "Kept **these**"),
      ]}
    />,
  );
  match(html, /Keep \*\*these\*\* stars/);
  match(html, /Kept <strong\s*>these<\/strong>/);
});

Deno.test("another agent's exchange folds its records and reads its requests as Markdown", () => {
  const message = (id: string, role: "user" | "tool", text: string) => ({
    id,
    role,
    text,
    at: "2026-11-03T10:00:00Z",
  });
  const html = renderToString(
    <ExchangeMessages
      messages={[
        message("r1", "tool", "first record"),
        message("r2", "tool", "second record"),
        message("order", "user", "Review **these** hooks"),
      ]}
    />,
  );
  match(html, /data-key="message:r1"><summary>[\s\S]*? 2 steps</);
  doesNotMatch(html, /data-key="message:r2"/);
  match(html, /Review <strong\s*>these<\/strong> hooks/);
});
