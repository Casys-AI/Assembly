import { seedRequestCases } from "../support/request-fixture.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { probeRoot } from "../support/hook-probe.ts";
import Workbench, {
  conversationHref,
  designerConversationShown,
  runtimeRevisionOperators,
  synchronizeModelLocation,
  useOpenRequestReads,
  useParkedRequestSelection,
  viewFromPath,
  workbenchGraphShown,
  Workspace,
} from "../../islands/Workbench.tsx";
import type {
  AgentConversation,
  ConversationsSnapshot,
} from "../../../src/domain/work/records/conversations.ts";
import { RuntimeRevisionCard } from "../../components/model/revisions/RevisionsView.tsx";
import { ChatView } from "../../components/conversations/ChatView.tsx";
import { GraphView } from "../../components/graph/GraphView.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import type { SourceProposal } from "../../lib/model/revisions/api.ts";
import { runSourceCommand } from "../../lib/model/sources/command.ts";
import { caseRecord, jobRecord, watchRecord } from "../support/case-fixture.ts";
import { CaseView } from "../../components/cases/CaseView.tsx";
import type { CasesSnapshot } from "../../lib/cases/cases.ts";
import { snapshot } from "../support/workbench-fixture.ts";
import { grant, operatorRoster } from "../support/operator-fixture.ts";
import { inOrder, nameOf, textOf, within } from "../support/dom.ts";

const PANELS = [
  "chat-panel",
  "agent-panel",
  "cases-panel",
  "case-panel",
  "system-panel",
  "model-panel",
  "activity-panel",
];
/** A link as the person meets it: its name, where it leads, whether current. */
const linkOf = (
  link: Element,
) => [
  nameOf(link),
  link.getAttribute("href"),
  link.getAttribute("aria-current"),
];

/**
 * The desk as the person meets it: the Dock, the panels on show and what
 * they hold. How the Dock and each page are drawn is their own tests'; here,
 * what the desk hands them and where they are shown.
 */
function desk(html: string) {
  const page = within(html);
  const dock = within(page.byRole("navigation", { name: /^Dock/ }));
  const panel = (id: string) => {
    const found = page.root.querySelector(`[id="${id}"]`);
    ok(found, `no ${id}`);
    return found;
  };
  return {
    page,
    dock,
    panel: (id: string) => within(panel(id)),
    /** The ids of the panels on show. */
    shown: () => PANELS.filter((id) => !panel(id).hasAttribute("hidden")),
    /** The circle that talks to the central agent, a button or a link. */
    circle: () =>
      dock.queryByRole("button", { name: /^Talk to / }) ??
        dock.byRole("link", { name: /^Talk to / }),
    places: () =>
      within(dock.byRole("list", { name: "Places" })).allByRole("link")
        .map(linkOf),
  };
}
/** Where the circle leads, when it is a link. */
const circleHref = (html: string) => desk(html).circle().getAttribute("href");
/** The pages of a place as tabs: [name, href, aria-current]. */
const tabsOf = (scope: ReturnType<typeof within>, label: string) =>
  within(scope.byRole("navigation", { name: label })).allByRole("link")
    .map(linkOf);

Deno.test("mounted navigation parks the Request selection across page-only and Main and excludes Main beside a full side agent", async () => {
  const root = probeRoot();
  let selected: { caseId: string; agentId: string | null } | null = null;
  let designer = false;
  function Probe(
    props: {
      selection: { caseId: string; agentId: string | null } | null;
      useParked: boolean;
      sideAgent: boolean;
    },
  ) {
    selected = useParkedRequestSelection(props.selection, props.useParked);
    designer = designerConversationShown({
      modelOpen: false,
      modelSplit: false,
      contextCaseId: null,
      showCases: false,
      scheduledCase: false,
      sideAgent: props.sideAgent,
      talking: true,
    });
    return null;
  }
  try {
    const request = { caseId: "case-a", agentId: "collector" };
    await root.show(Probe, {
      selection: request,
      useParked: false,
      sideAgent: false,
    });
    // Page-only retains its selected context; full Main asks for the parked one.
    await root.show(Probe, {
      selection: request,
      useParked: false,
      sideAgent: false,
    });
    await root.show(Probe, {
      selection: null,
      useParked: true,
      sideAgent: false,
    });
    deepStrictEqual(selected, request);
    equal(designer, true);
    await root.show(Probe, {
      selection: null,
      useParked: true,
      sideAgent: true,
    });
    deepStrictEqual(selected, request);
    equal(designer, false);
    // Opening the Requests list must not substitute a parked Request selection.
    await root.show(Probe, {
      selection: null,
      useParked: false,
      sideAgent: false,
    });
    equal(selected, null);
  } finally {
    await root.restore();
  }
});

Deno.test("opening Requests from Main keeps both panels until Main is explicitly hidden", async () => {
  const root = probeRoot();
  root.windowListeners();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  const state = createWorkbenchState({ initialState: snapshot() });
  state.requests.cases.supported.value = true;
  let html = "";
  function Probe(props: { path: string }) {
    html = renderToString(Workspace({
      state,
      started: false,
      initialUrl: `https://atelier.test${props.path}`,
    }));
    return null;
  }
  const href = (pattern: RegExp) => {
    const found = html.match(pattern)?.[1];
    ok(found);
    return found.replaceAll("&amp;", "&");
  };
  try {
    await root.show(Probe, { path: "/chat" });
    const requests = href(/id="cases-link" href="([^"]+)"/);
    await root.show(Probe, { path: requests });
    doesNotMatch(html, /id="chat-panel"[^>]*hidden/);
    doesNotMatch(html, /id="cases-panel"[^>]*hidden/);
    match(html, /desk-stage is-talking has-item/);
    const hide = href(/href="([^"]+)" aria-label="Close conversation"/);
    equal(hide, "/cases?main=hidden");
    await root.show(Probe, { path: hide });
    match(html, /id="chat-panel"[^>]*hidden/);
    doesNotMatch(html, /id="cases-panel"[^>]*hidden/);
    const restore = circleHref(html);
    equal(restore, "/cases");
    await root.show(Probe, { path: restore });
    doesNotMatch(html, /id="chat-panel"[^>]*hidden/);
  } finally {
    await root.restore();
    state.cases.dispose();
  }
});

Deno.test("workspace identifies the current system and admitted version while inspecting history", () => {
  const current = snapshot();
  current.id = "b416267f-1be9-4b0e-bab9-cd72b5302a03";
  const identity = {
    systemQualifiedName: "Research::MarketWatch",
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: current.id,
    catalogId: "catalog",
    builderId: "builder",
  };
  // Only the identity and version are consumed by the shell.
  current.executionModel = {
    identity,
    version: {
      repositoryVersion: "commit:abc123456789",
      digest: "active-digest",
    },
  } as NonNullable<typeof current.executionModel>;
  current.availableExecutionModel = {
    ...current.executionModel,
    version: {
      ...current.executionModel.version,
      repositoryVersion: "commit:next12345678",
    },
  };
  const state = createWorkbenchState({ initialState: current });
  state.selectedRevision.value = 3;
  state.inspected.value = { ...snapshot(), id: "Past system", revision: 3 };
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/model?revision=3"
    />,
  );
  match(html, /System: Research::MarketWatch/);
  match(html, /In service: commit:abc123456789/);
  // The admitted source is read asynchronously; execution is not its substitute.
  match(html, /aria-label="Main · Version unavailable"/);
  const identityTitle = within(html).root.querySelector(".workspace-identity")!;
  identityTitle.querySelector(".detail-facts")!.remove();
  // Exact visible content excludes the past system, qualified name, UUID and hashes.
  equal(textOf(identityTitle), "Main");
  // Closing the opened Model place restores the full Main conversation.
  match(html, /id="model-link" href="\/chat"[^>]*aria-current="page"/);
  match(html, /aria-label="Activity, \d+ pending"/);
  // The title bar keeps only the connection, the name and the version.
  const titlebar = html.slice(0, html.indexOf("</header>"));
  doesNotMatch(titlebar, /system-link|model-link|activity-link/);
});

Deno.test("workspace reports unavailable version without substituting the runtime revision", () => {
  const current = snapshot();
  current.id = "b416267f-1be9-4b0e-bab9-cd72b5302a03";
  const state = createWorkbenchState({ initialState: current });
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  match(html, /System: Workspace/);
  match(html, /aria-label="Main · Version unavailable"/);
  doesNotMatch(html, /Model 7/);
});

Deno.test("workspace uses the model system name and the implicit default SysML name instead of a runtime UUID", () => {
  for (const systemQualifiedName of [undefined, "Research::MarketWatch"]) {
    const current = snapshot();
    current.id = "b416267f-1be9-4b0e-bab9-cd72b5302a03";
    current.model = {
      ...(systemQualifiedName ? { systemQualifiedName } : {}),
      projectId: "project",
      editingContextId: "context",
      rootId: "root",
      systemId: current.id,
      catalogId: "catalog",
      builderId: "builder",
    };
    const state = createWorkbenchState({ initialState: current });
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl="https://atelier.test/chat"
      />,
    );
    const expected = systemQualifiedName || "ASELiveBuilder::liveBuilder";
    match(html, new RegExp(`System: ${expected}`));
    const identityTitle = within(html).root.querySelector(
      ".workspace-identity",
    )!;
    identityTitle.querySelector(".detail-facts")!.remove();
    equal(textOf(identityTitle), "Main");
  }
});

Deno.test("workspace routes keep one Dock, one circle and the graph renderer only where the graph is shown", () => {
  const visible: Record<string, string[]> = {
    "/": [],
    "/chat": ["chat-panel"],
    "/tools": ["chat-panel"],
    "/chat?agent=collector": ["agent-panel"],
    "/system": ["chat-panel", "system-panel"],
    "/system?select=unit-1": ["chat-panel", "system-panel"],
    "/system?page=nope": ["chat-panel", "system-panel"],
    "/model": ["chat-panel", "model-panel"],
    "/model?commit=commit%3Aabc&from=empty": ["chat-panel", "model-panel"],
    "/model?page=graph": ["chat-panel", "model-panel"],
    "/model?page=sysml": ["chat-panel", "model-panel"],
    "/model?page=graph&revision=3": ["chat-panel", "model-panel"],
    "/model?page=files&file=a.sysml&line=3": ["chat-panel", "model-panel"],
    // The links that predate the places: the graph, and the Model place's
    // earlier address.
    "/model?revision=3": ["chat-panel", "model-panel"],
    "/model?modelVersion=commit%3Aabc": ["chat-panel", "model-panel"],
    "/revisions": ["chat-panel", "model-panel"],
    "/revisions?commit=commit%3Aabc&from=empty": ["chat-panel", "model-panel"],
    "/revisions?page=graph": ["chat-panel", "model-panel"],
    "/revisions?page=files&file=a.sysml&line=3": ["chat-panel", "model-panel"],
    // An explicit Case context moves that Request to the left, including before
    // its record loads; unavailable scoped model reads must not reveal main.
    "/system?caseBranch=case-a&agent=collector": [
      "cases-panel",
      "system-panel",
    ],
    "/model?page=files&caseBranch=case-a&agent=collector": [
      "cases-panel",
      "model-panel",
    ],
    "/activity": ["activity-panel"],
    // A Case address before its record loads reads as a Request, on the Requests page.
    "/chat?case=ui-fixture%3Acase%3A1": ["chat-panel", "cases-panel"],
    "/cases?case=ui-fixture%3Acase%3A1": ["chat-panel", "cases-panel"],
    "/cases": ["chat-panel", "cases-panel"],
    "/cases?main=hidden": ["cases-panel"],
    "/chat?case=new": ["chat-panel", "cases-panel"],
  };
  const graphRoutes = new Set([
    "/model?revision=3",
    "/model?page=graph&revision=3",
  ]);
  const sysmlRoutes = new Set([
    "/model?page=sysml",
    "/model?page=graph",
    "/model?modelVersion=commit%3Aabc",
    "/revisions?page=graph",
  ]);
  for (const [path, panels] of Object.entries(visible)) {
    const html = renderToString(
      <Workbench initialUrl={`https://atelier.test${path}`} />,
    );
    const view = desk(html);
    const all = (selector: string) =>
      view.page.root.querySelectorAll(selector).length;
    equal(all(".desk-view"), 6);
    // One Dock (desk() finds exactly one) and one circle in it.
    ok(view.circle());
    // The Dock is always shown: no auto-hide state on the desk.
    doesNotMatch(html, /data-dock=/);
    // Only numeric execution history mounts the old graph renderer.
    equal(all(".native-graph"), graphRoutes.has(path) ? 1 : 0, path);
    equal(all(".sysml-page"), sysmlRoutes.has(path) ? 1 : 0, path);
    doesNotMatch(html, /<iframe|<script/);
    const active = viewFromPath(new URL(path, "https://atelier.test").pathname);
    equal(
      view.page.root.querySelector("[data-view]")?.getAttribute("data-view"),
      active,
    );
    deepStrictEqual(view.shown(), PANELS.filter((id) => panels.includes(id)));
  }
});

Deno.test("the Dock holds System, Model, then Activity; each place is its own address", () => {
  equal(viewFromPath("/system"), "system");
  equal(viewFromPath("/model"), "model");
  // The Model place's earlier address is still the Model place.
  equal(viewFromPath("/revisions"), "model");
  equal(viewFromPath("/activity"), "activity");
  equal(viewFromPath("/chat"), "chat");
  const dock = (path: string) =>
    renderToString(
      <Workspace
        state={createWorkbenchState({ initialState: snapshot() })}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
  const rest = dock("/");
  const [system, model, decide] = desk(rest).places();
  deepStrictEqual(system, ["System, Main Operator", "/system", null]);
  deepStrictEqual(model.slice(1), ["/model", null]);
  match(model[0]!, /^Model/);
  deepStrictEqual(decide.slice(1), ["/activity", null]);
  match(decide[0]!, /^Activity, \d+ pending$/);
  // Closing System or Model restores Main; Activity returns to the desk.
  // Only the place open is current.
  const open = (path: string) =>
    desk(dock(path)).places().map(([, href, current]) => [href, current]);
  deepStrictEqual(open("/system")[0], ["/chat", "page"]);
  for (const path of ["/model?proposal=p1", "/revisions?proposal=p1"]) {
    deepStrictEqual(open(path)[1], ["/chat", "page"]);
  }
  deepStrictEqual(open("/activity")[2], ["/", "page"]);
  for (
    const [path, at] of [["/model", 1], ["/system", 0], [
      "/activity",
      2,
    ]] as const
  ) {
    deepStrictEqual(
      open(path).map(([, current]) => current),
      [0, 1, 2].map((index) => index === at ? "page" : null),
      path,
    );
  }
});

Deno.test("the Model place frames its pages: Activity opens it, a revision's link opens Revisions, SysML hosts source views, one at a time", () => {
  const place = (path: string) =>
    desk(renderToString(
      <Workspace
        state={createWorkbenchState({ initialState: snapshot() })}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    )).panel("model-panel");
  const tabs = (
    current: "activity" | "revisions" | "files" | "releases" | "sysml",
  ) =>
    [
      ["activity", "/model", "Activity"],
      ["revisions", "/model?page=revisions", "Revisions"],
      ["files", "/model?page=files", "Files"],
      ["releases", "/model?page=releases", "Releases"],
      ["sysml", "/model?page=sysml", "SysML"],
    ].map(([id, href, label]) => [
      label,
      href,
      id === current ? "page" : "false",
    ]);
  /** The page shown: its tabs and its title, which shows once. */
  const shows = (
    panel: ReturnType<typeof place>,
    current: Parameters<typeof tabs>[0],
    title: string,
  ) => {
    deepStrictEqual(tabsOf(panel, "Model pages"), tabs(current));
    equal(textOf(panel.byRole("heading", { level: 1 })), title);
  };
  const markup = (panel: ReturnType<typeof place>) =>
    (panel.root as Element).outerHTML;
  // The bare address of the place opens the feed of its activity, and its
  // earlier address is the same place, page for page.
  const activityPanel = place("/model");
  const activity = markup(activityPanel);
  equal(markup(place("/revisions")), activity);
  shows(activityPanel, "activity", "Activity");
  match(activity, /class="act-page"/);
  doesNotMatch(activity, /class="rev-page"|class="revision-view"/);
  doesNotMatch(activity, /native-graph|id="history"/);
  // Every link that names a revision opens Revisions on it, as it always did.
  for (
    const path of [
      "/model?proposal=p1",
      "/model?commit=commit%3Aabc&from=empty",
      "/revisions?proposal=p1",
      "/revisions?commit=commit%3Aabc&from=empty",
    ]
  ) {
    const shown = place(path);
    const panel = markup(shown);
    // The tabs are links; the page shown says so; its title shows once.
    shows(shown, "revisions", "Revisions");
    // Only the page shown is mounted: the revisions page, never the graph.
    match(panel, /class="rev-page"/);
    doesNotMatch(panel, /class="act-page"|class="revision-view"/);
    doesNotMatch(panel, /native-graph|id="history"/);
  }
  // Files and Releases are adjacent Model pages, each framed on its own address.
  for (const page of ["files", "releases"] as const) {
    const shown = place(`/model?page=${page}`);
    const panel = markup(shown);
    shows(shown, page, page === "files" ? "Files" : "Releases");
    match(panel, /Reading the files…/);
    doesNotMatch(panel, /class="act-page"|class="rev-page"|native-graph/);
  }
  // Source versions and the old unpinned graph address use the SysML page.
  for (
    const path of [
      "/model?page=sysml",
      "/model?page=graph",
      "/revisions?page=graph",
      "/model?modelVersion=commit%3Aabc",
      "/model?page=graph&modelVersion=commit%3Aabc",
    ]
  ) {
    const shown = place(path);
    const panel = markup(shown);
    shows(shown, "sysml", "SysML");
    equal((panel.match(/class="sysml-page"/g) || []).length, 1);
    doesNotMatch(
      panel,
      /native-graph|rev-page|act-page|files-page|<iframe|<script/,
    );
  }
  // Numeric execution history retains its renderer, with the SysML tab selected.
  for (const path of ["/model?revision=3", "/model?page=graph&revision=3"]) {
    const shown = place(path);
    const graph = markup(shown);
    shows(shown, "sysml", "SysML");
    equal((graph.match(/class="native-graph"/g) || []).length, 1);
    doesNotMatch(graph, /sysml-page|revision-view|act-page|files-page/);
    doesNotMatch(graph, /SysML model<\/h2>/);
    match(graph, /f-partial="\/model\?page=graph"/);
    match(graph, /id="return-model-current"[^>]*href="\/model\?page=graph"/);
  }
});

Deno.test("the System place opens on Team, in the frame of a place, and draws no graph", () => {
  for (
    const path of [
      "/system",
      "/system?page=team",
      "/system?select=unit-1",
      // An unknown page never leaves the place empty.
      "/system?page=nope",
    ]
  ) {
    const html = renderToString(
      <Workspace
        state={createWorkbenchState({ initialState: snapshot() })}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    const view = desk(html);
    const system = view.page.byRole("region", { name: "System" });
    const shown = within(system);
    shown.byRole("link", { name: "Close System" });
    equal(
      system.querySelector("[data-page]")?.getAttribute("data-page"),
      "team",
    );
    equal(textOf(shown.byRole("heading", { level: 1 })), "Team", path);
    // The place's pages, as tabs. The board is read once the place is open,
    // so until then the page says it is being read.
    ok(tabsOf(shown, "System pages").length > 1);
    deepStrictEqual(shown.allByRole("status").map(textOf), [
      "Reading the system…",
    ]);
    const panel = system.outerHTML;
    doesNotMatch(
      panel,
      /native-graph|SysML model|revision-view|Saved systems|Create release/,
    );
    // Nothing of the Model place is drawn while System is open.
    doesNotMatch(
      html.slice(html.indexOf('id="model-panel"'), html.indexOf("</main>")),
      /view-page|revision-view|native-graph/,
    );
  }
  // And it is drawn on its own address only.
  for (const path of ["/", "/chat", "/model", "/revisions", "/activity"]) {
    const html = renderToString(
      <Workspace
        state={createWorkbenchState({ initialState: snapshot() })}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    doesNotMatch(html, /data-page="team"/, path);
    match(html, /id="system-panel"[^>]*hidden/);
  }
});

Deno.test("the Activity place mounts its page only when it is the one open", () => {
  const place = (path: string) =>
    renderToString(
      <Workspace
        state={createWorkbenchState({ initialState: snapshot() })}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
  const open = desk(place("/activity"));
  ok(open.shown().includes("activity-panel"));
  const panel = within(open.page.byRole("region", { name: "Activity" }));
  equal(
    open.page.root.querySelector("[data-view]")?.getAttribute("data-view"),
    "activity",
  );
  equal(textOf(panel.byRole("heading", { level: 1 })), "Activity");
  // The panel closes back to the desk, like every place.
  equal(
    panel.byRole("link", { name: "Close Activity" }).getAttribute("href"),
    "/",
  );
  for (
    const path of ["/", "/chat", "/model", "/revisions", "/cases", "/activity"]
  ) {
    const html = place(path);
    // The page is drawn once, and only on its own address.
    equal(
      desk(html).panel("activity-panel").root.querySelectorAll(
        '[data-page="activity"]',
      ).length,
      path === "/activity" ? 1 : 0,
      path,
    );
    equal(
      desk(html).shown().includes("activity-panel"),
      path === "/activity",
      path,
    );
  }
});

Deno.test("the Activity place lists the host's decisions in their order, each to its own page, and the Dock counts the same", async () => {
  // The legacy tool of the fixture waits for a human; a proposal waits too.
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path) =>
      Promise.resolve(
        path === "/api/model-revisions"
          ? Response.json({
            version: "commit:base",
            sourceDigest: "a".repeat(64),
            proposals: [sourceProposal("native:beta", "proposed")],
            runtime: { active: null, available: null, executable: false },
          })
          : Response.json({}, { status: 404 }),
      ),
  });
  await state.refreshPendingDecisions();
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/activity"
    />,
  );
  const view = desk(html);
  const panel = view.panel("activity-panel");
  // How a line is drawn is ActivityPage's test; here, what reaches it.
  const rows = panel.allByRole("link", { name: /^(?!Close)/ }).map((row) => [
    row.getAttribute("data-kind"),
    row.getAttribute("href"),
    textOf(row),
  ]);
  // The host's order: the proposal to the model first, then the tool. The
  // proposal still leads to Model > Revisions, the tool to its conversation.
  deepStrictEqual(rows.map(([kind, href]) => [kind, href]), [
    ["proposal", "/model?proposal=proposal-native%3Abeta"],
    ["tool", "/chat"],
  ]);
  match(rows[0][2]!, /Review model proposal/);
  match(rows[1][2]!, /Authorize tool: <Lire>/);
  equal(state.pendingDecisionCount.value, 2);
  // The Dock says the same number, on the place that holds them.
  equal(view.places()[2][0], "Activity, 2 pending");
  // Nothing is decided on this page.
  equal(
    panel.queryByRole("button", { name: /Accept|Decline|Authorize/ }),
    null,
  );
});

Deno.test("with nothing waiting, Activity says so and the Dock counts none", () => {
  const quiet = { ...snapshot(), candidates: [] };
  const state = createWorkbenchState({ initialState: quiet });
  state.requests.sessionReady.value = true;
  equal(state.pendingDecisionCount.value, 0);
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/activity"
    />,
  );
  const view = desk(html);
  const panel = view.panel("activity-panel");
  equal(
    panel.byText("Nothing to decide").getAttribute("data-code"),
    "nothing-to-decide",
  );
  doesNotMatch(html, /decide-list|class="decide-row"/);
  deepStrictEqual(view.places()[2].slice(0, 1), ["Activity, 0 pending"]);
  state.dispose();
});

Deno.test("historical view preserves draft, disables composing and removes decision actions", async () => {
  const historical = snapshot();
  historical.revision = 4;
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () =>
      Promise.resolve(Response.json({ state: historical, projection: null })),
  });
  state.draft.value = "À reprendre au présent";
  match(
    renderToString(<ChatView state={state} active />),
    /class="proposal-actions"/,
  );
  await state.selectRevision(4);
  const chat = renderToString(<ChatView state={state} active />);
  match(chat, /id="input"[^>]*disabled/);
  match(chat, /À reprendre au présent/);
  match(chat, /Read-only · revision 4/);
  doesNotMatch(chat, /class="proposal-actions"/);
});

Deno.test("back to the selected runtime revision restores its graph after a source inspection without refetching", async () => {
  const historical = { ...snapshot(), revision: 2 };
  let requests = 0;
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () => {
      requests++;
      return Promise.resolve(
        Response.json({
          state: historical,
          projection: {
            revision: 2,
            digest: "b".repeat(64),
            graph: {},
            recordedAt: "2026-10-21T00:00:00Z",
          },
        }),
      );
    },
  });
  await synchronizeModelLocation(state, { revision: "2" });
  equal(state.graphRequestUrl.value, "/api/model-graph?revision=2");
  await synchronizeModelLocation(state, { modelVersion: "commit:abc" });
  equal(
    state.graphRequestUrl.value,
    "/api/model-graph?modelVersion=commit%3Aabc",
  );
  equal(state.selectedRevision.value, 2);
  await synchronizeModelLocation(state, { revision: "2" });
  equal(state.graphSourceSelection.value, null);
  equal(state.graphRequestUrl.value, "/api/model-graph?revision=2");
  equal(state.displayed.value?.revision, 2);
  equal(requests, 1);
  await synchronizeModelLocation(state, { revision: "2" });
  equal(requests, 1);
  const html = renderToString(<GraphView state={state} />);
  match(html, /action="\/model\?page=graph&amp;revision=2"/);
  match(html, /f-partial="\/model\?page=graph"/);
  match(html, /data-model-source="\/api\/model-graph\?revision=2"/);
});

Deno.test("revision runtime selector retains peer-only specialists and unmarked read models while excluding recorded audits", () => {
  const primary: AgentConversation = {
    agentId: "primary",
    nativeId: "native:primary",
    name: "Principal",
    responsibility: "Contact",
    primary: true,
    runtimeOwned: true,
    canSend: true,
    revision: 1,
    busy: false,
    phase: "Prêt",
    messages: [],
    modelDigest: "digest",
  };
  const peer = {
    ...primary,
    agentId: "peer",
    nativeId: "native:peer",
    name: "Spécialiste pair",
    primary: false,
    canSend: false,
    readOnlyReason: "Accessible par appel pair uniquement",
  };
  const audit = {
    ...peer,
    agentId: "audit",
    nativeId: "native:audit",
    name: "Audit observé",
    runtimeOwned: false,
  };
  const unmarked = {
    ...peer,
    agentId: "old",
    nativeId: "native:old",
    name: "Lecture sans marqueur",
    runtimeOwned: undefined,
  };
  const operators = [primary, peer, audit, unmarked];
  const offered = runtimeRevisionOperators(operators);
  equal(
    offered.map((operator) => operator.nativeId).join(","),
    "native:primary,native:peer,native:old",
  );
  equal(operators.length, 4);
  const html = renderToString(
    <RuntimeRevisionCard
      operators={offered}
      selectedId="native:peer"
      busy={false}
      onSelect={() => {}}
      onAdopt={() => {}}
    />,
  );
  match(html, /value="native:peer" selected/);
  match(html, /Spécialiste pair/);
  match(html, /Lecture sans marqueur/);
  doesNotMatch(html, /Audit observé|native:audit/);
});

Deno.test("an operator opened from the Dock shows its own conversation beside the central one", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(roster());
  state.draft.value = "Brouillon du coordinateur";
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat?agent=collector"
    />,
  );
  const side = html.slice(html.indexOf('id="agent-panel"'));
  match(html, /id="agent-panel" aria-label="Collecteur"\s*>/);
  match(side, /Sources rassemblées/);
  match(side, /id="agent-input"/);
  doesNotMatch(side, /Brouillon du coordinateur|Demande initiale/);
  match(html, /id="chat-panel"[^>]*hidden/);
  match(
    html,
    /class="dock-item is-active" href="\/" aria-label="Collecteur" aria-current="page"/,
  );
  // The central agent is the circle, never a Dock item.
  doesNotMatch(html, /data-agent-id="coordinator"/);
  match(html, /aria-label="Talk to Coordinateur"/);
});

Deno.test("the central conversation reads oldest first, ends above the composer and has no circle avatar", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(roster());
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  const start = html.indexOf('id="chat-panel"');
  const panel = html.slice(start, html.indexOf('id="agent-panel"'));
  match(panel, /aria-label="Conversation with Coordinateur"/);
  doesNotMatch(html, /id="chat-panel"[^>]*hidden/);
  const first = panel.indexOf("Demande initiale");
  const reply = panel.indexOf("Collecteur missionné");
  const latest = panel.indexOf("Dernière nouvelle");
  ok(first > 0 && first < reply && reply < latest);
  ok(latest < panel.indexOf('id="composer"'));
  doesNotMatch(panel, /dock-circle|avatar/);
  match(html, /class="desk-stage is-talking"/);
});

/** A local backend double: conversations, and agent messages with optional conflicts. */
function backend(
  current: () => ConversationsSnapshot,
  sent: string[],
  conflicts: string[] = [],
) {
  return (path: string, init?: RequestInit) => {
    const message = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (message && init?.method === "POST") {
      const agentId = decodeURIComponent(message[1]);
      sent.push(agentId);
      return Promise.resolve(
        conflicts.includes(agentId)
          ? Response.json({ error: "Conflit de révision" }, { status: 409 })
          : Response.json({ accepted: true }),
      );
    }
    if (path === "/api/conversations") {
      return Promise.resolve(Response.json(current()));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  };
}

Deno.test("the circle, the header and every send follow the contact point when an admitted version moves it", async () => {
  const sent: string[] = [];
  const moved = roster();
  moved.version = "roster-2";
  moved.defaultAgentId = "collector";
  moved.conversations[0].primary = false;
  moved.conversations[1].primary = true;
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: backend(() => moved, sent),
  });
  state.agentConversations.accept(roster());
  state.agentConversations.accept(moved);
  equal(state.agentConversations.selectedAgentId.value, "collector");
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  match(html, /aria-label="Talk to Collecteur"/);
  match(html, /aria-label="Conversation with Collecteur"/);
  match(html, /class="agent-header-name"[^>]*><span>Collecteur<\/span>/);
  // The former contact point, still present, becomes ordinary work.
  match(html, /data-agent-id="coordinator"/);
  state.draft.value = "Bonjour";
  equal(await state.sendMessage(), true);
  deepStrictEqual(sent, ["collector"]);
});

Deno.test("a failed send to the operator beside the conversation shows in that panel only", async () => {
  const sent: string[] = [];
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: backend(roster, sent, ["collector"]),
  });
  state.agentConversations.accept(roster());
  equal(
    await state.agentConversations.sendTo("collector", "Relance la collecte"),
    false,
  );
  deepStrictEqual(sent, ["collector"]);
  equal(state.agentConversations.errorFor("collector"), "Conflit de révision");
  equal(state.agentConversations.error.value, "");
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat?agent=collector"
    />,
  );
  const central = html.slice(
    html.indexOf('id="chat-panel"'),
    html.indexOf('id="agent-panel"'),
  );
  const side = html.slice(
    html.indexOf('id="agent-panel"'),
    html.indexOf('id="model-panel"'),
  );
  match(side, /Conflit de révision/);
  doesNotMatch(central, /Conflit de révision/);
});

Deno.test("dock work keeps arrival order when the catalogue inserts a new thread before older ones", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const first = roster();
  state.agentConversations.accept(first);
  const second = roster();
  second.version = "roster-2";
  // The backend lists a reviewer right after its owner, before older work.
  second.conversations.splice(1, 0, {
    ...second.conversations[1],
    agentId: "reviewer",
    nativeId: "native:reviewer",
    name: "Relecteur",
    canSend: false,
    messages: [],
  });
  state.agentConversations.accept(second);
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/"
    />,
  );
  // Newest first: where the Dock draws them is its own test.
  const work = desk(html).dock.byRole("list", { name: "Work in progress" });
  deepStrictEqual(
    [...work.querySelectorAll("[data-agent-id]")].map((tile) =>
      tile.getAttribute("data-agent-id")
    ),
    ["reviewer", "collector"],
  );
});

function movedRoster(): ConversationsSnapshot {
  const moved = roster();
  moved.version = "roster-2";
  moved.defaultAgentId = "collector";
  moved.conversations[0].primary = false;
  moved.conversations[1].primary = true;
  return moved;
}

Deno.test("drafts follow their agent when the contact point moves, whichever panel shows them", async () => {
  const sent: string[] = [];
  let current = roster();
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: backend(() => current, sent),
  });
  state.agentConversations.accept(current);
  state.draft.value = "Brouillon du coordinateur";
  state.agentConversations.setDraft("collector", "Brouillon du collecteur");
  equal(state.draft.value, "Brouillon du coordinateur");
  // An adopted version makes the side operator the contact point.
  current = movedRoster();
  state.agentConversations.accept(current);
  equal(state.draft.value, "Brouillon du collecteur");
  equal(
    state.agentConversations.draftFor("coordinator"),
    "Brouillon du coordinateur",
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat?agent=coordinator"
    />,
  );
  const central = html.slice(
    html.indexOf('id="chat-panel"'),
    html.indexOf('id="agent-panel"'),
  );
  const side = html.slice(
    html.indexOf('id="agent-panel"'),
    html.indexOf('id="model-panel"'),
  );
  match(central, /Brouillon du collecteur/);
  match(side, /id="agent-input"[^>]*value="Brouillon du coordinateur"/);
  // Sending from the side panel clears that agent's draft only.
  equal(
    await state.agentConversations.sendTo(
      "coordinator",
      "Brouillon du coordinateur",
      true,
    ),
    true,
  );
  deepStrictEqual(sent, ["coordinator"]);
  equal(state.agentConversations.draftFor("coordinator"), "");
  equal(state.draft.value, "Brouillon du collecteur");
});

Deno.test("a historical revision names that era's agent in the conversation, never the present roster", async () => {
  const historical = {
    ...snapshot(),
    revision: 4,
    messages: [{
      id: "old",
      role: "assistant" as const,
      text: "Ancienne réponse",
      at: "2026-10-20T08:00:00Z",
    }],
    executionModel: {
      identity: { builderId: "native:old" },
      operator: {
        nativeId: "native:old",
        name: "Ancien concepteur",
        instruction: "Ancienne mission",
      },
      // Only the operator and builder identities are read by the conversation.
    } as unknown as NonNullable<ReturnType<typeof snapshot>["executionModel"]>,
  };
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () =>
      Promise.resolve(Response.json({ state: historical, projection: null })),
  });
  state.agentConversations.accept(roster());
  await synchronizeModelLocation(state, { revision: "4" });
  equal(state.readOnly.value, true);
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/model?revision=4"
    />,
  );
  const central = html.slice(
    html.indexOf('id="chat-panel"'),
    html.indexOf('id="agent-panel"'),
  );
  match(central, /aria-label="Conversation with Ancien concepteur"/);
  match(central, /Historical view · revision 4/);
  match(central, /Ancienne réponse/);
  doesNotMatch(
    central,
    /Coordinateur|Coordonner|agent-header-name|agent-details|Demande initiale/,
  );
  // Back to the present goes through the address, which holds the revision.
  match(
    central,
    /<a class="action primary" id="return-current" href="\/model\?page=graph"/,
  );
});

Deno.test("work shown together keeps its order when one thread receives its first message", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const quiet = roster();
  quiet.conversations.push({
    ...quiet.conversations[1],
    agentId: "analyst",
    nativeId: "native:analyst",
    name: "Analyste",
    messages: [],
  });
  quiet.conversations[1].messages = [];
  state.agentConversations.accept(quiet);
  const order = () => {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl="https://atelier.test/"
      />,
    );
    return html.indexOf('data-agent-id="analyst"') <
      html.indexOf('data-agent-id="collector"');
  };
  // Collector is first in the catalogue, so it sits next to the logo.
  equal(order(), true);
  const spoken = structuredClone(quiet);
  spoken.version = "roster-2";
  spoken.conversations[2].messages = [{
    id: "first",
    role: "assistant",
    text: "Premier message",
    at: "2026-10-24T07:00:00Z",
  }];
  state.agentConversations.accept(spoken);
  equal(order(), true);
});

/** A source proposal by an operator, with the version its decision moves to. */
function sourceProposal(
  owner: string,
  status: "proposed" | "accepted",
): SourceProposal {
  return {
    id: `proposal-${owner}`,
    author: `agent:${owner}`,
    reason: "Quota",
    status,
    baseVersion: "commit:base",
    proposalVersion: "commit:proposed",
    acceptedVersion: status === "accepted" ? "commit:accepted" : undefined,
    sourceDigest: "a".repeat(64),
    createdAt: "2026-10-24T08:30:00Z",
    authorization: {
      kind: "operator" as const,
      operatorNativeId: owner,
      systemQualifiedName: "System",
      operatorQualifiedName: "System::agent",
      mandateId: "mandate",
      mandateRevision: 1,
      policyId: "policy",
      policyRevision: 1,
      policyDigest: "b".repeat(64),
      operations: ["set-value"],
    },
  };
}

Deno.test("a decision made in Evolution makes the conversation reread its proposals, with no runtime revision change", async () => {
  let status: "proposed" | "accepted" = "proposed";
  const reads: string[] = [];
  // No legacy tool candidates: only the source proposal can be pending.
  const quiet = { ...snapshot(), candidates: [] };
  const state = createWorkbenchState({
    initialState: quiet,
    fetch: (path) =>
      Promise.resolve(
        path === "/api/state"
          ? Response.json(quiet)
          : path === "/api/history"
          ? Response.json({ revisions: [] })
          : Response.json({ proposals: [] }),
      ),
    proposalApi: {
      read: (agentId: string) => {
        reads.push(agentId);
        return Promise.resolve({
          agentId,
          version: status === "proposed" ? "commit:base" : "commit:accepted",
          sourceDigest: "c".repeat(64),
          proposals: [sourceProposal(agentId, status)],
          runtime: { available: null, active: null, executable: true },
        });
      },
      preview: () => Promise.reject(new Error("no preview")),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    } as never,
  });
  state.agentConversations.accept(roster());
  await state.chatProposals.refresh("native:coordinator");
  const before = renderToString(<ChatView state={state} active />);
  match(before, /class="chat-proposal is-pending"/);
  // The Evolution panel's own command path, wired as the workbench wires it,
  // with its reread suspended: the conversation is stale before any reread.
  let releaseEvolution!: () => void;
  const command = runSourceCommand(state.chatProposals, {
    operation: () => {
      status = "accepted";
      return Promise.resolve();
    },
    reread: () => new Promise<void>((resolve) => releaseEvolution = resolve),
    changed: () => state.sourcesChanged(),
  });
  await Promise.resolve();
  equal(state.chatProposals.generation.value, 1);
  equal(state.chatProposals.canAct("native:coordinator"), false);
  releaseEvolution();
  await command;
  deepStrictEqual(reads, ["native:coordinator", "native:coordinator"]);
  equal(state.chatProposals.canAct("native:coordinator"), true);
  const after = renderToString(<ChatView state={state} active />);
  doesNotMatch(after, /class="chat-proposal is-pending"/);
  match(after, /Accepted/);
});

Deno.test("Activate stays disabled while the operator's proposals are stale after a decision elsewhere", async () => {
  let failCoordinator = false;
  const state = createWorkbenchState({
    initialState: snapshot(),
    proposalApi: {
      read: (agentId: string) =>
        agentId === "native:coordinator" && failCoordinator
          ? Promise.reject(new Error("Relecture impossible"))
          : Promise.resolve({
            agentId,
            version: "commit:accepted",
            sourceDigest: "c".repeat(64),
            proposals: [
              sourceProposal(agentId, "accepted"),
              { ...sourceProposal(agentId, "proposed"), id: "second" },
            ],
            runtime: {
              available: {
                digest: "new",
                repositoryVersion: "commit:accepted",
              },
              active: { digest: "old" },
              executable: true,
            },
          }),
      preview: () => Promise.reject(new Error("no preview")),
      decide: () => Promise.resolve({}),
      adopt: () => Promise.resolve({}),
    } as never,
  });
  state.agentConversations.accept(roster());
  await state.chatProposals.refresh("native:coordinator");
  await state.chatProposals.refresh("native:collector");
  const activate = () =>
    renderToString(<ChatView state={state} active />).match(
      /<button type="button" class="proposal-accept"[^>]*>Activate for/,
    )?.[0] ?? "";
  ok(activate() && !/disabled/.test(activate()));
  // The collector refuses its own proposal; the coordinator's reread fails.
  failCoordinator = true;
  const second = {
    ...sourceProposal("native:collector", "proposed"),
    id: "second",
  };
  equal(
    await state.chatProposals.decide(second, "native:collector", "refuse"),
    true,
  );
  equal(state.chatProposals.isStale("native:coordinator"), true);
  match(activate(), /disabled/);
});

Deno.test("tool, mandate, source and Evolution decisions share one lock: none acts while another is in flight", async () => {
  let release!: () => void;
  const decisions: string[] = [];
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path, init) => {
      if (path === "/api/decisions" && init?.method === "POST") {
        decisions.push(path);
        return new Promise((resolve) =>
          release = () => resolve(Response.json({ accepted: true }))
        );
      }
      return Promise.resolve(
        path === "/api/state"
          ? Response.json(snapshot())
          : Response.json({ revisions: [] }),
      );
    },
  });
  const toolButtons = () =>
    renderToString(<ChatView state={state} active />).match(
      /<button type="button" class="proposal-accept"[^>]*>/,
    )?.[0] ?? "";
  doesNotMatch(toolButtons(), /disabled/);
  // A legacy tool admission is in flight: everything else waits for it.
  const admission = state.decide(
    "candidate",
    "c1",
    "approve",
    7,
    "a".repeat(64),
  );
  equal(state.chatProposals.inFlight.value, true);
  equal(state.decisionsOpen.value, false);
  equal(await state.decide("change", "x", "approve", 7), false);
  // An Evolution command is not even sent while the admission is in flight.
  equal(
    await runSourceCommand(state.chatProposals, {
      operation: () => Promise.reject(new Error("must not be sent")),
      reread: () => Promise.resolve(),
      changed: () => {},
    }),
    false,
  );
  equal(state.chatProposals.generation.value, 0);
  release();
  equal(await admission, true);
  deepStrictEqual(decisions, ["/api/decisions"]);
  equal(state.chatProposals.inFlight.value, false);
  // Conversely, a change from Evolution in flight disables the tool card.
  let settle!: () => void;
  const evolution = state.chatProposals.track(() =>
    new Promise<void>((resolve) => settle = resolve)
  );
  match(toolButtons(), /disabled/);
  equal(
    await state.decide("candidate", "c1", "approve", 7, "a".repeat(64)),
    false,
  );
  settle();
  await evolution;
  equal(state.decisionsOpen.value, true);
});

/** The roster with case-attached messages, from the central agent and a specialist. */
function casesRoster(): ConversationsSnapshot {
  const base = roster();
  base.conversations[0].messages = [{
    id: "m1",
    role: "user",
    text: "Find AI training offers",
    at: "2026-10-24T11:00:00Z",
    caseId: "ui-fixture:case:1",
  } as never, {
    id: "m2",
    role: "assistant",
    text: "I asked Collecteur to gather sources.",
    at: "2026-10-24T11:01:00Z",
    caseId: "ui-fixture:case:1",
  } as never, {
    id: "m3",
    role: "assistant",
    text: "Unrelated earlier note",
    at: "2026-10-24T10:00:00Z",
  }];
  base.conversations[1].messages = [{
    id: "w1",
    role: "assistant",
    text: "Twelve offers found.",
    at: "2026-10-24T11:00:30Z",
    caseId: "ui-fixture:case:1",
  } as never];
  return base;
}

Deno.test("left of the logo: the open Requests, the pinned Cases next to the Requests button, then the button", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [
      caseRecord(1),
      caseRecord(2),
      caseRecord(3, { status: "done", closedAt: "2026-10-24T14:00:00Z" }),
    ],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  state.pins.toggle("ui-fixture:case:1");
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/"
    />,
  );
  const view = desk(html);
  const tile = (id: string) =>
    view.dock.root.querySelectorAll(`[data-case-id="${id}"]`);
  const requests = view.dock.byRole("link", { name: "Requests" });
  equal(requests.getAttribute("href"), "/cases");
  ok(inOrder(
    tile("ui-fixture:case:2")[0],
    tile("ui-fixture:case:1")[0],
    requests,
    view.circle(),
  ));
  // A pinned Case has one tile, not two, marked with its pin.
  equal(tile("ui-fixture:case:1").length, 1);
  const pinned = tile("ui-fixture:case:1")[0];
  match(nameOf(pinned), /, pinned$/);
  for (const mark of ["is-case", "is-request", "is-pinned"]) {
    ok(pinned.classList.contains(mark), mark);
  }
  ok(pinned.querySelector(".dock-pin"));
  const dock = html.slice(html.indexOf('<nav class="dock"'));
  // A done Request leaves the Dock unless it is pinned.
  doesNotMatch(dock, /data-case-id="ui-fixture:case:3"/);
  // Other operators are no longer Dock tiles: the central agent's name lists them.
  doesNotMatch(dock, /data-agent-id=/);
});
Deno.test("a Request whose operator asked a change lights its Dock tile and its row in the list, and no other", () => {
  const asks = grant({
    id: "network",
    requestedBy: "native:research",
    caseId: "ui-fixture:case:2",
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({ initialState: current });
  // Main holds no change: the Branch Operator asked in its own Request.
  state.agentConversations.accept(operatorRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  seedRequestCases(
    state,
    {
      systemId: "ui-fixture",
      cases: [
        caseRecord(1, { owner: "native:designer" }),
        caseRecord(2, { owner: "native:research" }),
      ],
    },
    operatorRoster([], [asks]),
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/cases"
    />,
  );
  const view = desk(html);
  const tile = (number: number) =>
    nameOf(
      view.dock.root.querySelector(
        `[data-case-id="ui-fixture:case:${number}"]`,
      )!,
    );
  match(tile(2), /, decision waiting$/);
  doesNotMatch(tile(1), /decision waiting/);
  const row = (number: number) =>
    view.panel("cases-panel").root.querySelector(
      `a.rev-row[href*="case%3A${number}"]`,
    )!.textContent;
  match(row(2), /needs you/);
  doesNotMatch(row(1), /needs you/);
  state.dispose();
});

Deno.test("Activity lists an independent Request's pending decision and its badge counts the same queue", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  state.agentConversations.accept(operatorRoster());
  const request = caseRecord(2, { owner: "native:research" });
  seedRequestCases(
    state,
    { systemId: "ui-fixture", cases: [request] },
    operatorRoster([], [grant({
      id: "request-change",
      requestedBy: "native:research",
      caseId: request.id,
    })]),
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/activity"
    />,
  );
  const view = desk(html);
  equal(view.places()[2][0], "Activity, 1 pending");
  equal(state.pendingDecisionCount.value, 1);
  equal(
    view.panel("activity-panel").allByRole("link", { name: /Authorize/ })
      .length,
    1,
  );
  doesNotMatch(html, /Nothing to decide/);
  state.dispose();
});

Deno.test("open Requests retain readers; invalidation rereads only its held Request", async () => {
  const root = probeRoot();
  const reads: string[] = [];
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: (path) => {
      reads.push(decodeURIComponent(path));
      return Promise.reject(new Error("unavailable"));
    },
  });
  state.requests.cases.accept({
    systemId: "ui-fixture",
    cases: [
      caseRecord(1),
      caseRecord(2),
      caseRecord(3, {
        status: "closed-done",
        closedAt: "2026-10-24T14:00:00Z",
      }),
    ],
  });
  function Probe(props: { started: boolean }) {
    useOpenRequestReads(state, props.started);
    return null;
  }
  try {
    // Not started, or no Request session yet: no read.
    await root.show(Probe, { started: false });
    await root.show(Probe, { started: true });
    deepStrictEqual(reads, []);
    // The session opens: each open Request is read, the closed one is not.
    state.requests.sessionReady.value = true;
    await root.show(Probe, { started: true });
    deepStrictEqual(reads.sort(), [
      "/api/conversations?caseId=ui-fixture:case:1",
      "/api/conversations?caseId=ui-fixture:case:2",
    ]);
    // Rendering again does not poll the held Requests.
    // Let the first reads finish: a read still in flight is shared, not repeated.
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads.length = 0;
    await root.show(Probe, { started: true });
    deepStrictEqual(reads, []);
    await state.requests.invalidateConversation("ui-fixture:case:2");
    deepStrictEqual(reads.sort(), [
      "/api/cases/ui-fixture:case:2?space=requests",
      "/api/conversations?caseId=ui-fixture:case:2",
    ]);
    reads.length = 0;
    await root.show(Probe, { started: false });
    await state.requests.invalidateConversation("ui-fixture:case:2");
    deepStrictEqual(reads, ["/api/cases/ui-fixture:case:2?space=requests"]);
  } finally {
    await root.restore();
    state.dispose();
  }
});

Deno.test("a Request is read on the Requests page: its own conversation, its actions on it", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  // Both addresses of a Request lead to the same selected page.
  for (const path of ["/cases?case=", "/chat?case="]) {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}ui-fixture%3Acase%3A1`}
      />,
    );
    doesNotMatch(html, /id="chat-panel"[^>]*hidden/);
    match(html, /id="case-panel"[^>]*hidden/);
    const page = html.slice(
      html.indexOf('id="cases-panel"'),
      html.indexOf('id="case-panel"'),
    );
    match(page, /<h2>Objective 1<\/h2>/);
    match(page, /aria-label="Keep in Dock" aria-pressed="false"/);
    doesNotMatch(page, /<button[^>]*>Close<\/button>/);
    // Only this Case's messages: the request and the reply, not the designer's.
    match(page, /Find AI training offers/);
    match(page, /I asked Collecteur/);
    doesNotMatch(page, /Unrelated earlier note/);
    // The left column holds this Case's agents, not the Cases.
    match(page, /<nav class="case-tree" aria-label="Conversations">/);
    doesNotMatch(page, /class="cases-list"/);
    doesNotMatch(page, /class="feed-group"|<h1>Requests<\/h1>/);
    match(page, /<a class="cases-back" href="\/cases">/);
    // The Dock's Requests tile is the open page, and leads back to the list.
    match(html, /id="cases-link" href="\/cases"[^>]*aria-current="page"/);
  }
});

Deno.test("a pinned Request opens the Requests page on it; a pinned Job keeps its own page", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(1), caseRecord(2), jobRecord()],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  for (const id of [1, 2, 7]) state.pins.toggle(`ui-fixture:case:${id}`);
  const render = (path: string) =>
    renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
  const tile = (html: string, id: number) =>
    html.match(
      new RegExp(`<a[^>]*data-case-id="ui-fixture:case:${id}"[^>]*>`),
    )?.[0] ?? "";
  const home = render("/");
  match(tile(home, 1), /href="\/cases\?case=ui-fixture%3Acase%3A1"/);
  match(tile(home, 7), /href="\/chat\?case=ui-fixture%3Acase%3A7"/);
  // On the page, the selected Request's tile is the open one: it closes it.
  const open = render("/cases?case=ui-fixture%3Acase%3A1");
  match(tile(open, 1), /href="\/chat"/);
  match(tile(open, 2), /href="\/cases\?case=ui-fixture%3Acase%3A2"/);
});

Deno.test("a Job named on the Cases address keeps its own page", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(roster());
  state.cases.accept({ systemId: "ui-fixture", cases: [jobRecord()] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/cases?case=ui-fixture%3Acase%3A7"
    />,
  );
  match(html, /id="case-panel"(?![^>]*hidden)/);
  match(html, /id="cases-panel"[^>]*hidden/);
  match(html, /class="case-view is-job"/);
  // The Requests tile is not the open one.
  match(html, /id="cases-link" href="\/cases"/);
});

Deno.test("the designer's conversation shows only messages outside any Case", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  const chat = html.slice(
    html.indexOf('id="chat-panel"'),
    html.indexOf('id="agent-panel"'),
  );
  match(chat, /Unrelated earlier note/);
  doesNotMatch(chat, /Find AI training offers|I asked Collecteur/);
  doesNotMatch(chat, /class="cases-page/);
});

Deno.test("the Requests page without a selection lists every Request above a field that starts a Case", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [
      caseRecord(1),
      caseRecord(2, {
        status: "closed-done",
        closedAt: "2026-10-24T14:00:00Z",
      }),
    ],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  // `/cases` and the old address of a Case not opened yet are the same page.
  for (const path of ["/cases", "/chat?case=new"]) {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    const page = html.slice(
      html.indexOf('id="cases-panel"'),
      html.indexOf('id="case-panel"'),
    );
    match(html, /id="cases-panel"(?![^>]*hidden)/);
    match(page, /<h1>Requests<\/h1>/);
    // Open then Done, each Request a link, and no Coordinator row.
    match(
      page,
      /class="feed-group">Open<[\s\S]*case%3A1"[\s\S]*class="feed-group">Done<[\s\S]*case%3A2"/,
    );
    doesNotMatch(page, /cases-back/);
    match(page, /id="cases-input"[^>]*placeholder="What do you need\?"/);
    // Nothing of any Case, nor of the designer, in the empty conversation.
    doesNotMatch(page, /Find AI training offers|Unrelated earlier note|<h2/);
    doesNotMatch(page, /aria-current="true"/);
    // On the list the Requests button closes the page.
    match(html, /id="cases-link" href="\/"[^>]*aria-current="page"/);
  }
});

Deno.test("the Requests button opens the list, leads back to it from a Case, and closes it from the list", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const button = (path: string) =>
    renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    ).match(/<a[^>]*id="cases-link"[^>]*>/)?.[0] ?? "";
  match(button("/"), /href="\/cases"(?![^>]*aria-current)/);
  match(button("/cases"), /href="\/"[^>]*aria-current="page"/);
  for (
    const path of [
      "/cases?case=ui-fixture%3Acase%3A1",
      "/cases?case=ui-fixture%3Acase%3A1&agent=collector",
    ]
  ) {
    match(button(path), /href="\/cases"[^>]*aria-current="page"/);
  }
});

Deno.test("a sub-agent named by the address is read on the Requests page, without a field", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const render = (path: string) => {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    return html.slice(
      html.indexOf('id="cases-panel"'),
      html.indexOf('id="case-panel"'),
    );
  };
  const main = render("/cases?case=ui-fixture%3Acase%3A1");
  // The owner at the root, then the sub-agent below it with its message count.
  match(
    main,
    /<nav class="case-tree" aria-label="Conversations">[\s\S]*aria-level="1"[\s\S]*aria-current="true"[\s\S]*Coordinateur[\s\S]*aria-level="2"[\s\S]*case%3A1&amp;agent=collector"[\s\S]*Collecteur<\/span>\s*<span class="tree-count">1<span class="sr-only"> message</,
  );
  match(main, /id="cases-input"[^>]*placeholder="Reply…"/);
  // The panel on the right is the selected agent's: the owner's, here.
  match(main, /<aside class="agent-panel"[^>]*data-agent-id="coordinator"/);
  const reading = render(
    "/cases?case=ui-fixture%3Acase%3A1&agent=collector",
  );
  match(reading, /aria-label="Collecteur"/);
  match(reading, /<aside class="agent-panel"[^>]*data-agent-id="collector"/);
  match(reading, /Twelve offers found\./);
  doesNotMatch(reading, /I asked Collecteur|id="cases-input"|<textarea/);
  // The Case stays the page: its head and its way back.
  match(reading, /<h2>Objective 1<\/h2>/);
  match(reading, /<a class="cases-back" href="\/cases">/);
});

Deno.test("a message attached to a Case shows a discreet chip that opens it", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(<ChatView state={state} active />);
  // One chip where the conversation enters the Case, not one per message.
  equal((html.match(/class="case-chip"/g) ?? []).length, 1);
  match(
    html,
    /<a class="case-chip" href="\/cases\?case=ui-fixture%3Acase%3A1">Objective 1<\/a>/,
  );
});

Deno.test("a Main Job tile from SSE survives an older suspended GET response without becoming a durable Request", async () => {
  const listeners = new Map<string, (event: { data?: string }) => void>();
  let finish!: (snapshot: CasesSnapshot) => void;
  const response = new Promise<CasesSnapshot>((resolve) => finish = resolve);
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () => Promise.resolve(Response.json({}, { status: 404 })),
    casesPort: {
      read: () => response,
      readOne: () => Promise.resolve(null),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
    eventSourceFactory: () => ({
      addEventListener: (type, listener) => listeners.set(type, listener),
      close: () => {},
    }),
  });
  const stop = state.start();
  try {
    // The production SSE listener receives both Cases while GET is suspended.
    listeners.get("cases")!({
      data: JSON.stringify({
        systemId: "ui-fixture",
        cases: [{ ...jobRecord(), id: "ui-fixture:case:1", number: 1 }, {
          ...jobRecord(),
          id: "ui-fixture:case:2",
          number: 2,
        }],
      }),
    });
    finish({
      systemId: "ui-fixture",
      cases: [state.cases.byId("ui-fixture:case:1")!],
    });
    // The store registered its response handler when start() began the GET.
    await response;
    state.pins.toggle("ui-fixture:case:1");
    state.pins.toggle("ui-fixture:case:2");
    const html = renderToString(
      <Workspace state={state} started initialUrl="https://atelier.test/" />,
    );
    match(html, /data-case-id="ui-fixture:case:1"/);
    match(html, /data-case-id="ui-fixture:case:2"/);
    equal(state.requests.cases.snapshot.value, null);
  } finally {
    stop();
  }
});

Deno.test("without Cases on the backend (404), the Dock keeps the operator conversations and shows no error", async () => {
  const state = createWorkbenchState({
    initialState: snapshot(),
    casesPort: {
      read: () => Promise.resolve(null),
      readOne: () => Promise.resolve(null),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  state.agentConversations.accept(roster());
  await state.cases.refresh();
  equal(state.cases.supported.value, false);
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/"
    />,
  );
  match(html, /data-agent-id="collector"/);
  doesNotMatch(html, /data-case-id|case-chip|Cases unavailable/);
});

Deno.test("a Job page shows its steps, its judgment point as buttons and its recent runs", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(roster());
  state.cases.accept({ systemId: "ui-fixture", cases: [jobRecord()] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat?case=ui-fixture%3Acase%3A7"
    />,
  );
  const panel = html.slice(
    html.indexOf('id="case-panel"'),
    html.indexOf('id="model-panel"'),
  );
  match(panel, /class="case-view is-job"/);
  match(panel, />Job</);
  match(panel, />1st of the month, 09:00</);
  const steps = [...panel.matchAll(/class="job-step is-([a-z]+)"/g)].map((m) =>
    m[1]
  );
  deepStrictEqual(steps, ["done", "done", "judgment", "pending"]);
  match(panel, /Publish this draft\?/);
  // Not wired to a backend yet: visible, disabled, and saying so.
  match(
    panel,
    /<button type="button"\s+disabled\s+title="Not available yet"\s*>Publish</,
  );
  equal((panel.match(/class="job-run is-/g) ?? []).length, 3);
  match(panel, /class="case-close"/);
  // Jobs stand on the right of the logo, behind their own button.
  const view = desk(html);
  ok(
    inOrder(view.circle(), view.dock.byRole("button", { name: /^Jobs \(1\)/ })),
  );
});

Deno.test("a Watch page shows its state, its wake band and folds quiet wakes; Pause and Stop wait for the backend", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.cases.accept({ systemId: "ui-fixture", cases: [watchRecord()] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <CaseView state={state} record={state.cases.byId("ui-fixture:case:8")} />,
  );
  match(
    html,
    /class="watch-state is-watching" role="status"\s*>Watching · next wake /,
  );
  equal((html.match(/class="is-changed"/g) ?? []).length, 1);
  equal((html.match(/class="is-quiet"/g) ?? []).length, 5);
  match(html, />3 wakes without change</);
  match(html, />2 new offers</);
  match(html, />2 wakes without change</);
  match(html, /disabled title="Not available yet"\s*>Pause</);
  match(html, /disabled title="Not available yet"\s*>Stop</);
  // A Watch ends with Stop, not with Close case.
  doesNotMatch(html, /class="case-close"/);
  const calls: string[] = [];
  const paused = createWorkbenchState({ initialState: snapshot() });
  paused.cases.accept({
    systemId: "ui-fixture",
    cases: [watchRecord(8, "paused")],
  });
  const wired = renderToString(
    <CaseView
      state={paused}
      record={paused.cases.byId("ui-fixture:case:8")}
      actions={{
        run: () => calls.push("run"),
        pause: () => calls.push("pause"),
        resume: () => calls.push("resume"),
        stop: () => calls.push("stop"),
      }}
    />,
  );
  match(wired, />Paused</);
  match(wired, /<button type="button"\s*>Resume</);
});

Deno.test("the top bar holds the Assembly menu, and the connection shows only when something is wrong", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.connection.value = "live";
  const live = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/"
    />,
  );
  const bar = live.slice(0, live.indexOf("</header>"));
  match(
    bar,
    /<button type="button" class="app-menu-button"[^>]*aria-expanded="false"[^>]*>Assembly</,
  );
  doesNotMatch(bar, /id="connection"/);
  state.connection.value = "reconnecting";
  const broken = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/"
    />,
  );
  match(broken, /id="connection" role="status"[\s\S]*Reconnecting…/);
});

Deno.test("a busy header does not infer its current Case from owned Requests or message history", () => {
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const threads = roster();
  threads.conversations[0].busy = true;
  threads.conversations[0].messages.push(
    {
      id: "second-case-work",
      role: "assistant",
      text: "Working on the second request",
      at: "2026-10-24T12:30:00Z",
      caseId: "ui-fixture:case:2",
    } as AgentConversation["messages"][number],
  );
  state.agentConversations.accept(threads);
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(1), caseRecord(2)],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  match(
    html,
    /class="agent-header-phase is-busy" role="status"\s*>Working</,
  );
  doesNotMatch(html, /Working on Case #/);
});

Deno.test("the central agent's header says what it works on, without an avatar", () => {
  // No legacy tool waits for a decision in this system.
  const state = createWorkbenchState({
    initialState: { ...snapshot(), candidates: [] },
  });
  const threads = roster();
  threads.conversations[0].busy = true;
  state.agentConversations.accept(threads);
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(12, { createdAt: "2026-10-24T12:00:00Z" })],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const header = () => {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl="https://atelier.test/chat"
      />,
    );
    return html.slice(
      html.indexOf('id="chat-panel"'),
      html.indexOf('id="agent-panel"'),
    );
  };
  match(
    header(),
    /class="agent-header-phase is-busy" role="status"\s*>Working</,
  );
  threads.conversations[0].busy = false;
  threads.version = "roster-2";
  state.agentConversations.accept(threads);
  match(header(), /role="status"\s*>Waiting for you</);
  state.cases.accept({ systemId: "ui-fixture", cases: [] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  match(header(), /role="status"\s*>Idle</);
  doesNotMatch(header(), /avatar|dock-circle/);
});

Deno.test("conversation links keep the exact agent identity", () => {
  equal(conversationHref("native:a/b"), "/chat?agent=native%3Aa%2Fb");
  equal(conversationHref(), "/chat");
});

function roster(): ConversationsSnapshot {
  const base = {
    responsibility: "Coordonner",
    revision: 1,
    busy: false,
    phase: "Prêt",
    modelDigest: "digest",
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
      canSend: true,
      messages: [
        {
          id: "a",
          role: "user",
          text: "Demande initiale",
          at: "2026-10-24T08:00:00Z",
        },
        {
          id: "b",
          role: "assistant",
          text: "Collecteur missionné",
          at: "2026-10-24T08:01:00Z",
        },
        {
          id: "c",
          role: "assistant",
          text: "Dernière nouvelle",
          at: "2026-10-24T08:02:00Z",
        },
      ],
    }, {
      ...base,
      agentId: "collector",
      nativeId: "native:collector",
      name: "Collecteur",
      primary: false,
      canSend: true,
      messages: [{
        id: "d",
        role: "assistant",
        text: "Sources rassemblées",
        at: "2026-10-24T08:01:30Z",
      }],
    }],
  };
}

Deno.test("model places reuse the selected Request sub-operator and refuse unavailable Case models", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(1), caseRecord(2)],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const agentId = casesRoster().conversations[1].agentId;
  for (const path of ["/system?page=rights", "/model?page=files"]) {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}&caseBranch=ui-fixture%3Acase%3A1&agent=${agentId}`}
      />,
    );
    match(html, /id="chat-panel"[^>]*hidden/);
    const request = html.slice(
      html.indexOf('id="cases-panel"'),
      html.indexOf('id="case-panel"'),
    );
    doesNotMatch(request.slice(0, request.indexOf(">") + 1), /hidden/);
    match(request, /cases-page is-case is-compact/);
    match(request, /Twelve offers found/);
    doesNotMatch(request, /id="cases-input"/);
    match(request, new RegExp(`Open full Request`));
    match(html, /aria-label="Request 1 · Version unavailable · Read-only"/);
    match(html, /Reading the Request model/);
    const dock = html.slice(html.indexOf('<nav class="dock"'));
    match(dock, /has-context is-context-request/);
    match(dock, /dock-context-badge/);
    // Selecting the other Request keeps whichever right-hand page was open.
    const link = dock.match(
      /href="([^"]+)"[^>]*data-case-id="ui-fixture:case:2"/,
    )?.[1];
    ok(link);
    const next = new URL(link.replaceAll("&amp;", "&"), "http://atelier.test");
    equal(next.pathname, path.split("?")[0]);
    equal(
      next.searchParams.get("page"),
      path.includes("rights") ? "rights" : "files",
    );
    equal(next.searchParams.get("caseBranch"), "ui-fixture:case:2");
    equal(next.searchParams.has("branch"), false);
  }
  state.cases.dispose();
});

Deno.test("Dock links hide the current conversation without changing the inspected page and open full chat from page-only", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(1), caseRecord(2)],
  });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const render = (path: string) =>
    renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
  const splitPath =
    "/model?page=files&caseBranch=ui-fixture%3Acase%3A1&agent=collector&version=commit%3Aold&file=a.sysml";
  const split = render(splitPath);
  const dockLink = (html: string, caseId: string) => {
    const dock = html.slice(html.indexOf('<nav class="dock"'));
    const href = dock.match(
      new RegExp(`href="([^"]+)"[^>]*data-case-id="${caseId}"`),
    )?.[1];
    ok(href);
    return href.replaceAll("&amp;", "&");
  };
  const hiddenHref = dockLink(split, "ui-fixture:case:1");
  const mainLink = circleHref(split);
  ok(mainLink);
  const mainContext = new URL(mainLink, "https://atelier.test");
  equal(mainContext.searchParams.get("caseBranch"), "ui-fixture:case:1");
  equal(mainContext.searchParams.get("agent"), "collector");
  equal(mainContext.searchParams.get("version"), "commit:old");
  equal(mainContext.searchParams.get("conversation"), "main");
  const mainWithModel = render(mainLink);
  doesNotMatch(mainWithModel, /id="chat-panel"[^>]*hidden/);
  match(mainWithModel, /id="cases-panel"[^>]*hidden/);
  match(mainWithModel, /href="\/chat" aria-label="Leave Request context"/);
  const returnToRequest = new URL(
    dockLink(mainWithModel, "ui-fixture:case:1"),
    "https://atelier.test",
  );
  equal(returnToRequest.searchParams.get("caseBranch"), "ui-fixture:case:1");
  equal(returnToRequest.searchParams.get("agent"), "collector");
  equal(returnToRequest.searchParams.get("version"), "commit:old");
  equal(returnToRequest.searchParams.has("conversation"), false);
  const switchCase = new URL(
    dockLink(mainWithModel, "ui-fixture:case:2"),
    "https://atelier.test",
  );
  equal(switchCase.pathname, "/model");
  equal(switchCase.searchParams.get("caseBranch"), "ui-fixture:case:2");
  equal(switchCase.searchParams.get("conversation"), "main");
  equal(switchCase.searchParams.has("version"), false);
  const closeHref = (html: string, label: string) => {
    const href = html.match(
      new RegExp(`href="([^"]+)" aria-label="${label}"`),
    )?.[1];
    ok(href);
    return href.replaceAll("&amp;", "&");
  };
  const placeHref = (html: string, id: string) => {
    const href = html.match(new RegExp(`id="${id}-link" href="([^"]+)"`))?.[1];
    ok(href);
    return href.replaceAll("&amp;", "&");
  };
  const requestPanel = split.slice(
    split.indexOf('id="cases-panel"'),
    split.indexOf('id="case-panel"'),
  );
  equal(closeHref(requestPanel, "Close conversation"), hiddenHref);
  const closeModel = new URL(
    closeHref(split, "Close Model"),
    "https://atelier.test",
  );
  equal(closeModel.pathname, "/cases");
  equal(closeModel.searchParams.get("case"), "ui-fixture:case:1");
  equal(closeModel.searchParams.get("agent"), "collector");
  equal(closeModel.searchParams.get("main"), "hidden");
  const fullVisibleRequest = render(closeModel.pathname + closeModel.search);
  match(fullVisibleRequest, /id="chat-panel"[^>]*hidden/);
  doesNotMatch(fullVisibleRequest, /id="cases-panel"[^>]*hidden/);
  equal(closeHref(mainWithModel, "Close Model"), "/chat");
  for (
    const [page, label, id] of [
      ["system?page=team", "Close System", "system"],
      [
        "model?page=files",
        "Close Model",
        "model",
      ],
    ] as const
  ) {
    const scoped = `/${page}&caseBranch=ui-fixture%3Acase%3A1&agent=collector`;
    const casePage = render(scoped);
    const caseClose = new URL(
      closeHref(casePage, label),
      "https://atelier.test",
    );
    equal(caseClose.pathname, "/cases");
    equal(caseClose.searchParams.get("case"), "ui-fixture:case:1");
    equal(caseClose.searchParams.get("agent"), "collector");
    equal(caseClose.searchParams.get("main"), "hidden");
    equal(placeHref(casePage, id), closeHref(casePage, label));
    const mainPage = render(`${scoped}&conversation=main`);
    equal(closeHref(mainPage, label), "/chat");
    equal(placeHref(mainPage, id), "/chat");
    const pageOnlyScoped = render(`${scoped}&conversation=hidden`);
    equal(closeHref(pageOnlyScoped, label), "/");
    equal(placeHref(pageOnlyScoped, id), "/");
  }
  const hiddenUrl = new URL(hiddenHref, "https://atelier.test");
  equal(hiddenUrl.searchParams.get("conversation"), "hidden");
  for (
    const [key, value] of new URL(splitPath, "https://atelier.test")
      .searchParams
  ) {
    equal(hiddenUrl.searchParams.get(key), value);
  }
  const pageOnly = render(hiddenHref);
  equal(closeHref(pageOnly, "Close Model"), "/");
  match(pageOnly, /desk-stage has-item/);
  doesNotMatch(pageOnly, /desk-stage is-talking/);
  match(pageOnly, /id="cases-panel"[^>]*hidden/);
  const fullRequest = new URL(
    dockLink(pageOnly, "ui-fixture:case:1"),
    "https://atelier.test",
  );
  equal(fullRequest.pathname, "/cases");
  equal(fullRequest.searchParams.get("case"), "ui-fixture:case:1");
  equal(fullRequest.searchParams.get("agent"), "collector");
  const other = new URL(
    dockLink(pageOnly, "ui-fixture:case:2"),
    "https://atelier.test",
  );
  equal(other.pathname, "/model");
  equal(other.searchParams.get("caseBranch"), "ui-fixture:case:2");
  equal(other.searchParams.get("conversation"), "hidden");
  match(circleHref(pageOnly)!, /^\/model\?.*conversation=main/);
  const mainSplit = render("/system?page=rights&version=commit%3Aold");
  const mainPanel = mainSplit.slice(
    mainSplit.indexOf('id="chat-panel"'),
    mainSplit.indexOf('id="agent-panel"'),
  );
  equal(
    closeHref(mainPanel, "Close conversation"),
    "/system?page=rights&version=commit%3Aold&conversation=hidden",
  );
  equal(closeHref(mainSplit, "Close System"), "/chat");
  equal(closeHref(render("/model?page=files"), "Close Model"), "/chat");
  equal(closeHref(render("/chat"), "Close conversation"), "/");
  const requestAndMain = render(
    "/cases?case=ui-fixture%3Acase%3A1&agent=collector",
  );
  doesNotMatch(requestAndMain, /id="chat-panel"[^>]*hidden/);
  doesNotMatch(requestAndMain, /id="cases-panel"[^>]*hidden/);
  const hideMain = new URL(
    closeHref(requestAndMain, "Close conversation"),
    "https://atelier.test",
  );
  equal(hideMain.searchParams.get("case"), "ui-fixture:case:1");
  equal(hideMain.searchParams.get("agent"), "collector");
  equal(hideMain.searchParams.get("main"), "hidden");
  const mainDockHref = (html: string) => {
    const href = circleHref(html);
    ok(href);
    return href;
  };
  const hiddenByDock = mainDockHref(requestAndMain);
  equal(hiddenByDock, hideMain.pathname + hideMain.search);
  const pageOnlyCase = render(hiddenByDock);
  match(pageOnlyCase, /id="chat-panel"[^>]*hidden/);
  doesNotMatch(pageOnlyCase, /id="cases-panel"[^>]*hidden/);
  const restoredMain = new URL(
    mainDockHref(pageOnlyCase),
    "https://atelier.test",
  );
  equal(restoredMain.searchParams.get("case"), "ui-fixture:case:1");
  equal(restoredMain.searchParams.get("agent"), "collector");
  equal(restoredMain.searchParams.has("main"), false);
  doesNotMatch(
    render(restoredMain.pathname + restoredMain.search),
    /id="chat-panel"[^>]*hidden/,
  );
  equal(
    closeHref(render("/cases?case=ui-fixture%3Acase%3A1"), "Close Requests"),
    "/chat",
  );
  equal(
    circleHref(mainSplit),
    "/system?page=rights&version=commit%3Aold&conversation=hidden",
  );
  const mainFull = render(
    "/system?page=rights&version=commit%3Aold&conversation=hidden",
  );
  equal(closeHref(mainFull, "Close System"), "/");
  equal(placeHref(mainFull, "system"), "/");
  match(mainFull, /desk-stage has-item/);
  equal(circleHref(mainFull), "/chat");
  state.cases.dispose();
});

Deno.test("source inspection labels the displayed version and keeps its conversation on return", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/model?page=files&caseBranch=ui-fixture%3Acase%3A1&agent=collector&version=commit%3Aold"
    />,
  );
  match(html, /Read-only inspection · commit:old/);
  const href = html.match(/href="([^"]+)">Return to current model/)?.[1];
  ok(href);
  const current = new URL(href.replaceAll("&amp;", "&"), "http://atelier.test");
  equal(current.searchParams.get("caseBranch"), "ui-fixture:case:1");
  equal(current.searchParams.get("agent"), "collector");
  equal(current.searchParams.has("version"), false);
  equal(state.readOnly.value, false);
  state.cases.dispose();
});

Deno.test("direct System and Model entries show the existing Main Operator conversation on the left", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  state.agentConversations.accept(casesRoster());
  state.cases.accept({ systemId: "ui-fixture", cases: [caseRecord(1)] });
  seedRequestCases(
    state,
    state.cases.snapshot.value!,
    state.agentConversations.snapshot.value,
    { presentationPeers: true },
  );
  for (const path of ["/system", "/model?page=releases"]) {
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    match(html, /desk-stage is-talking has-model-context has-item/);
    const designer = html.slice(
      html.indexOf('id="chat-panel"'),
      html.indexOf('id="agent-panel"'),
    );
    doesNotMatch(designer.slice(0, designer.indexOf(">") + 1), /hidden/);
    match(designer, /Unrelated earlier note/);
    doesNotMatch(designer, /Find AI training offers/);
    match(html, /aria-label="Main · Version unavailable"/);
    equal((designer.match(/id="input"/g) ?? []).length, 1);
  }
  const chat = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/chat"
    />,
  );
  match(chat, /id="model-link" href="\/model"/);
  state.cases.dispose();
});

Deno.test("ignored inspection aliases cannot label live main content as an old source version", () => {
  for (
    const path of [
      "/model?page=activity&modelVersion=commit%3Aold",
      "/model?page=activity&commit=commit%3Aold",
      "/model?page=files&modelVersion=commit%3Aold",
      "/model?page=files&commit=commit%3Aold",
      "/model?page=releases&modelVersion=commit%3Aold",
      "/system?modelVersion=commit%3Aold",
      "/system?commit=commit%3Aold",
    ]
  ) {
    const state = createWorkbenchState({ initialState: snapshot() });
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    const title = html.slice(0, html.indexOf("</header>"));
    match(title, /aria-label="Main · Version unavailable"/);
    doesNotMatch(title, /Model old|read-only inspection/);
    doesNotMatch(
      html,
      /Read-only inspection · commit:old|Return to current model/,
    );
    if (path.includes("activity")) match(html, /class="act-page"/);
    if (path.includes("files") || path.includes("releases")) {
      match(html, /Reading the files…/);
    }
    if (path.startsWith("/system")) match(html, /Reading the system…/);
    const systemLink = html.match(/id="system-link" href="([^"]+)"/)?.[1];
    const modelLink = html.match(/id="model-link" href="([^"]+)"/)?.[1];
    if (path.startsWith("/model")) equal(systemLink, "/system");
    else equal(modelLink, "/model");
  }
});

Deno.test("recognized SysML and Revisions source selections retain their inspection labels and canonical cross-place version", () => {
  for (
    const path of [
      "/model?page=sysml&modelVersion=commit%3Aold",
      "/model?modelVersion=commit%3Aold",
      "/model?page=revisions&commit=commit%3Aold",
    ]
  ) {
    const state = createWorkbenchState({ initialState: snapshot() });
    const html = renderToString(
      <Workspace
        state={state}
        started={false}
        initialUrl={`https://atelier.test${path}`}
      />,
    );
    match(html, /Version: commit:old/);
    match(html, /aria-label="Main · Service status unavailable · Read-only"/);
    match(html, /Read-only inspection · commit:old/);
    match(html, /id="system-link" href="\/system\?version=commit%3Aold"/);
    if (path.includes("modelVersion")) match(html, /class="sysml-page"/);
    else match(html, /class="rev-page"/);
  }
});

Deno.test("a resolved Request graph never loads Designer execution history", async () => {
  let calls = 0;
  const state = createWorkbenchState({
    initialState: snapshot(),
    fetch: () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  });
  equal(workbenchGraphShown("/model?page=graph", "case-one", false), false);
  equal(workbenchGraphShown("/model?page=graph", null, false), true);
  await synchronizeModelLocation(state, {
    page: "graph",
    caseBranch: "case-one",
    revision: "1",
  });
  equal(calls, 0);
  equal(state.selectedRevision.peek(), null);
});

Deno.test("release creation names an exact source without claiming Main divergence", () => {
  const state = createWorkbenchState({ initialState: snapshot() });
  const html = renderToString(
    <Workspace
      state={state}
      started={false}
      initialUrl="https://atelier.test/model?page=releases&version=commit%3Aold&create=1"
    />,
  );
  match(html, /Version: commit:old/);
  match(html, /aria-label="Main · Service status unavailable · Read-only"/);
  doesNotMatch(html, /Read-only inspection · commit:old/);
});

Deno.test("remembered scoped places cannot reintroduce a Case after explicit global return", async () => {
  const root = probeRoot();
  root.windowListeners();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  const state = createWorkbenchState({ initialState: snapshot() });
  const globalVersion = `commit:${"a".repeat(40)}`;
  const oldVersion = encodeURIComponent(`commit:${"b".repeat(40)}`);
  let html = "";
  function Probe(props: { path: string }) {
    html = renderToString(Workspace({
      state,
      started: false,
      initialUrl: `https://atelier.test${props.path}`,
    }));
    return null;
  }
  const href = (id: string) => {
    const raw = html.match(new RegExp(`id="${id}" href="([^"]+)"`))?.[1];
    ok(raw);
    return new URL(raw.replaceAll("&amp;", "&"), "https://atelier.test");
  };
  try {
    await root.show(Probe, {
      path:
        `/model?page=files&caseBranch=caseX&agent=child&version=${oldVersion}&file=x.sysml`,
    });
    await root.show(Probe, { path: "/cases?case=caseC" });
    const closeCase = html.match(/href="([^"]+)" aria-label="Close Requests"/)
      ?.[1];
    equal(closeCase, "/chat");
    await root.show(Probe, { path: closeCase! });
    await root.show(Probe, {
      path: `/system?page=diagnostics&version=${
        encodeURIComponent(globalVersion)
      }`,
    });
    const model = href("model-link");
    equal(model.pathname, "/model");
    equal(model.searchParams.get("page"), "files");
    equal(model.searchParams.get("version"), globalVersion);
    for (
      const key of ["caseBranch", "agent", "branch", "file", "conversation"]
    ) {
      equal(model.searchParams.has(key), false, key);
    }
    await root.show(Probe, {
      path:
        `/system?page=rights&caseBranch=caseX&agent=child&version=${oldVersion}&select=old`,
    });
    await root.show(Probe, { path: "/chat" });
    await root.show(Probe, {
      path: `/model?page=files&version=${encodeURIComponent(globalVersion)}`,
    });
    const system = href("system-link");
    equal(system.pathname, "/system");
    equal(system.searchParams.get("page"), "rights");
    equal(system.searchParams.get("version"), globalVersion);
    for (
      const key of ["caseBranch", "agent", "branch", "select", "conversation"]
    ) {
      equal(system.searchParams.has(key), false, key);
    }
  } finally {
    await root.restore();
    state.cases.dispose();
  }
});
