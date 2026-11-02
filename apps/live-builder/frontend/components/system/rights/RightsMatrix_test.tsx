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
import { cellKey } from "../../../lib/system/rights/projection.ts";
import { keysGiven } from "../../../test/support/vnode-keys.ts";
import { CellDetail } from "./RightsDetail.tsx";
import { RightsPage } from "./RightsPage.tsx";

/** The unit of the initial model as the team calls it; SysML's words use its identifier. */
const NAMES = new Map([[LIVE_BUILDER, "Builder"]]);

const matrix = (
  model: AuthorityMatrix | undefined,
  over: PageOptions = {},
) =>
  renderSystemPage(
    RightsPage,
    "rights",
    initialBoard(),
    { names: NAMES, sysml: true, ...over },
    { matrix: model },
  );

const rowOf = (html: string, row: string) =>
  html.match(new RegExp(`<tr data-row="${row}"[^>]*>.*?</tr>`, "s"))?.[0];

/** The dot of each cell of a row, by the column it is in: `allowed`, `propose`... or nothing. */
function dots(html: string, row: string): [string, string][] {
  return [...rowOf(html, row)!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((
    [, cell],
  ) => cell).flatMap((cell) => {
    const column = cell.match(/data-column="([^"]+)"/)?.[1];
    return column
      ? [[column, cell.match(/<span class="dot ([^"]+)">/)![1]] as [
        string,
        string,
      ]]
      : [];
  });
}

const cell = cellKey(OWNER, "candidate.admit");

Deno.test("the matrix scrolls in the container the detail measures itself against; the families head the columns, each over its own, the rights written upright", () => {
  const html = matrix(ownerModeled());
  match(
    html,
    /<div class="detail-table"><div class="matrix-scroll"><table class="matrix rights-matrix">/,
  );
  deepStrictEqual(
    [...html.matchAll(/<th colspan="(\d+)" scope="colgroup">([^<]+)<\/th>/g)]
      .map(([, span, label]) => [Number(span), label]),
    [
      [3, "Tools"],
      [2, "Admission"],
      [2, "Mandate &amp; operators"],
      [3, "Model"],
      [1, "Memory &amp; skills"],
    ],
  );
  // The matrix's own words, with what the right is in the tooltip.
  deepStrictEqual(
    [...html.matchAll(
      /<th class="vert" scope="col" title="([^"]*)"><span>([^<]+)<\/span>/g,
    )]
      .map(([, , label]) => label),
    [
      "Build tool · read_web_page",
      "Use active tools",
      "Reach network hosts",
      "Review a tested tool",
      "Admit a tool",
      "Rewrite own mandate directly",
      "Create operators directly",
      "Read the model sources",
      "Propose model edits",
      "Accept a model revision",
      "Memory · capture",
    ],
  );
  match(html, /title="What &quot;Admit a tool&quot; lets one do\."/);
  // Rows of a table are the children of its body.
  for (const children of childrenOf(html, "tbody")) {
    ok(children.every((tag) => tag === "tr"), `${children}`);
  }
  for (const children of childrenOf(html, "tr")) {
    ok(children.every((tag) => tag === "th" || tag === "td"), `${children}`);
  }
});

Deno.test("the rows are you first, then the operators, as the model names them; the columns of a family begin with a line", () => {
  const html = matrix(ownerModeled());
  deepStrictEqual(
    [...html.matchAll(/<tr data-row="([^"]+)"/g)].map(([, row]) => row),
    [OWNER, BUILDER],
  );
  // SysML's words: the unit by its identifier.
  match(
    rowOf(html, OWNER)!,
    /<th scope="row" title="owner">You · in liveBuilder<\/th>/,
  );
  match(
    rowOf(html, BUILDER)!,
    /<th scope="row" title="ASELiveBuilder::liveBuilder::builder">builder · liveBuilder<\/th>/,
  );
  deepStrictEqual(
    [...rowOf(html, BUILDER)!.matchAll(/<td( class="g0")?/g)].map(([, start]) =>
      Boolean(start)
    ),
    [
      true,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ],
  );
});

Deno.test("a dot says what the model gives: alone, a proposal, inherited, not given; a right granted to no use is ringed warm", () => {
  const body = withCell(ownerModeledBody(), BUILDER, "model.consult", {
    state: "inherited",
    display: "allowed",
  });
  const html = matrix(parseMatrix(body));
  deepStrictEqual(dots(html, BUILDER), [
    ["tool.build:read_web_page", "propose"],
    ["tool.invoke", "allowed is-unusable"],
    ["network.reach", "denied"],
    ["candidate.review", "denied"],
    ["candidate.admit", "denied"],
    ["mandate.rewrite", "denied"],
    ["operator.spawn", "denied"],
    ["model.consult", "inherited"],
    ["model.edit", "propose"],
    ["model.decide", "denied"],
    ["behavior:memory-capture@ASELiveBuilder::liveBuilder", "allowed"],
  ]);
  // The owner holds three cells; the others are blank, not a refusal.
  deepStrictEqual(dots(html, OWNER).map(([column]) => column), [
    "candidate.review",
    "candidate.admit",
    "model.decide",
  ]);
  // Each dot says its state, to a reader that does not see it.
  match(
    html,
    /aria-label="builder · liveBuilder, Use active tools: allowed \(of no use\)"/,
  );
  match(html, /aria-label="You · in liveBuilder, Admit a tool: allowed"/);
});

Deno.test("the legend names each dot", () => {
  const legend =
    matrix(ownerModeled()).match(/<div class="legend"[^>]*>(.*?)<\/div>/s)![1];
  deepStrictEqual(
    [...legend.matchAll(/<span class="dot ([^"]+)"><\/span>([^<]+)<\/span>/g)]
      .map(([, dot, words]) => [dot, words]),
    [
      ["allowed", "allowed"],
      ["propose", "can propose, a decision follows"],
      ["inherited", "inherited"],
      ["denied", "not allowed"],
      ["allowed is-unusable", "allowed, of no use"],
    ],
  );
});

Deno.test("choosing a cell opens its detail in a row under the line, over every column; choosing it again closes it", () => {
  const html = matrix(ownerModeled(), { selected: cell });
  equal(asides(html), 1);
  match(
    html,
    new RegExp(
      `<tr data-row="${OWNER}" class="is-selected">.*?</tr><tr class="detail-row"><td colspan="12"><div class="detail-hold"><aside class="detail" aria-label="Detail" data-cell="${OWNER}\\|candidate.admit">`,
      "s",
    ),
  );
  // Only the cell chosen is lit, and it closes the detail.
  deepStrictEqual(
    [...html.matchAll(/<td class="([^"]*is-selected[^"]*)">/g)].map(([, one]) =>
      one
    ),
    ["is-selected"],
  );
  match(
    rowOf(html, OWNER)!,
    /href="\/system\?page=rights" aria-label="You · in liveBuilder, Admit a tool: allowed" aria-current="true"/,
  );
  // Another cell's detail replaces it: one at a time, under its own line.
  const other = matrix(ownerModeled(), {
    selected: cellKey(BUILDER, "model.edit"),
  });
  equal(asides(other), 1);
  match(
    other,
    /<tr data-row="8605dd44-[^"]+" class="is-selected">.*?<\/tr><tr class="detail-row">/s,
  );
  // A cell the matrix does not have opens nothing.
  equal(
    asides(matrix(ownerModeled(), { selected: cellKey(OWNER, "tool.invoke") })),
    0,
  );
  equal(asides(matrix(ownerModeled(), { selected: "nothing" })), 0);
});

Deno.test("the detail tells the state, its basis, the rule and where the host applies it, the codes, and what the right is", () => {
  const html = matrix(ownerModeled(), { selected: cell });
  const detail = html.match(/<aside class="detail".*?<\/aside>/s)![0];
  match(detail, /<div class="kind-kw">Admission<\/div>/);
  match(detail, /<h2 class="detail-title">Admit a tool<\/h2>/);
  match(detail, /<div class="detail-type">You · in liveBuilder<\/div>/);
  deepStrictEqual(
    [...detail.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>(.*?)<\/dd>/gs)].map((
      [, name, value],
    ) => [name, value.replace(/<[^>]+>/g, "")]),
    [
      ["State", "allowed · admit"],
      ["Basis", "host-rule"],
      ["Rule", "human-decides-candidate-admission-when-admissionMode-is-human"],
      ["Applied at", "humanAdmission"],
      ["Codes", "OWNER_ROOT_GRANT_UNDIFFERENTIATED"],
    ],
  );
  // A code the page has a phrase for says it on hover.
  match(
    detail,
    /<span data-code="OWNER_ROOT_GRANT_UNDIFFERENTIATED" title="the owner holds one grant for everything"><code>/,
  );
  match(
    detail,
    /<p class="detail-sum" title="What &quot;Admit a tool&quot; lets one do\.">/,
  );
});

Deno.test("Declared by points at the files of the model, at the line, one link for each place the cell is declared", () => {
  const html = matrix(ownerModeled(), { selected: cell });
  const declared = html.match(/<h5>Declared by<\/h5>(.*?)<\/aside>/s)![1];
  deepStrictEqual(
    [...declared.matchAll(
      /<a class="chip is-source" href="([^"]+)" title="([^"]+)" data-action="source">.*?<span class="faint">([^<]+)<\/span>/gs,
    )]
      .map(([, href, qname, place]) => [href, qname, place]),
    [
      [
        "/model?page=files&amp;file=configuration.sysml&amp;line=293",
        "ASELiveBuilder::liveBuilder::owner::ownerMandate::rootGrant",
        "configuration.sysml:293",
      ],
      [
        "/model?page=files&amp;file=configuration.sysml&amp;line=287",
        "ASELiveBuilder::liveBuilder::owner::ownerMandate",
        "configuration.sysml:287",
      ],
      [
        "/model?page=files&amp;file=configuration.sysml&amp;line=284",
        "ASELiveBuilder::liveBuilder::admissionMode",
        "configuration.sysml:284",
      ],
    ],
  );
  // Each chip names the element by its last two names.
  match(declared, /<\/svg>ownerMandate::rootGrant<span class="faint">/);
  // Read at a version, the file is read at that version.
  const pinned = matrix(ownerModeled(), { selected: cell, version: HEAD });
  match(
    pinned,
    new RegExp(
      `href="/model\\?page=files&amp;version=${
        encodeURIComponent(HEAD)
      }&amp;file=configuration.sysml&amp;line=293"`,
    ),
  );
  // A cell declared nowhere in a file has nothing to point at.
  const bare = matrix(ownerModeled(), {
    selected: cellKey(BUILDER, "network.reach"),
  });
  equal(asides(bare), 1);
  doesNotMatch(bare, /Declared by/);
});

Deno.test("the owner an older model leaves implicit is told by the host's rule, declared by the one line that sets the mode", () => {
  const html = matrix(legacy(), { selected: cell });
  const detail = html.match(/<aside class="detail".*?<\/aside>/s)![0];
  match(detail, /<dd>host-rule<\/dd>/);
  match(detail, /<code>OWNER_IMPLICIT<\/code>/);
  deepStrictEqual(
    [...detail.matchAll(/class="faint">([^<]*:[0-9]+)</g)].map(([, place]) =>
      place
    ),
    ["configuration.sysml:283"],
  );
});

Deno.test("a state or a code the host adds is shown as it is, not an error: the dot looks as the host says, the code has no phrase", () => {
  const body = withCell(ownerModeledBody(), BUILDER, "tool.invoke", {
    state: "frozen",
    display: "denied",
    basis: "negotiated",
    codes: ["BRAND_NEW_CODE", "RIGHT_WITHOUT_OBJECT"],
    via: { kind: "telepathy" },
    uncertain: { code: "NOT_FROM_COMPILER", reason: "Read from the fallback." },
  });
  const page = parseMatrix(body);
  const html = matrix(page, { selected: cellKey(BUILDER, "tool.invoke") });
  equal(
    dots(html, BUILDER).find(([column]) => column === "tool.invoke")![1],
    "denied",
  );
  const detail = html.match(/<aside class="detail".*?<\/aside>/s)![0];
  deepStrictEqual(
    [...detail.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>(.*?)<\/dd>/gs)].map((
      [, name, value],
    ) => [name, value.replace(/<[^>]+>/g, "")]),
    [
      // The state as the host says it, with its mode.
      ["State", "frozen · execute"],
      ["Basis", "negotiated"],
      ["Rule", "telepathy"],
      ["Uncertain", "Read from the fallback."],
      ["Codes", "BRAND_NEW_CODERIGHT_WITHOUT_OBJECT"],
    ],
  );
  // The code the page does not know says nothing more than it is; the one it knows says what it means.
  match(
    detail,
    /<span data-code="BRAND_NEW_CODE"><code>BRAND_NEW_CODE<\/code>/,
  );
  match(detail, /data-code="RIGHT_WITHOUT_OBJECT" title="nothing to act on"/);
});

Deno.test("a model with no right declared says so in one line", () => {
  const body = ownerModeledBody();
  const empty = parseMatrix({ ...body, rows: [], cells: [] });
  equal(
    matrix(empty).match(/<p class="view-empty"[^>]*>.*?<\/p>/)?.[0],
    '<p class="view-empty" data-code="no-rights">No rights declared</p>',
  );
  const noColumns = parseMatrix({ ...body, columns: [], cells: [] });
  match(matrix(noColumns), /data-code="no-rights"/);
});

Deno.test("the version being read is kept by every link of the matrix", () => {
  const html = matrix(ownerModeled(), { version: HEAD, selected: cell });
  const hrefs = [...html.matchAll(/ href="([^"]*)"/g)].map(([, href]) => href);
  ok(hrefs.length > 10);
  for (const href of hrefs) {
    match(href, new RegExp(`version=${encodeURIComponent(HEAD)}`));
  }
});

Deno.test("the detail says a right is granted and of no use, beside the mode it is exercised in", () => {
  // The builder may use active tools, and has none to use.
  const html = matrix(ownerModeled(), {
    selected: cellKey(BUILDER, "tool.invoke"),
  });
  const detail = html.match(/<aside class="detail".*?<\/aside>/s)![0];
  match(
    detail,
    /<dt>State<\/dt><dd>allowed<span class="faint"> · execute<\/span><span class="faint"> · of no use<\/span><\/dd>/,
  );
  // A right that is used is not said to be of no use.
  const used = matrix(ownerModeled(), {
    selected: cellKey(BUILDER, "model.consult"),
  });
  doesNotMatch(used, /of no use<\/span><\/dd>/);
});

Deno.test("the detail tells what the host says when it says part of it: an uncertainty by its reason, or by its code, a place by its file", () => {
  const detailOf = (patch: Record<string, unknown>) =>
    matrix(
      parseMatrix(withCell(ownerModeledBody(), BUILDER, "tool.invoke", patch)),
      {
        selected: cellKey(BUILDER, "tool.invoke"),
      },
    ).match(/<aside class="detail".*?<\/aside>/s)![0];
  match(
    detailOf({ uncertain: { code: "NOT_FROM_COMPILER" } }),
    /<dt>Uncertain<\/dt><dd>NOT_FROM_COMPILER<\/dd>/,
  );
  match(
    detailOf({ uncertain: { reason: "Read from the fallback." } }),
    /<dt>Uncertain<\/dt><dd>Read from the fallback\.<\/dd>/,
  );
  // A place with a file and no role or name is still a link to the file, at its line.
  const place = detailOf({
    sources: [{ file: "configuration.sysml", line: 9 }],
  });
  match(
    place,
    /<a class="chip is-source" href="\/model\?page=files&amp;file=configuration.sysml&amp;line=9" data-action="source"><svg[^>]*>.*?<\/svg><span class="faint">configuration.sysml:9<\/span><\/a>/s,
  );
});

Deno.test("each cell is drawn in a box of its own: choosing another cell, even of the same line, does not keep the first one's box", () => {
  const keys = (selected: string) =>
    keysGiven(CellDetail, () => matrix(ownerModeled(), { selected }));
  deepStrictEqual(keys(cellKey(BUILDER, "model.edit")), [
    cellKey(BUILDER, "model.edit"),
  ]);
  deepStrictEqual(keys(cellKey(BUILDER, "model.consult")), [
    cellKey(BUILDER, "model.consult"),
  ]);
  deepStrictEqual(keys(cellKey(OWNER, "tool.invoke")), []);
});
