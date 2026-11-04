import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { EffectiveModelUpdate } from "../../../src/domain/work/records/effective-model-update.ts";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { ModelUpdateDivider } from "./ModelUpdateDivider.tsx";
import {
  caseModelUpdates,
  chatEntries,
  ChatTimeline,
  entriesFor,
  withExchanges,
} from "./ChatTimeline.tsx";

const update = (
  overrides: Partial<EffectiveModelUpdate> = {},
): EffectiveModelUpdate => ({
  id: "activation-1",
  operatorId: "alpha",
  kind: "action-flow",
  activatedAt: "2026-10-27T10:02:00Z",
  from: { digest: "before", repositoryVersion: "commit:old" },
  to: { digest: "after", repositoryVersion: "commit:new" },
  caseId: "request-1",
  ...overrides,
});
const conversation = (updates: EffectiveModelUpdate[]): AgentConversation => ({
  agentId: "alpha",
  nativeId: "alpha",
  name: "Alpha",
  primary: true,
  canSend: true,
  busy: false,
  revision: 7,
  modelDigest: "after",
  responsibility: "",
  phase: "Ready",
  effectiveModelUpdates: updates,
  messages: [
    {
      id: "start",
      role: "user",
      text: "Please adjust",
      at: "2026-10-27T10:01:00Z",
      caseId: "request-1",
    },
    {
      id: "end",
      role: "assistant",
      text: "Finished",
      at: "2026-10-27T10:03:00Z",
      caseId: "request-1",
    },
  ],
});

Deno.test("effective activation divider opens its exact revision and known base", () => {
  const html = renderToString(<ModelUpdateDivider update={update()} />);
  match(html, /Action flow updated/);
  match(html, /href="\/model\?commit=commit%3Anew&amp;from=commit%3Aold"/);
  match(html, /aria-label="Action flow updated: inspect version commit:new"/);
  doesNotMatch(html, /role="alert"|role="status"|button/);
});

Deno.test("unknown old versions stay unknown; a digest alone never links to the present", () => {
  const html = renderToString(
    <ModelUpdateDivider
      update={update({
        kind: "model",
        from: { digest: "before" },
      })}
    />,
  );
  match(html, /Model updated/);
  match(html, /href="\/model\?commit=commit%3Anew"/);
  doesNotMatch(html, /from=|currentVersion/);
  const noCommit = renderToString(
    <ModelUpdateDivider
      update={update({
        to: { digest: "immutable-digest" },
      })}
    />,
  );
  doesNotMatch(noCommit, /<a /);
  match(noCommit, /title="immutable-digest"/);
});

Deno.test("durable updates join their explicit scope chronologically and cannot inherit a neighbouring request", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const agent = conversation([
    update(),
    update({ id: "unscoped", caseId: undefined }),
    update({
      id: "designer",
      caseId: undefined,
      designerScopeId: "designer-1",
    }),
    update({ id: "other", caseId: "request-2" }),
  ]);
  const entries = chatEntries(state, agent);
  deepStrictEqual(
    entriesFor(entries, { caseId: "request-1" }).map((entry) => entry.id),
    [
      "message:start",
      "model-update:activation-1",
      "message:end",
    ],
  );
  deepStrictEqual(entriesFor(entries, "designer").map((entry) => entry.id), [
    "model-update:designer",
  ]);
  equal(entriesFor(entries, "new-case").length, 0);
  state.selectedRevision.value = 4;
  equal(
    chatEntries(state, agent).some((entry) => entry.kind === "model-update"),
    false,
  );
});

Deno.test("merged request includes a teammate activation once even without a teammate message", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const own = conversation([update()]);
  const teammate = {
    ...conversation([
      update({ id: "teammate", operatorId: "beta" }),
      update({ id: "unrelated", operatorId: "beta", caseId: "request-2" }),
    ]),
    agentId: "beta",
    nativeId: "beta",
    messages: [],
  };
  const other = caseModelUpdates([own, teammate], "request-1", own);
  deepStrictEqual(other.map((entry) => entry.id), ["model-update:teammate"]);
  const timeline = withExchanges(chatEntries(state, own), [], [
    ...other,
    ...other,
  ]);
  deepStrictEqual(timeline.map((entry) => entry.id), [
    "message:start",
    "model-update:activation-1",
    "model-update:teammate",
    "message:end",
  ]);
});

Deno.test("merged teammate activations at the same commit name their affected operators", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const own = conversation([]);
  const beta = {
    ...conversation([
      update({ id: "beta-update", operatorId: "native-beta", kind: "model" }),
    ]),
    agentId: "beta",
    nativeId: "native-beta",
    name: "Researcher",
    messages: [],
  };
  const gamma = {
    ...conversation([
      update({ id: "gamma-update", operatorId: "native-gamma", kind: "model" }),
    ]),
    agentId: "gamma",
    nativeId: "native-gamma",
    name: "Reviewer",
    messages: [],
  };
  const unknown = {
    ...conversation([
      update({
        id: "unknown-update",
        operatorId: "retired-operator",
        kind: "model",
      }),
    ]),
    agentId: "legacy",
    messages: [],
  };
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [own, beta, gamma],
  });
  const entries = withExchanges(
    chatEntries(state, own),
    [],
    caseModelUpdates([beta, gamma, unknown], "request-1", own),
  );
  const html = renderToString(
    <ChatTimeline state={state} entries={entries} conversation={own} />,
  );
  match(html, /Model updated<span> · Researcher<\/span>/);
  match(html, /Model updated<span> · Reviewer<\/span>/);
  match(html, /Model updated<span> · retired-operator<\/span>/);
  match(
    html,
    /aria-label="Model updated for Researcher: inspect version commit:new"/,
  );
  match(
    html,
    /aria-label="Model updated for Reviewer: inspect version commit:new"/,
  );
  equal(
    (html.match(/href="\/model\?commit=commit%3Anew&amp;from=commit%3Aold"/g) ||
      []).length,
    3,
  );
});

Deno.test("Request update divider shows eight commit hex characters and keeps its full exact title without a Main link", () => {
  const exact = `commit:1234abcd${"f".repeat(32)}`;
  const html = renderToString(
    <ModelUpdateDivider
      requestScoped
      update={update({
        to: { digest: "d".repeat(64), repositoryVersion: exact },
      })}
    />,
  );
  match(html, /Version 1234abcd<\/span>/);
  match(html, new RegExp(`title="${exact}"`));
  doesNotMatch(html, /Version commit:|href=/);
});

Deno.test("a Request's update divider names the teammate from that Request's roster", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const owner = conversation([
    update({ id: "member", operatorId: "native-reviewer", kind: "model" }),
  ]);
  state.requests.snapshots.value = new Map([["request-1", {
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [owner, {
      ...conversation([]),
      agentId: "reviewer",
      nativeId: "native-reviewer",
      name: "Hook reviewer",
    }],
  }]]);
  const html = renderToString(
    <ChatTimeline
      state={state}
      entries={chatEntries(state, owner).filter((entry) =>
        entry.kind === "model-update"
      )}
      conversation={owner}
      independentRequest
      caseId="request-1"
    />,
  );
  match(html, /Model updated<span> · Hook reviewer<\/span>/);
  doesNotMatch(html, /native-reviewer/);
});
