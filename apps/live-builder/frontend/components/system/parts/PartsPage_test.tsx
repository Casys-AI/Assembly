import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import {
  ANALYST,
  board,
  COORDINATOR,
  HEAD,
  initialBoard,
  link,
  linkedBoard,
  port,
  structuredBoard,
  unit,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import { asides } from "../../../test/support/markup.ts";
import {
  type PageOptions,
  renderSystemPage,
} from "../../../test/support/system-page.ts";
import { PartsPage } from "./PartsPage.tsx";

const OPERATOR = `${COORDINATOR}.operator`;
const SANDBOX = `${COORDINATOR}.sandbox`;
const CATALOG = `${COORDINATOR}.catalog`;

const parts = (model: ModelBoard, over: PageOptions = {}) =>
  renderSystemPage(PartsPage, "parts", model, over);

/** The link of a port, part or unit, through to its end. */
const linkOf = (html: string, id: string) =>
  html.match(
    new RegExp(
      `<a class="[^"]*"[^>]*data-id="${
        id.replaceAll(".", "\\.")
      }"[^>]*>.*?</a>`,
      "s",
    ),
  )?.[0];

Deno.test("each unit is a panel of its own: operators first, then the platform they rely on, then what is connected", () => {
  const html = parts(structuredBoard());
  equal((html.match(/<section class="part-unit/g) ?? []).length, 3);
  const start = html.indexOf('<section class="part-unit');
  const first = html.slice(
    start,
    html.indexOf('<section class="part-unit', start + 1),
  );
  ok(first.indexOf(">Operators<") < first.indexOf(">Platform<"));
  ok(first.indexOf(">Platform<") < first.indexOf('<table class="part-conns">'));
  // The platform says what it is in a tooltip, not in a paragraph.
  match(
    html,
    /<div class="kind-kw part-kind" title="Environments, catalogs and gates the operators rely on">Platform<\/div>/,
  );
  match(html, /<div class="panels is-platform">/);
  // A unit is called by the name the team gives it.
  match(html, /<span class="part-t">Coordinateur<\/span>/);
  match(
    html,
    /<span class="part-sum">Plans the work and hands it on\.<\/span>/,
  );
});

Deno.test("parts are nested as the model nests them", () => {
  const html = parts(structuredBoard());
  const sandbox = html.indexOf(`data-id="${SANDBOX}"`);
  const runner = html.indexOf(`data-id="${SANDBOX}.runner"`);
  const catalog = html.indexOf(`data-id="${CATALOG}"`);
  ok(sandbox < runner && runner < catalog);
  match(html, /<div class="panels is-nested"><section class="panel el">/);
  // The nested part sits inside the sandbox's panel, which closes after it.
  equal((html.match(/<div class="panels is-nested">/g) ?? []).length, 1);
});

Deno.test("a port is a square with its name and type, and what it carries; a conjugated one is hollow and ~", () => {
  const html = parts(structuredBoard());
  match(
    linkOf(html, `${OPERATOR}.proposals`)!,
    /<span class="port-sq" aria-hidden="true"><\/span><span class="port-name">proposals<span class="port-ty"> : CandidatePort<\/span><\/span><span class="port-flow">→ candidate : CandidateIdentity<\/span>/,
  );
  const conjugated = linkOf(html, `${SANDBOX}.proposals`)!;
  match(conjugated, /^<a class="port el is-conjugated"/);
  match(conjugated, /<span class="port-ty"> : ~CandidatePort<\/span>/);
  match(conjugated, /← candidate : CandidateIdentity/);
});

Deno.test("a port nothing reaches is flagged; one the board counts, or a connect of the model reaches, is not", () => {
  const html = parts(structuredBoard());
  // Open, with what it carries.
  match(
    linkOf(html, `${SANDBOX}.results`)!,
    /^<a class="port el is-open".*<span class="port-flow">→ result : TestResult<span class="port-warn"> · not connected<\/span><\/span>/s,
  );
  // Open, and carrying nothing: the flag alone.
  const lone = parts(board({
    team: [{
      ...unit({ id: "u", title: "u" }),
      ports: [port("u.p", "p")],
    }],
  }));
  match(
    linkOf(lone, "u.p")!,
    /<span class="port-flow"><span class="port-warn">not connected<\/span><\/span>/,
  );
  // The board counts a connection; a connect of the model reaches the others.
  for (
    const id of [
      `${OPERATOR}.proposals`,
      `${SANDBOX}.proposals`,
      `${SANDBOX}.runner.runs`,
      `${CATALOG}.candidates`,
    ]
  ) {
    doesNotMatch(linkOf(html, id)!, /is-open|not connected/, id);
  }
  equal((html.match(/not connected/g) ?? []).length, 1);
});

Deno.test("the connections of a unit are a table of what joins what, each end told by its part and port", () => {
  const html = parts(structuredBoard());
  match(
    html,
    /<thead><tr><th>Connection<\/th><th>From<\/th><th>To<\/th><\/tr><\/thead>/,
  );
  match(
    html,
    /<tr class="el"><td><span class="kind-kw">connect<\/span><\/td><td><span title="Model::proposals" data-end="unit-coordinator\.operator\.proposals">builder\.proposals<\/span><\/td><td><span title="Model::proposals" data-end="unit-coordinator\.sandbox\.proposals">testSandbox\.proposals<\/span><\/td><\/tr>/,
  );
  match(html, />runner\.runs<\/span>/);
  // A unit with nothing connected has no table.
  equal((html.match(/<table /g) ?? []).length, 1);
});

Deno.test("the ends of a connection are not links: the detail of a port opens under the port, in its panel, never away from what was chosen", () => {
  const html = parts(structuredBoard());
  const table = html.slice(
    html.indexOf('<table class="part-conns">'),
    html.indexOf("</table>"),
  );
  doesNotMatch(table, /<a /);
  // Each end names the port it is, for whoever hovers it.
  match(
    table,
    /<span title="Model::proposals" data-end="unit-coordinator\.operator\.proposals">/,
  );
  // The ports themselves, in their panels, are the links; there is one place for each.
  const port = linkOf(html, `${OPERATOR}.proposals`)!;
  match(port, /^<a class="port /);
  equal(
    (html.match(
      new RegExp(
        `data-id="${OPERATOR.replaceAll(".", "\\.")}\\.proposals"`,
        "g",
      ),
    ) ?? []).length,
    1,
  );
  // Choosing the port opens its detail once, in the panel; the row that joins it follows the choice.
  const chosen = parts(structuredBoard(), {
    selected: `${OPERATOR}.proposals`,
  });
  equal(asides(chosen), 1);
  match(chosen, /<tr class="el is-selected"><td><span class="kind-kw">connect/);
});

Deno.test("a connection to an element the board does not hold keeps its end as the model names it, with nothing to open", () => {
  const model = withLinks(structuredBoard(), [
    link("connect", `${OPERATOR}.proposals`, "ghost-port"),
  ]);
  const html = parts(model);
  match(
    html,
    /<td><span title="Model::proposals" data-end="unit-coordinator\.operator\.proposals">builder\.proposals<\/span><\/td><td><span class="faint" data-end="ghost-port">ghost-port<\/span><\/td>/,
  );
  doesNotMatch(html, /data-id="ghost-port"/);
});

Deno.test("a connection from an element the board does not hold is still listed, where the end it holds is", () => {
  const model = withLinks(structuredBoard(), [
    link("connect", "ghost-start", `${SANDBOX}.results`),
  ]);
  const html = parts(model);
  match(
    html,
    /<td><span class="faint" data-end="ghost-start">ghost-start<\/span><\/td><td><span title="Model::results" data-end="unit-coordinator\.sandbox\.results">testSandbox\.results<\/span><\/td>/,
  );
  // The port it reaches no longer says it is open.
  doesNotMatch(
    linkOf(html, `${SANDBOX}.results`)!,
    /not connected/,
  );
});

Deno.test("the detail of a port opens right under it, among the ports of its part", () => {
  const html = parts(structuredBoard(), { selected: `${SANDBOX}.results` });
  equal(asides(html), 1);
  match(
    html,
    /<a class="port el is-selected is-open" href="\/system\?page=parts" aria-current="true" data-id="unit-coordinator\.sandbox\.results"[^>]*>.*?<\/a><aside class="detail" aria-label="Detail" data-element="unit-coordinator\.sandbox\.results">/s,
  );
  // It sits inside the ports of the sandbox, not after its panel.
  const ports = html.slice(
    html.indexOf(`<div class="ports"><a class="port el is-conjugated"`),
  );
  ok(ports.indexOf("<aside ") < ports.indexOf("</div>"));
  // What holds it is its context, not stepped back.
  match(
    html,
    /<section class="panel el is-context"><a class="part-link"[^>]*data-id="unit-coordinator\.sandbox"/,
  );
  match(html, /<section class="part-unit el is-context">/);
  // The other unit is stepped back.
  match(
    html,
    /<section class="part-unit el"><a class="part-link"[^>]*data-id="unit-analyst"/,
  );
});

Deno.test("the detail of a part follows the whole row of parts it is in, and that of a unit follows the unit", () => {
  const part = parts(structuredBoard(), { selected: CATALOG });
  equal(asides(part), 1);
  match(
    part,
    /<\/section><\/div><aside class="detail" aria-label="Detail" data-element="unit-coordinator\.catalog">/,
  );
  // The row of platform parts has closed before the detail.
  const row = part.slice(
    part.indexOf('<div class="panels is-platform">'),
    part.indexOf("<aside "),
  );
  equal((row.match(/<div class="panels/g) ?? []).length, 2);
  const nested = parts(structuredBoard(), { selected: `${SANDBOX}.runner` });
  equal(asides(nested), 1);
  // A nested part's detail follows the nested row, inside its parent's panel.
  match(
    nested,
    /<\/section><\/div><aside [^>]*data-element="unit-coordinator\.sandbox\.runner">.*?<\/section>/s,
  );
  const whole = parts(structuredBoard(), { selected: COORDINATOR });
  equal(asides(whole), 1);
  match(
    whole,
    /<\/table><\/section><aside [^>]*data-element="unit-coordinator"/,
  );
  match(whole, /<section class="part-unit el is-selected">/);
});

Deno.test("only one detail is open, wherever the choice is made from", () => {
  for (
    const id of [
      COORDINATOR,
      OPERATOR,
      SANDBOX,
      `${SANDBOX}.runner`,
      `${SANDBOX}.runner.runs`,
      `${OPERATOR}.proposals`,
      ANALYST,
    ]
  ) {
    equal(asides(parts(structuredBoard(), { selected: id })), 1, id);
  }
});

Deno.test("what the chosen port is connected to is lit, with the reason", () => {
  const html = parts(structuredBoard(), { selected: `${SANDBOX}.runner.runs` });
  // A connect of the model links the two ports: connected to, either way.
  match(
    linkOf(html, `${CATALOG}.candidates`)!,
    /^<a class="port el is-lit is-conjugated".*<span class="el-why"><span class="chip">connected to<\/span><\/span>/s,
  );
  // What holds that port is lit by it, and the reason is told once, at the port.
  match(
    html,
    /<section class="panel el is-lit"><a class="part-link"[^>]*data-id="unit-coordinator\.catalog"/,
  );
  equal((html.match(/<span class="el-why">/g) ?? []).length, 1);
  match(html, /<div class="parts has-selection">/);
  // The row of the connection is chosen: it joins the port chosen.
  match(html, /<tr class="el is-selected"><td><span class="kind-kw">connect/);
});

Deno.test("SysML's words give the keyword and the identifier a unit is declared by", () => {
  const html = parts(structuredBoard(), { sysml: true });
  match(
    html,
    /<span class="kind-kw">part<\/span><span class="part-t">liveBuilder<\/span>/,
  );
  doesNotMatch(html, /Coordinateur|kind-icon/);
  match(
    html,
    /<span class="port-name"><span class="kind-kw">port<\/span>proposals<span class="port-ty"> : CandidatePort<\/span>/,
  );
  // The readable view has icons, no keywords, and the team's names.
  const readable = parts(structuredBoard());
  doesNotMatch(readable, /kind-kw">(part|port)</);
  match(readable, /<span class="kind-icon" title="component">/);
});

Deno.test("a selection no part, port or unit stands for follows the title", () => {
  // A step of a flow is not structure: the page has nothing to open under.
  const html = parts(linkedBoard(), {
    selected: `${COORDINATOR}.promotion.step0`,
  });
  equal(asides(html), 1);
  match(html, /^<div class="parts has-selection"><aside /);
  doesNotMatch(html, /is-selected/);
  // The operator it is allocated to is lit.
  match(linkOf(html, `${COORDINATOR}.operator`)!, /^<a class="part-link"/);
  match(html, /<section class="panel el is-lit">/);
});

Deno.test("a model with no unit says it has no structure, in one line", () => {
  equal(
    parts(board({})),
    '<p class="view-empty" data-code="no-structure">No system structure yet</p>',
  );
  // Nothing opens in it, and the version asked for is kept by the links of a model that has some.
  const pinned = parts(initialBoard(), { version: HEAD });
  match(
    pinned,
    new RegExp(
      `href="/system\\?page=parts&amp;select=[^"]*&amp;version=${
        encodeURIComponent(HEAD)
      }"`,
    ),
  );
});

Deno.test("a unit with no part says nothing more than its name", () => {
  const bare = parts(board({
    team: [{ ...unit({ id: "u", title: "u" }), children: [] }],
  }));
  doesNotMatch(bare, /Operators|Platform|<table|<div class="panels/);
  match(bare, /<span class="part-t">u<\/span>/);
});

Deno.test("parts that repeat an id still open one detail", () => {
  const unitWithTwins = {
    ...unit({ id: "u", title: "u" }),
    children: [
      {
        ...unit({ id: "x", title: "x" }),
        id: "u.same",
        kind: "machine" as const,
      },
      {
        ...unit({ id: "x", title: "x" }),
        id: "u.same",
        kind: "machine" as const,
      },
    ],
  };
  const html = parts(board({ team: [unitWithTwins] }), { selected: "u.same" });
  deepStrictEqual(asides(html), 1);
});
