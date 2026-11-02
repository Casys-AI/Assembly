import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import {
  HEAD,
  initialBoard,
  LIVE_BUILDER,
} from "../../../test/support/board-fixture.ts";
import {
  BUILDER,
  legacy,
  OWNER,
  ownerModeled,
  ownerModeledBody,
  selfApprovingBody,
  UNIT,
  withCell,
} from "../../../test/support/matrix-fixture.ts";
import { asides, childrenOf } from "../../../test/support/markup.ts";
import {
  type PageOptions,
  renderSystemPage,
} from "../../../test/support/system-page.ts";
import {
  type AuthorityMatrix,
  parseMatrix,
} from "../../../lib/system/rights/api.ts";
import {
  mainActorOf,
  markKey,
  operatorActorOf,
  type ReferenceRights,
  rightsOf,
} from "../../../lib/system/rights/projection.ts";
import { keysGiven } from "../../../test/support/vnode-keys.ts";
import { FamilyDetail } from "./RightsDetail.tsx";
import { RightsPage } from "./RightsPage.tsx";

/** The unit of the initial model as the team calls it. */
const NAMES = new Map([[LIVE_BUILDER, "Builder"]]);

const rights = (
  matrix: AuthorityMatrix | undefined,
  over: PageOptions = {},
  main?: ReferenceRights,
  branches?: readonly ReferenceRights[],
) =>
  renderSystemPage(
    RightsPage,
    "rights",
    initialBoard(),
    { names: NAMES, ...over },
    { matrix, main, branches },
  );

const rowOf = (html: string, actor: string) =>
  html.match(new RegExp(`<tr data-actor="${actor}">.*?</tr>`, "s"))?.[0];

/** The cells of a row, each as the mark it holds: a dot of the matrix (`allowed`, `propose`, `denied`), `lock`, or nothing. */
function marksOf(html: string, actor: string): string[] {
  return marksIn(rowOf(html, actor)!);
}

function marksIn(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell]) =>
    cell.includes('<svg viewBox="0 0 24 24" class="ic faint"')
      ? "lock"
      : cell.match(/<span class="dot ([^"]+)"/)?.[1] ?? ""
  );
}

/** The global Main beside a Case's rights, read from `matrix` as the main system's. */
function mainOf(matrix: AuthorityMatrix | undefined): ReferenceRights {
  const main = rightsOf(matrix, []);
  return {
    rights: main,
    actor: mainActorOf(main, BUILDER),
    href: "/system?page=rights",
    initials: "MO",
    about: "Its rights on the main system",
  };
}

/** The main system's matrix where the Main may no longer invoke tools. */
const mainWithoutInvoke = () =>
  parseMatrix(
    withCell(ownerModeledBody(), BUILDER, "tool.invoke", {
      state: "denied",
      display: "denied",
    }),
  );

/** The dots of a matrix line, by column. */
const dotsIn = (row: string) =>
  [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell]) =>
    cell.match(/<span class="dot ([^"]+)"/)?.[1] ?? ""
  );

const MAIN_ROW = /<tr class="is-main" data-actor="main-operator">.*?<\/tr>/s;

const header = (html: string) =>
  html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));

Deno.test("the actors are the rows, you first; the families of rights are the columns, each with its mark and a short name", () => {
  const html = rights(ownerModeled());
  deepStrictEqual(
    [...html.matchAll(/<tr data-actor="([^"]+)">/g)].map(([, id]) => id),
    ["you", BUILDER],
  );
  match(rowOf(html, "you")!, /<\/span>You<\/th>/);
  match(rowOf(html, BUILDER)!, /<\/span>Builder<\/th>/);
  match(rowOf(html, "you")!, /<span class="mini you">/);
  deepStrictEqual(
    [
      ...header(html).matchAll(
        /<th scope="col" title="([^"]+)">.*?<span>([^<]+)<\/span>/gs,
      ),
    ]
      .map(([, family, short]) => [family, short]),
    [
      ["Tools", "Tools"],
      ["Admission", "Approve"],
      ["Mandate &amp; operators", "Mandate"],
      ["Model", "Model"],
      ["Memory &amp; skills", "Memory"],
    ],
  );
  // The family of exposed behaviors holds no right for anyone here: no column.
  doesNotMatch(html, /Exposed behaviors|Work/);
});

Deno.test("in a Case, the global Main's rights on the main system follow you, linked to the main system, and open nothing here", () => {
  const html = rights(ownerModeled(), {}, mainOf(ownerModeled()));
  deepStrictEqual(
    [...html.matchAll(/data-actor="([^"]+)"/g)].map(([, id]) => id),
    ["you", "main-operator", BUILDER],
  );
  const row = html.match(MAIN_ROW)![0];
  match(row, /<a href="\/system\?page=rights"[^>]*>Main Operator<\/a>/);
  // Its marks are the main system's, under the Case's families.
  deepStrictEqual(marksIn(row), marksOf(html, BUILDER));
  doesNotMatch(row, /data-mark|mark-link/);
  // Outside a Case there is no such line.
  doesNotMatch(rights(ownerModeled()), /main-operator/);

  // While its rights are read, or when they cannot be, the line stays, empty,
  // and its link says why.
  const unread = rights(ownerModeled(), {}, {
    ...mainOf(undefined),
    problem: "Its rights on the main system could not be read",
  }).match(MAIN_ROW)![0];
  ok(marksIn(unread).every((mark) => mark === ""));
  match(unread, /title="Its rights on the main system could not be read"/);

  // In SysML's words, its line follows yours, with the main system's dots,
  // which open nothing.
  const matrix = rights(
    ownerModeled(),
    { sysml: true },
    mainOf(mainWithoutInvoke()),
  );
  const order = [...matrix.matchAll(/<tr[^>]* data-row="([^"]+)"/g)]
    .map(([, id]) => id);
  equal(order.indexOf("main-operator"), order.indexOf(BUILDER) - 1);
  ok(order.indexOf(OWNER) < order.indexOf("main-operator"));
  const mainLine = matrix.match(/<tr class="is-main"[^>]*>.*?<\/tr>/s)![0];
  const caseLine = matrix.match(
    new RegExp(`<tr data-row="${BUILDER}"[^>]*>.*?</tr>`, "s"),
  )![0];
  doesNotMatch(mainLine, /matrix-cell/);
  const mainDots = dotsIn(mainLine), caseDots = dotsIn(caseLine);
  equal(mainDots.length, caseDots.length);
  const changed = mainDots.flatMap((dot, at) =>
    dot === caseDots[at] ? [] : [[caseDots[at], dot]]
  );
  // The Case may invoke tools (of no use yet); the Main may not.
  deepStrictEqual(changed, [["allowed is-unusable", "denied"]]);
});

Deno.test("on the main system, each open Case's Branch Operator closes the table with its initials and its rights in its branch", () => {
  const branch = (caseId: string, title: string, matrix?: AuthorityMatrix) => {
    const own = rightsOf(matrix, []);
    return {
      rights: own,
      actor: operatorActorOf(own, BUILDER, {
        id: `branch:${caseId}`,
        label: title,
      }),
      href: `/system?page=rights&caseBranch=${caseId}`,
      initials: title.slice(0, 2).toUpperCase(),
      about: "Branch Operator · its rights in its branch",
    };
  };
  const html = rights(ownerModeled(), {}, undefined, [
    branch("a", "Qualification", mainWithoutInvoke()),
    branch("b", "Release check"),
  ]);
  deepStrictEqual(
    [...html.matchAll(/data-actor="([^"]+)"/g)].map(([, id]) => id),
    ["you", BUILDER, "branch:a", "branch:b"],
  );
  const a = html.match(
    /<tr class="is-main" data-actor="branch:a">.*?<\/tr>/s,
  )![0];
  match(a, /<span class="mini" aria-hidden="true">QU<\/span>/);
  match(
    a,
    /<a href="\/system\?page=rights&amp;caseBranch=a"[^>]*>Qualification<\/a>/,
  );
  // Its marks are its branch's own: here it may not invoke tools.
  ok(marksIn(a).some((mark) => mark !== ""));
  // A branch whose rights are still read has its line, empty.
  const b = html.match(
    /<tr class="is-main" data-actor="branch:b">.*?<\/tr>/s,
  )![0];
  ok(marksIn(b).every((mark) => mark === ""));
});

Deno.test("the global Main is the Case's operator in the main matrix: a reviewer of the same unit is not the Main", () => {
  const body = ownerModeledBody();
  const reviewer = {
    ...body.rows.find((row) => row.id === BUILDER)!,
    id: "reviewer-op",
    role: "reviewer" as const,
    label: `${UNIT}::reviewer`,
  };
  const main = rightsOf(
    parseMatrix(
      withCell(
        { ...body, rows: [...body.rows, reviewer] },
        "reviewer-op",
        "candidate.review",
        { state: "allowed" },
      ),
    ),
    [],
  );
  deepStrictEqual(mainActorOf(main, BUILDER).rows.map((row) => row.id), [
    BUILDER,
  ]);
  deepStrictEqual(mainActorOf(main, "other-op").rows, []);
});

Deno.test("a mark is what the actor holds in the family: alone, a proposal, a lock for what is never given, an empty ring for the rest", () => {
  const html = rights(ownerModeled());
  // You: nothing in tools, mandate or memory (not an empty ring: no mark).
  deepStrictEqual(marksOf(html, "you"), ["", "allowed", "", "allowed", ""]);
  // Builder: it proposes tools, is refused admission, never rewrites its mandate.
  deepStrictEqual(marksOf(html, BUILDER), [
    "propose",
    "denied",
    "lock",
    "allowed",
    "allowed",
  ]);
});

Deno.test("allowed and of no use is not full: a granted right with nothing to act on is a warm ring, and says so", () => {
  // Nothing else in tools: the only right the builder is granted there is of no use.
  const body = withCell(
    ownerModeledBody(),
    BUILDER,
    "tool.build:read_web_page",
    { state: "denied", display: "denied", mode: undefined, codes: [] },
  );
  const html = rights(parseMatrix(body), {
    selected: markKey(BUILDER, "tools"),
  });
  equal(marksOf(html, BUILDER)[0], "denied is-unusable");
  match(
    rowOf(html, BUILDER)!,
    /aria-label="Builder, Tools: granted, unusable"/,
  );
  // The line says why, in words.
  match(
    html,
    /<li title="[^"]*" data-column="tool\.invoke"><span class="dot denied is-unusable"><\/span><span>Use active tools<\/span><span class="faint">nothing to act on<\/span><\/li>/,
  );
});

Deno.test("each mark has its tooltip: the rights of the family one by one, and what the actor holds of each", () => {
  const html = rights(ownerModeled());
  const title = (actor: string, family: string) =>
    rowOf(html, actor)!.match(
      new RegExp(`title="([^"]*)"[^>]*data-mark="${actor}\\|${family}"`),
    )?.[1];
  equal(
    title(BUILDER, "tools"),
    [
      "Build tool · read_web_page: proposes",
      "Use active tools: granted, unusable",
      "Reach network hosts: no",
    ].join("\n"),
  );
  equal(
    title(BUILDER, "mandate"),
    [
      "Rewrite own mandate directly: never",
      "Create operators directly: never",
    ].join("\n"),
  );
  equal(
    title("you", "admission"),
    [
      "Review a tested tool: yes",
      "Admit a tool: yes",
    ].join("\n"),
  );
  match(
    rowOf(html, BUILDER)!,
    /aria-label="Builder, Mandate &amp; operators: never"/,
  );
});

Deno.test("an operator that approves its own tools with no one to review them is flagged where it builds and approves", () => {
  const html = rights(parseMatrix(selfApprovingBody()));
  const flags = (actor: string) =>
    [...rowOf(html, actor)!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((
      [, cell],
    ) => cell.includes('class="flag"'));
  // Tools and admission only.
  deepStrictEqual(flags(BUILDER), [true, true, false, false, false]);
  deepStrictEqual(flags("you"), [false, false, false, false, false]);
  match(
    html,
    /<span class="flag" role="img" aria-label="Approves its own tools; no operator may review them" title="Approves its own tools; no operator may review them">/,
  );
  // The legend names the flag when there is one to name.
  match(
    html,
    /<span class="flag" aria-hidden="true"><\/span>approves its own tools<\/span>/,
  );
  // With the owner reviewing, or a person admitting, nothing is flagged.
  doesNotMatch(rights(ownerModeled()), /class="flag"|approves its own tools/);
  doesNotMatch(rights(legacy()), /class="flag"|approves its own tools/);
});

Deno.test("the flag is said again in the detail of the family it flags", () => {
  const html = rights(parseMatrix(selfApprovingBody()), {
    selected: markKey(BUILDER, "admission"),
  });
  match(
    html,
    /<p class="detail-sum rights-flag">Approves its own tools; no operator may review them<\/p>/,
  );
  doesNotMatch(
    rights(parseMatrix(selfApprovingBody()), {
      selected: markKey(BUILDER, "model"),
    }),
    /rights-flag/,
  );
});

Deno.test("without the matrix yet the actors are there with nothing in their lines, and nothing is drawn that needs it", () => {
  const html = rights(undefined);
  deepStrictEqual(
    [...html.matchAll(/<tr data-actor="([^"]+)">/g)].map(([, id]) => id),
    ["you", "ASELiveBuilder::liveBuilder"],
  );
  match(rowOf(html, "you")!, /<\/span>You<\/th>/);
  match(rowOf(html, "ASELiveBuilder::liveBuilder")!, /<\/span>Builder<\/th>/);
  // No family, no mark, no legend, no detail: and no exception.
  equal(header(html), "<thead><tr><th></th></tr>");
  doesNotMatch(html, /<td|<a |class="legend"|<aside/);
  // Choosing something that is not there opens nothing.
  const asked = rights(undefined, { selected: markKey("you", "tools") });
  equal(asides(asked), 0);
});

Deno.test("the page says which version the rights are of, the one shown above, not the proposals waiting, whether it is read or not; the rest is in the legend's tooltip", () => {
  const said =
    /<p class="rights-caveats">These are the rights of the version shown above, as its sources declare them; proposals waiting for a decision are not counted\.<\/p>/;
  match(rights(ownerModeled()), said);
  match(rights(undefined), said);
  // Not a word of "in service": that is another act than adopting.
  doesNotMatch(rights(ownerModeled()), /in service/);
  // The host's other caveats follow, in the page's words, in the legend's tooltip, not on the page.
  const html = rights(ownerModeled());
  equal([...html.matchAll(/class="rights-caveats"/g)].length, 1);
  match(
    html,
    /<div class="legend" title="Allowed means declared: every action still passes the host's checks when it is done\.\nA blank cell means nothing declares a right there\.">/,
  );
  doesNotMatch(html, /<(p|li)[^>]*>[^<]*Allowed means declared/);
  // Nothing more to say, no tooltip.
  doesNotMatch(
    rights(
      parseMatrix({ ...ownerModeledBody(), caveats: ["ADOPTED_VERSION_ONLY"] }),
    ),
    /class="legend" title/,
  );
});

Deno.test("choosing a mark opens its family in a row under the actor, as wide as the table's container; choosing it again closes it", () => {
  const key = markKey(BUILDER, "tools");
  const html = rights(ownerModeled(), { selected: key });
  equal(asides(html), 1);
  match(
    html,
    new RegExp(
      `<tr data-actor="${BUILDER}">.*?</tr><tr class="detail-row"><td colspan="6"><div class="detail-hold"><aside class="detail" aria-label="Detail" data-mark="${BUILDER}\\|tools">`,
      "s",
    ),
  );
  match(
    html,
    /<div class="kind-kw">Tools<\/div><h2 class="detail-title">Builder<\/h2>/,
  );
  // The rights of the family, in the matrix's order, with a mark each.
  deepStrictEqual(
    [...html.matchAll(/data-column="([^"]+)"><span class="dot ([^"]+)"/g)].map((
      [, column, mark],
    ) => [column, mark]),
    [
      ["tool.build:read_web_page", "propose"],
      ["tool.invoke", "denied is-unusable"],
      ["network.reach", "denied"],
    ],
  );
  // The table is in the container the detail measures itself against.
  match(
    html,
    /<div class="detail-table"><div class="matrix-scroll"><table class="glance">/,
  );
  for (const children of childrenOf(html, "tbody")) {
    ok(children.every((tag) => tag === "tr"), `${children}`);
  }
  // The mark is the one chosen: choosing it again closes the detail.
  match(
    rowOf(html, BUILDER)!,
    /href="\/system\?page=rights" title="[^"]*" aria-label="[^"]*" aria-current="true" data-mark="[^"]+\|tools"/,
  );
  // Another actor's mark replaces it: one at a time.
  const other = rights(ownerModeled(), { selected: markKey("you", "model") });
  equal(asides(other), 1);
  match(other, /<tr data-actor="you">.*?<\/tr><tr class="detail-row">/s);
  doesNotMatch(other, /<aside[^>]*data-mark="[^"]+\|tools"/);
});

Deno.test("the detail of what you hold lists the rights of the family of every row of yours", () => {
  const html = rights(ownerModeled(), {
    selected: markKey("you", "admission"),
  });
  match(html, /<h2 class="detail-title">You<\/h2>/);
  deepStrictEqual(
    [...html.matchAll(/data-column="([^"]+)"><span class="dot ([^"]+)"/g)].map((
      [, column, mark],
    ) => [column, mark]),
    [["candidate.review", "allowed"], ["candidate.admit", "allowed"]],
  );
});

Deno.test("the owner an older model leaves implicit is you all the same", () => {
  const html = rights(legacy());
  deepStrictEqual(marksOf(html, "you"), ["", "allowed", "", "", ""]);
  match(html, /<tr data-actor="you">/);
});

Deno.test("in SysML's words the page is the whole matrix", () => {
  const html = rights(ownerModeled(), { sysml: true });
  match(html, /<table class="matrix rights-matrix">/);
  doesNotMatch(html, /class="glance"/);
  // But not before it is read.
  const unread = rights(undefined, { sysml: true });
  match(unread, /class="glance"/);
  doesNotMatch(unread, /rights-matrix/);
});

Deno.test("the version being read is kept by every link of the page", () => {
  const html = rights(ownerModeled(), { version: HEAD });
  const hrefs = [...html.matchAll(/ href="([^"]*)"/g)].map(([, href]) => href);
  ok(hrefs.length > 0);
  for (const href of hrefs) {
    match(href, new RegExp(`version=${encodeURIComponent(HEAD)}`));
  }
  const open = rights(ownerModeled(), {
    version: HEAD,
    selected: markKey(BUILDER, "tools"),
  });
  match(open, /class="detail-x" href="\/system\?page=rights&amp;version=/);
});

Deno.test("a family, a state or a code the host adds is drawn without an error: the family by its own name, the state as it is", () => {
  const body = withCell(ownerModeledBody(), BUILDER, "ledger.read", {
    state: "frozen",
    codes: ["BRAND_NEW_CODE"],
  });
  const html = rights(
    parseMatrix({
      ...body,
      groups: [...body.groups, { id: "ledger", label: "Ledger", order: 7 }],
      columns: [
        ...body.columns,
        {
          id: "ledger.read",
          group: "ledger",
          label: "Read the ledger",
          mode: "execute",
          order: 2000,
        },
      ],
    }),
    { selected: markKey(BUILDER, "ledger") },
  );
  // Its heading is its name; it has no mark of its own, and its rights are told as they are.
  match(html, /<th scope="col" title="Ledger"><span>Ledger<\/span><\/th>/);
  equal(marksOf(html, BUILDER).at(-1), "denied");
  match(html, /aria-label="Builder, Ledger: frozen"/);
  match(
    html,
    /data-column="ledger\.read"><span class="dot denied"><\/span><span>Read the ledger<\/span><span class="faint">frozen<\/span>/,
  );
});

Deno.test("an actor is the team's name for its unit, or the unit's own name; the owner is you in a unit", () => {
  // The roster knows no name for this unit: it keeps its identifier.
  const html = rights(ownerModeled(), { names: new Map() });
  match(rowOf(html, BUILDER)!, /<\/span>liveBuilder<\/th>/);
  match(rowOf(html, "you")!, /<\/span>You<\/th>/);
  equal(OWNER, "owner@ASELiveBuilder::liveBuilder");
});

Deno.test("choosing a mark the actor does not hold opens nothing: no box with no right in it", () => {
  // You hold nothing in tools; the link of that mark is not drawn either.
  const html = rights(ownerModeled(), { selected: markKey("you", "tools") });
  equal(asides(html), 0);
  doesNotMatch(html, /data-mark="you\|tools"/);
  doesNotMatch(html, /class="detail-row"/);
  // A pair no actor or no family of the matrix has opens nothing either.
  equal(
    asides(rights(ownerModeled(), { selected: markKey("nobody", "tools") })),
    0,
  );
  equal(
    asides(rights(ownerModeled(), { selected: markKey("you", "ledger") })),
    0,
  );
});

Deno.test("a family nobody holds a right in is not drawn, even when the matrix has columns for it", () => {
  const body = ownerModeledBody();
  // The family of exposed behaviors has a column here, and no cell for anyone.
  const html = rights(
    parseMatrix({
      ...body,
      columns: [...body.columns, {
        id: "behavior:inbox@ASELiveBuilder::liveBuilder",
        kind: "behavior",
        group: "behaviors",
        label: "Hand over work",
        mode: "execute",
        order: 900,
        target: {
          kind: "entry-kind",
          ref: "inbox",
          unit: "ASELiveBuilder::liveBuilder",
        },
      }],
    }),
  );
  doesNotMatch(html, /Work|Exposed behaviors/);
  equal(
    [...header(html).matchAll(/<th scope="col"/g)].length,
    5,
  );
});

Deno.test("each family is drawn in a box of its own: choosing another mark of the same actor does not keep the first one's box", () => {
  const keys = (selected: string) =>
    keysGiven(FamilyDetail, () => rights(ownerModeled(), { selected }));
  deepStrictEqual(keys(markKey(BUILDER, "tools")), [markKey(BUILDER, "tools")]);
  deepStrictEqual(keys(markKey(BUILDER, "model")), [markKey(BUILDER, "model")]);
  deepStrictEqual(keys(markKey("you", "tools")), []);
});
