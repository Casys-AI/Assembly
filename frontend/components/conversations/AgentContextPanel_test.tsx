import { deepStrictEqual, doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import type { ChatProposalApi } from "../../lib/conversations/proposals.ts";
import type { SourceRevisions } from "../../lib/model/revisions/api.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { modelContextTools } from "../../../src/domain/model/consultation/context.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { AgentContextPanel } from "./AgentContextPanel.tsx";
import { AgentHeader } from "./AgentHeader.tsx";

function conversation(
  agentId: string,
  primary: boolean,
): AgentConversation {
  return {
    agentId,
    nativeId: "native:" + agentId,
    name: primary ? "Concepteur" : '<img src=x onerror="attack()">',
    responsibility: primary ? "Concevoir" : "<script>mission()</script>",
    primary,
    canSend: true,
    revision: 1,
    busy: false,
    phase: "Prêt",
    messages: [],
    modelDigest: "digest",
    proposalContext: {
      configurationRevision: 1,
      before: {
        network: {
          allowedHosts: primary ? ["primary.example"] : ["peer.example"],
        },
        builder: {
          admissionAuthority: primary ? "human" : "reviewer",
        },
        urlSelectionMode: primary ? "user-provided" : "authorized-host",
      },
      changes: [],
    },
  };
}

function aggregate() {
  const initial = snapshot();
  initial.configuration!.network = { allowedHosts: ["global.example"] };
  const state = createWorkbenchState({ initialState: initial });
  state.agentConversations.accept({
    systemId: initial.id,
    defaultAgentId: "primary",
    version: "v1",
    conversations: [
      conversation("primary", true),
      conversation("peer", false),
    ],
  });
  state.operatorTools.accept({
    systemId: initial.id,
    version: "v1",
    tools: ["primary", "peer"].map((agentId) => ({
      agentId,
      agentName: agentId,
      revision: 1,
      candidate: {
        ...initial.candidates[0],
        id: agentId + "-tool",
        name: agentId + "-tool",
        stage: "active",
      },
    })),
    modelTools: ["primary", "peer"].map((agentId) => ({
      agentId,
      agentName: agentId,
      tool: { ...modelContextTools()[0], id: agentId + "-model" },
    })),
  });
  state.agentConversations.select("peer");
  return state;
}

function render(
  state: ReturnType<typeof createWorkbenchState>,
  tab: "mission" | "mandate" | "tools",
) {
  return renderToString(
    <AgentContextPanel state={state} tab={tab} onClose={() => {}} />,
  );
}

Deno.test("panel escapes the selected agent's mission and identity", () => {
  const html = render(aggregate(), "mission");
  match(html, /id="agent-context-panel"/);
  match(html, /&lt;img/);
  match(html, /&lt;script>mission/);
  doesNotMatch(html, /<img|<script|Concevoir/);
});

Deno.test("peer mandate reads its own admission and network scope", () => {
  const html = render(aggregate(), "mandate");
  match(html, /Allowed hosts/);
  match(html, /peer\.example/);
  match(html, /Tool admission[\s\S]*Reviewer/);
  match(html, /URL selection[\s\S]*Pages of allowed hosts/);
  doesNotMatch(
    html,
    /primary\.example|global\.example|Human decision|Declared capabilities/,
  );
});

Deno.test("tools are isolated by exact agent id", () => {
  const html = render(aggregate(), "tools");
  match(html, /peer-tool|peer-model/);
  doesNotMatch(html, /primary-tool|primary-model|data-tool-id="c1"/);
  doesNotMatch(html, /Admit this tool|Refuse this tool/);
});

Deno.test("tools distinguish an unknown catalogue from a confirmed empty one", () => {
  const state = aggregate();
  state.operatorTools.stale.value = true;
  match(render(state, "tools"), /Tool status is refreshing/);
  state.operatorTools.snapshot.value = null;
  state.operatorTools.stale.value = false;
  match(render(state, "tools"), /tool catalogue is not available/);
  doesNotMatch(render(state, "tools"), /No tool available/);
  state.operatorTools.error.value = "Catalogue indisponible.";
  match(render(state, "tools"), /Catalogue indisponible/);
  state.operatorTools.accept({
    systemId: "ui-fixture",
    version: "empty",
    tools: [],
    modelTools: [],
  });
  match(render(state, "tools"), /No tool available/);
});

Deno.test("source rights are read for the selected native operator only", async () => {
  const rights: SourceRevisions = {
    agentId: "native:peer",
    version: "v1",
    sourceDigest: "digest",
    proposals: [],
    runtime: {
      available: null,
      active: null,
      executable: true,
      sourceRights: {
        modelEditPolicy: {
          id: "peer-policy",
          revision: 1,
          elementId: "element",
          sourceIds: [],
          holderNativeId: "native:peer",
          mandateNativeId: "mandate",
          mandateId: "mandate",
          mandateRevision: 1,
          operations: ["rename"],
          grants: [{ file: "peer.sysml", qualifiedRoots: ["Peer"] }],
        },
        modelAdministration: null,
      },
    },
  };
  const initial = snapshot();
  const state = createWorkbenchState({
    initialState: initial,
    proposalApi: {
      read: () => Promise.resolve(rights),
    } as unknown as ChatProposalApi,
  });
  state.agentConversations.accept({
    systemId: initial.id,
    defaultAgentId: "primary",
    version: "v1",
    conversations: [conversation("primary", true), conversation("peer", false)],
  });
  state.agentConversations.select("peer");
  await state.chatProposals.refresh("native:peer");
  const html = render(state, "mandate");
  match(html, /rename|peer\.sysml/);
  doesNotMatch(html, /primary\.example|Human decision/);
});

Deno.test("historical selection never borrows the current primary snapshot", () => {
  const state = aggregate();
  state.selectedRevision.value = 2;
  state.inspected.value = { ...snapshot(), revision: 2 };
  const mandate = render(state, "mandate");
  const tools = render(state, "tools");
  match(mandate, /Mandate not recorded/);
  match(tools, /Tools not recorded/);
  doesNotMatch(mandate + tools, /global\.example|peer\.example|peer-tool|c1/);
});

Deno.test("primary fallback uses only the matching current snapshot", () => {
  const initial = snapshot();
  const state = createWorkbenchState({ initialState: initial });
  match(render(state, "tools"), /data-tool-id="c1"/);
  match(render(state, "mandate"), /Human decision/);
  state.selectedRevision.value = 2;
  state.inspected.value = { ...initial, revision: 2 };
  doesNotMatch(render(state, "tools"), /data-tool-id="c1"/);
  doesNotMatch(render(state, "mandate"), /Human decision/);
});

Deno.test("an operator that left the catalogue shows as unavailable, never as the primary", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  for (const tab of ["mission", "mandate", "tools"] as const) {
    const html = renderToString(
      <AgentContextPanel
        state={state}
        tab={tab}
        conversation={null}
        onClose={() => {}}
      />,
    );
    match(html, /This agent is not available\./);
    doesNotMatch(
      html,
      /data-tool-id="c1"|Human decision|data-agent-id="primary"/,
    );
  }
});

Deno.test("each tab shows its own part of the agent, in English", () => {
  const state = aggregate();
  for (
    const [tab, title, content] of [
      ["mission", "Mission", /agent-context-mission|<script>/],
      ["mandate", "Mandate", /agent-context-mandate/],
      ["tools", "Tools", /agent-context-tools/],
    ] as const
  ) {
    const html = render(state, tab);
    match(html, new RegExp(`<p>${title}</p>`));
    match(html, new RegExp(`aria-label="${title} of `));
    match(html, content);
    match(html, /aria-label="Close the panel"/);
    // Read only: it explains, it never asks for a decision.
    doesNotMatch(html, /<form|<input|<textarea|type="submit"/);
  }
});

Deno.test("the drawer on the agent's name keeps its three tabs around the panel", () => {
  const state = aggregate();
  const conversation = state.agentConversations.snapshot.value!
    .conversations[1];
  const html = renderToString(
    <AgentHeader
      state={state}
      conversation={conversation}
      fallbackName="Agent"
      detail="mandate"
      onDetail={() => {}}
    />,
  );
  match(html, /role="group" aria-label="Agent information"/);
  const tabs = [...html.matchAll(
    /<button type="button"\s+id="agent-(\w+)-button" aria-pressed="(\w+)"\s*>(\w+)<\/button>/g,
  )].map(([, id, pressed, label]) => [id, pressed, label]);
  deepStrictEqual(tabs, [
    ["mission", "false", "Mission"],
    ["mandate", "true", "Mandate"],
    ["tools", "false", "Tools"],
  ]);
  // The selected tab's panel follows, for that agent.
  match(html, /id="agent-context-panel"[\s\S]*peer\.example/);
});

Deno.test("a fresh catalogue keeps exact linked tool states after a command failure", () => {
  const state = aggregate();
  const catalogue = state.operatorTools.snapshot.value!;
  const peerTool = catalogue.tools.find((entry) => entry.agentId === "peer")!;
  peerTool.candidate.stage = "awaiting-admission";
  state.operatorTools.accept({ ...catalogue });
  state.operatorTools.error.value = "Decision rejected";
  const fresh = render(state, "tools");
  match(fresh, /class="chip tool-candidate-chip warn"/);
  match(
    fresh,
    /href="\/model\?operator=peer&amp;candidate=peer-tool&amp;digest=a{64}"/,
  );
  match(fresh, /Awaiting admission/);
  doesNotMatch(fresh, /Last observed|Decision rejected|refreshing/);
  state.operatorTools.stale.value = true;
  const stale = render(state, "tools");
  match(stale, /Last observed: Awaiting admission/);
  match(stale, /current activity is unknown/);
  doesNotMatch(stale, /tool-candidate-chip warn/);
  state.dispose();
});
