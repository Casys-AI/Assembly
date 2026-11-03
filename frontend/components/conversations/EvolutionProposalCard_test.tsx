import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { options, type VNode } from "preact";
import { act } from "preact/test-utils";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { createRevisionApi } from "../../lib/model/revisions/api.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import {
  evolutionAuthorization,
  evolutionMessage,
  evolutionRecord,
} from "../../test/support/evolution-fixture.ts";
import { operatorRoster } from "../../test/support/operator-fixture.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { press } from "../../test/support/press.ts";
import {
  createEvolutionRequestState,
  EvolutionProposalCard,
} from "./EvolutionProposalCard.tsx";
import {
  chatEntries,
  ChatTimeline,
  ExchangeMessages,
} from "./ChatTimeline.tsx";

function fixture() {
  const current = snapshot();
  current.candidates = [];
  current.designer = { scopeId: "scope:main" };
  const state = createWorkbenchState({ initialState: current });
  const roster = operatorRoster();
  roster.conversations[0].designerScopeId = "scope:main";
  roster.conversations[0].messages = [];
  state.agentConversations.accept(roster);
  return { state, roster, conversation: roster.conversations[0] };
}
Deno.test("evolution cards show target, categories, durable lifecycle, blockers and exact comparison pins", () => {
  const { state, conversation } = fixture();
  const record = evolutionRecord({
    status: "armed",
    blockers: [{
      code: "ACTIVE_CONTRIBUTION",
      operatorId: "native:research",
      detail: "Wait for the current contribution to finish.",
    }],
  });
  let reads = 0;
  const page = press(
    <EvolutionProposalCard
      record={record}
      state={state}
      conversation={conversation}
      scope={{ designerScopeId: "scope:main" }}
      readDiff={() => {
        reads++;
        return Promise.reject(new Error("Unexpected read"));
      }}
    />,
  );
  match(page.html, /Evolve Research/);
  match(page.html, /Action flow · Instructions · Revision 1/);
  match(page.html, /Waiting for safe checkpoint/);
  match(page.html, /Wait for the current contribution to finish/);
  match(page.html, /Before commit:base/);
  match(page.html, /After commit:candidate/);
  doesNotMatch(page.html, /Action flow updated|Model updated/);
  equal(reads, 0);
  state.dispose();
});
Deno.test("a card action sends only an exact message request and waits for durable status", async () => {
  const { state, conversation } = fixture();
  const record = evolutionRecord();
  const sent: unknown[] = [];
  state.agentConversations.sendTo = (...args) => {
    sent.push(args);
    return Promise.resolve(true);
  };
  const requestState = createEvolutionRequestState();
  const draw = () =>
    press(
      <EvolutionProposalCard
        record={record}
        state={state}
        conversation={conversation}
        scope={{ designerScopeId: "scope:main" }}
        requestState={requestState}
      />,
    );
  deepStrictEqual(draw().labels, [
    "Request acceptance",
    "Request cancellation",
  ]);
  draw().click("Request acceptance");
  await Promise.resolve();
  await Promise.resolve();
  equal(sent.length, 1);
  const call = sent[0] as unknown[];
  equal(call[0], "designer");
  equal(call[2], false);
  equal(call[3], undefined);
  match(String(call[1]), /dossier revision 1, proposal proposal:flow/);
  equal(record.status, "prepared");
  match(draw().html, /Request sent/);
  match(draw().html, /Prepared/);
  doesNotMatch(draw().html, />Adopted<|>Accepted</);
  state.dispose();
});
Deno.test("closed Requests, other scopes and historical cards cannot send evolution requests", () => {
  const { state, conversation } = fixture();
  const record = evolutionRecord({
    origin: {
      operatorId: conversation.nativeId,
      requestId: "ui-fixture:case:2",
    },
  });
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(2, { status: "closed-done" })],
  });
  const closed = press(
    <EvolutionProposalCard
      record={record}
      state={state}
      conversation={conversation}
      scope={{ caseId: record.origin.requestId }}
    />,
  );
  deepStrictEqual(closed.labels, []);
  match(closed.html, /originating Request is closed or unavailable/);
  const historical = press(
    <EvolutionProposalCard
      record={evolutionRecord()}
      state={state}
      conversation={conversation}
      scope={{ designerScopeId: "scope:main" }}
      historical
    />,
  );
  deepStrictEqual(historical.labels, []);
  match(historical.html, /Recorded Prepared at 2026-10-27/);
  const other = press(
    <EvolutionProposalCard
      record={evolutionRecord()}
      state={state}
      conversation={conversation}
      scope={{ designerScopeId: "scope:other" }}
    />,
  );
  deepStrictEqual(other.labels, []);
  match(other.html, /originating conversation with Main/);
  const oldDesigner = press(
    <EvolutionProposalCard
      record={evolutionRecord({
        origin: {
          operatorId: conversation.nativeId,
          designerScopeId: "scope:old",
        },
      })}
      state={state}
      conversation={conversation}
      scope={{ designerScopeId: "scope:old" }}
    />,
  );
  deepStrictEqual(oldDesigner.labels, []);
  match(
    oldDesigner.html,
    /Main Operator conversation is no longer current or cannot be verified/,
  );
  state.dispose();
});
Deno.test("conversation and exchange cards enrich only exact live dossier receipts and freeze history", () => {
  const { state, roster } = fixture();
  const captured = evolutionRecord();
  roster.conversations[0].messages = [
    evolutionMessage(captured),
    evolutionMessage({ ...captured, revision: 2 }),
  ];
  roster.evolutions = {
    version: "evolution:5",
    items: [
      evolutionRecord({ revision: 5, status: "published-awaiting-adoption" }),
    ],
    truncated: false,
  };
  state.agentConversations.accept(roster);
  const conversation = state.conversationSnapshot.value!.conversations[0];
  const draw = () =>
    renderToString(
      <ChatTimeline
        state={state}
        entries={chatEntries(state, conversation)}
        conversation={conversation}
      />,
    );
  const live = draw();
  equal(live.match(/data-evolution-id=/g)?.length, 1);
  match(live, /Published · not active/);
  doesNotMatch(live, /Legacy result text/);
  const exchange = renderToString(
    <ExchangeMessages
      state={state}
      conversation={conversation}
      messages={conversation.messages}
    />,
  );
  equal(exchange.match(/data-evolution-id=/g)?.length, 1);
  match(exchange, /Published · not active/);
  state.selectedRevision.value = 1;
  const historical = draw();
  match(historical, /Recorded Prepared/);
  doesNotMatch(historical, /Published · not active|Request acceptance/);
  equal(conversation.messages.length, 2);
  state.dispose();
});

Deno.test("unconfirmed live dossier reads stay recorded and expose no requests", () => {
  const { state, roster } = fixture();
  roster.conversations[0].messages = [evolutionMessage()];
  state.agentConversations.accept(roster);
  const conversation = state.conversationSnapshot.value!.conversations[0];
  const page = press(
    <ChatTimeline
      state={state}
      conversation={conversation}
      entries={chatEntries(state, conversation)}
    />,
  );
  match(page.html, /Recorded Prepared/);
  match(page.html, /Current evolution dossier details are unavailable/);
  deepStrictEqual(page.labels, []);
  state.dispose();
});
Deno.test("a generic evolution source proposal cannot render owner-control actions without a dossier card", () => {
  const { state, conversation } = fixture();
  const html = renderToString(
    <ChatTimeline
      state={state}
      conversation={conversation}
      entries={[{
        kind: "source",
        id: "source:evolution",
        at: "2026-10-27T01:00:00Z",
        proposal: {
          id: "evolution",
          author: "agent:native:designer",
          authorization: evolutionAuthorization(),
          reason: "Evolve flow",
          baseVersion: "commit:base",
          createdAt: "2026-10-27T01:00:00Z",
          status: "proposed",
          sourceDigest: "source",
          proposalVersion: "commit:candidate",
        },
      }]}
    />,
  );
  equal(html, "");
  state.dispose();
});

Deno.test("a command receipt in another scope stays an observation and cannot move the dossier card", () => {
  const { state, conversation } = fixture();
  const receipt = { ...evolutionMessage(), designerScopeId: "scope:elsewhere" };
  const html = renderToString(
    <ChatTimeline
      state={state}
      conversation={conversation}
      entries={[{
        kind: "message",
        id: receipt.id,
        at: receipt.at,
        message: receipt,
      }]}
    />,
  );
  match(html, /Legacy result text/);
  doesNotMatch(html, /data-evolution-id|Request acceptance/);
  const exchange = renderToString(
    <ExchangeMessages
      state={state}
      conversation={conversation}
      messages={[receipt]}
    />,
  );
  match(exchange, /Legacy result text/);
  doesNotMatch(exchange, /data-evolution-id/);
  state.dispose();
});

Deno.test("historical expansion reads only captured immutable sources and rejects changed pins", async () => {
  for (const mismatch of ["none", "version", "digest"] as const) {
    const { state, conversation } = fixture();
    const record = evolutionRecord();
    const paths: string[] = [];
    const api = createRevisionApi((path) => {
      paths.push(String(path));
      return Promise.resolve(Response.json({
        fromVersion: mismatch === "version"
          ? "commit:foreign"
          : record.base.version,
        toVersion: record.candidate.version,
        fromSourceDigest: record.base.sourceDigest,
        toSourceDigest: mismatch === "digest"
          ? "foreign-source"
          : record.candidate.sourceDigest,
        patch:
          "diff --git a/flow.sysml b/flow.sysml\n--- a/flow.sysml\n+++ b/flow.sysml\n@@ -1 +1 @@\n-old step\n+new step\n",
        files: [{
          path: "flow.sysml",
          kind: "changed",
          additions: 1,
          deletions: 1,
        }],
        additions: 1,
        deletions: 1,
      }));
    });
    const probe = probeRoot();
    let card!: VNode;
    const Probe = () => {
      card = EvolutionProposalCard({
        record,
        state,
        conversation,
        scope: { designerScopeId: "scope:main" },
        historical: true,
        currentUnavailable:
          "Current evolution dossier details are unavailable.",
        readDiff: api.diff,
      });
      return null;
    };
    try {
      let toggle:
        | ((event: { currentTarget: { open: boolean } }) => void)
        | undefined;
      const previous = options.attr;
      options.attr = (attribute, value) => {
        if (
          attribute.toLowerCase() === "ontoggle" && typeof value === "function"
        ) {
          toggle = value;
        }
        return previous?.(attribute, value);
      };
      try {
        await probe.show(Probe, {});
        equal(paths.length, 0);
        renderToString(card);
      } finally {
        options.attr = previous;
      }
      equal(typeof toggle, "function");
      await act(async () => {
        toggle!({ currentTarget: { open: true } });
        await Promise.resolve();
      });
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      deepStrictEqual(paths, [
        `/api/model-diff?${new URLSearchParams({
          from: record.base.version,
          to: record.candidate.version,
        })}`,
      ]);
      const html = renderToString(card);
      match(html, /Recorded Prepared at/);
      match(html, /Current evolution dossier details are unavailable/);
      doesNotMatch(
        html,
        /Request acceptance|Request activation|Request cancellation/,
      );
      if (mismatch === "none") match(html, /proposal-code-diff/);
      else {
        match(
          html,
          /does not match this evolution&#39;s exact source revisions|does not match this evolution's exact source revisions/,
        );
        doesNotMatch(html, /proposal-code-diff/);
      }
      equal(record.status, "prepared");
    } finally {
      await probe.restore();
      state.dispose();
    }
  }
});
