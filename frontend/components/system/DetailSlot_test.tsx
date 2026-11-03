import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { options } from "preact";
import { renderToString } from "preact-render-to-string";
import type {
  BoardItem,
  ModelBoard,
} from "../../../src/domain/model/records/board.ts";
import {
  board,
  COORDINATOR,
  HEAD,
  kitchenSink,
  link,
  linkedBoard,
  mandate,
  tool,
  unit,
  values,
  withLinks,
} from "../../test/support/board-fixture.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { detailOf } from "../../lib/system/board/detail.ts";
import { DetailPlace, DetailSlot, DetailUnderTitle } from "./DetailSlot.tsx";
import { DetailBox } from "./DetailBox.tsx";
import { ElementDetail } from "./ElementDetail.tsx";
import { tidy } from "../../test/support/markup.ts";

const OPERATOR = `${COORDINATOR}.operator`;

function detailFor(
  model: ModelBoard,
  selected: string | null,
  over: { sysml?: boolean; version?: string; page?: "team" | "explore" } = {},
) {
  return detailOf({
    board: model,
    page: over.page ?? "explore",
    selected,
    sysml: over.sysml ?? false,
    version: over.version,
    names: new Map([[COORDINATOR, "Coordinateur"]]),
  });
}

/** The detail of the element the address selects, wide, as a page under its title shows it. */
function shown(
  model: ModelBoard,
  selected: string,
  over: Parameters<typeof detailFor>[2] & { narrow?: boolean } = {},
) {
  const detail = detailFor(model, selected, over);
  ok(detail.selected, `${selected} is not on the board`);
  return tidy(renderToString(
    <ElementDetail
      element={detail.selected}
      detail={detail}
      narrow={over.narrow}
    />,
  ));
}

/** A model whose rules declare a mandate with every sort of value. */
function mandated(): ModelBoard {
  const held: BoardItem = {
    ...mandate(`${COORDINATOR}.mandate`, COORDINATOR, "Plan the work"),
    values: values({
      id: "commercial-watch-v1",
      version: 1,
      source: "host configuration",
      operatorName: "Coordinateur",
      scope: "Plan and merge",
      mayAdmit: true,
      mayInvokeActiveCatalog: false,
      maxAgentDecisions: 12,
      timeoutMs: 90_000,
      allowedHosts: ["a.org", "b.org"],
    }),
  };
  return withLinks(
    board({
      team: [unit({ id: COORDINATOR, title: "liveBuilder" })],
      cando: [tool(`${COORDINATOR}.read`, COORDINATOR, "read_web_page")],
      rules: [held],
    }),
    [
      link("bind", OPERATOR, held.id, { role: "mandate" }),
      link("can-call", OPERATOR, `${COORDINATOR}.read`),
    ],
  );
}

Deno.test("the detail tells what the element is, its name, the model's note on it, and what the model declares", () => {
  const html = shown(mandated(), `${COORDINATOR}.mandate`);
  match(
    html,
    /^<aside class="detail" aria-label="Detail" data-element="unit-coordinator\.mandate">/,
  );
  match(html, /<div class="kind-kw">mandate<\/div>/);
  match(html, /<h2 class="detail-title">Builder mandate<\/h2>/);
  match(html, /<p class="detail-sum" title="Plan the work">Plan the work<\/p>/);
  // Said in words: names as phrases, yes and no, a duration, a count, a list.
  const facts = html.match(/<dl class="detail-facts">(.*?)<\/dl>/s)![1];
  deepStrictEqual(
    [...facts.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((
      [, name, value],
    ) => [name, value]),
    [
      ["Scope", "Plan and merge"],
      ["May admit", "yes"],
      ["May invoke active catalog", "no"],
      ["Max agent decisions", "12"],
      ["Timeout", "1.5 min"],
      ["Allowed hosts", "a.org, b.org"],
    ],
  );
  // The identity and versioning of the declaration are the model's own business.
  doesNotMatch(
    facts,
    /commercial-watch-v1|host configuration|Version|Operator name/,
  );
  doesNotMatch(html, /detail-type|is-code/);
});

Deno.test("what the element is related to is grouped by what the relation says, each a link to the element", () => {
  const html = shown(mandated(), `${COORDINATOR}.mandate`);
  match(
    html,
    new RegExp(
      `<div data-relation="mandate of"><h5>mandate of</h5><div class="detail-chips"><a class="chip" href="/system\\?page=parts&amp;select=${
        OPERATOR.replace(".", "\\.")
      }" title="Parts">Builder</a></div></div>`,
    ),
  );
  // A relation leads to the page that is the element's home: an operator to
  // Parts, a unit to Team.
  const unitHtml = shown(mandated(), COORDINATOR);
  match(unitHtml, /<h5>holds mandate<\/h5>/);
  match(unitHtml, /<h5>may call<\/h5>/);
  match(
    unitHtml,
    new RegExp(
      `<a class="chip" href="[^"]*select=${COORDINATOR}\\.read"[^>]*>Read web page</a>`,
    ),
  );
  // Nothing related, nothing said.
  doesNotMatch(
    shown(board({ cando: [tool("t", "u", "t")] }), "t"),
    /detail-rel/,
  );
});

Deno.test("the first three groups are listed and the others open under a 'more', no script needed", () => {
  const many = withLinks(
    board({
      team: [unit({ id: "u", title: "u" })],
      cando: [tool("t1", "u", "one"), tool("t2", "u", "two")],
    }),
    [
      link("allocate", "t1", "u.operator"),
      link("connect", "t1", "u.sandbox"),
      link("bind", "t1", "u.catalog", { role: "mandate" }),
      link("can-call", "u.operator", "t1"),
    ],
  );
  const html = shown(many, "t1");
  equal((html.match(/<h5>/g) ?? []).length, 4);
  match(
    html,
    /<details class="detail-more"><summary class="chip">1 more<\/summary><div data-relation="callable by">/,
  );
  // The first groups are outside it.
  const outside = html.slice(0, html.indexOf("<details"));
  equal((outside.match(/<h5>/g) ?? []).length, 3);
  // With three or fewer there is nothing to open.
  doesNotMatch(shown(mandated(), `${COORDINATOR}.read`), /<details/);
});

Deno.test("a group that names more than eight elements says how many it does not list", () => {
  const tools = Array.from(
    { length: 11 },
    (_, n) => tool(`t${n}`, "u", `tool${n}`),
  );
  const model = withLinks(
    board({ team: [unit({ id: "u", title: "u" })], cando: tools }),
    tools.map((one) => link("can-call", "u.operator", one.id)),
  );
  const html = shown(model, "u");
  equal((html.match(/<a class="chip"/g) ?? []).length, 8);
  match(html, /<span class="faint">\+3<\/span>/);
});

Deno.test("twins that read alike are one chip in a group, the first of them; the count of the others follows the chips", () => {
  // The same tool declared in two units: two elements, one name.
  const tools = [
    tool("t1", "u1", "read"),
    tool("t2", "u2", "read"),
    tool("t3", "u1", "write"),
  ];
  const model = withLinks(
    board({
      team: [unit({ id: "u1", title: "u1" }), unit({ id: "u2", title: "u2" })],
      cando: tools,
    }),
    tools.map((one) => link("can-call", "u1.operator", one.id)),
  );
  const html = shown(model, "u1");
  const chips = [
    ...html.matchAll(/<a class="chip" href="([^"]*)"[^>]*>(.*?)<\/a>/g),
  ]
    .map(([, href, name]) => [name, decodeURIComponent(href)]);
  deepStrictEqual(chips, [
    ["Read", "/system?page=explore&amp;select=t1"],
    ["Write", "/system?page=explore&amp;select=t3"],
  ]);
  // Ports of two parts are not twins: each is named by its part.
  const ported = withLinks(kitchenSink(), [link("connect", "p1", "flow")]);
  match(shown(ported, "flow"), />panel\.out<\/a>/);
  // Past eight names, "+N" counts names, not twins.
  const many = Array.from(
    { length: 10 },
    (_, n) => tool(`m${n}`, "u1", `tool${n % 9}`),
  );
  const crowded = withLinks(
    board({ team: [unit({ id: "u1", title: "u1" })], cando: many }),
    many.map((one) => link("can-call", "u1.operator", one.id)),
  );
  const crowd = shown(crowded, "u1");
  equal((crowd.match(/<a class="chip"/g) ?? []).length, 8);
  match(crowd, /<span class="faint">\+1<\/span>/);
});

Deno.test("a port is named by the part it belongs to", () => {
  const model = withLinks(kitchenSink(), [link("connect", "p1", "flow")]);
  const html = shown(model, "flow");
  match(html, />panel\.out<\/a>/);
});

Deno.test("a unit is told by the name the team gives it, and leads to its page", () => {
  const html = shown(mandated(), COORDINATOR);
  match(html, /<div class="kind-kw">system<\/div>/);
  match(html, /<h2 class="detail-title">Coordinateur<\/h2>/);
  // From Explore, a unit is at home on Team: the way there is an action.
  match(
    html,
    new RegExp(
      `<a class="chip is-action" href="/system\\?select=${COORDINATOR}" data-action="open"><svg [^>]*>.*?</svg>Team</a>`,
      "s",
    ),
  );
  // From Team itself there is nowhere else to go but the source.
  const onTeam = shown(mandated(), COORDINATOR, { page: "team" });
  doesNotMatch(onTeam, /data-action="open"/);
  // The model's note on its package describes the package, not this unit.
  const documented = board({
    team: [{
      ...unit({
        id: "u",
        title: "u",
        summary: "The whole package, described.",
      }),
      summarySource: "package-doc",
    }],
  });
  doesNotMatch(shown(documented, "u"), /detail-sum|The whole package/);
  // Any other note is the element's.
  const noted = board({
    team: [{
      ...unit({ id: "u", title: "u", summary: "What the unit does." }),
      summarySource: "type-doc",
    }],
  });
  match(
    shown(noted, "u"),
    /<p class="detail-sum" title="What the unit does\.">/,
  );
});

Deno.test("the source is the element's line in the model's files, at the version being read", () => {
  const html = shown(mandated(), `${COORDINATOR}.read`);
  match(
    html,
    /<div class="detail-actions"><a class="chip is-action" href="\/model\?page=files&amp;file=model\.sysml&amp;line=1" data-action="source"><svg [^>]*>.*?<\/svg>Source<\/a><\/div>/s,
  );
  doesNotMatch(html, /data-action="open"/);
  const pinned = shown(mandated(), `${COORDINATOR}.read`, { version: HEAD });
  match(
    pinned,
    new RegExp(
      `href="/model\\?page=files&amp;version=${
        encodeURIComponent(HEAD)
      }&amp;file=model\\.sysml&amp;line=1"`,
    ),
  );
  // An element the sources do not place has no source to go to, and no row of actions.
  const placed = mandated();
  const unplaced = {
    ...placed,
    columns: placed.columns.map((column) => ({
      ...column,
      items: column.items.map((entry) => ({ ...entry, file: "" })),
    })),
  };
  doesNotMatch(shown(unplaced, `${COORDINATOR}.read`), /detail-actions|Source/);
});

Deno.test("in SysML's words the detail gives the keyword, the type, how it is declared and every value as written", () => {
  const html = shown(mandated(), `${COORDINATOR}.mandate`, { sysml: true });
  match(html, /<div class="kind-kw">item<\/div>/);
  match(html, /<div class="detail-type">: ConfiguredMandate<\/div>/);
  match(html, /<dt>Source<\/dt><dd class="is-code">model\.sysml:1<\/dd>/);
  match(html, /<dt>id<\/dt><dd class="is-code">commercial-watch-v1<\/dd>/);
  match(html, /<dt>maxAgentDecisions<\/dt><dd class="is-code">12<\/dd>/);
  match(html, /<dt>mayAdmit<\/dt><dd class="is-code">true<\/dd>/);
  match(
    html,
    /<dt>allowedHosts<\/dt><dd class="is-code">\[&quot;a\.org&quot;,&quot;b\.org&quot;\]<\/dd>/,
  );
  // The unit is the identifier the model gives it, not the name the team goes by.
  const unitHtml = shown(mandated(), COORDINATOR, { sysml: true });
  match(unitHtml, /<h2 class="detail-title">liveBuilder<\/h2>/);
  match(unitHtml, /<div class="kind-kw">part<\/div>/);
});

Deno.test("in a column the detail is narrow: the card above says what it is, so it keeps to the summary and where to go", () => {
  const html = shown(mandated(), COORDINATOR, { narrow: true });
  match(html, /^<aside class="detail is-narrow" /);
  match(html, /<a class="detail-x"/);
  match(html, /data-action="open"/);
  match(html, /data-action="source"/);
  doesNotMatch(
    html,
    /kind-kw|detail-title|detail-facts|detail-rel|detail-type/,
  );
  const noted = board({
    cando: [{ ...tool("t", "u", "t", "What it does."), file: "a.sysml" }],
  });
  match(
    shown(noted, "t", { narrow: true }),
    /<p class="detail-sum" title="What it does\.">What it does\.<\/p>/,
  );
});

Deno.test("the cross is the link to the page with nothing chosen, and says Escape does the same", () => {
  const html = shown(mandated(), `${COORDINATOR}.read`);
  match(
    html,
    /<a class="detail-x" href="\/system\?page=explore" aria-label="Close" title="Close \(Esc\)">×<\/a>/,
  );
  const pinned = shown(mandated(), `${COORDINATOR}.read`, { version: HEAD });
  match(
    pinned,
    new RegExp(
      `<a class="detail-x" href="/system\\?page=explore&amp;version=${
        encodeURIComponent(HEAD)
      }"`,
    ),
  );
});

Deno.test("a slot shows the detail only after the element that carries the selection, and one at a time", () => {
  const detail = detailFor(linkedBoard(), `${COORDINATOR}.read`);
  const slot = (ids: readonly string[]) =>
    tidy(renderToString(<DetailSlot ids={ids} detail={detail} />));
  // A card that stands for several twins carries any of their ids.
  for (const ids of [[`${COORDINATOR}.read`], ["x", `${COORDINATOR}.read`]]) {
    match(slot(ids), /^<aside class="detail" /);
  }
  equal(slot([`${COORDINATOR}.outline`]), "");
  equal(slot([]), "");
  // Nothing selected, or a selection the board does not hold: nothing anywhere.
  for (const none of [null, "", "ghost"]) {
    const closed = detailFor(linkedBoard(), none);
    equal(
      renderToString(
        <DetailSlot ids={[`${COORDINATOR}.read`]} detail={closed} />,
      ),
      "",
    );
    equal(
      renderToString(<DetailUnderTitle detail={closed} carried={new Set()} />),
      "",
    );
  }
});

Deno.test("narrow is the slot's: the same element is wide where nothing narrows it", () => {
  const detail = detailFor(linkedBoard(), `${COORDINATOR}.read`);
  const ids = [`${COORDINATOR}.read`];
  match(
    renderToString(<DetailSlot ids={ids} detail={detail} narrow />),
    /^<aside class="detail is-narrow" /,
  );
  doesNotMatch(
    renderToString(<DetailSlot ids={ids} detail={detail} />),
    /is-narrow/,
  );
});

Deno.test("in a list the detail is an item of it; in a table, a row that spans the columns", () => {
  const detail = detailFor(linkedBoard(), `${COORDINATOR}.read`);
  const ids = [`${COORDINATOR}.read`];
  const item = tidy(
    renderToString(<DetailSlot ids={ids} detail={detail} as="li" />),
  );
  match(item, /^<li class="detail-item"><aside class="detail" /);
  ok(item.endsWith("</aside></li>"));
  const row = tidy(
    renderToString(<DetailSlot ids={ids} detail={detail} as="row" span={4} />),
  );
  match(
    row,
    /^<tr class="detail-row"><td colspan="4"><div class="detail-hold"><aside class="detail" /,
  );
  ok(row.endsWith("</aside></div></td></tr>"));
  // A slot with nothing to show leaves no empty item or row behind.
  equal(renderToString(<DetailSlot ids={["x"]} detail={detail} as="li" />), "");
  equal(
    renderToString(
      <DetailSlot ids={["x"]} detail={detail} as="row" span={4} />,
    ),
    "",
  );
});

Deno.test("a selection that nothing on the page carries opens under the title; one something carries does not", () => {
  const detail = detailFor(linkedBoard(), `${COORDINATOR}.promotion.step0`);
  const under = (carried: string[]) =>
    tidy(
      renderToString(
        <DetailUnderTitle detail={detail} carried={new Set(carried)} />,
      ),
    );
  match(
    under([`${COORDINATOR}.read`]),
    /^<aside class="detail" aria-label="Detail" data-element="unit-coordinator\.promotion\.step0">/,
  );
  equal(under([`${COORDINATOR}.promotion.step0`]), "");
});

Deno.test("Escape closes the detail by following its cross, once, and only while it is open", async () => {
  const probe = probeRoot();
  const registered = probe.windowListeners();
  const detail = detailFor(linkedBoard(), `${COORDINATOR}.read`);
  const crosses: { ref: { current: unknown }; href: unknown }[] = [];
  const before = options.vnode;
  options.vnode = (vnode) => {
    const props = vnode.props as Record<string, unknown>;
    if (vnode.type === "a" && props.class === "detail-x" && vnode.ref) {
      crosses.push({
        ref: vnode.ref as { current: unknown },
        href: props.href,
      });
    }
    before?.(vnode);
  };
  // The box every detail opens in holds the cross and the key (DetailBox).
  function Open() {
    DetailBox({
      closeHref: detail.closeHref,
      data: { "data-element": detail.selected!.id },
      children: null,
    });
    return null;
  }
  try {
    await probe.show(Open, {});
    equal(crosses.length, 1);
    equal(crosses[0].href, "/system?page=explore");
    let followed = 0;
    crosses[0].ref.current = { click: () => followed++ };
    equal(registered.length, 1);
    const key = (over: Record<string, unknown> = {}) => ({
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      target: { tagName: "BODY" },
      preventDefault() {},
      ...over,
    });
    registered[0].listener(key());
    equal(followed, 1, "Escape follows the cross");
    // Typing in a field is not closing the detail.
    registered[0].listener(key({ target: { tagName: "TEXTAREA" } }));
    registered[0].listener(key({ key: "Enter" }));
    equal(followed, 1);
    // Once the detail is gone Escape has nothing left to close.
    await probe.unmount();
    equal(registered.length, 0);
  } finally {
    options.vnode = before;
    await probe.restore();
  }
});

Deno.test("a page whose choice is not an element of the board draws its own detail where an element's would go: a row of a table, an item of a list, beside it", () => {
  const detail = detailFor(linkedBoard(), "owner|candidate.admit");
  // The board holds no such element: the choice is the page's own.
  equal(detail.selected, undefined);
  equal(detail.choice, "owner|candidate.admit");
  const box = (
    <DetailBox
      closeHref={detail.closeHref}
      data={{ "data-cell": "owner|candidate.admit" }}
    >
      <h2>Admit a tool</h2>
    </DetailBox>
  );
  const aside =
    '<aside class="detail" aria-label="Detail" data-cell="owner|candidate.admit"><a class="detail-x" href="/system?page=explore" aria-label="Close" title="Close (Esc)">×</a><h2>Admit a tool</h2></aside>';
  equal(
    tidy(renderToString(<DetailPlace as="row" span={3}>{box}</DetailPlace>)),
    `<tr class="detail-row"><td colspan="3"><div class="detail-hold">${aside}</div></td></tr>`,
  );
  equal(
    tidy(renderToString(<DetailPlace as="li">{box}</DetailPlace>)),
    `<li class="detail-item">${aside}</li>`,
  );
  equal(tidy(renderToString(<DetailPlace>{box}</DetailPlace>)), aside);
  // A slot, which looks for an element of the board, has nothing to open for it.
  equal(
    renderToString(
      <DetailSlot ids={["owner|candidate.admit"]} detail={detail} />,
    ),
    "",
  );
  // An element the board holds opens its own detail in its slot.
  const element = detailFor(linkedBoard(), `${COORDINATOR}.read`);
  match(
    renderToString(
      <DetailSlot ids={[`${COORDINATOR}.read`]} detail={element} />,
    ),
    /^<aside class="detail"/,
  );
});
