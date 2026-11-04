import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { act } from "preact/test-utils";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import {
  ANALYST,
  board,
  BUILDER,
  COLLECTOR,
  COORDINATOR,
  crowdBoard,
  initialBoard,
  item,
  link,
  policy,
  rosterEntry,
  tool,
  unit,
  watchBoard,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import {
  edgesOf,
  layoutTeam,
  nodesOf,
  TEAM_ROOM,
} from "../../../lib/system/team/layout.ts";
import {
  agentsOnly,
  BRANCH_LIMIT,
  type BranchRef,
  MAIN,
  type RosterEntry,
  teamOf,
  withBranches,
  withMain,
} from "../../../lib/system/team/projection.ts";
import type { ToolServer } from "../../../lib/system/tools/servers.ts";
import type { CandidateRead } from "../../../lib/system/tools/candidates.ts";
import { snapshot } from "../../../test/support/workbench-fixture.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { press } from "../../../test/support/press.ts";
import { TeamPage } from "./TeamPage.tsx";
import { tidy } from "../../../test/support/markup.ts";

const hrefOf = (id: string) => `/system?select=${encodeURIComponent(id)}`;

Deno.test("Case Team renders Branch Operator in both the network and profile only for its exact generic owner", () => {
  const model = board({
    team: [unit({
      id: "owner-unit",
      title: "Owner",
      operator: "owner-op",
      declared: { operatorName: "Main Operator" },
    })],
  });
  const render = (requestOwnerId?: string) =>
    renderToString(
      <TeamPage
        board={model}
        roster={[]}
        selected={null}
        hrefOf={hrefOf}
        requestOwnerId={requestOwnerId}
      />,
    );
  match(render(), /Main Operator/);
  match(render("other-op"), /Main Operator/);
  const scoped = render("owner-op");
  match(scoped, /<span class="tname">Branch Operator<\/span>/);
  match(scoped, /<h2[^>]*>Branch Operator<\/h2>/);
  doesNotMatch(scoped, /Main Operator/);
  match(scoped, /data-agent="owner-unit"/);
  // The Case names its operator on its initials, which its avatar keeps.
  const named = renderToString(
    <TeamPage
      board={model}
      roster={[]}
      selected={null}
      hrefOf={hrefOf}
      requestOwnerId="owner-op"
      branchName="Qorvane Margature"
    />,
  );
  match(named, /<span class="tname">Qorvane Margature<\/span>/);
  match(named, /<h2[^>]*>Qorvane Margature<\/h2>/);
  match(named, /<span class="tavatar">QM<\/span>/);
  doesNotMatch(named, /Branch Operator|Main Operator/);
});

Deno.test("Case Team draws the global Main beside the team, over its Branch Operator, with a plain link to the main system", () => {
  const model = board({
    team: [
      unit({
        id: "owner-unit",
        title: "Owner",
        operator: "owner-op",
        declared: { operatorName: "Researcher" },
      }),
      unit({ id: "peer-unit", title: "Peer", operator: "peer-op" }),
    ],
  });
  const render = (mainHref?: string) =>
    renderToString(
      <TeamPage
        board={model}
        roster={[]}
        selected={null}
        hrefOf={hrefOf}
        requestOwnerId="owner-op"
        mainHref={mainHref}
      />,
    );
  const scoped = render("/system");
  match(scoped, /<a class="tnode is-main"[^>]*href="\/system"/);
  match(scoped, /<span class="tname">Main Operator<\/span>/);
  // A custom-named Branch Operator keeps its name beside the Main.
  match(scoped, /<span class="tname">Researcher<\/span>/);
  doesNotMatch(render(), /is-main|Main Operator/);

  // The Main joins the Case's own unit, whatever it is called, and no other.
  const team = withMain(teamOf(model, [], "owner-op"));
  deepStrictEqual(
    team.edges.filter((edge) => edge.kind === "supervises")
      .map((edge) => [edge.from, edge.to]),
    [[MAIN, "owner-unit"]],
  );
  ok(nodesOf(team).some((node) => node.id === MAIN && node.kind === "main"));
  // Without a Branch Operator on the board, the Main stands alone.
  const alone = withMain(teamOf(model, [], "unknown-op"));
  equal(alone.edges.some((edge) => edge.kind === "supervises"), false);
  ok(nodesOf(alone).some((node) => node.id === MAIN));
});

Deno.test("the main system's Team draws one node per open Case's Branch Operator, under the unit they run, folding the oldest", () => {
  const model = board({
    team: [unit({ id: "main-unit", title: "Main", operator: "main-op" })],
  });
  const branch = (n: number): BranchRef => ({
    caseId: `case-${n}`,
    title: `Request ${n}`,
    name: `Rylessa ${n}`,
    owner: "main-op",
    href: `/system?caseBranch=case-${n}`,
  });
  const few = [branch(3), branch(2), branch(1)];
  const html = renderToString(
    <TeamPage
      board={model}
      roster={[]}
      selected={null}
      hrefOf={hrefOf}
      branches={few}
    />,
  );
  for (const n of [1, 2, 3]) {
    match(
      html,
      new RegExp(
        `<a class="tnode is-branch"[^>]*href="/system\\?caseBranch=case-${n}"[^>]*title="Branch Operator · Request ${n}"`,
      ),
    );
  }
  // Each goes by its operator's name; its Request is in the tooltip.
  match(html, /<span class="tname">Rylessa 1<\/span>/);
  doesNotMatch(html, /<span class="tname">Request 1<\/span>/);
  const team = withBranches(teamOf(model), model, few, "/cases");
  deepStrictEqual(
    team.edges.filter((edge) => edge.kind === "supervises")
      .map((edge) => [edge.from, edge.to]),
    few.map((one) => ["main-unit", `branch:${one.caseId}`]),
  );
  // Past the limit, the newest stay and the oldest fold into one node.
  const many = Array.from(
    { length: BRANCH_LIMIT + 2 },
    (_, index) => branch(BRANCH_LIMIT + 2 - index),
  );
  const crowded = withBranches(teamOf(model), model, many, "/cases");
  equal(crowded.branches!.length, BRANCH_LIMIT);
  deepStrictEqual(crowded.branches!.at(-1), {
    id: "branch:more",
    label: "+3",
    title:
      "Rylessa 3 · Request 3\nRylessa 2 · Request 2\nRylessa 1 · Request 1",
    href: "/cases",
  });
  // A Case's own Team never draws Branch Operators.
  doesNotMatch(
    renderToString(
      <TeamPage
        board={model}
        roster={[]}
        selected={null}
        hrefOf={hrefOf}
        requestOwnerId="main-op"
        mainHref="/system"
        branches={few}
      />,
    ),
    /is-branch/,
  );
});

function page(
  boardOf: ModelBoard,
  options: {
    roster?: readonly RosterEntry[];
    selected?: string | null;
    runtime?: CandidateRead;
    serversOf?: (
      nativeIds: readonly string[],
    ) => readonly ToolServer[] | undefined;
  } = {},
) {
  return tidy(renderToString(
    <TeamPage
      board={boardOf}
      roster={options.roster ?? []}
      selected={options.selected ?? null}
      hrefOf={hrefOf}
      serversOf={options.serversOf}
      runtime={options.runtime}
    />,
  ));
}

/** The sections of the profile, by their title. */
function sections(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(
      /<section class="ctx-sec[^"]*" data-section="([^"]*)">([\s\S]*?)<\/section>/g,
    )]
      .map(([, title, inner]) => [title.replaceAll("&amp;", "&"), inner]),
  );
}

Deno.test("a team of a few is a network: the person, the agents as links, what they use, the one chosen in full under it", () => {
  const html = page(watchBoard());
  equal((html.match(/class="tmap"/g) || []).length, 1);
  match(html, /<div class="tmap"[^>]*role="group" aria-label="Team network"/);
  ok(html.indexOf('class="tmap"') < html.indexOf('class="profile"'));
  // The person comes first, as the avatar of "You", and is no link.
  match(
    html,
    /<div class="tnode is-you"[^>]*data-node="you"[^>]*><span class="tavatar"><svg/,
  );
  // Each agent is a link that selects it; the one shown says so, the others say they are not.
  const agents = [
    ...html.matchAll(
      /<a class="tnode is-agent( is-picked)?"[^>]*href="([^"]*)"[^>]*aria-current="(true|false)"[^>]*data-agent="([^"]*)"/g,
    ),
  ]
    .map((
      [, picked, href, current, id],
    ) => [id, href, current, Boolean(picked)]);
  deepStrictEqual(agents, [
    [COORDINATOR, `/system?select=${COORDINATOR}`, "true", true],
    [ANALYST, `/system?select=${ANALYST}`, "false", false],
    [COLLECTOR, `/system?select=${COLLECTOR}`, "false", false],
  ]);
  // Their avatars are their initials, their labels their names.
  match(
    html,
    /<span class="tavatar">CV<\/span><span class="tname">Coordinateur veille<\/span>/,
  );
  match(
    html,
    /<span class="tavatar">An<\/span><span class="tname">Analyste<\/span>/,
  );
  // The agents come first: what they work with waits behind "Resources".
  doesNotMatch(html, /class="tres/);
  match(
    html,
    /<div class="seg"><button type="button" aria-pressed="false"[^>]*>Resources<\/button><\/div>/,
  );
  // One wire for each edge, the person's dark: the coordinator, and nobody else.
  const edges = edgesOf(agentsOnly(teamOf(watchBoard())));
  equal((html.match(/<line /g) || []).length, edges.length);
  equal((html.match(/<line class="wire talk"/g) || []).length, 1);
  equal(edges.filter((edge) => edge.kind === "talk").length, 1);
  // The agent shown is the one the person talks with, in full.
  match(html, /<article class="profile" aria-label="Coordinateur veille"/);
  match(
    html,
    /<h2[^>]*>Coordinateur veille<\/h2><div class="faint">Talks with you<\/div>/,
  );
});

Deno.test("the network is drawn where the layout puts it: every node at its box, the frame as high as the layout", () => {
  const team = agentsOnly(teamOf(watchBoard()));
  const layout = layoutTeam(nodesOf(team), edgesOf(team), TEAM_ROOM);
  const html = page(watchBoard());
  match(html, new RegExp(`class="tmap"[^>]*style="height:${layout.height}px"`));
  for (const box of layout.boxes) {
    const place = `transform:translate(${box.x - box.w / 2}px, ${
      box.y - box.h / 2
    }px);width:${box.w}px`;
    ok(html.includes(place), `${box.id} at ${place}`);
  }
  // The same page is the same markup: nothing in it is chance or time.
  equal(page(watchBoard()), html);
});

Deno.test("Resources brings back what the agents work with, and the profile lists it either way", async () => {
  const probe = probeRoot();
  let view: ReturnType<typeof press> | undefined;
  function Probe() {
    view = press(() =>
      TeamPage({ board: watchBoard(), roster: [], selected: null, hrefOf })
    );
    return null;
  }
  const drawn = () => tidy(view!.html);
  try {
    await probe.show(Probe, {});
    const agents = drawn();
    doesNotMatch(agents, /class="tres|wire uses/);
    match(sections(agents)["Tools & skills"], /read_web_page/);

    await act(() => view!.click("Resources"));
    const all = drawn();
    match(all, /aria-pressed="true"[^>]*>Resources/);
    // What is used by three is one node, counted; what is used by one is not.
    const pills = [
      ...all.matchAll(
        /<div class="tres( is-shared)?"[^>]*title="([^"]*)"[^>]*data-resource="([^"]*)"/g,
      ),
    ].map(([, shared, title, key]) => [key, Boolean(shared), title]);
    equal(pills.length, 6);
    deepStrictEqual(pills[0], [
      "tool:read_web_page",
      true,
      "Coordinateur veille has\nAnalyste has\nCollecteur has",
    ]);
    equal(
      (all.match(/<span class="times" aria-label="3 agents">×3<\/span>/g) ||
        []).length,
      2,
    );
    equal(
      (all.match(/<line class="wire uses"/g) || []).length,
      teamOf(watchBoard()).edges.filter((edge) => edge.kind === "uses").length,
    );

    await act(() => view!.click("Resources"));
    doesNotMatch(drawn(), /class="tres/);
  } finally {
    await probe.restore();
  }
});

Deno.test("a member the Branch Operator may call is drawn with an arrow from it", () => {
  const model = withLinks(
    board({
      team: [
        unit({
          id: "owner-unit",
          title: "Owner",
          operator: "owner-op",
          declared: { operatorName: "Main Operator" },
        }),
        unit({
          id: "reviewer-unit",
          title: "Reviewer",
          declared: { operatorName: "Relecteur d'accroches" },
        }),
      ],
      cando: [item("reviewer-unit.inbox", "capability", "inbox", {
        scope: "reviewer-unit",
      })],
    }),
    [link("can-call", "owner-op", "reviewer-unit.inbox")],
  );
  const html = tidy(renderToString(
    <TeamPage
      board={model}
      roster={[]}
      selected={null}
      hrefOf={hrefOf}
      requestOwnerId="owner-op"
      branchName="Remurin Talvrek"
      mainHref="/system"
    />,
  ));
  const calls = [...html.matchAll(/<line class="wire calls"[^>]*>/g)];
  equal(calls.length, 1);
  match(calls[0][0], /marker-end="url\(#tmap-call\)"/);
  match(html, /<marker id="tmap-call"/);
  match(html, /<span class="tname">Relecteur d'accroches<\/span>/);
  // With no resource on the board, there is nothing to switch.
  doesNotMatch(html, />Resources</);
});

Deno.test("choosing an agent changes the profile and the one marked, and nothing of the network", () => {
  const first = page(watchBoard());
  const second = page(watchBoard(), { selected: ANALYST });
  match(second, /<article class="profile" aria-label="Analyste"/);
  match(
    second,
    /<h2[^>]*>Analyste<\/h2><div class="faint">Not in direct contact with you<\/div>/,
  );
  match(
    second,
    new RegExp(`class="tnode is-agent is-picked"[^>]*data-agent="${ANALYST}"`),
  );
  doesNotMatch(
    second,
    new RegExp(`is-picked"[^>]*data-agent="${COORDINATOR}"`),
  );
  const network = (html: string) =>
    html.slice(
      html.indexOf('<div class="tmap"'),
      html.indexOf('<article class="profile"'),
    )
      .replace(/ is-picked/g, "").replace(/aria-current="(true|false)"/g, "");
  equal(network(second), network(first));
  // An agent that is not on the team is no choice.
  match(
    page(watchBoard(), { selected: "ghost" }),
    /aria-label="Coordinateur veille"/,
  );
});

Deno.test("the initial model's lone unit is shown with what the runtime says of it, and with its own name when the runtime says nothing", () => {
  const withRoster = page(initialBoard(), { roster: [rosterEntry(BUILDER)] });
  match(withRoster, /<span class="tname">Concepteur<\/span>/);
  match(
    withRoster,
    /<h2 title="ASELiveBuilder::liveBuilder">Concepteur<\/h2><div class="faint">Talks with you<\/div>/,
  );
  match(withRoster, /class="tnode is-you"/);
  // The runtime's name is not the model's: the model names the unit, so the title shows.
  const alone = page(initialBoard());
  match(alone, /<h2 title="ASELiveBuilder::liveBuilder">liveBuilder<\/h2>/);
  // Nothing says who the person talks with: no person, no sentence about it.
  doesNotMatch(alone, /is-you|Talks with you|Not in direct contact/);
  doesNotMatch(alone, /class="wire talk"/);
  // Working now is a dot on the avatar and a word under the name.
  const busy = page(initialBoard(), {
    roster: [rosterEntry(BUILDER, { busy: true })],
  });
  match(busy, /data-busy="true"/);
  match(busy, /Talks with you · working now/);
  doesNotMatch(withRoster, /data-busy|working now/);
});

Deno.test("the profile has a section for each part the model declares, with its figures, its things and its rules", () => {
  const html = page(initialBoard(), { roster: [rosterEntry(BUILDER)] });
  const found = sections(html);
  deepStrictEqual(Object.keys(found), [
    "Context",
    "Tools & skills",
    "Memory",
    "Mandate",
    "Works on",
  ]);
  // A measured figure reads as itself; a declared ceiling says it is one.
  match(
    found.Context,
    /title="recent messages"><b>8<\/b><span>recent messages<\/span>/,
  );
  match(
    found.Context,
    /title="Limit declared in the model"><b>≤ 250k<\/b><span>context characters<\/span>/,
  );
  match(
    found["Tools & skills"],
    /<span class="chip" title="Return the actual[^"]*">read_web_page<\/span>/,
  );
  match(
    found["Tools & skills"],
    /<span class="rule">allowed hosts: raw\.githubusercontent\.com<\/span>/,
  );
  match(found.Memory, /<b>≤ 24h<\/b><span>validity<\/span>/);
  match(found.Memory, /<span class="rule">require source refs: yes<\/span>/);
  // The agent's own mandate, in the model's words, its name on hover, the limits as figures.
  match(
    found.Mandate,
    /<p class="mandate" title="builderMandate">Propose read_web_page and read_web_page_outline; invoke active catalog tools<\/p>/,
  );
  doesNotMatch(found.Mandate, /Stable authority identity/);
  match(found.Mandate, /<b>≤ 12<\/b><span>agent decisions<\/span>/);
  // The flows it performs are named, and are words: nothing to press until
  // the page they would lead to exists.
  match(found["Works on"], /<span class="chip"[^>]*>Promotion<\/span>/);
  doesNotMatch(found["Works on"], /<a |<button/);
});

Deno.test("what the model leaves out says so: no context policy, no tool or skill, no memory, no mandate", () => {
  const bare = board({
    team: [unit({ id: "u", title: "u", declared: { operatorName: "Bare" } })],
  });
  const html = page(bare);
  const found = sections(html);
  for (
    const [title, none] of [
      ["Context", "No context policy declared"],
      ["Tools & skills", "No tool or skill declared"],
      ["Memory", "No memory declared"],
      ["Mandate", "No mandate declared"],
    ]
  ) {
    match(found[title], new RegExp(`<div class="faint">${none}</div>`), title);
  }
  equal((html.match(/class="ctx-sec is-blank"/g) || []).length, 4);
  // Nothing to work on: the section is not there at all.
  equal("Works on" in found, false);
  // A mandate that has a name and no words shows its name, not an excuse.
  const named = board({
    team: [unit({ id: "u", title: "u" })],
    rules: [item("m", "mandate", "someMandate", { scope: "u" })],
  });
  const mandate = sections(page(named)).Mandate;
  match(mandate, /<p class="mandate faint">someMandate<\/p>/);
  doesNotMatch(mandate, /No mandate declared/);
});

Deno.test("a model with no agent says so, and draws no network", () => {
  for (
    const empty of [board({}), board({ team: [item("p", "machine", "p")] })]
  ) {
    const html = page(empty);
    match(
      html,
      /<p class="view-empty" data-code="no-agent">No agent declared<\/p>/,
    );
    doesNotMatch(html, /tmap|profile|team-picker/);
  }
});

const ANCHORS = {
  code: "ANCHOR_UNRESOLVED",
  severity: "info",
  context: { anchors: ["ASELibrary::Operator"] },
  recovery: "Add the missing ASE library definitions to the model sources.",
} as const;

Deno.test("a team that came out empty shows what the host noted, with its code and its recovery, and does not claim that nothing is declared", () => {
  const html = page(board({}, { diagnostics: [ANCHORS] }));
  match(
    html,
    /<p class="view-empty" data-code="no-agent-found">No agent could be read<\/p>/,
  );
  match(
    html,
    /<li data-code="ANCHOR_UNRESOLVED" data-severity="info"><code class="rev-host-code">ANCHOR_UNRESOLVED<\/code>Add the missing ASE library definitions to the model sources\.<\/li>/,
  );
  doesNotMatch(html, /No agent declared|tmap|profile/);
  // Whatever the severity: any note may be why there is no agent.
  const worse = page(board({}, {
    diagnostics: [{ ...ANCHORS, code: "MODEL_INVALID", severity: "error" }],
  }));
  match(worse, /data-code="MODEL_INVALID" data-severity="error"/);
  // The host noted nothing: the model declares no agent.
  match(page(board({})), /data-code="no-agent">No agent declared/);
  doesNotMatch(page(board({})), /board-notes/);
});

Deno.test("with a team on show, only the warnings and the errors of the host are said, above the team", () => {
  const diagnostics = [
    ANCHORS,
    { ...ANCHORS, code: "UNIT_SKIPPED", severity: "warning" as const },
    { ...ANCHORS, code: "LINK_BROKEN", severity: "error" as const },
  ];
  const html = page({
    ...initialBoard(),
    meta: { ...initialBoard().meta, diagnostics },
  });
  match(html, /data-code="UNIT_SKIPPED" data-severity="warning"/);
  match(html, /data-code="LINK_BROKEN" data-severity="error"/);
  doesNotMatch(html, /ANCHOR_UNRESOLVED/);
  ok(html.indexOf("board-notes") < html.indexOf('class="team-page"'));
  // An info note alone is no noise.
  const quiet = page({
    ...initialBoard(),
    meta: { ...initialBoard().meta, diagnostics: [ANCHORS] },
  });
  doesNotMatch(quiet, /board-notes|ANCHOR_UNRESOLVED/);
  // The list form shows them too, outside the grid of the list.
  const crowd = crowdBoard(13);
  const many = page({
    ...crowd,
    meta: { ...crowd.meta, diagnostics },
  });
  match(many, /data-code="UNIT_SKIPPED"/);
  ok(many.indexOf("board-notes") < many.indexOf("team-page is-list"));
});

Deno.test("up to twelve agents are a network; with more, a list at the left of the agent shown", () => {
  const twelve = page(crowdBoard(12));
  equal((twelve.match(/class="tmap"/g) || []).length, 1);
  doesNotMatch(twelve, /team-picker/);
  match(twelve, /class="team-page"/);
  const many = page(crowdBoard(13), { selected: "unit-4" });
  doesNotMatch(many, /tmap|tnode/);
  match(many, /class="team-page is-list"/);
  const picks = [
    ...many.matchAll(
      /<a class="team-pick" href="([^"]*)" aria-current="(true|false)" data-agent="([^"]*)"[^>]*>[\s\S]*?<span class="team-pick-name">([^<]*)<\/span>/g,
    ),
  ]
    .map(([, href, current, id, name]) => [href, current, id, name]);
  equal(picks.length, 13);
  deepStrictEqual(picks[3], [
    "/system?select=unit-4",
    "true",
    "unit-4",
    "Agent 4",
  ]);
  deepStrictEqual(picks.filter((entry) => entry[1] === "true").length, 1);
  // The list comes before the agent it chooses, which is in full beside it.
  ok(many.indexOf('class="team-picker"') < many.indexOf('class="profile"'));
  match(many, /<article class="profile" aria-label="Agent 4"/);
  // Nobody chosen: the one the person talks with.
  match(page(crowdBoard(13)), /<article class="profile" aria-label="Agent 1"/);
  match(
    page(crowdBoard(13)),
    /href="\/system\?select=unit-1" aria-current="true"/,
  );
});

Deno.test("what the runtime holds of the agent, its tools by server, comes beside what the model declares", () => {
  const servers: ToolServer[] = [{
    name: "web",
    tools: [
      { id: "1", name: "read_web_page", description: "", kind: "candidate" },
      {
        id: "2",
        name: "read_web_page_outline",
        description: "",
        kind: "candidate",
        stage: "testing",
      },
    ],
  }, {
    name: "model",
    tools: [{
      id: "model.search",
      name: "search",
      description: "",
      kind: "model",
    }],
  }];
  const asked: (readonly string[])[] = [];
  const html = page(initialBoard(), {
    roster: [rosterEntry(BUILDER)],
    serversOf: (nativeIds) => {
      asked.push(nativeIds);
      return servers;
    },
  });
  deepStrictEqual(asked, [[BUILDER]]);
  const tools = sections(html)["Tools & skills"];
  match(
    tools,
    /<span class="fl">Servers<\/span><span class="chip ghost" data-tool-server="web"[^>]*>web 2<\/span>/,
  );
  match(tools, /data-tool-server="model"[^>]*>model 1<\/span>/);
  // The model's own tools stay as it declares them.
  match(tools, /<span class="fl">Has<\/span>/);
  // An agent with no tool in the model still shows the ones it runs.
  const onlyRuntime = page(board({ team: [unit({ id: "u", title: "u" })] }), {
    serversOf: () => servers,
  });
  const runtime = sections(onlyRuntime)["Tools & skills"];
  doesNotMatch(runtime, /No tool or skill declared/);
  match(runtime, /data-tool-server="web"/);
  // Unknown is not empty: nothing is said of servers.
  doesNotMatch(
    sections(
      page(initialBoard(), { serversOf: () => undefined }),
    )["Tools & skills"],
    /Servers/,
  );
});

Deno.test("what the model says is shown as text and never as markup", () => {
  const hostile = "<img src=x onerror=attack()>";
  const attack = board({
    team: [
      unit({ id: "u", title: hostile, declared: { operatorName: hostile } }),
    ],
    cando: [tool("t", "u", hostile, hostile)],
    rules: [
      item("m", "mandate", hostile, { scope: "u", summary: hostile }),
      policy(
        "p",
        "u",
        "ContextPolicy",
        { note: hostile, list: [hostile] },
        "context",
      ),
    ],
  });
  const html = page(attack, { roster: [rosterEntry("u", { name: hostile })] });
  // Every `<` is escaped: what is left of it is text.
  doesNotMatch(html, /<img|<script/);
  match(html, /&lt;img src=x onerror=attack\(\)>/);
  equal((html.match(/&lt;img/g) || []).length > 8, true);
});

Deno.test("the page changes nothing: it has links and words, and only the Resources switch", () => {
  for (
    const [html, switches] of [
      [page(watchBoard()), 1],
      [page(crowdBoard(14)), 0],
      [page(initialBoard()), 1],
    ] as const
  ) {
    // The one control shows more of the network; it writes nothing.
    equal(
      (html.match(
        /<button type="button" aria-pressed="false"[^>]*>Resources<\/button>/g,
      ) ||
        []).length,
      switches,
    );
    doesNotMatch(
      html.replace(/<button[^>]*>Resources<\/button>/, ""),
      /<button|<input|<select|<textarea|<form|onclick|contenteditable/i,
    );
    // Every link goes to a page of the System place, and says where it leads.
    for (const [, href] of html.matchAll(/<a [^>]*href="([^"]*)"/g)) {
      match(href, /^\/system\?select=/);
    }
  }
  // A page the board owns is not changed by being drawn.
  const source = watchBoard();
  const before = JSON.stringify(source);
  page(source, { roster: [rosterEntry(COORDINATOR)] });
  equal(JSON.stringify(source), before);
});

Deno.test("Has integrates exact owned candidates and preserves native declarations and homonyms", () => {
  const modeled = board({
    team: [unit({ id: "u", title: "Unit", operator: "native:a" })],
    cando: [
      { ...tool("bound", "u", "Read"), element: "native:tool" },
      tool("homonym", "u", "Read"),
      item("skill", "skill", "Read", { scope: "u" }),
    ],
  });
  const candidate = {
    ...snapshot().candidates[0],
    name: "Read",
    binding: { elementId: "native:tool", graphPath: "model.tool" },
  };
  const runtime: CandidateRead = {
    catalogue: {
      systemId: "system",
      version: "v1",
      tools: [
        {
          agentId: "session:a",
          agentName: "Same owner",
          revision: 1,
          candidate,
        },
        {
          agentId: "session:b",
          agentName: "Same owner",
          revision: 1,
          candidate: { ...candidate, name: "Wrong owner" },
        },
      ],
    },
    loading: false,
    stale: false,
    error: "",
  };
  const options = {
    roster: [rosterEntry("native:a", { agentId: "session:a" })],
    runtime,
  };
  const before = JSON.stringify(modeled);
  const html = sections(page(modeled, options))["Tools & skills"];
  equal((html.match(/class="chip tool-candidate-chip warn"/g) ?? []).length, 1);
  equal((html.match(/class="chip"[^>]*>Read<\/span>/g) ?? []).length, 2);
  match(
    html,
    /href="\/model\?operator=session%3Aa&amp;candidate=c1&amp;digest=a{64}"/,
  );
  match(html, /Awaiting admission/);
  doesNotMatch(html, /Wrong owner|session%3Ab/);
  const stale = sections(
    page(modeled, { ...options, runtime: { ...runtime, stale: true } }),
  )["Tools & skills"];
  match(stale, /Last observed: Awaiting admission/);
  match(stale, /current activity is unknown/);
  doesNotMatch(stale, /tool-candidate-chip warn/);
  // A native identity absent from the roster cannot borrow a session by its label or ID.
  const unknown = sections(
    page(modeled, { ...options, roster: [rosterEntry("native:a")] }),
  )["Tools & skills"];
  doesNotMatch(unknown, /data-candidate|href="\/model/);
  equal(JSON.stringify(modeled), before);
});
