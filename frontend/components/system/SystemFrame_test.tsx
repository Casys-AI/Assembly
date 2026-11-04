import {
  createPerformanceStore,
  type PerformanceStore,
} from "../../lib/system/performance/store.ts";
import { performanceReadout } from "../../test/support/performance-fixture.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  notEqual,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import type {
  ConversationsSnapshot,
  OperatorToolsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import {
  allocatedBoard,
  ANALYST,
  board as emptyBoard,
  boardHost,
  BUILDER,
  COORDINATOR,
  crowdBoard,
  flowBoard,
  guaranteeBoard,
  HEAD,
  initialBoard,
  link,
  linkedBoard,
  LIVE_BUILDER,
  OLDER,
  rosterEntry,
  structuredBoard,
  watchBoard,
  withLinks,
} from "../../test/support/board-fixture.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { press } from "../../test/support/press.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { matrixHost, OWNER } from "../../test/support/matrix-fixture.ts";
import { createBoardApi } from "../../lib/system/board/api.ts";
import {
  type BoardStore,
  createBoardStore,
} from "../../lib/system/board/store.ts";
import { createMatrixApi } from "../../lib/system/rights/api.ts";
import { createMatrixStore } from "../../lib/system/rights/store.ts";
import type { SystemPage } from "../../lib/workbench/desk.ts";
import {
  createViewPrefs,
  type PrefsStorage,
  VIEW_MODE_KEY,
  type ViewPrefs,
} from "../../lib/system/view-prefs.ts";
import {
  createWorkbenchState,
  type WorkbenchState,
} from "../../lib/workbench/state.ts";
import { SystemFrame } from "./SystemFrame.tsx";
import { tidy } from "../../test/support/markup.ts";
import { nameOf, textOf, within } from "../../test/support/dom.ts";
import type { ComponentChildren } from "preact";
import type { CaseModelScope } from "../../lib/case-model-scope.ts";
import { caseRecord, caseScope } from "../../test/support/case-fixture.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import { ModelLinkContext } from "../view/ModelContextLink.tsx";

/** A workbench whose central agent runs `inService`, when it runs anything. */
function workbench(inService?: string): WorkbenchState {
  const current = snapshot();
  if (inService) {
    current.executionModel = {
      identity: { systemQualifiedName: "ASELiveBuilder::liveBuilder" },
      version: { repositoryVersion: inService, digest: "digest" },
    } as NonNullable<typeof current.executionModel>;
  }
  return createWorkbenchState({ initialState: current });
}

function roster(state: WorkbenchState, systemId = state.current.value!.id) {
  const entry = rosterEntry(BUILDER);
  const operator: ConversationsSnapshot["conversations"][number] = {
    ...entry,
    agentId: BUILDER,
    responsibility: "Conversation du système",
    revision: 1,
    phase: "Ready",
    messages: [],
    modelDigest: "digest",
    runtimeOwned: true,
  };
  state.agentConversations.accept({
    systemId,
    defaultAgentId: BUILDER,
    version: "v1",
    conversations: [operator],
  });
}

/** The viewer's preferences, kept in a storage of their own. */
function preferences(saved?: string) {
  const kept = new Map<string, string>(saved ? [[VIEW_MODE_KEY, saved]] : []);
  const storage: PrefsStorage = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
  };
  return { prefs: createViewPrefs(() => storage), kept };
}

/** The place, with its board read as the host answers it. */
async function frame(
  options: {
    search?: string;
    state?: WorkbenchState;
    host?: Parameters<typeof boardHost>[0];
    /** What the authority matrix route answers. */
    matrixHost?: Parameters<typeof matrixHost>[0];
    open?: boolean;
    page?: SystemPage;
    prefs?: ViewPrefs;
    performance?: PerformanceStore;
  } = {},
) {
  const host = boardHost(options.host);
  const board = createBoardStore({
    api: createBoardApi({ fetch: host.fetch }),
  });
  const matrices = matrixHost(options.matrixHost);
  const matrix = createMatrixStore({
    api: createMatrixApi({ fetch: matrices.fetch }),
  });
  const asked = new URLSearchParams(options.search ?? "").get("version");
  if (options.open !== false) await board.open(asked ?? undefined);
  const state = options.state ?? workbench(HEAD);
  const html = () =>
    tidy(renderToString(
      <SystemFrame
        state={state}
        page={options.page ?? "team"}
        location={{ search: options.search ?? "" }}
        board={board}
        matrix={matrix}
        performance={options.performance}
        prefs={options.prefs ?? preferences().prefs}
      />,
    ));
  return { host, board, matrix, matrices, state, html };
}

/** A link as the person meets it: its name, where it leads, whether current. */
const linkOf = (
  link: Element,
) => [
  nameOf(link),
  link.getAttribute("href"),
  link.getAttribute("aria-current"),
];

/**
 * What the frame shows around a page: the page it mounted, its title (which
 * shows once), its tabs and More menu, its status lines and its alert. How
 * each is drawn is the test of PageFrame, PageNav, MoreMenu and Problem.
 */
function view(html: string) {
  const page = within(html);
  const menu = () => page.root.querySelector("header > details");
  return {
    page,
    mounted: page.root.querySelector("[data-page]")?.getAttribute("data-page"),
    title: () => textOf(page.byRole("heading", { level: 1 })),
    tabs: () =>
      within(page.byRole("navigation", { name: "System pages" }))
        .allByRole("link").map(linkOf),
    /** The menu's summary as [name, aria-current], then its pages. */
    menu: () => {
      const summary = menu()?.querySelector("summary");
      return summary
        ? [
          [textOf(summary), summary.getAttribute("aria-current")],
          ...[...menu()!.querySelectorAll("a")].map(linkOf),
        ]
        : null;
    },
    status: page.allByRole("status").map(textOf),
    alert: page.queryByRole("alert"),
  };
}

// The read of the Main's rights as the mounted frame starts it is in
// test/dom/SystemFrameCaseMain_test.tsx: here its store is already read.
Deno.test("in a Case, Team and Rights draw the branch with the global Main beside it, its rights from the main system's matrix", async () => {
  const probe = probeRoot();
  // The Case's own board and matrix, and the main system's matrix apart.
  const { board, matrix, state } = await frame();
  // The Case's address names its version: the board is read at it.
  await board.open(HEAD);
  await matrix.open(HEAD);
  const mainHost = matrixHost();
  const mainMatrix = createMatrixStore({
    api: createMatrixApi({ fetch: mainHost.fetch }),
  });
  // `workbench(HEAD)`: the Main runs HEAD.
  await mainMatrix.open(HEAD);
  const systemId = state.current.value!.id;
  state.requests.context.value = { projectId: "project", systemId };
  state.requests.sessionReady.value = true;
  const record = caseRecord(1, {
    id: "A",
    owner: BUILDER,
    objective: "Qualification MVP checkpoint",
  });
  state.requests.cases.accept({ systemId, cases: [record] });
  const scope: CaseModelScope = {
    caseId: "A",
    branchId: "branch:A",
    executionSpaceId: "space:A",
    branchVersion: HEAD,
    executionVersion: HEAD,
    version: HEAD,
    release: null,
    readOnly: true,
  };
  const search = `?caseBranch=A&version=${encodeURIComponent(HEAD)}`;
  let boundary: {
    props: {
      render(
        scope: CaseModelScope,
        request: typeof fetch,
        search: string,
      ): ComponentChildren;
    };
  };
  function Probe({ page }: { page: SystemPage }) {
    boundary = SystemFrame({
      state,
      page,
      location: { search },
      board,
      matrix,
      mainMatrix,
      prefs: preferences().prefs,
    }) as unknown as typeof boundary;
    return null;
  }
  const scoped = async (page: SystemPage) => {
    await probe.show(Probe, { page });
    return tidy(renderToString(
      <ModelLinkContext.Provider value={search}>
        {boundary!.props.render(scope, globalThis.fetch, search)}
      </ModelLinkContext.Provider>,
    ));
  };
  try {
    const team = await scoped("team");
    match(team, /<a class="tnode is-main"[^>]*href="\/system"/);
    match(team, /<span class="tname">Main Operator<\/span>/);
    match(team, new RegExp(`data-agent="${LIVE_BUILDER}"`));

    const rights = await scoped("rights");
    const row = rights.match(
      /<tr class="is-main" data-actor="main-operator">.*?<\/tr>/s,
    )?.[0] ?? "";
    match(
      row,
      /<a href="\/system\?page=rights&amp;version=commit%3Aa{40}"[^>]*>Main Operator<\/a>/,
    );
    match(row, /class="dot /);
    doesNotMatch(row, /caseBranch|data-mark/);
  } finally {
    await probe.restore();
  }

  // On the main system itself, there is no Main beside the team: the open
  // Case's Branch Operator closes the rights instead, its own line greyed.
  const main = await frame({ state, page: "rights" });
  await main.matrix.open(HEAD);
  const rightsOnMain = main.html();
  doesNotMatch(rightsOnMain, /main-operator/);
  match(
    rightsOnMain,
    /<tr class="is-main" data-actor="branch:A">.*?<a href="\/system\?page=rights&amp;caseBranch=A"/s,
  );
  // It goes by its name, on the Case's initials.
  const name = branchOperatorName(record);
  match(name, /^Q[a-z]+ M[a-z]+$/);
  match(
    rightsOnMain,
    new RegExp(`data-actor="branch:A">.*?caseBranch=A"[^>]*>${name}</a>`, "s"),
  );
});

Deno.test("the place is the frame of a page: Team is its title, once, with the pages of the place as tabs", async () => {
  const { html } = await frame();
  const page = html();
  const shown = view(page);
  equal(shown.mounted, "team");
  equal(shown.title(), "Team");
  deepStrictEqual(shown.tabs(), [
    ["Team", "/system", "page"],
    ["Performance", "/system?page=performance", "false"],
    ["Explore", "/system?page=explore", "false"],
    ["Flows", "/system?page=flows", "false"],
    ["Requirements", "/system?page=requirements", "false"],
    ["Rights", "/system?page=rights", "false"],
    ["Diagnostics", "/system?page=diagnostics", "false"],
  ]);
  // The board is drawn: the team of the initial model.
  match(page, /class="tmap"/);
  match(page, /<article class="profile"/);
  doesNotMatch(page, /Reading the system|data-code="board-/);
});

Deno.test("until the board is read the page says it is being read, and draws nothing of a team", async () => {
  const { html } = await frame({ open: false });
  const page = html();
  deepStrictEqual(view(page).status, ["Reading the system…"]);
  doesNotMatch(page, /tmap|profile|repo-version|No agent declared/);
  equal(view(page).title(), "Team");
});

Deno.test("the version read is named Main with its exact commit in inspection", async () => {
  const { html } = await frame();
  const page = html();
  match(page, new RegExp(`<div class="repo-version" data-version="${HEAD}">`));
  match(page, /Version: commit:a{40}/);
  match(page, /aria-label="Inspect Main · In service"/);
  doesNotMatch(page, /Show current model/);
});

Deno.test("when the model in service is another commit, the gap is said beside the version, and only then", async () => {
  const other = `commit:${"c".repeat(40)}`;
  const gap = tidy(renderToString(
    <SystemFrame
      state={workbench(other)}
      page="team"
      location={{ search: "" }}
      board={(await frame()).board}
    />,
  ));
  match(gap, /aria-label="Main · Not in service"/);
  match(gap, /In service: commit:c{40}/);
  for (const same of [HEAD, HEAD.replace("commit:", "")]) {
    match(
      (await frame({ state: workbench(same) })).html(),
      /aria-label="Main · In service"/,
    );
  }
  match(
    (await frame({ state: workbench() })).html(),
    /Service status unavailable/,
  );
});

Deno.test("a version the address names is the version read, with the way back to main", async () => {
  const search = `?version=${encodeURIComponent(OLDER)}&select=${COORDINATOR}`;
  const { html, host, board } = await frame({
    search,
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() } },
  });
  const page = html();
  deepStrictEqual(host.requests.map((request) => request.path), [
    `/api/model/board?version=${encodeURIComponent(OLDER)}`,
  ]);
  match(page, /Version: commit:b{40}/);
  match(
    page,
    new RegExp(
      `<a href="/system\\?select=${COORDINATOR}">Show current model</a>`,
    ),
  );
  doesNotMatch(page, /title="The head of main"/);
  // What it reads is that version's team, three agents.
  equal((page.match(/class="tnode is-agent/g) || []).length, 3);
  // Choosing an agent keeps the version the page is read at.
  match(
    page,
    new RegExp(
      `href="/system\\?select=unit-analyst&amp;version=${
        encodeURIComponent(OLDER)
      }"`,
    ),
  );
  equal(board.state.value.asked, OLDER);
});

Deno.test("on Flows, the way back to main keeps the flow being read and what is open, and drops the version only", async () => {
  const flow = `${COORDINATOR}.conversation`;
  const version = encodeURIComponent(OLDER);
  const boards = { [HEAD]: flowBoard(), [OLDER]: flowBoard() };
  // Reading a flow at an older version, nothing open: main shows that flow, not the first.
  const read = await frame({
    page: "flows",
    search: `?page=flows&flow=${flow}&version=${version}`,
    host: { boards },
  });
  match(
    read.html(),
    new RegExp(
      `<a href="/system\\?page=flows&amp;flow=${flow}">Show current model</a>`,
    ),
  );
  // With a step open, both stay.
  const step = `${flow}#resume`;
  const open = await frame({
    page: "flows",
    search: `?page=flows&flow=${flow}&select=${
      encodeURIComponent(step)
    }&version=${version}`,
    host: { boards },
  });
  match(
    open.html(),
    new RegExp(
      `<a href="/system\\?page=flows&amp;flow=${flow}&amp;select=${
        encodeURIComponent(step)
      }">Show current model</a>`,
    ),
  );
  // A version the host lacks says the same way back, to the same flow.
  const missing = await frame({
    page: "flows",
    search: `?page=flows&flow=${flow}&version=commit:${"9".repeat(40)}`,
  });
  match(
    missing.html(),
    new RegExp(
      `<a class="rev-retry" href="/system\\?page=flows&amp;flow=${flow}">Show current model</a>`,
    ),
  );
  // Another page has no flow to keep, whatever the address carries.
  const other = await frame({
    page: "explore",
    search: `?page=explore&flow=${flow}&version=${version}`,
    host: { boards },
  });
  match(
    other.html(),
    /<a href="\/system\?page=explore">Show current model<\/a>/,
  );
});

Deno.test("the roster of the system names the agents it knows: its name for the operator, and whom the person talks with", async () => {
  const state = workbench(HEAD);
  roster(state);
  const page = (await frame({ state })).html();
  match(page, /<span class="tname">Concepteur<\/span>/);
  match(page, /class="tnode is-you"/);
  match(page, /Talks with you/);
  // A roster of another system is not this system's.
  const stranger = workbench(HEAD);
  roster(stranger, "another-system");
  const alone = (await frame({ state: stranger })).html();
  match(alone, /<span class="tname">liveBuilder<\/span>/);
  doesNotMatch(alone, /is-you|Talks with you/);
  // The roster is the system as it runs now, as for every page that joins it:
  // while a past revision is inspected it is not joined.
  state.selectedRevision.value = 3;
  const past = (await frame({ state })).html();
  match(past, /<span class="tname">liveBuilder<\/span>/);
  doesNotMatch(past, /is-you|Talks with you|Concepteur/);
});

function candidateCatalogue(state: WorkbenchState): OperatorToolsSnapshot {
  return {
    systemId: state.current.value!.id,
    version: "catalogue-1",
    tools: [{
      agentId: BUILDER,
      agentName: "Current operator name",
      revision: 1,
      candidate: {
        ...snapshot().candidates[0],
        name: "Current preparation",
        stage: "testing",
      },
    }],
  };
}

Deno.test("System composes candidate chips in Has while preserving its board", async () => {
  const state = workbench(HEAD);
  roster(state);
  const source = candidateCatalogue(state);
  state.operatorTools.accept(source);
  const shown = await frame({ state });
  const before = JSON.stringify(shown.board.state.value.board);
  const initial = shown.html();
  match(
    initial,
    /<span class="fl">Has<\/span>[\s\S]*Current preparation[\s\S]*>Testing<\/span>/,
  );
  match(initial, /data-tool-server="web"/);
  state.operatorTools.accept({
    ...source,
    version: "catalogue-2",
    tools: [{
      ...source.tools[0],
      candidate: {
        ...source.tools[0].candidate,
        stage: "active",
        binding: { elementId: "tool", graphPath: "model.tool" },
      },
    }],
  });
  match(
    shown.html(),
    /class="chip tool-candidate-chip"[\s\S]*>Active<\/span>/,
  );
  doesNotMatch(shown.html(), /tool-candidate-chip run/);
  state.operatorTools.loading.value = true;
  match(
    shown.html(),
    /Last observed: Active[\s\S]*Tool status is refreshing/,
  );
  state.operatorTools.loading.value = false;
  state.operatorTools.error.value = "Catalogue read failed";
  state.operatorTools.stale.value = true;
  const failed = shown.html();
  match(failed, /Catalogue read failed[\s\S]*current activity is unknown/);
  doesNotMatch(failed, /tool-candidate-chip run|>Active<\/span>/);
  equal(JSON.stringify(shown.board.state.value.board), before);
  equal(shown.host.requests.length, 1);
});

Deno.test("a rejected admission does not make a successfully reconciled catalogue look unreadable", async () => {
  const runtime = snapshot();
  let reads = 0, writes = 0;
  const state = createWorkbenchState({
    initialState: runtime,
    fetch: (path, init) => {
      if (init?.method === "POST") {
        writes++;
        return Promise.resolve(Response.json({ error: "Decision rejected." }, {
          status: 409,
        }));
      }
      equal(path, "/api/operator-tools");
      reads++;
      return Promise.resolve(Response.json(fresh));
    },
  });
  const initial = candidateCatalogue(state);
  initial.tools[0].candidate.stage = "awaiting-admission";
  initial.tools[0].candidate.requiredAuthority = "human";
  const fresh = structuredClone(initial);
  fresh.version = "reconciled";
  fresh.tools[0].revision++;
  fresh.tools[0].candidate.stage = "active";
  fresh.tools[0].candidate.binding = {
    elementId: "native-tool",
    graphPath: "model.tool",
  };
  roster(state);
  state.operatorTools.accept(initial);
  equal(await state.operatorTools.decide(initial.tools[0], "approve"), false);
  equal(writes, 1);
  equal(reads, 1);
  equal(state.operatorTools.error.value, "Decision rejected.");
  equal(state.operatorTools.stale.value, false);
  const page = (await frame({ state })).html();
  match(
    page,
    /class="chip tool-candidate-chip"[\s\S]*Current preparation[\s\S]*>Active/,
  );
  doesNotMatch(page, /could not be read|Last observed|Decision rejected/);
  state.dispose();
});

Deno.test("explicit versions and runtime history cannot borrow current preparations, servers, names or busy state", async () => {
  const state = workbench(HEAD);
  roster(state);
  const conversations = state.agentConversations.snapshot.value!;
  state.agentConversations.accept({
    ...conversations,
    conversations: conversations.conversations.map((operator) => ({
      ...operator,
      name: "Current operator name",
      busy: true,
    })),
  });
  state.operatorTools.accept(candidateCatalogue(state));
  const current = (await frame({ state })).html();
  match(current, /Current operator name/);
  match(current, /working now/);
  match(current, /data-tool-server="web"/);
  match(current, /data-candidate="c1"/);
  doesNotMatch(current, /Tool preparation/);

  for (const version of [HEAD, OLDER]) {
    for (const page of ["team", "parts"] as const) {
      const shown = await frame({
        state,
        page,
        search: `?version=${encodeURIComponent(version)}`,
        host: { boards: { [HEAD]: initialBoard(), [OLDER]: initialBoard() } },
      });
      const historical = shown.html();
      doesNotMatch(
        historical,
        /Tool preparation|Current preparation|data-tool-server|Current operator name|working now|data-busy/,
      );
      match(historical, /liveBuilder/);
    }
  }
  state.selectedRevision.value = 3;
  const historicalRuntime = (await frame({ state })).html();
  doesNotMatch(
    historicalRuntime,
    /Tool preparation|Current preparation|data-tool-server|Current operator name|working now|data-busy/,
  );
  match(historicalRuntime, /liveBuilder/);
});

Deno.test("a candidate catalogue from another system is unavailable in System", async () => {
  const state = workbench(HEAD);
  state.operatorTools.accept({
    ...candidateCatalogue(state),
    systemId: "another-system",
  });
  const html = (await frame({ state })).html();
  match(html, /tool catalogue is not available/);
  doesNotMatch(
    html,
    /Current preparation|Current operator name|data-tool-server/,
  );
});

Deno.test("a read that fails says so with its code, offers to read again when that can help, and shows nothing it did not read", async () => {
  const retryable = [
    ["TOOLKIT_TIMEOUT", 502, "board-timeout"],
    ["MODEL_BOARD_FAILED", 500, "board-failed"],
  ] as const;
  for (const [code, status, shown] of retryable) {
    const { html } = await frame({ host: { fail: { status, code } } });
    const page = html();
    const { alert } = view(page);
    equal(alert?.getAttribute("data-code"), shown);
    equal(alert?.getAttribute("data-host-code"), code);
    const retry = within(page).byRole("button", { name: "Try again" });
    equal(retry.hasAttribute("disabled"), false);
    // The host's own code and its recovery are under the sentence.
    match(textOf(alert!), new RegExp(`${code} Read the board again\\.`));
    doesNotMatch(page, /tmap|repo-version|Reading the system/);
  }
  // The host's message, when it gives one, is what it said.
  const told = await frame({
    host: {
      fail: {
        status: 500,
        code: "MODEL_BOARD_FAILED",
        context: { message: "The Toolkit crashed." },
      },
    },
  });
  match(textOf(view(told.html()).alert!), /The Toolkit crashed\./);
  // The host cannot be reached at all: no code of the host's to show.
  const board = createBoardStore({
    api: createBoardApi({
      fetch: (() => Promise.reject(new TypeError("down"))) as never,
    }),
  });
  await board.open();
  const unreachable = tidy(renderToString(
    <SystemFrame
      state={workbench()}
      page="team"
      location={{ search: "" }}
      board={board}
    />,
  ));
  match(unreachable, /data-code="board-unavailable"/);
  match(unreachable, /Try again/);
  doesNotMatch(unreachable, /data-host-code|rev-host-code/);
});

Deno.test("a host that asks to wait is waited for: the button says for how long, and stays shut", async () => {
  const { html } = await frame({
    host: {
      fail: { status: 502, code: "TOOLKIT_TIMEOUT", retryAfter: 3 },
    },
  });
  const page = html();
  ok(
    within(page).byRole("button", { name: "Try again in 3 s" })
      .hasAttribute("disabled"),
  );
  // Without a wait asked for, it is open at once.
  const open = (await frame({
    host: { fail: { status: 502, code: "TOOLKIT_TIMEOUT" } },
  })).html();
  doesNotMatch(open, /disabled|Try again in/);
});

Deno.test("a head the host cannot find is its failure, to read again: it is not a version the person asked for", async () => {
  const { html } = await frame({
    host: {
      fail: {
        status: 404,
        code: "NOT_FOUND",
        context: {
          selection: "head",
          message: "Model repository is not initialized",
        },
      },
    },
  });
  const page = html();
  match(
    page,
    /data-code="board-failed" data-host-code="NOT_FOUND">The system could not be read\./,
  );
  match(page, /Model repository is not initialized/);
  doesNotMatch(page, /not in the model's history|Show current model/);
  match(page, /Try again/);
  // The same answer to a version the address names is that version missing.
  const named = (await frame({
    search: `?version=${encodeURIComponent(OLDER)}`,
    host: { fail: { status: 404, code: "NOT_FOUND" } },
  })).html();
  match(named, /data-code="version-absent" data-host-code="NOT_FOUND"/);
  match(named, /Show current model/);
  doesNotMatch(named, /Try again/);
});

Deno.test("a version that is not one, or that the host lacks, is told with a way back to main and nothing to retry", async () => {
  for (
    const [version, code] of [["main", "version-invalid"], [
      `commit:${"9".repeat(40)}`,
      "version-absent",
    ]]
  ) {
    const { html } = await frame({
      search: `?version=${encodeURIComponent(version)}`,
    });
    const page = html();
    match(page, new RegExp(`data-code="${code}"`));
    doesNotMatch(page, /Try again/);
    match(page, /<a class="rev-retry" href="\/system">Show current model<\/a>/);
    doesNotMatch(page, /tmap|repo-version/);
  }
});

Deno.test("a board that cannot be read again stays on show, with the reason beside it", async () => {
  const { html, board, host } = await frame();
  match(html(), /class="tmap"/);
  host.state.fail = { status: 502, code: "TOOLKIT_TIMEOUT" };
  await board.open();
  const page = html();
  match(page, /data-code="board-timeout"/);
  match(page, /Try again/);
  // The team it had is still drawn, with the version it was read at.
  match(page, /class="tmap"/);
  match(page, /Version: commit:a{40}/);
  host.state.fail = undefined;
  await board.open();
  doesNotMatch(html(), /board-timeout|Try again/);
});

Deno.test("the retry button reads the board again", async () => {
  const host = boardHost({ fail: { status: 502, code: "TOOLKIT_TIMEOUT" } });
  const board: BoardStore = createBoardStore({
    api: createBoardApi({ fetch: host.fetch }),
  });
  await board.open();
  equal(host.requests.length, 1);
  const view = press(
    <SystemFrame
      state={workbench()}
      page="team"
      location={{ search: "" }}
      board={board}
    />,
  );
  host.state.fail = undefined;
  view.click("Try again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(host.requests.length, 2);
  equal(board.state.value.problem, undefined);
  equal(board.state.value.version, HEAD);
});

Deno.test("a board of another version than the address's is not drawn for a frame while the right one is read", async () => {
  const { board, state } = await frame({
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() } },
  });
  // The head was read; the address now names a version, not yet read.
  const page = tidy(renderToString(
    <SystemFrame
      state={state}
      page="team"
      location={{ search: `?version=${encodeURIComponent(OLDER)}` }}
      board={board}
    />,
  ));
  match(page, /Reading the system…/);
  doesNotMatch(page, /tmap|repo-version/);
});

Deno.test("the tabs keep the version being read and drop what the other page selects", async () => {
  const search = `?version=${encodeURIComponent(OLDER)}&select=${COORDINATOR}`;
  const { html } = await frame({
    search,
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() } },
  });
  const version = encodeURIComponent(OLDER);
  const tabs = view(html()).tabs();
  deepStrictEqual(tabs[0], ["Team", `/system?version=${version}`, "page"]);
  deepStrictEqual(tabs[2], [
    "Explore",
    `/system?page=explore&version=${version}`,
    "false",
  ]);
  ok(tabs.every(([, href]) => !href?.includes("select=")));
});

Deno.test("Explore is the place's second page: the same board, drawn as everything the model declares", async () => {
  const { html, host } = await frame({
    page: "explore",
    host: { boards: { [HEAD]: linkedBoard() } },
  });
  const page = html();
  const shown = view(page);
  equal(shown.mounted, "explore");
  equal(shown.title(), "Explore");
  deepStrictEqual(shown.tabs()[2], ["Explore", "/system?page=explore", "page"]);
  match(page, /<div class="explore">/);
  doesNotMatch(page, /tmap|profile/);
  // The version read is told on this page too, and the board was read once.
  match(page, /<div class="repo-version"/);
  equal(host.requests.length, 1);
  // Until the board is read, the page says so and draws no card.
  const reading = (await frame({ page: "explore", open: false })).html();
  deepStrictEqual(view(reading).status, ["Reading the system…"]);
  doesNotMatch(reading, /explore-card/);
});

Deno.test("an element the address selects opens in place on Explore, under its card, at the version being read", async () => {
  const { html } = await frame({
    page: "explore",
    search: `?select=${COORDINATOR}.mandate&version=${
      encodeURIComponent(HEAD)
    }`,
    host: { boards: { [HEAD]: linkedBoard() } },
  });
  const page = html();
  equal((page.match(/<aside /g) ?? []).length, 1);
  match(
    page,
    new RegExp(
      `<a class="explore-card el is-selected" href="/system\\?page=explore&amp;version=${
        encodeURIComponent(HEAD)
      }" aria-current="true" data-id="${COORDINATOR}\\.mandate"[^>]*>.*?</a><aside class="detail is-narrow"`,
      "s",
    ),
  );
  // A selection no card stands for opens under the title, after the version line.
  const step = (await frame({
    page: "explore",
    search: `?select=${COORDINATOR}.promotion.step0`,
    host: { boards: { [HEAD]: linkedBoard() } },
  })).html();
  match(
    step,
    /<div class="repo-version".*?<\/div><div class="explore"><aside class="detail" /s,
  );
});

/** The page's choice of words: its buttons as [name, aria-pressed], or none. */
function wordsChoice(html: string) {
  const group = within(html).queryByRole("group", { name: "Words used" });
  return group &&
    within(group).allByRole("button").map((button) => [
      nameOf(button),
      button.getAttribute("aria-pressed"),
    ]);
}

Deno.test("the choice of words is offered on every page that obeys it and reaches it, and Team, which does not, does not offer it", async () => {
  const boards = {
    explore: linkedBoard(),
    flows: flowBoard(),
    requirements: guaranteeBoard(),
    rights: initialBoard(),
    parts: structuredBoard(),
    allocations: allocatedBoard(),
  };
  const { prefs } = preferences("sysml");
  prefs.restore();
  for (
    const [page, board] of Object.entries(boards) as [SystemPage, ModelBoard][]
  ) {
    const host = { boards: { [HEAD]: board } };
    const readable = await frame({ page, host });
    const sysml = await frame({ page, prefs, host });
    await readable.matrix.open(HEAD);
    await sysml.matrix.open(HEAD);
    deepStrictEqual(wordsChoice(readable.html()), [
      ["Readable", "true"],
      ["SysML", "false"],
    ], page);
    deepStrictEqual(wordsChoice(sysml.html()), [
      ["Readable", "false"],
      ["SysML", "true"],
    ], page);
    // How each page reads in SysML's words is that page's own test.
    notEqual(textOf(sysml.html()), textOf(readable.html()), page);
  }
  const team = (await frame({ page: "team" })).html();
  equal(wordsChoice(team), null);
  doesNotMatch(team, /SysML/);
  // The choice is offered while the board is read, or when it cannot be: it is the viewer's.
  ok(wordsChoice((await frame({ page: "explore", open: false })).html()));
});

Deno.test("choosing SysML tells the page in SysML's words at once, and keeps the choice for the next page", async () => {
  const { prefs, kept } = preferences();
  const { board, state } = await frame({
    page: "explore",
    host: { boards: { [HEAD]: linkedBoard() } },
    prefs,
  });
  const draw = () =>
    press(
      <SystemFrame
        state={state}
        page="explore"
        location={{ search: "" }}
        board={board}
        prefs={prefs}
      />,
    );
  const readable = draw();
  deepStrictEqual(readable.labels.slice(0, 2), ["Readable", "SysML"]);
  readable.click("SysML");
  equal(prefs.mode.value, "sysml");
  equal(kept.get(VIEW_MODE_KEY), "sysml");
  const sysml = draw().html;
  deepStrictEqual(wordsChoice(sysml)![1], ["SysML", "true"]);
  notEqual(textOf(sysml), textOf(readable.html));
  // And back.
  draw().click("Readable");
  equal(prefs.mode.value, "readable");
  equal(textOf(draw().html), textOf(readable.html));
});

Deno.test("units are called as the team calls them in Explore, and by the model's identifier in SysML's words", async () => {
  const state = workbench(HEAD);
  roster(state);
  const named = await frame({
    page: "explore",
    state,
    host: { boards: { [HEAD]: initialBoard() } },
  });
  match(textOf(named.html()), /\bConcepteur\b/);
  const { prefs } = preferences("sysml");
  prefs.restore();
  const sysml = await frame({
    page: "explore",
    state,
    prefs,
    host: { boards: { [HEAD]: initialBoard() } },
  });
  match(textOf(sysml.html()), /\bliveBuilder\b/);
  doesNotMatch(sysml.html(), /Concepteur/);
});

Deno.test("the choice saved in this browser is read once the page is shown, not while it is drawn", async () => {
  const { prefs } = preferences("sysml");
  const { board, state } = await frame({ page: "explore", prefs });
  // Drawn: the page is readable, as the server drew it.
  equal(prefs.mode.value, "readable");
  const probe = probeRoot();
  function Shown() {
    SystemFrame({
      state,
      page: "explore",
      location: { search: "" },
      board,
      prefs,
    });
    return null;
  }
  try {
    await probe.show(Shown, {});
    equal(prefs.mode.value, "sysml");
  } finally {
    await probe.restore();
  }
});

Deno.test("Requirements is a tab; Parts and Allocations follow in the More menu", async () => {
  const { html } = await frame();
  const page = html();
  deepStrictEqual(view(page).menu(), [
    ["More", "false"],
    ["Parts", "/system?page=parts", "false"],
    ["Allocations", "/system?page=allocations", "false"],
  ]);
  // The pages of the menu keep the version being read and drop what is selected.
  const pinned = await frame({
    search: `?version=${encodeURIComponent(OLDER)}&select=${COORDINATOR}`,
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: watchBoard() } },
  });
  const version = encodeURIComponent(OLDER);
  deepStrictEqual(
    view(pinned.html()).menu()!.slice(1).map(([, href]) => href),
    [
      `/system?page=parts&version=${version}`,
      `/system?page=allocations&version=${version}`,
    ],
  );
  // Release creation and consultation belong to Model.
  doesNotMatch(page, /saved-systems|Create release|>Releases</);
});

Deno.test("Requirements is a page of the place: the same board, as what the model demands", async () => {
  const { html, host } = await frame({
    page: "requirements",
    host: { boards: { [HEAD]: guaranteeBoard() } },
  });
  const page = html();
  const shown = view(page);
  equal(shown.mounted, "requirements");
  equal(shown.title(), "Requirements");
  deepStrictEqual(shown.tabs()[4], [
    "Requirements",
    "/system?page=requirements",
    "page",
  ]);
  // The menu is not called by a page that is not in it.
  deepStrictEqual(shown.menu()![0], ["More", "false"]);
  match(page, /<div class="requirements">/);
  match(page, /data-id="req\.orphan" data-mark="off"/);
  doesNotMatch(page, /tmap|profile|explore-card/);
  equal(host.requests.length, 1);
  // Until the board is read: the page says so.
  const reading = (await frame({ page: "requirements", open: false })).html();
  deepStrictEqual(view(reading).status, ["Reading the system…"]);
  doesNotMatch(reading, /qrow/);
});

Deno.test("a page of the menu calls the menu by its name, and no tab is current", async () => {
  for (
    const [page, name, content] of [
      ["parts", "Parts", /<div class="parts">/],
      ["allocations", "Allocations", /<div class="allocations">/],
    ] as const
  ) {
    const { html } = await frame({
      page,
      host: {
        boards: {
          [HEAD]: page === "parts" ? structuredBoard() : allocatedBoard(),
        },
      },
    });
    const shown = view(html());
    equal(shown.mounted, page);
    equal(shown.title(), name);
    deepStrictEqual(shown.menu()![0], [name, "page"]);
    match(html(), content);
    ok(shown.tabs().every(([, , current]) => current === "false"));
  }
});

Deno.test("an element the address selects opens in place on each page that draws it", async () => {
  const cases = [
    [
      "requirements",
      guaranteeBoard(),
      "req.exact",
      /<\/a><\/li><li class="detail-item"><aside /,
    ],
    [
      "parts",
      structuredBoard(),
      `${COORDINATOR}.sandbox.results`,
      /<\/a><aside /,
    ],
    [
      "allocations",
      allocatedBoard(),
      `${COORDINATOR}.promotion.step1`,
      /<\/tr><tr class="detail-row"><td colspan="5"><div class="detail-hold"><aside /,
    ],
  ] as const;
  for (const [page, board, select, where] of cases) {
    const { html } = await frame({
      page,
      search: `?select=${select}&version=${encodeURIComponent(HEAD)}`,
      host: { boards: { [HEAD]: board } },
    });
    const shown = html();
    equal((shown.match(/<aside /g) ?? []).length, 1, page);
    match(shown, where, page);
    // The close link and the others keep the version being read.
    match(
      shown,
      new RegExp(
        `<a class="detail-x" href="/system\\?page=${page}&amp;version=${
          encodeURIComponent(HEAD)
        }"`,
      ),
      page,
    );
  }
});

Deno.test("units are called as the team calls them on Parts and Allocations", async () => {
  const state = workbench(HEAD);
  roster(state);
  // The initial model's one unit answers to the roster's name for its operator.
  const allocated = withLinks(initialBoard(), [
    link("allocate", "promotion.step0", BUILDER),
  ]);
  const parts = (await frame({
    page: "parts",
    state,
    host: { boards: { [HEAD]: initialBoard() } },
  })).html();
  match(textOf(parts), /\bConcepteur\b/);
  const allocations = (await frame({
    page: "allocations",
    state,
    host: { boards: { [HEAD]: allocated } },
  })).html();
  equal(
    textOf(within(allocations).byRole("columnheader", { name: "Concepteur" })),
    "Concepteur",
  );
  match(textOf(allocations), /Promotion · in Concepteur/);
});

Deno.test("Flows is the place's third tab: the same board, as the behavior the model describes", async () => {
  const { html, host } = await frame({
    page: "flows",
    host: { boards: { [HEAD]: flowBoard() } },
  });
  const page = html();
  const shown = view(page);
  equal(shown.mounted, "flows");
  equal(shown.title(), "Flows");
  deepStrictEqual(shown.tabs()[3], ["Flows", "/system?page=flows", "page"]);
  deepStrictEqual(shown.menu()![0], ["More", "false"]);
  match(page, /<div class="flows-page">/);
  match(page, /class="vflow is-root"/);
  doesNotMatch(page, /tmap|profile|explore-card/);
  equal(host.requests.length, 1);
  // Until the board is read: the page says so.
  const reading = (await frame({ page: "flows", open: false })).html();
  deepStrictEqual(view(reading).status, ["Reading the system…"]);
  doesNotMatch(reading, /flows-page|vflow/);
});

Deno.test("the tabs of the other pages lead to Flows at the version being read, and Flows' own links keep the flow and the version", async () => {
  const version = encodeURIComponent(HEAD);
  const { html } = await frame({
    page: "flows",
    search: `?flow=${COORDINATOR}.conversation&version=${version}`,
    host: { boards: { [HEAD]: flowBoard() } },
  });
  const page = html();
  deepStrictEqual(view(page).tabs()[3], [
    "Flows",
    `/system?page=flows&version=${version}`,
    "page",
  ]);
  // The flow the address asks for is read.
  match(
    page,
    new RegExp(
      `class="flows-stage" data-kind="flow" data-flow="${COORDINATOR}.conversation"`,
    ),
  );
  // The entries lead to a flow at that version, a step keeps both.
  match(
    page,
    new RegExp(
      `class="flows-pick" href="/system\\?page=flows&amp;flow=${COORDINATOR}.promotion&amp;version=${version}"`,
    ),
  );
  match(
    page,
    new RegExp(
      `href="/system\\?page=flows&amp;flow=${COORDINATOR}.conversation&amp;select=${COORDINATOR}.conversation%23wait&amp;version=${version}"`,
    ),
  );
});

Deno.test("an element the address selects opens in place on Flows, under its step, and closing it stays in the flow", async () => {
  const version = encodeURIComponent(HEAD);
  const { html } = await frame({
    page: "flows",
    search: `?select=${COORDINATOR}.conversation%23wait&version=${version}`,
    host: { boards: { [HEAD]: flowBoard() } },
  });
  const page = html();
  equal((page.match(/<aside /g) ?? []).length, 1);
  match(page, /<\/a><span class="vloop">[^<]*<\/span><aside class="detail"/);
  // The step belongs to the second flow, which is the one read; closing keeps it.
  match(
    page,
    new RegExp(
      `class="flows-stage has-selection" data-kind="flow" data-flow="${COORDINATOR}.conversation"`,
    ),
  );
  match(
    page,
    new RegExp(
      `<a class="detail-x" href="/system\\?page=flows&amp;flow=${COORDINATOR}.conversation&amp;version=${version}"`,
    ),
  );
});

Deno.test("units are called as the team calls them on Flows: the operator who performs a step is its unit's name", async () => {
  const state = workbench(HEAD);
  roster(state);
  const allocated = withLinks(initialBoard(), [
    link("allocate", "promotion.step0", BUILDER),
  ]);
  const flows = within((await frame({
    page: "flows",
    state,
    host: { boards: { [HEAD]: allocated } },
  })).html());
  match(
    textOf(flows.root.querySelector("[data-performer]")!),
    /^Concepteur$/,
  );
});

Deno.test("Rights remains a first-level tab: the actors are drawn at once, the page says it is reading the rights, and the marks come with the matrix", async () => {
  const { html, matrix, matrices } = await frame({ page: "rights" });
  let page = html();
  const shown = view(page);
  equal(shown.mounted, "rights");
  equal(shown.title(), "Rights");
  deepStrictEqual(shown.tabs()[5], ["Rights", "/system?page=rights", "page"]);
  // The board is read; the matrix is not: the actors, and a line that says so.
  deepStrictEqual(shown.status, ["Reading the rights…"]);
  match(page, /<tr data-actor="you">/);
  doesNotMatch(page, /class="dot|class="legend|Reading the system/);
  // The version the page describes is said whether the matrix is read or not.
  match(page, /the version shown above/);
  // The matrix arrives: it is drawn, and the line is gone. (When the place reads it, and
  // at which commit, is the hook's to prove: see useMatrix_test.ts; drawing runs no effect.)
  await matrix.open(HEAD);
  page = html();
  doesNotMatch(page, /Reading the rights|data-code="matrix-/);
  match(page, /class="dot allowed"/);
  match(page, /the version shown above/);
  deepStrictEqual(matrices.requests.map((request) => request.path), [
    `/api/model/authority-matrix?version=${encodeURIComponent(HEAD)}`,
  ]);
  // Until the board is read, there is no rights page to draw.
  const unread = (await frame({ page: "rights", open: false })).html();
  deepStrictEqual(view(unread).status, ["Reading the system…"]);
  doesNotMatch(unread, /data-actor/);
});

Deno.test("the matrix drawn is the matrix of the commit the board describes, never another's", async () => {
  const { html, matrix } = await frame({ page: "rights" });
  await matrix.open(OLDER);
  // The matrix of another commit was read: the page still waits for its own.
  const page = html();
  match(page, /Reading the rights…/);
  doesNotMatch(page, /class="dot/);
});

Deno.test("a matrix that cannot be read says so with its code and offers to read again; the actors stay, and the board is not blamed", async () => {
  const { html, matrix } = await frame({
    page: "rights",
    matrixHost: {
      fail: { status: 502, code: "TOOLKIT_TIMEOUT", retryAfter: 3 },
    },
  });
  await matrix.open(HEAD);
  const page = html();
  const { alert } = view(page);
  equal(alert?.getAttribute("data-code"), "matrix-timeout");
  equal(alert?.getAttribute("data-host-code"), "TOOLKIT_TIMEOUT");
  match(textOf(alert!), /^The rights took too long to read\./);
  ok(
    within(page).byRole("button", { name: /^Try again/ })
      .hasAttribute("disabled"),
  );
  match(page, /<tr data-actor="you">/);
  doesNotMatch(page, /Reading the rights|data-code="board-/);
  // A failure that reading again will not mend offers no retry.
  const invalid = await frame({
    page: "rights",
    matrixHost: { fail: { status: 500, code: "AUTHORITY_MATRIX_FAILED" } },
  });
  await invalid.matrix.open(HEAD);
  match(invalid.html(), /data-code="matrix-failed"/);
  match(invalid.html(), /Try again/);
});

Deno.test("reading the rights again is a read of the same commit", async () => {
  const { state, board, matrix, matrices } = await frame({
    page: "rights",
    matrixHost: { fail: { status: 500, code: "AUTHORITY_MATRIX_FAILED" } },
  });
  await matrix.open(HEAD);
  matrices.state.fail = undefined;
  const draw = () =>
    press(
      <SystemFrame
        state={state}
        page="rights"
        location={{ search: "" }}
        board={board}
        matrix={matrix}
        prefs={preferences().prefs}
      />,
    );
  const failed = draw();
  deepStrictEqual(failed.labels.filter((label) => label.startsWith("Try")), [
    "Try again",
  ]);
  failed.click("Try again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(matrices.requests.length, 2);
  // The same commit, named: a head read would be of a commit the page is not drawn for.
  equal(
    matrices.requests[1].path,
    `/api/model/authority-matrix?version=${encodeURIComponent(HEAD)}`,
  );
  equal(matrix.state.value.problem, undefined);
  ok(matrix.state.value.matrix);
  // And it is the page's own matrix: drawn, with no waiting line and no offer to read again.
  const drawn = draw().html;
  match(drawn, /class="dot allowed"/);
  doesNotMatch(drawn, /Try again|Reading the rights/);
});

Deno.test("a version the matrix lacks is told with the way back to main, as for the board", async () => {
  const absent = encodeURIComponent(OLDER);
  const { html, matrix } = await frame({
    page: "rights",
    search: `?version=${absent}`,
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: initialBoard() } },
  });
  await matrix.open(OLDER);
  const page = html();
  match(page, /data-code="version-absent"/);
  match(
    page,
    /<a class="rev-retry" href="\/system\?page=rights">Show current model<\/a>/,
  );
  doesNotMatch(page, /Try again/);
});

Deno.test("a cell the address selects opens in place on Rights", async () => {
  const { prefs } = preferences("sysml");
  prefs.restore();
  const select = encodeURIComponent(`${OWNER}|candidate.admit`);
  const { html, matrix } = await frame({
    page: "rights",
    prefs,
    search: `?select=${select}`,
  });
  await matrix.open(HEAD);
  const page = html();
  const detail = within(page).byRole("complementary", { name: "Detail" });
  equal(
    detail.getAttribute("data-cell"),
    "owner@ASELiveBuilder::liveBuilder|candidate.admit",
  );
  match(textOf(detail), /Declared by/);
});

Deno.test("Team joins roster nativeId to catalogue agentId rather than assuming they match", async () => {
  const state = workbench(HEAD);
  roster(state);
  const known = state.agentConversations.snapshot.value!;
  state.agentConversations.accept({
    ...known,
    defaultAgentId: "session:builder",
    conversations: known.conversations.map((entry) => ({
      ...entry,
      agentId: "session:builder",
    })),
  });
  const source = candidateCatalogue(state);
  source.tools[0].agentId = "session:builder";
  source.tools[0].candidate.stage = "awaiting-admission";
  state.operatorTools.accept(source);
  const html = (await frame({ state })).html();
  match(html, /data-tool-server="web"/);
  match(html, /class="chip tool-candidate-chip warn"/);
  match(html, /operator=session%3Abuilder&amp;candidate=c1/);
  doesNotMatch(html, /Tool preparation/);
  state.dispose();
});

Deno.test("unsupported Case or branch scope never displays a previously read main board", async () => {
  for (
    const search of [
      "?caseBranch=request%3A7&agent=collector",
      "?branch=requests/7",
      "?caseBranch=",
    ]
  ) {
    const { html } = await frame({ search, page: "rights" });
    const page = html();
    match(
      page,
      search.includes("caseBranch=request")
        ? /Reading the Request model/
        : /This branch is unavailable on this host/,
    );
    doesNotMatch(
      page,
      /repo-version|class="tmap"|class="rights-page"|Reading the rights/,
    );
    const links = [...page.matchAll(/href="([^"]+)"/g)].map((entry) =>
      entry[1].replaceAll("&amp;", "&")
    );
    for (const href of links) {
      const expected = new URLSearchParams(search);
      const query = new URL(href, "http://atelier.test").searchParams;
      equal(query.get("caseBranch"), expected.get("caseBranch"));
      equal(query.get("branch"), expected.get("branch"));
      equal(query.get("agent"), expected.get("agent"));
    }
  }
});

Deno.test("Request navigation keeps its advanced pages under More and Main retains its tabs", async () => {
  const request =
    (await frame({ search: "?caseBranch=request&branch=unavailable" })).html();
  const main = (await frame()).html();
  for (const name of ["Explore", "Flows", "Requirements", "Diagnostics"]) {
    const requestLink = within(request).byRole("link", { name });
    ok(requestLink.closest("details"), `${name} belongs under More`);
    equal(within(main).byRole("link", { name }).closest("details"), null);
    equal(
      new URL(requestLink.getAttribute("href")!, "http://localhost")
        .searchParams.get("caseBranch"),
      "request",
    );
  }
  for (const name of ["Team", "Performance", "Rights"]) {
    equal(within(request).byRole("link", { name }).closest("details"), null);
  }
});

Deno.test("Performance shares the exact historical System source and conversation without a metrics fallback", async () => {
  const { html, host, matrices } = await frame({
    page: "performance",
    search: `?version=${encodeURIComponent(OLDER)}&agent=selected-child`,
    host: { boards: { [HEAD]: initialBoard(), [OLDER]: initialBoard() } },
  });
  const page = html();
  const shown = view(page);
  equal(shown.mounted, "performance");
  equal(shown.title(), "Performance");
  match(page, /class="repo-version"/);
  match(page, /role="status"[^>]*>Reading measurements…</);
  doesNotMatch(page, /<dt>Tokens|N\/A/);
  const content = within(page).root.querySelector("[data-page=performance]")!;
  content.querySelector(".repo-version")!.remove();
  doesNotMatch(
    content.innerHTML,
    /class="tmap"|class="profile"|view-mode|<select|<svg/,
  );
  for (const [, href] of shown.tabs()) {
    const query = new URL(href!, "http://atelier.test").searchParams;
    equal(query.get("version"), OLDER);
    equal(query.get("agent"), "selected-child");
  }
  deepStrictEqual(host.requests.map((request) => request.path), [
    `/api/model/board?version=${encodeURIComponent(OLDER)}`,
  ]);
  equal(matrices.requests.length, 0);
});

Deno.test("Team keeps the system summary independent of the selected operator and retains empty and large teams", async () => {
  const summaries: string[] = [];
  for (const selected of [COORDINATOR, ANALYST]) {
    const { html } = await frame({
      search: `?select=${selected}`,
      host: { boards: { [HEAD]: watchBoard() } },
    });
    const page = html();
    summaries.push(
      page.match(/<section class="performance-summary".*?<\/section>/)![0],
    );
    match(page, /class="system-team-layout"/);
    match(page, /class="tmap"/);
    match(page, /<article class="profile"/);
  }
  equal(summaries[0], summaries[1]);
  for (
    const [board, expected] of [
      [emptyBoard({}), /data-code="no-agent"/],
      [crowdBoard(13), /class="team-page is-list"/],
    ] as const
  ) {
    const page = (await frame({ host: { boards: { [HEAD]: board } } })).html();
    match(page, expected);
    match(page, /href="\/system\?page=performance">Open Performance<\/a>/);
    match(page, /role="status"[^>]*>Reading measurements…</);
  }
});

Deno.test("Team and Performance do not display unavailable measurements under an unresolved Case or branch", async () => {
  for (const page of ["team", "performance"] as const) {
    for (
      const search of [
        "?caseBranch=case-one&agent=child",
        "?branch=requests/unavailable&agent=child",
      ]
    ) {
      const markup = (await frame({ page, search })).html();
      match(
        markup,
        search.includes("caseBranch")
          ? /Reading the Request model/
          : /This branch is unavailable on this host/,
      );
      doesNotMatch(
        markup,
        /performance-summary|<dd>N\/A|class="tmap"|class="profile"/,
      );
    }
  }
});

Deno.test("Team and Performance consume the same exact board-version readout without duplicating its request", async () => {
  let calls = 0;
  const performance = createPerformanceStore({
    api: {
      read(selection) {
        return new Promise<ReturnType<typeof performanceReadout>>((resolve) => {
          calls++;
          equal(selection.expectedVersion, HEAD);
          resolve(performanceReadout(selection));
        });
      },
    },
  });
  try {
    await performance.open({ expectedVersion: HEAD });
    const team = (await frame({ performance })).html();
    const page = (await frame({ performance, page: "performance" })).html();
    match(team, /class="system-performance-rail"/);
    const tokens =
      /<dt>Tokens<\/dt><dd title="Usage missing for 3 of 3 calls\.">N\/A/;
    match(team, tokens);
    match(page, tokens);
    match(page, /Input 10 \(1 missing\)/);
    equal(calls, 1);
    const older = (await frame({
      performance,
      page: "performance",
      search: `?version=${encodeURIComponent(OLDER)}`,
      host: { boards: { [HEAD]: initialBoard(), [OLDER]: initialBoard() } },
    })).html();
    doesNotMatch(older, /<dt>Tokens|Input 10/);
    match(older, /Reading measurements…/);
  } finally {
    performance.dispose();
  }
});

Deno.test("Request System identifies the executing source and never marks another inspection in service", async () => {
  const { board, state } = await frame();
  await board.open(HEAD);
  const search = `?caseBranch=A&version=${encodeURIComponent(HEAD)}`;
  function Request({ executionVersion }: { executionVersion: string }) {
    const boundary = SystemFrame({
      state,
      page: "team",
      location: { search },
      board,
    }) as unknown as {
      props: {
        render(
          scope: CaseModelScope,
          request: typeof fetch,
          search: string,
        ): ComponentChildren;
      };
    };
    return boundary.props.render(
      caseScope("A", HEAD, { executionVersion, baseVersion: OLDER }),
      fetch,
      search,
    );
  }
  const current = renderToString(<Request executionVersion={HEAD} />);
  const currentLabel = within(current).root.querySelector(
    ".repo-version summary",
  )!;
  equal(
    currentLabel.getAttribute("aria-label"),
    "Inspect Request · modified · In service · Read-only",
  );
  doesNotMatch(current, /Show current model|head of main/);
  const inspected = renderToString(<Request executionVersion={OLDER} />);
  match(inspected, /Show current model/);
  const inspectedLabel = within(inspected).root.querySelector(
    ".repo-version summary",
  )!;
  equal(
    inspectedLabel.getAttribute("aria-label"),
    "Inspect Request · modified · Not in service · Read-only",
  );
});

Deno.test("System search is available with the board and retains the view mode control", async () => {
  const loaded = await frame({ page: "explore" });
  match(loaded.html(), /aria-label="Search System"/);
  match(loaded.html(), /aria-label="Words used"/);
  const loading = await frame({ open: false });
  doesNotMatch(loading.html(), /aria-label="Search System"/);
});

Deno.test("Diagnostics mounts on the exact resolved Main board and retains historical navigation", async () => {
  const current = await frame({ page: "diagnostics" });
  const html = current.html();
  equal(view(html).mounted, "diagnostics");
  equal(view(html).title(), "Diagnostics");
  match(html, /class="system-diagnostics"/);
  match(html, /Reading this check/);
  doesNotMatch(html, /No findings reported/);
  const historical = await frame({
    page: "diagnostics",
    search: `?page=diagnostics&version=${
      encodeURIComponent(HEAD)
    }&conversation=hidden`,
  });
  const detail = historical.html();
  match(detail, /class="system-diagnostics"/);
  match(detail, new RegExp(`version=${encodeURIComponent(HEAD)}`));
  match(detail, /conversation=hidden/);
  current.board.dispose();
  current.matrix.dispose();
  historical.board.dispose();
  historical.matrix.dispose();
});

Deno.test("unresolved Request scope never draws Main diagnostics", async () => {
  const { html, board, matrix } = await frame({
    page: "diagnostics",
    search: "?page=diagnostics&branch=foreign",
  });
  const page = html();
  match(page, /This branch is unavailable on this host/);
  doesNotMatch(page, /system-diagnostics|No findings reported/);
  board.dispose();
  matrix.dispose();
});
