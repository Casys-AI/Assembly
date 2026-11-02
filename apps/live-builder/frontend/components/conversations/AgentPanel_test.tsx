import { textOf } from "../../test/support/dom.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { ArtifactSourceBindingReference } from "../../../src/domain/work/artifacts/source-reference.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { modelContextTools } from "../../../src/domain/model/consultation/context.ts";
import type { ChatProposalApi } from "../../lib/conversations/proposals.ts";
import type { SourceRevisions } from "../../lib/model/revisions/api.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import { AgentPanel } from "./AgentPanel.tsx";

const peer: AgentConversation = {
  agentId: "peer",
  nativeId: "native:peer",
  name: "Peer <b>",
  responsibility: "Compare the offers.\nSend the list.",
  primary: false,
  canSend: true,
  revision: 1,
  busy: false,
  phase: "Ready",
  messages: [],
  modelDigest: "digest",
};

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
        operations: ["rename", "set-value"],
        grants: [{ file: "peer.sysml", qualifiedRoots: ["Peer", "Shared"] }],
      },
      modelAdministration: null,
    },
  },
};

Deno.test("the panel names the agent and escapes it; the whole mission is its tooltip", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(<AgentPanel state={state} conversation={peer} />);
  match(html, /<aside class="agent-panel" aria-label="Peer &lt;b>, details"/);
  match(html, /<h2>Peer &lt;b><\/h2>/);
  match(html, /<span class="agent-tile" aria-hidden="true">PB<\/span>/);
  match(html, /<p title="Compare the offers\.\nSend the list\.">/);
  doesNotMatch(html, /<b>/);
  state.dispose();
});

Deno.test("the panel shows the rights and tools in compact rows, with no way to change them", async () => {
  const initial = snapshot();
  const state = createWorkbenchState({
    initialState: initial,
    proposalApi: {
      read: () => Promise.resolve(rights),
    } as unknown as ChatProposalApi,
  });
  state.agentConversations.accept({
    systemId: initial.id,
    defaultAgentId: "peer",
    version: "v1",
    conversations: [peer],
  });
  state.operatorTools.accept({
    systemId: initial.id,
    version: "v1",
    tools: [{
      agentId: "peer",
      agentName: "Peer",
      revision: 1,
      candidate: {
        ...initial.candidates[0],
        id: "peer-tool",
        name: "Peer tool",
        description: "Reads one page",
        stage: "awaiting-admission",
      },
    }, {
      agentId: "peer",
      agentName: "Peer",
      revision: 1,
      candidate: {
        ...initial.candidates[0],
        id: "peer-refused",
        name: "Refused tool",
        stage: "refused",
      },
    }],
    modelTools: [{
      agentId: "peer",
      agentName: "Peer",
      tool: { ...modelContextTools()[0], id: "peer-model" },
    }],
  });
  await state.chatProposals.refresh("native:peer");
  const html = renderToString(<AgentPanel state={state} conversation={peer} />);
  // Editing grants sit in the open, where the drawer folds them.
  match(
    textOf(html),
    /Model editing rename, set-value peer\.sysml Peer, Shared Model administration None/,
  );
  // Tools sit under their server: its name and count, opened on each tool's
  // short name, its stage while not usable, and its description.
  match(
    textOf(html),
    /web 1 pending 2 Peer tool Awaiting admission Reads one page Refused tool Refused/,
  );
  match(
    html,
    /data-tool-server="peer-model"[\s\S]*data-model-tool-id="peer-model"/,
  );
  equal(html.match(/<details/g)?.length, 2);
  doesNotMatch(html, /<button|<form/);
  equal(html.match(/<h3>/g)?.length, 2);
  state.dispose();
});

Deno.test("a malformed skill catalog is read as absent, and a nameless skill is no row", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = (skills: unknown) =>
    renderToString(
      <AgentPanel
        state={state}
        conversation={{ ...peer, skills: skills as never }}
      />,
    );
  doesNotMatch(html("pricing"), /Skills/);
  doesNotMatch(html({ length: 1 }), /Skills/);
  const mixed = html([null, { id: "x" }, {
    id: "pricing",
    name: "Pricing",
    description: "",
    loaded: true,
  }]);
  match(textOf(mixed), /Skills Pricing$/);
  state.dispose();
});

Deno.test("the Case panel retains its projected Branch Operator or custom name while global Main remains Main Operator", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  try {
    for (
      const name of ["Branch Operator", "Research coordinator", "Specialist"]
    ) {
      const conversation = { ...peer, name, primary: name !== "Specialist" };
      const html = renderToString(
        <AgentPanel
          state={state}
          conversation={conversation}
          requestCaseId="case-one"
        />,
      );
      match(html, new RegExp(`<h2>${name}</h2>`));
      match(html, /data-agent-id="peer"/);
      match(html, /Request · read-only/);
      doesNotMatch(html, /Main Operator/);
    }
    const main = renderToString(
      <AgentPanel
        state={state}
        conversation={{ ...peer, name: "Main Operator", primary: true }}
      />,
    );
    match(main, /<h2>Main Operator<\/h2>/);
    doesNotMatch(main, /Branch Operator/);
  } finally {
    state.dispose();
  }
});

Deno.test("once its Case is read, the Case panel names its generic Branch Operator on the Case's initials and keeps a custom name", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  try {
    const record = caseRecord(1, {
      id: "case-one",
      objective: "Qualification MVP checkpoint",
    });
    state.requests.cases.accept({
      systemId: state.current.value!.id,
      cases: [record],
    });
    const panel = (name: string) =>
      renderToString(
        <AgentPanel
          state={state}
          conversation={{ ...peer, name, primary: true }}
          requestCaseId="case-one"
        />,
      );
    const named = panel("Branch Operator");
    match(named, new RegExp(`<h2>${branchOperatorName(record)}</h2>`));
    match(named, /<span class="agent-tile" aria-hidden="true">QM<\/span>/);
    doesNotMatch(named, /Branch Operator/);
    match(panel("Researcher"), /<h2>Researcher<\/h2>/);
  } finally {
    state.dispose();
  }
});

Deno.test("Main conversation panels show bound tool and skill metadata without inspection or comparison controls", () => {
  const initial = snapshot(), manifest = "b".repeat(64);
  const binding: ArtifactSourceBindingReference = {
    version: 1,
    bindingId: "binding",
    versionId: "version",
    revision: 1,
    ownerId: peer.agentId,
    localArtifactId: "skill",
    invocationId: "invocation",
    reference: {
      version: 2,
      scopeId: "scope",
      repositoryId: "repo",
      artifactId: "skill",
      kind: "skill-document",
      commitOid: "a".repeat(40),
      entryPath: `artifacts/${manifest}/SKILL.md`,
      manifestPath: `artifacts/${manifest}/manifest.json`,
      contentEncoding: "utf8-v1",
      contentDigest: "a".repeat(64),
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: manifest,
    },
  };
  initial.candidates[0].sourceBinding = {
    ...binding,
    localArtifactId: initial.candidates[0].id,
    reference: {
      ...binding.reference,
      kind: "tool-draft",
      entryPath: `artifacts/${manifest}/source.json`,
      contentEncoding: "tool-draft-json-v1",
    },
  };
  const state = createWorkbenchState({ initialState: initial });
  state.agentConversations.accept({
    systemId: initial.id,
    defaultAgentId: peer.agentId,
    version: "v1",
    conversations: [peer],
  });
  state.operatorTools.accept({
    systemId: initial.id,
    version: "v1",
    tools: [{
      agentId: peer.agentId,
      agentName: peer.name,
      revision: 1,
      candidate: initial.candidates[0],
    }],
    modelTools: [],
  });
  try {
    const html = renderToString(
      <AgentPanel
        state={state}
        conversation={{
          ...peer,
          name: "Main Operator",
          primary: true,
          skills: [{
            id: "skill",
            name: "Installed skill",
            description: "Useful guidance",
            loaded: true,
            sourceBinding: binding,
          }],
        }}
      />,
    );
    match(textOf(html), /Installed skill/);
    match(html, /title="Useful guidance"/);
    match(html, /data-tool-id="c1"/);
    doesNotMatch(
      html,
      /<button|artifact-source-inspector|Read again|Open exact source|Keep for comparison|Clear comparison|Retained dependencies|Retained source|Close source/,
    );
  } finally {
    state.dispose();
  }
});
