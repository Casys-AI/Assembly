import { ModelLinkContext } from "../view/ModelContextLink.tsx";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { act } from "preact/test-utils";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import type { OperatorTool } from "../../../src/application/work/operators/conversation-types.ts";
import type { CandidateRead } from "../../lib/system/tools/candidates.ts";
import {
  ANALYST,
  board,
  COLLECTOR,
  COORDINATOR,
  HEAD,
  initialBoard,
  item,
  kitchenSink,
  linkedBoard,
  tool,
  unit,
  watchBoard,
} from "../../test/support/board-fixture.ts";
import { asides, tidy } from "../../test/support/markup.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import {
  type PageOptions,
  renderSystemPage,
  UNIT_NAMES,
} from "../../test/support/system-page.ts";
import { detailOf } from "../../lib/system/board/detail.ts";
import { ElementDetail } from "./ElementDetail.tsx";
import { ExplorePage } from "./ExplorePage.tsx";
import { settle } from "../../test/support/settle.ts";

const explore = (model: ModelBoard, over: PageOptions = {}) =>
  renderSystemPage(ExplorePage, "explore", model, over);

const cardOf = (html: string, id: string) =>
  html.match(new RegExp(`<a class="explore-card[^"]*"[^>]*data-id="${id}"`))
    ?.[0];

Deno.test("the columns the model fills are drawn, in order, each with how many cards it holds", () => {
  const html = explore(watchBoard());
  deepStrictEqual(
    [...html.matchAll(/data-column="(\w+)"/g)].map(([, id]) => id),
    ["team", "cando", "rules"],
  );
  // Guarantees and information declare nothing in this model: no empty column.
  doesNotMatch(html, /Guarantees|Information/);
  match(html, />Team<span class="explore-n">3<\/span>/);
  // Seven things are declared in Can do; the tools of every unit are one card each.
  match(html, />Can do<span class="explore-n">3<\/span>/);
  match(html, /<h3 class="explore-head" title="7 across 3 systems">/);
  // A column without twins says nothing about them.
  match(html, /<h3 class="explore-head"><svg[^>]*>.*?<\/svg>Team</s);
});

Deno.test("a model that declares nothing says so, in one line", () => {
  const html = explore(board({}));
  equal(
    html,
    '<p class="view-empty" data-code="no-element">Nothing declared yet</p>',
  );
});

Deno.test("units are drawn by the name the team gives them, everything else by its own title", () => {
  const html = explore(watchBoard());
  match(html, /<span class="explore-t">Coordinateur<\/span>/);
  match(html, /<span class="explore-t">Collecteur<\/span>/);
  // The model's identifier is told as a phrase, as the detail of the card will.
  match(html, /<span class="explore-t">Read web page<\/span>/);
  doesNotMatch(html, /read_web_page/);
  // Groups name the unit they are declared in by the same name.
  match(html, /<div class="explore-group">in Coordinateur<\/div>/);
  match(html, /<div class="explore-group">in Analyste<\/div>/);
});

Deno.test("the same tool in every unit is one card marked ×3, and says where it is from", () => {
  const html = explore(watchBoard());
  equal((html.match(/data-id="[^"]*\.read"/g) ?? []).length, 1);
  match(html, /<div class="explore-group">In every system<\/div>/);
  match(
    html,
    /<span class="explore-times" title="one per system: Coordinateur, Analyste and Collecteur">×3<\/span>/,
  );
  // A card nobody shares has no mark.
  const alone = cardOf(html, `${COORDINATOR}.promotion`)!;
  ok(alone);
  doesNotMatch(
    html.slice(html.indexOf(alone), html.indexOf("</a>", html.indexOf(alone))),
    /explore-times/,
  );
});

Deno.test("each card is a link that opens its element in place, in the page's own address", () => {
  const html = explore(watchBoard());
  match(
    html,
    new RegExp(
      `<a class="explore-card el" href="/system\\?page=explore&amp;select=${COORDINATOR}" aria-current="false" data-id="${COORDINATOR}">`,
    ),
  );
  // A twin card opens the first of its elements.
  match(
    html,
    new RegExp(
      `href="/system\\?page=explore&amp;select=${COORDINATOR}\\.read"`,
    ),
  );
  // The model's summary is the card's tooltip.
  match(
    html,
    /title="Planifier les travaux exposés et réintégrer leurs résultats"/,
  );
  // The version being read is kept by every link.
  const pinned = explore(watchBoard(), { version: HEAD });
  match(
    pinned,
    new RegExp(
      `href="/system\\?page=explore&amp;select=${COORDINATOR}&amp;version=${
        encodeURIComponent(HEAD)
      }"`,
    ),
  );
  // With nothing chosen, nothing is open or stepped back.
  doesNotMatch(html, /<aside|is-selected|is-lit|has-selection/);
});

Deno.test("a card's tooltip is the element's own note: the note of a package describes the package, not the card", () => {
  const unitWith = (summary: string, source: string) => ({
    ...unit({ id: "u", title: "u", summary }),
    summarySource: source,
  });
  const tooltip = (html: string) =>
    html.match(/<a class="explore-card[^"]*"[^>]*data-id="u"([^>]*)>/)![1];
  // A note that is the package's is nobody's tooltip: the card says nothing.
  const documented = explore(
    board({ team: [unitWith("The whole package, described.", "package-doc")] }),
  );
  doesNotMatch(tooltip(documented), /title=/);
  doesNotMatch(documented, /The whole package/);
  // Any other note is the element's, as the detail says it.
  const noted = explore(
    board({ team: [unitWith("What the unit does.", "type-doc")] }),
  );
  match(tooltip(noted), /title="What the unit does\."/);
});

Deno.test("a card and the detail that opens elsewhere in full go by the same name, in both views", () => {
  const model = linkedBoard();
  for (const sysml of [false, true]) {
    const detail = detailOf({
      board: model,
      page: "explore",
      selected: null,
      sysml,
      names: UNIT_NAMES,
    });
    const html = explore(model, { sysml });
    for (
      const id of [
        `${COORDINATOR}.promotion`,
        `${COORDINATOR}.read`,
        `${COORDINATOR}.mandate`,
        COORDINATOR,
      ]
    ) {
      const card = html.match(
        new RegExp(
          `<a class="explore-card[^"]*"[^>]*data-id="${
            id.replaceAll(".", "\\.")
          }"[^>]*>.*?<span class="explore-t">([^<]*)`,
          "s",
        ),
      );
      // A card's own detail is narrow and has no heading; the full one, where
      // a page has room for it, is told by the same name.
      const full = tidy(renderToString(
        <ElementDetail element={detail.index.get(id)!} detail={detail} />,
      )).match(/<h2 class="detail-title">([^<]*)<\/h2>/);
      ok(card && full, `${id} is a card and has a detail`);
      equal(card[1], full[1], `${id} (${sysml ? "SysML" : "readable"})`);
    }
  }
});

Deno.test("the readable view marks kinds with an icon, SysML's own words with the keyword and the type", () => {
  const readable = explore(watchBoard());
  match(readable, /<span class="kind-icon" title="tool"><svg /);
  doesNotMatch(readable, /kind-kw|explore-ty/);
  const sysml = explore(watchBoard(), { sysml: true });
  match(sysml, /<span class="kind-kw">item<\/span>/);
  match(sysml, /<span class="kind-kw">perform action<\/span>/);
  doesNotMatch(sysml, /kind-icon/);
  // The type follows the title; units are called by their own title.
  match(
    sysml,
    /<span class="explore-t">read_web_page<span class="explore-ty">: CapabilityContract<\/span><\/span>/,
  );
  match(sysml, /<span class="explore-t">liveBuilder<\/span>/);
  doesNotMatch(sysml, /Coordinateur/);
});

Deno.test("the detail opens right after the card chosen, narrow because it is in a column, and it is the only one", () => {
  const html = explore(linkedBoard(), { selected: `${COORDINATOR}.promotion` });
  equal(asides(html), 1);
  match(
    html,
    new RegExp(
      `<a class="explore-card el is-selected" href="/system\\?page=explore" aria-current="true" data-id="${COORDINATOR}\\.promotion">.*?</a><aside class="detail is-narrow" aria-label="Detail" data-element="${COORDINATOR}\\.promotion">`,
      "s",
    ),
  );
  // The card chosen leads to the page without it: choosing again closes it.
  // The detail is not between the cards of another column.
  const before = html.slice(0, html.indexOf("<aside "));
  equal((before.match(/<section /g) ?? []).length, 2);
  equal((html.match(/<\/section>/g) ?? []).length, 3);
});

Deno.test("another card chosen moves the detail: it is never open under two", () => {
  for (
    const id of [`${COORDINATOR}.mandate`, ANALYST, `${ANALYST}.execution`]
  ) {
    const html = explore(linkedBoard(), { selected: id });
    equal(asides(html), 1, id);
    match(
      html,
      new RegExp(
        `data-id="${id.replace(".", "\\.")}"[^>]*>.*?</a><aside `,
        "s",
      ),
    );
    match(
      html,
      new RegExp(`<aside [^>]*data-element="${id.replace(".", "\\.")}"`),
    );
  }
});

Deno.test("a twin chosen by any of its ids opens the detail under the one card that stands for them all", () => {
  for (
    const id of [`${COORDINATOR}.read`, `${ANALYST}.read`, `${COLLECTOR}.read`]
  ) {
    const html = explore(linkedBoard(), { selected: id });
    equal(asides(html), 1, id);
    // The card is chosen; the detail is the element asked for, not the first twin.
    match(
      html,
      new RegExp(
        `<a class="explore-card el is-selected"[^>]*data-id="${COORDINATOR}\\.read"[^>]*>.*?</a><aside [^>]*data-element="${
          id.replace(".", "\\.")
        }">`,
        "s",
      ),
    );
  }
});

Deno.test("a name the board knows by another id still opens: the id the Toolkit gives, the card that holds it", () => {
  const model = board({
    team: [{
      ...unit({ id: "u", title: "u" }),
      children: [{
        ...unit({ id: "x", title: "x" }),
        id: "u.op",
        element: "native-op",
      }],
    }],
  });
  const html = explore(model, { selected: "u" });
  equal(asides(html), 1);
  // The part inside the unit is not a card of the page: its detail follows the title.
  const inside = explore(model, { selected: "native-op" });
  equal(asides(inside), 1);
  match(inside, /^<div class="explore"><aside [^>]*data-element="u\.op"/);
});

Deno.test("nothing is opened for an id the board does not hold", () => {
  for (const selected of ["ghost", "", "constructor", "__proto__"]) {
    const html = explore(linkedBoard(), { selected });
    equal(asides(html), 0, JSON.stringify(selected));
    doesNotMatch(html, /is-selected|is-lit|has-selection/);
  }
});

Deno.test("a selection no card stands for follows the title, whatever the page draws below", () => {
  // A step of the flow is on the flow's page: Explore has no card for it.
  const html = explore(linkedBoard(), {
    selected: `${COORDINATOR}.promotion.step0`,
  });
  equal(asides(html), 1);
  match(html, /^<div class="explore"><aside class="detail" /);
  // It is wide: the variant of a column does not apply under the title.
  doesNotMatch(html, /is-narrow/);
  match(html, /<h2 class="detail-title">Step 1<\/h2>/);
  // No card is chosen, and the ones it is related to are lit.
  doesNotMatch(html, /is-selected/);
  match(
    html,
    new RegExp(
      `is-lit" href="[^"]*" aria-current="false" data-id="${COORDINATOR}"`,
    ),
  );
});

Deno.test("what the chosen element is related to stays lit with the reason, the rest steps back", () => {
  const html = explore(linkedBoard(), { selected: `${COORDINATOR}.read` });
  match(html, /<div class="explore-board has-selection">/);
  // The unit that holds the operator which calls the tool is lit, and says why.
  const unitCard = html.match(
    new RegExp(
      `<a class="explore-card el is-lit"[^>]*data-id="${COORDINATOR}">.*?</a>`,
      "s",
    ),
  )?.[0];
  ok(unitCard, "the unit is lit");
  match(
    unitCard,
    /<span class="el-why"><span class="chip">callable by<\/span><\/span>/,
  );
  // The other units, with nothing to do with it, are neither lit nor chosen.
  doesNotMatch(cardOf(html, ANALYST)!, /is-lit|is-selected/);
  // The card chosen says no reason: it is the reason.
  doesNotMatch(
    html.match(/<a class="explore-card el is-selected".*?<\/a>/s)![0],
    /el-why/,
  );
  // Without a selection no reason is told.
  doesNotMatch(explore(linkedBoard()), /el-why/);
});

Deno.test("what holds the chosen element, or is held by it, is neither lit nor stepped back", () => {
  const model = board({
    team: [unit({ id: "u", title: "u" }), unit({ id: "v", title: "v" })],
    cando: [tool("u.tool", "u", "search")],
  });
  // The unit's operator is chosen; the unit that holds it is its context.
  const html = explore(
    {
      ...model,
      links: [],
    },
    { selected: "u.operator" },
  );
  match(html, /<a class="explore-card el is-context"[^>]*data-id="u"/);
  doesNotMatch(cardOf(html, "v")!, /is-context/);
});

Deno.test("a flow's card, a guarantee's, and what the model declares in a board of every shape are drawn without breaking", () => {
  const html = explore(kitchenSink());
  match(html, /data-column="team"/);
  match(html, /data-column="cando"/);
  match(html, /data-column="rules"/);
  match(html, /data-column="guarantees"/);
  // A lifecycle and a requirement are guarantees: each is a card.
  match(html, /data-id="life"/);
  match(html, /data-id="req"/);
  // The initial model: one unit, six things it can do, six rules.
  const initial = explore(initialBoard());
  equal((initial.match(/<a class="explore-card/g) ?? []).length, 1 + 6 + 6);
});

const runtimeTool = (
  owner: string,
  element: string,
  stage: OperatorTool["candidate"]["stage"] = "active",
): OperatorTool => ({
  agentId: owner,
  agentName: "Same name",
  revision: 1,
  candidate: {
    id: "same-id",
    name: "search",
    description: "",
    digest: `${owner}-digest`,
    stage,
    kind: "read_web_page",
    code: "",
    createdAt: "now",
    baseCatalogRevision: 0,
    binding: { elementId: element, graphPath: "model.sysml" },
  },
});

function linkedToolsPage(over: {
  historical?: boolean;
  stale?: boolean;
  loading?: boolean;
  error?: string;
  tools?: OperatorTool[];
  catalogue?: null;
} = {}) {
  const model = board({
    team: [
      unit({ id: "a", title: "a", operator: "native-owner-a" }),
      unit({ id: "b", title: "b", operator: "native-owner-b" }),
    ],
    cando: [
      { ...tool("a.tool", "a", "search"), element: "native-tool-a" },
      { ...tool("b.tool", "b", "search"), element: "native-tool-b" },
    ],
  });
  const runtime: CandidateRead = {
    catalogue: over.catalogue === null ? null : {
      systemId: "s",
      version: "v",
      tools: over.tools ?? [
        runtimeTool("owner-a", "native-tool-a"),
        runtimeTool("owner-b", "native-tool-b", "awaiting-admission"),
      ],
    },
    stale: over.stale ?? false,
    loading: over.loading ?? false,
    error: over.error ?? "",
  };
  return renderSystemPage(ExplorePage, "explore", model, {}, {
    runtime,
    roster: [
      { agentId: "owner-a", nativeId: "native-owner-a" },
      { agentId: "owner-b", nativeId: "native-owner-b" },
    ],
    historical: over.historical ?? false,
  });
}

Deno.test("Explore gives each linked twin its exact owner/candidate/digest link outside the inspection anchor", () => {
  const html = linkedToolsPage();
  equal((html.match(/<a class="explore-card/g) ?? []).length, 3);
  match(html, /data-id="a.tool"[^>]*>.*?×2/s);
  match(html, /data-occurrence="a.tool"/);
  match(html, /data-occurrence="b.tool"/);
  match(
    html,
    /href="\/model\?operator=owner-a&amp;candidate=same-id&amp;digest=owner-a-digest"/,
  );
  match(
    html,
    /href="\/model\?operator=owner-b&amp;candidate=same-id&amp;digest=owner-b-digest"/,
  );
  match(html, /Same name.*?Active/s);
  match(html, /Awaiting admission/);
  // Each inspection anchor closes before its runtime state links begin.
  for (
    const anchor of html.matchAll(/<a class="explore-card[^>]*>.*?<\/a>/gs)
  ) {
    doesNotMatch(anchor[0], /href="\/model|tool-candidate/);
  }
  doesNotMatch(html, /is-appearing|New tool/);
});

Deno.test("Explore never treats name-only or unknown-owner candidates as the tool's state", () => {
  const html = linkedToolsPage({
    tools: [
      runtimeTool("missing-owner", "native-tool-a"),
      runtimeTool("owner-a", "search"),
      runtimeTool("owner-b", "native-tool-a"),
    ],
  });
  doesNotMatch(html, /explore-tool-states|href="\/model\?page=revisions/);
  // The ordinary model inspection cards still appear and still navigate.
  match(html, /data-id="a.tool"/);
  match(html, /href="\/system\?page=explore&amp;select=a.tool"/);
});

Deno.test("Explore marks stale observations explicitly and ignores a command error after a fresh read", () => {
  const stale = linkedToolsPage({ stale: true, error: "Read failed" });
  match(stale, /Last observed: Active/);
  match(stale, /Last observed: Awaiting admission/);
  const fresh = linkedToolsPage({ error: "Earlier command failed" });
  doesNotMatch(fresh, /Last observed/);
  match(fresh, /Active/);
  const loading = linkedToolsPage({ loading: true });
  match(loading, /Last observed: Active/);
});

Deno.test("Explore historical views suppress runtime links even if present-day data is supplied", () => {
  for (const over of [{ historical: true }, { catalogue: null }] as const) {
    const html = linkedToolsPage(over);
    doesNotMatch(
      html,
      /explore-tool-states|href="\/model\?page=revisions|is-appearing|New tool/,
    );
    match(html, /data-id="a.tool"/);
  }
});

Deno.test("a recovered active binding keeps its confirmed state without a graph navigation path", () => {
  const candidate = runtimeTool("owner-a", "native-tool-a");
  candidate.candidate.binding!.graphPath = "";
  const html = linkedToolsPage({ tools: [candidate] });
  match(html, />Active</);
  doesNotMatch(html, /Unknown state/);
});

Deno.test("Explore renders a native catalogue candidate under the unit containing its exact occurrence", () => {
  const own = unit({ id: "u", title: "Unit", operator: "native-owner" });
  const model = board({
    team: [{
      ...own,
      children: own.children!.map((child) =>
        child.id === "u.catalog"
          ? {
            ...child,
            children: [item("native-candidate", "machine", "tool_hash", {
              type: {
                title: "ToolCandidate",
                qname: "ASELiveBuilder::ToolCandidate",
              },
            })],
          }
          : child
      ),
    }],
    cando: [tool("contract", "u", "read_web_page")],
  });
  const runtime: CandidateRead = {
    catalogue: {
      systemId: "s",
      version: "v",
      tools: [runtimeTool("session-owner", "native-candidate")],
    },
    stale: false,
    loading: false,
    error: "",
  };
  const render = (historical = false) =>
    renderSystemPage(ExplorePage, "explore", model, {}, {
      runtime,
      roster: [{ agentId: "session-owner", nativeId: "native-owner" }],
      historical,
    });
  const html = render();
  match(html, /data-id="u"[^>]*>.*?<\/a><div class="explore-tool-states">/s);
  match(html, /data-occurrence="native-candidate"/);
  match(
    html,
    /operator=session-owner&amp;candidate=same-id&amp;digest=session-owner-digest/,
  );
  match(html, />Active</);
  doesNotMatch(html, /data-occurrence="contract"/);
  doesNotMatch(render(true), /explore-tool-states|data-occurrence=/);
});

Deno.test("Explore renders a new tool's transient indication through its production lifecycle and cleans it on expiry or unmount", async () => {
  const root = probeRoot();
  let node!: ReturnType<typeof ExplorePage>;
  function Probe({ model }: { model: ModelBoard }) {
    node = ExplorePage({
      board: model,
      detail: detailOf({
        board: model,
        page: "explore",
        selected: null,
        sysml: false,
      }),
      appearanceMs: 0,
    });
    return null;
  }
  const model = (ids: readonly string[]) => {
    const own = unit({ id: "u", title: "u" });
    return board({
      team: [{
        ...own,
        children: own.children!.map((child) =>
          child.id === "u.catalog"
            ? {
              ...child,
              children: ids.map((id) =>
                item(id, "machine", `tool_${id}`, {
                  type: {
                    title: "ToolCandidate",
                    qname: "ASELiveBuilder::ToolCandidate",
                  },
                })
              ),
            }
            : child
        ),
      }],
      cando: [tool("existing-contract", "u", "read_web_page")],
    });
  };
  const html = () => tidy(renderToString(node));
  try {
    await root.show(Probe, { model: model(["search"]) });
    doesNotMatch(html(), /is-appearing|<span class="sr-only">New tool<\/span>/);

    await root.show(Probe, { model: model(["search", "browse"]) });
    match(cardOf(html(), "u")!, /is-appearing/);
    doesNotMatch(cardOf(html(), "existing-contract")!, /is-appearing/);
    match(
      html(),
      /<a class="explore-card[^"]*is-appearing"[^>]*data-id="u"[^>]*>.*?<span class="sr-only">New tool<\/span><\/a>/s,
    );

    // The real timer runs, shortened to nothing: expiry clears the mark.
    await act(() => settle());
    doesNotMatch(html(), /is-appearing|<span class="sr-only">New tool<\/span>/);

    await root.show(Probe, { model: model(["search", "browse", "inspect"]) });
    match(cardOf(html(), "u")!, /is-appearing/);
    // Deno's default timer/operation sanitizer also fails if unmount leaves
    // this production appearance timeout pending.
    await root.unmount();
  } finally {
    await root.restore();
  }
});

Deno.test("rendered System selection and detail links follow the selected Request", () => {
  const board = watchBoard();
  const detail = detailOf({
    board,
    page: "explore",
    selected: COORDINATOR,
    sysml: false,
    version: HEAD,
    names: UNIT_NAMES,
  });
  for (const caseId of ["case-one", "case-two"]) {
    const html = tidy(
      renderToString(
        <ModelLinkContext.Provider
          value={`?caseBranch=${caseId}&agent=operator`}
        >
          <ExplorePage board={board} detail={detail} />
        </ModelLinkContext.Provider>,
      ),
    );
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((entry) =>
      entry[1]
    );
    ok(links.length > 1);
    match(html, /class="explore-card/);
    match(html, /class="detail-x"/);
    for (const href of links) {
      match(href, new RegExp(`caseBranch=${caseId}`));
      match(href, /agent=operator/);
    }
    doesNotMatch(
      html,
      new RegExp(
        `caseBranch=${caseId === "case-one" ? "case-two" : "case-one"}`,
      ),
    );
  }
});
