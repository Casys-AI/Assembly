import { settle } from "../../test/support/settle.ts";
import { doesNotMatch, equal, match, ok } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ChatView } from "./ChatView.tsx";
import { press } from "../../test/support/press.ts";
import { recordingState } from "../../test/support/recording-state.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../src/domain/work/records/conversations.ts";
import { type ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
import { operatorRoster } from "../../test/support/operator-fixture.ts";
Deno.test("conversation renders untrusted content as text and tool output as collapsed details", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.draft.value = "Brouillon conservé";
  const html = renderToString(<ChatView state={state} active />);
  match(html, /&lt;script(?:>|&gt;)attack\(\)&lt;\/script(?:>|&gt;)/);
  match(html, /&lt;img src=x onerror=attack\(\)(?:>|&gt;)/);
  match(
    html,
    /<details class="tool-steps" data-key="message:m2"><summary><span aria-hidden="true">···<\/span> 1 step<\/summary>/,
  );
  match(html, /Brouillon conservé/);
  doesNotMatch(html, /<details[^>]* open/);
  doesNotMatch(html, /<script|<img/);
});

function conversations(): ConversationsSnapshot {
  return {
    systemId: "ui-fixture",
    defaultAgentId: "coordinator",
    version: "threads-1",
    conversations: [{
      agentId: "coordinator",
      nativeId: "native:coordinator",
      name: "Contact principal",
      responsibility: "Répartir le travail",
      primary: true,
      canSend: true,
      revision: 7,
      busy: true,
      phase: "Coordination en cours",
      modelDigest: "model",
      messages: [{
        id: "contact-message",
        role: "assistant",
        text: "Message du contact",
        at: "now",
      }],
    }, {
      agentId: "audit",
      nativeId: "native:audit",
      name: "<Relecteur>",
      responsibility: "Examiner le candidat exact",
      primary: false,
      canSend: false,
      readOnlyReason:
        "Ce mandat ne déclare pas d’entrée de conversation humaine.",
      revision: 3,
      busy: false,
      phase: "Revue enregistrée",
      modelDigest: "model",
      messages: [{
        id: "review-message",
        role: "assistant",
        text: "Seul l’avis du relecteur",
        at: "now",
      }],
    }],
  };
}

Deno.test("chat leaves the mission and mandate to the contextual panel", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const threads = conversations();
  const mission = `${
    "Consigne complète. ".repeat(150)
  }<script>attack()</script>`;
  threads.conversations[0].responsibility = mission;
  state.agentConversations.accept(threads);
  const html = renderToString(<ChatView state={state} active />);
  doesNotMatch(html, /Consigne complète/);
  doesNotMatch(html, /<script/);
});

Deno.test("the selected audit shows its own recorded messages without exposing the contact's draft or granting contact", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(conversations());
  state.draft.value = "Brouillon du contact";
  state.agentConversations.select("audit");
  const html = renderToString(<ChatView state={state} active />);
  doesNotMatch(html, /Conversations des agents/);
  match(html, /Seul l’avis du relecteur/);
  match(html, /&lt;Relecteur(?:>|&gt;)/);
  match(html, /Ce mandat ne déclare pas d’entrée de conversation humaine/);
  // The read-only reason replaces the composer instead of a disabled field.
  doesNotMatch(html, /<textarea|id="composer"/);
  ok(
    html.indexOf("Seul l’avis du relecteur") <
      html.indexOf("Ce mandat ne déclare pas d’entrée de conversation humaine"),
  );
  doesNotMatch(
    html,
    /Message du contact|Brouillon du contact|<script|<Relecteur>/,
  );
});

Deno.test("historical conversation never borrows current agent messages or names", async () => {
  const historical = { ...snapshot(), revision: 4 };
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () =>
      Promise.resolve(Response.json({ state: historical, projection: null })),
  });
  state.agentConversations.accept(conversations());
  await state.selectRevision(4);
  const html = renderToString(<ChatView state={state} active />);
  match(html, /Read-only · revision 4/);
  doesNotMatch(
    html,
    /Conversations des agents|Message du contact|Seul l’avis du relecteur|Répartir le travail/,
  );
});

Deno.test("chat does not display system-wide tool counts as agent permissions", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const threads = conversations();
  threads.conversations.push({
    ...threads.conversations[1],
    agentId: "worker",
    nativeId: "native:worker",
    name: "Collecteur",
    messages: [],
  });
  state.agentConversations.accept(threads);
  const candidate = {
    ...snapshot().candidates[0],
    id: "shared-artifact",
    stage: "active" as const,
  };
  state.operatorTools.accept({
    systemId: "ui-fixture",
    version: "catalog",
    tools: [
      { agentId: "audit", agentName: "Relecteur", revision: 3, candidate },
      { agentId: "worker", agentName: "Collecteur", revision: 6, candidate },
    ],
  });
  const html = renderToString(<ChatView state={state} active />);
  doesNotMatch(html, /3 agents, 2 active tools/);
});

Deno.test("Main leaves correlated work to Activity; other conversations keep its recorded role", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const threads = conversations();
  const work = {
    callerId: "native:worker",
    correlationId: "work",
    invocationId: "call",
    behaviorId: "access",
    targetNativeId: "target-action",
    modelVersion: { digest: "admitted", repositoryVersion: "branch:pinned" },
  };
  threads.conversations[0].messages = [{
    id: "request",
    role: "tool",
    text: "Dossier transmis",
    at: "now",
    work,
  }];
  state.agentConversations.accept(threads);
  const main = renderToString(<ChatView state={state} active />);
  doesNotMatch(main, /Dossier transmis|Work received|Work returned/);
  const audit = threads.conversations[1];
  audit.messages = threads.conversations[0].messages;
  const received = renderToString(
    <ChatView state={state} active conversation={audit} />,
  );
  match(received, /Work received/);
  match(received, /View received work/);
  doesNotMatch(received, /class="message-label">You|Tool result/);
  audit.messages[0].work!.callerId = audit.nativeId;
  state.agentConversations.accept(threads);
  const returned = renderToString(
    <ChatView state={state} active conversation={audit} />,
  );
  match(returned, /Work returned/);
  match(returned, /View returned work/);
  doesNotMatch(returned, /class="message-label">You|Tool result/);
  state.dispose();
});

Deno.test("messages read oldest first with the latest just above the composer, whatever their arrival order", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const threads = conversations();
  threads.conversations[0].busy = false;
  threads.conversations[0].messages = [
    {
      id: "late",
      role: "assistant",
      text: "Troisième",
      at: "2026-10-24T09:03:00Z",
    },
    { id: "early", role: "user", text: "Premier", at: "2026-10-24T09:01:00Z" },
    {
      id: "middle",
      role: "assistant",
      text: "Deuxième",
      at: "2026-10-24T09:02:00Z",
    },
  ];
  state.agentConversations.accept(threads);
  const html = renderToString(<ChatView state={state} active />);
  const first = html.indexOf("Premier");
  const second = html.indexOf("Deuxième");
  const third = html.indexOf("Troisième");
  ok(first > 0 && first < second && second < third);
  ok(html.indexOf('id="scroll"') < first);
  ok(third < html.indexOf('id="composer"'));
  ok(html.indexOf('id="composer"') < html.indexOf('id="input"'));
});

Deno.test("a view bound to another agent keeps its own draft, ids and send rights", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const threads = conversations();
  threads.conversations[1].canSend = true;
  state.agentConversations.accept(threads);
  state.draft.value = "Brouillon du contact";
  const audit = state.conversationSnapshot.value!.conversations[1];
  const html = renderToString(
    <ChatView state={state} active conversation={audit} idPrefix="agent-" />,
  );
  match(html, /Seul l’avis du relecteur/);
  match(html, /id="agent-input"/);
  match(html, /id="agent-composer"/);
  doesNotMatch(html, /id="input"|Brouillon du contact|Message du contact/);
  // The audit is idle and accepts human input, unlike the busy contact.
  doesNotMatch(html, /id="agent-input"[^>]*disabled/);
  equal(state.agentConversations.canSendTo("coordinator"), false);
  equal(state.agentConversations.canSendTo("audit"), true);
});

Deno.test("a bound view without its conversation never falls back to the central messages", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(conversations());
  const html = renderToString(
    <ChatView state={state} active conversation={null} idPrefix="agent-" />,
  );
  match(html, /This conversation is not available\./);
  doesNotMatch(html, /Message du contact|attack\(\)|<textarea/);
});

Deno.test("the composer speaks English", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(operatorRoster());
  const html = renderToString(<ChatView state={state} active />);
  match(html, /aria-label="Your message to Designer"/);
  match(html, /placeholder="Write to Designer…"/);
  match(html, /Enter to send · Shift \+ Enter for a new line/);
  match(html, /<span class="sr-only">Send<\/span>/);
  doesNotMatch(html, /Écrivez|Envoyer|Entrée|Votre message/);
});

Deno.test("an operator without a human entry offers a field only inside the open Request it owns", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(operatorRoster());
  const research = state.agentConversations.snapshot.value!.conversations[1];
  // Its general thread says why there is nothing to write in.
  const general = renderToString(
    <ChatView state={state} active conversation={research} />,
  );
  match(general, /This mandate receives requests from the coordinator\./);
  doesNotMatch(general, /<textarea/);
  // Its Request takes a reply, written to the operator, not to the designer.
  const request = renderToString(
    <ChatView
      state={state}
      active
      conversation={research}
      idPrefix="cases-"
      target={{ caseId: "ui-fixture:case:2" }}
      placeholder="Reply…"
    />,
  );
  match(request, /<textarea[^>]*id="cases-input"/);
  doesNotMatch(request, /<textarea[^>]*disabled|conversation-readonly/);
  // A closed Request has neither the field nor an explanation.
  const closed = renderToString(
    <ChatView
      state={state}
      active
      conversation={research}
      target={{ caseId: "ui-fixture:case:2" }}
      composer={false}
    />,
  );
  doesNotMatch(closed, /<textarea|conversation-readonly/);
});

/** The composer drawn for this draft, with the form's submit and the host's posts. */
function composerWith(draft: string) {
  const { state, posts } = recordingState();
  state.draft.value = draft;
  return { posts, ...press(<ChatView state={state} active />) };
}
/** The markup without the field's (possibly huge) text: failures stay readable. */
const bare = (html: string) => html.replace(/ value="[^"]*"/, ' value="…"');

Deno.test("a 50,000-character message is kept whole in the field and is sent whole", async () => {
  const text = "x".repeat(50_000);
  const composer = composerWith(text);
  // Nothing in the field cuts what was typed or pasted.
  doesNotMatch(bare(composer.html), /maxlength/i);
  ok(composer.html.includes(`value="${text}"`));
  // Far from the bound, the counter and the hint stay out of the way.
  doesNotMatch(bare(composer.html), /free-text-count|Message too long/);
  doesNotMatch(bare(composer.html), /id="send"[^>]*disabled|aria-invalid/);
  composer.submit?.({ preventDefault() {} });
  while (composer.posts.length === 0) await settle(1);
  equal(composer.posts.length, 1);
  equal(composer.posts[0].path, "/api/conversations/designer/messages");
  equal(composer.posts[0].body.text, text);
});

Deno.test("near the bound the composer counts, and the bound itself still sends", async () => {
  const near = composerWith("x".repeat(95_000));
  match(
    bare(near.html),
    /<p class="free-text-count" id="input-count"\s*>95,000 \/ 100,000</,
  );
  doesNotMatch(bare(near.html), /Message too long|id="send"[^>]*disabled/);
  const edge = composerWith("x".repeat(MAX_USER_MESSAGE_CHARS));
  match(bare(edge.html), />100,000 \/ 100,000</);
  doesNotMatch(bare(edge.html), /Message too long|id="send"[^>]*disabled/);
  edge.submit?.({ preventDefault() {} });
  while (edge.posts.length === 0) await settle(1);
  equal((edge.posts[0].body.text as string).length, MAX_USER_MESSAGE_CHARS);
});

Deno.test("above the bound the text stays whole, sending is disabled and the hint says why", () => {
  const text = "x".repeat(MAX_USER_MESSAGE_CHARS + 1);
  const composer = composerWith(text);
  const html = bare(composer.html);
  doesNotMatch(html, /maxlength/i);
  ok(composer.html.includes(`value="${text}"`));
  match(
    html,
    /<p class="free-text-count is-over" id="input-count" role="status">Message too long: 100,001 \/ 100,000 characters<\/p>/,
  );
  match(html, /aria-invalid/);
  match(html, /aria-describedby="input-note input-count"/);
  match(html, /id="send"[^>]*disabled/);
});

Deno.test("the bound counts the text as it is sent, trimmed", () => {
  const padded = composerWith(
    ` ${"x".repeat(MAX_USER_MESSAGE_CHARS)}\n\n`,
  );
  doesNotMatch(bare(padded.html), /Message too long|id="send"[^>]*disabled/);
});

Deno.test("selected scoped Request shows initial native refusal without a fabricated assistant reply or retry action", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const conversation = conversations().conversations[0];
  conversation.busy = false;
  conversation.phase = "Initial execution refused";
  conversation.initialExecutionOutcome = "refused";
  conversation.messages = [{
    id: "initial-input",
    role: "user",
    text: "My request",
    at: "now",
    caseId: "requestA",
  }];
  const before = structuredClone(conversation.messages);
  const html = renderToString(
    <ChatView
      state={state}
      active
      independentRequest
      conversation={conversation}
      target={{ caseId: "requestA" }}
      showHeading={false}
    />,
  );
  match(html, /The initial execution was refused/);
  match(html, /This Request remains open. Retry is not automatic/);
  match(html, /My request/);
  doesNotMatch(html, /PRIVATE|NATIVE_EXECUTION|Retry execution|Case closed/);
  equal(JSON.stringify(conversation.messages), JSON.stringify(before));
  const main = renderToString(
    <ChatView state={state} active conversation={conversation} />,
  );
  doesNotMatch(main, /The initial execution was refused/);
  state.dispose();
});
