import { requestVersionInfo } from "../../lib/workbench/version-label.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { modelAuthors, ModelSpace, ScopedModelPage } from "./ModelSpace.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../src/domain/work/records/conversations.ts";
import { toolProposalHref } from "../../lib/model/tool-proposal-location.ts";

const place = (
  page: "activity" | "revisions" | "files" | "releases" | "sysml" | "graph",
  search = "",
) =>
  renderToString(
    <ModelSpace
      state={createWorkbenchState({ initialState: snapshot() })}
      page={page}
      location={{ pathname: "/model", search }}
      operators={[]}
    />,
  );

Deno.test("the Model place offers Activity, Revisions, Files and SysML as links to its own address", () => {
  for (
    const page of ["activity", "revisions", "files", "sysml", "graph"] as const
  ) {
    const html = place(page);
    match(html, /aria-label="Model pages"/);
    // The first page has the bare address; the others are named.
    match(html, /<a href="\/model"[^>]*>Activity<\/a>/);
    match(html, /<a href="\/model\?page=revisions"[^>]*>Revisions<\/a>/);
    match(html, /<a href="\/model\?page=files"[^>]*>Files<\/a>/);
    match(html, /<a href="\/model\?page=sysml"[^>]*>SysML<\/a>/);
    equal((html.match(/aria-current="page"/g) || []).length, 1);
  }
});

Deno.test("the Activity page is the feed of the model's life, in a column, and mounts no other page", () => {
  const html = place("activity");
  match(html, /<a href="\/model" aria-current="page">Activity<\/a>/);
  equal((html.match(/aria-current="page"/g) || []).length, 1);
  match(html, /<h1 class="view-title">Activity<\/h1>/);
  match(html, /class="view-page is-column"/);
  // Read at the first render of the page: the history is not loaded yet.
  match(html, /<div class="act-page">/);
  match(html, /Reading the history…/);
  doesNotMatch(
    html,
    /rev-page|files-page|sysml-page|class="model"|native-graph/,
  );
  // And the other pages do not mount the feed.
  for (const other of ["revisions", "files", "sysml", "graph"] as const) {
    doesNotMatch(place(other), /act-page/, other);
  }
});

Deno.test("the Revisions page is the list and detail of the model's history, in a column, and mounts no graph", () => {
  const html = place("revisions", "?commit=commit%3Aabc");
  match(
    html,
    /<a href="\/model\?page=revisions" aria-current="page">Revisions<\/a>/,
  );
  match(html, /<h1 class="view-title">Revisions<\/h1>/);
  // Read at the first render of the page: the history is not loaded yet.
  match(html, /<div class="rev-page">/);
  match(html, /Reading the history…/);
  match(html, /class="view-page is-column"/);
  // The older view, with its own title and cards, is not mounted.
  doesNotMatch(html, /revision-view|revision-overview|Historique du système/);
  doesNotMatch(html, /native-graph|id="history"|id="model-graph"/);
});

Deno.test("legacy execution history keeps the old renderer under the canonical SysML tab", () => {
  const html = place("graph");
  match(
    html,
    /<a href="\/model\?page=sysml" aria-current="page">SysML<\/a>/,
  );
  match(html, /<h1 class="view-title">SysML<\/h1>/);
  match(html, /class="view-page is-fill"/);
  match(html, /<div class="model">/);
  match(html, /class="native-graph"/);
  doesNotMatch(html, /class="revision-view"/);
  // The page names the graph once: the graph's own title is not repeated.
  doesNotMatch(html, /class="section-head"/);
  match(html, /action="\/model\?page=graph"/);
  match(html, /f-partial="\/model\?page=graph"/);
  match(html, /id="return-model-current"[^>]*href="\/model\?page=graph"/);
});

Deno.test("the SysML page mounts the native view page alone, without an iframe or script", () => {
  const html = place("sysml", "?page=sysml");
  match(html, /<a href="\/model\?page=sysml" aria-current="page">SysML<\/a>/);
  match(html, /<h1 class="view-title">SysML<\/h1>/);
  match(html, /class="view-page is-fill"/);
  equal((html.match(/class="sysml-page"/g) ?? []).length, 1);
  match(html, /Reading the model views…/);
  doesNotMatch(
    html,
    /native-graph|rev-page|files-page|act-page|<iframe|<script/,
  );
});

Deno.test("the Files page reads the repository in a column, and mounts neither the revisions nor the graph", () => {
  const html = place("files", "?page=files&file=lib%2Fa.sysml&line=3");
  match(
    html,
    /<a href="\/model\?page=files" aria-current="page">Files<\/a>/,
  );
  equal((html.match(/aria-current="page"/g) || []).length, 1);
  match(html, /<h1 class="view-title">Files<\/h1>/);
  match(html, /class="view-page is-column"/);
  // Read at the first render of the page: the files are not loaded yet.
  match(html, /<div class="files-page">/);
  match(html, /Reading the files…/);
  doesNotMatch(
    html,
    /rev-page|sysml-page|class="model"|native-graph|id="history"/,
  );
  // And the other pages do not mount the files.
  doesNotMatch(place("revisions"), /files-page/);
  doesNotMatch(place("graph"), /files-page/);
  doesNotMatch(place("sysml"), /files-page/);
});

Deno.test("authors are named by the whole roster of the system, the operators that own a runtime first", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const member = (nativeId: string, name: string) => ({ nativeId, name });
  const owning = [member("designer", "Designer")];
  // Before the roster is known, the operators are all there is.
  deepStrictEqual(modelAuthors(state, owning), owning);
  state.agentConversations.snapshot.value = {
    systemId: "ui-fixture",
    conversations: [
      member("reviewer", "Reviewer"),
      member("designer", "Designer (peer)"),
    ],
  } as never;
  // A member that owns no runtime is named too, and none is named twice.
  deepStrictEqual(modelAuthors(state, owning), [
    member("designer", "Designer"),
    member("reviewer", "Reviewer"),
  ]);
  // A roster of another system names nobody here.
  state.agentConversations.snapshot.value = {
    systemId: "another-system",
    conversations: [member("reviewer", "Reviewer")],
  } as never;
  deepStrictEqual(modelAuthors(state, owning), owning);
});

function toolDetailFixture() {
  const state = createWorkbenchState({ initialState: snapshot() });
  const conversation = (agentId: string): AgentConversation => ({
    agentId,
    nativeId: `native:${agentId}`,
    name: `Operator ${agentId}`,
    responsibility: "",
    primary: agentId === "alpha",
    canSend: true,
    revision: 7,
    busy: false,
    phase: "Ready",
    messages: [],
    modelDigest: "model",
    proposalContext: {
      configurationRevision: 3,
      before: {
        network: { allowedHosts: [`${agentId}.example`] },
        builder: { admissionAuthority: "human" },
      },
      changes: [],
    },
  });
  const tools: OperatorTool[] = ["alpha", "beta"].map((agentId) => ({
    agentId,
    agentName: `Operator ${agentId}`,
    revision: 7,
    candidate: {
      ...snapshot().candidates[0],
      name: `Tool ${agentId}`,
      code: `return "${agentId} exact code";`,
      requiredAuthority: "human",
    },
  }));
  state.agentConversations.accept({
    systemId: "ui-fixture",
    version: "v1",
    defaultAgentId: "alpha",
    conversations: [conversation("alpha"), conversation("beta")],
  });
  state.operatorTools.accept({ systemId: "ui-fixture", version: "v1", tools });
  // The selected conversation is deliberately someone else.
  state.agentConversations.select("alpha");
  const search = new URL(toolProposalHref(tools[1]), "http://local").search;
  const html = (query = search, page: "activity" | "revisions" = "revisions") =>
    renderToString(
      <ModelSpace
        state={state}
        page={page}
        location={{ pathname: "/model", search: query }}
        operators={[]}
      />,
    );
  return { state, tools, search, html };
}

Deno.test("Model opens the exact runtime tool card and real diff without source history or changing the conversation", () => {
  const f = toolDetailFixture();
  const html = f.html();
  match(html, /data-tool-proposal/);
  match(html, /href="\/model\?page=revisions">Back to revisions/);
  match(html, /Tool proposal · Operator beta/);
  match(html, /href="\/chat\?agent=beta">Open conversation/);
  match(html, /data-proposal-id="tool-beta-c1"/);
  match(html, /Tool beta/);
  match(html, /beta exact code/);
  match(html, /beta\.example/);
  match(html, />Admit and integrate</);
  match(html, /This single admission records your agreement/);
  equal(
    html.indexOf("This single admission") < html.indexOf("proposal-code-diff"),
    true,
  );
  doesNotMatch(
    html,
    /Tool alpha|alpha exact code|alpha\.example|Reading the history|class="rev-page"/,
  );
  doesNotMatch(html, /class="proposal-accept" disabled/);
  equal(f.state.selectedConversation.value?.agentId, "alpha");
});

Deno.test("Model tool details preserve the shared decision gate and do not infer authority", () => {
  const f = toolDetailFixture();
  f.state.pending.value = true;
  match(f.html(), /class="proposal-accept" disabled/);
  f.state.pending.value = false;
  f.state.operatorTools.accept({
    systemId: "ui-fixture",
    version: "v2",
    tools: f.tools.map((tool) => ({
      ...tool,
      candidate: { ...tool.candidate, requiredAuthority: "reviewer" },
    })),
  });
  match(f.html(), /class="proposal-accept" disabled/);
  match(f.html(), /Awaiting admission/);
});

Deno.test("Model explicitly rejects stale, changed, missing and historical tool selections", () => {
  const f = toolDetailFixture();
  const unavailable = (html: string, code: string) => {
    match(html, new RegExp(`data-code="${code}"`));
    doesNotMatch(
      html,
      /data-proposal-id|beta exact code|alpha exact code|>Admit and integrate</,
    );
  };
  unavailable(
    f.html(f.search.replace("operator=beta", "operator=missing")),
    "tool-proposal-owner-absent",
  );
  unavailable(
    f.html(f.search.replace("candidate=c1", "candidate=missing")),
    "tool-proposal-candidate-absent",
  );
  unavailable(
    f.html(f.search.replace("digest=", "digest=changed")),
    "tool-proposal-digest-changed",
  );
  unavailable(
    f.html(`${f.search}&commit=old`),
    "tool-proposal-address-invalid",
  );
  f.state.operatorTools.stale.value = true;
  unavailable(f.html(), "tool-proposal-catalogue-stale");
  f.state.operatorTools.stale.value = false;
  f.state.operatorTools.error.value = "A command was refused, then reconciled.";
  match(f.html(), /data-proposal-id="tool-beta-c1"/);
  match(f.html(), /A command was refused, then reconciled/);
  f.state.selectedRevision.value = 6;
  unavailable(f.html(), "tool-proposal-historical");
});

Deno.test("the canonical tool link opens Activity's waiting notification while explicit Revisions links remain supported", () => {
  const f = toolDetailFixture();
  const activity = f.html(f.search, "activity");
  match(activity, /<h1 class="view-title">Activity/);
  match(activity, /data-group="waiting"/);
  match(activity, /data-proposal-id="tool-beta-c1"/);
  match(activity, /beta exact code|Admit and integrate/);
  doesNotMatch(activity, /alpha exact code|Back to revisions/);
  const old = f.html(f.search + "&page=revisions");
  match(old, /<h1 class="view-title">Revisions/);
  match(old, /Back to revisions|data-proposal-id="tool-beta-c1"/);
  equal(f.state.selectedConversation.value?.agentId, "alpha");
  f.state.dispose();
});

Deno.test("Model exposes Releases beside Files and preserves the selected exact source between them", () => {
  const version = `commit:${"a".repeat(40)}`;
  const html = place(
    "releases",
    `?page=releases&version=${encodeURIComponent(version)}`,
  );
  match(
    html,
    new RegExp(
      `href="/model\\?page=files&amp;version=commit%3A${"a".repeat(40)}"`,
    ),
  );
  match(
    html,
    new RegExp(
      `href="/model\\?page=releases&amp;version=commit%3A${
        "a".repeat(40)
      }" aria-current="page"`,
    ),
  );
  match(html, /<h1 class="view-title">Releases<\/h1>/);
  doesNotMatch(
    place("releases", "?page=releases&branch=unavailable"),
    /saved-systems-form/,
  );
  match(
    place("releases", "?page=releases&caseBranch=case-a"),
    /Reading the Request model/,
  );
});

Deno.test("unavailable branch navigation retains its scope and offers no main fallback", () => {
  for (const context of ["branch=unavailable"]) {
    const html = place("releases", `?page=releases&${context}`);
    match(
      html,
      new RegExp(`href="/model\\?page=files&amp;${context}"[^>]*>Files<`),
    );
    match(
      html,
      new RegExp(`href="/model\\?page=releases&amp;${context}"[^>]*>Releases<`),
    );
    doesNotMatch(html, />View main<|href="\/model\?page=files"/);
    doesNotMatch(html, /saved-systems-form|class="repo"/);
  }
});

Deno.test("Case model pages remain empty while their scope is loading", () => {
  for (
    const page of [
      "activity",
      "revisions",
      "files",
      "releases",
      "sysml",
    ] as const
  ) {
    const html = place(
      page,
      "?caseBranch=request%3A7&agent=collector&version=commit%3Aold",
    );
    match(html, /Reading the Request model/);
    doesNotMatch(
      html,
      /class="act-page"|class="rev-page"|class="files-page"|class="sysml-page"/,
    );
    doesNotMatch(html, /<a |<form|saved-systems-form|Create release/);
  }
});

Deno.test("main-only feeds do not pretend to inspect a named source version", () => {
  for (const page of ["activity", "revisions"] as const) {
    const html = place(page, "?version=commit%3Aold");
    match(html, /This page cannot inspect that model version/);
    match(html, /href="\/model\?page=files&amp;version=commit%3Aold"/);
    doesNotMatch(html, /class="act-page"|class="rev-page"/);
  }
});

Deno.test("Request Model tabs keep the inspected version when switching Files and SysML", () => {
  const version = `commit:${"a".repeat(40)}`;
  for (const page of ["files", "sysml"] as const) {
    const html = renderToString(
      <ScopedModelPage
        versionInfo={requestVersionInfo({ id: "case-one" })}
        page={page}
        location={{
          pathname: "/model",
          search: `?caseBranch=case-one&agent=operator&version=${
            encodeURIComponent(version)
          }`,
        }}
        request={fetch}
      />,
    );
    for (const destination of ["files", "sysml"]) {
      const href = [...html.matchAll(/href="([^"]+)"/g)].map((entry) =>
        entry[1]
      ).find((value) => value.includes(`page=${destination}`));
      match(href ?? "", /version=commit%3A[a-f0-9]{40}/);
      match(href ?? "", /caseBranch=case-one/);
      match(href ?? "", /agent=operator/);
    }
  }
});

Deno.test("Request Model tabs expose only pages with a scoped reader", () => {
  const html = renderToString(
    <ScopedModelPage
      versionInfo={requestVersionInfo({ id: "case-one" })}
      page="files"
      caseId="case-one"
      location={{
        pathname: "/model",
        search: "?caseBranch=case-one&version=commit%3Aold",
      }}
      request={() => {
        throw new Error("Rendering must not fetch");
      }}
    />,
  );
  for (const label of ["Files", "Releases", "SysML"]) {
    match(html, new RegExp(`>${label}</a>`));
  }
  doesNotMatch(html, />Activity<\/a>|>Revisions<\/a>/);
});

Deno.test("resolved Request pages without a scoped reader refuse before showing global actions", () => {
  const search = `?caseBranch=case-one&version=commit%3A${"a".repeat(40)}`;
  for (const page of ["activity", "revisions", "releases", "graph"] as const) {
    const html = renderToString(
      <ScopedModelPage
        versionInfo={requestVersionInfo({ id: "case-one" })}
        page={page}
        location={{ pathname: "/model", search }}
        request={() => {
          throw new Error("unexpected network request");
        }}
      />,
    );
    match(html, /This view is unavailable for a Request branch/);
    doesNotMatch(
      html,
      /<form|saved-systems-form|Create release|class="repo"|class="act-page"|class="rev-page"|class="native-graph"/,
    );
  }
});

Deno.test("host-resolved Request Releases reuse the scoped Files reader instead of an unavailable or Main catalogue view", () => {
  const html = renderToString(
    <ScopedModelPage
      versionInfo={requestVersionInfo({ id: "caseA" })}
      page="releases"
      caseId="caseA"
      location={{
        pathname: "/model",
        search: `?caseBranch=caseA&version=commit%3A${"a".repeat(40)}`,
      }}
      request={() => {
        throw new Error("Rendering must not fetch");
      }}
    />,
  );
  match(html, /Releases/);
  match(html, /Reading the files/);
  doesNotMatch(
    html,
    /This view is unavailable for a Request branch|main · exact source/,
  );
});
