import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import {
  board,
  constraint,
  COORDINATOR,
  guaranteeBoard,
  HEAD,
  requirement,
} from "../../test/support/board-fixture.ts";
import { asides, childrenOf } from "../../test/support/markup.ts";
import {
  type PageOptions,
  renderSystemPage,
} from "../../test/support/system-page.ts";
import { RequirementsPage } from "./RequirementsPage.tsx";

const requirements = (model: ModelBoard, over: PageOptions = {}) =>
  renderSystemPage(RequirementsPage, "requirements", model, over);

const rowOf = (html: string, id: string) =>
  html.match(
    new RegExp(`<a class="qrow[^"]*"[^>]*data-id="${id}"[^>]*>.*?</a>`, "s"),
  )
    ?.[0];

Deno.test("the page lists requirements, then constraints, each with a dot for where it stands", () => {
  const html = requirements(guaranteeBoard());
  deepStrictEqual(
    [...html.matchAll(/data-section="(\w+)"/g)].map(([, name]) => name),
    ["requirements", "constraints"],
  );
  deepStrictEqual(
    [...html.matchAll(/data-id="([^"]+)" data-mark="(\w+)"/g)].map((
      [, id, mark],
    ) => `${id}:${mark}`),
    [
      "req.exact:on",
      "req.fail:on",
      "req.orphan:off",
      "req.plain:off",
      "chk.live:on",
      "chk.idle:idle",
    ],
  );
  // The dot itself says it, for whoever cannot see it.
  match(html, /<span class="qmark is-on" role="img" aria-label="2 owners">/);
  match(html, /<span class="qmark is-off" role="img" aria-label="no owner/);
  match(
    html,
    /<span class="qmark is-idle" role="img" aria-label="used by no performed step">/,
  );
  // A lifecycle is a guarantee of the model but not a requirement.
  doesNotMatch(html, /AdmissionLifecycle|Admission lifecycle|data-id="life"/);
});

Deno.test("the tooltip counts the owners or says there is none, and never says tested", () => {
  const html = requirements(guaranteeBoard());
  match(html, /title="ExactReviewedCandidate — 2 owners"/);
  match(html, /title="FailClosedPromotion — 1 owner"/);
  match(
    html,
    /title="ActiveOnlyCallable — no owner: nothing is declared to satisfy it"/,
  );
  match(html, /title="testedAdmission — used by a performed step"/);
  match(html, /title="exactAdmission — used by no performed step"/);
  const tooltips = [...html.matchAll(/ title="([^"]*—[^"]*)"/g)].map(([, t]) =>
    t
  );
  equal(tooltips.length, 6);
  // Only what the board knows: owners, or what performs it. Nothing about tests.
  for (const tip of tooltips) {
    match(
      tip,
      / — (\d+ owners?|no owner: nothing is declared to satisfy it|used by (a performed|no performed) step)$/,
    );
  }
  doesNotMatch(html, /not tested|untested|tests? pass/i);
});

Deno.test("a requirement reads as its summary, with its name and clauses under it; a constraint says where it holds", () => {
  const html = requirements(guaranteeBoard());
  match(
    rowOf(html, "req.exact")!,
    /Activation requires approval for the same candidate digest\.<span class="qsub">Exact reviewed candidate · Same reviewed bytes · Fresh review<\/span>/,
  );
  // Without a summary the name is the text, and there is nothing to repeat under it.
  match(rowOf(html, "req.plain")!, /<span class="qtext">Named only<\/span>/);
  match(
    rowOf(html, "chk.live")!,
    /Tested admission<span class="qon">on Configured admission<\/span>/,
  );
  // A constraint nothing performs says so, after where it holds.
  match(
    rowOf(html, "chk.idle")!,
    /Exact admission<span class="qon">on Admit candidate · not performed<\/span>/,
  );
  // The readable view shows no expression.
  doesNotMatch(html, /class="expr"/);
});

Deno.test("in SysML's words each statement is as written, with its keyword and its expressions", () => {
  const html = requirements(guaranteeBoard(), { sysml: true });
  match(
    rowOf(html, "req.exact")!,
    /<span class="kind-kw">requirement<\/span> ExactReviewedCandidate/,
  );
  // The clauses of a requirement, with their expressions.
  match(
    rowOf(html, "req.exact")!,
    /<span class="qclause"><span class="kind-kw">require constraint<\/span> sameReviewedBytes<span class="expr">activationRequested implies review.approved<\/span><\/span>/,
  );
  // A clause without an expression has none to show.
  match(
    rowOf(html, "req.exact")!,
    /<span class="qclause"><span class="kind-kw">require constraint<\/span> freshReview<\/span>/,
  );
  // A constraint: its type and its expression.
  match(
    rowOf(html, "chk.idle")!,
    /<span class="kind-kw">constraint<\/span> exactAdmission<span class="qty">: AdmitCandidate<\/span><span class="expr">decision.admitted and exactBytesUnchanged<\/span>/,
  );
  // The summary of the readable view is not the statement.
  doesNotMatch(html, /Activation requires approval/);
  // The dots do not depend on the words.
  match(html, /data-id="req.orphan" data-mark="off"/);
});

Deno.test("the rows are items of the lists, and the detail is one too: never a direct child of a list", () => {
  for (const selected of ["req.exact", "req.exact.same", "chk.idle"]) {
    const html = requirements(guaranteeBoard(), { selected });
    equal(asides(html), 1, selected);
    const lists = childrenOf(html, "ul");
    equal(lists.length, 2);
    for (const children of lists) {
      ok(children.every((tag) => tag === "li"), `${selected}: ${children}`);
    }
    // The detail is the item that follows the row.
    match(html, /<\/li><li class="detail-item"><aside /);
  }
  // With nothing chosen the lists hold the rows alone.
  deepStrictEqual(childrenOf(requirements(guaranteeBoard()), "ul"), [
    ["li", "li", "li", "li"],
    ["li", "li"],
  ]);
});

Deno.test("the detail opens right under the row chosen, in the page's own address, and the row is chosen", () => {
  const html = requirements(guaranteeBoard(), { selected: "req.fail" });
  match(
    html,
    /<a class="qrow el is-selected" href="\/system\?page=requirements" aria-current="true" data-id="req\.fail" data-mark="on" title="[^"]*">.*?<\/a><\/li><li class="detail-item"><aside class="detail" aria-label="Detail" data-element="req\.fail">/s,
  );
  // Not narrow: a list is wide enough for all the detail.
  doesNotMatch(html, /is-narrow/);
  match(html, /<h2 class="detail-title">Fail closed promotion<\/h2>/);
  // The other rows lead to themselves; the version being read is kept.
  match(html, /href="\/system\?page=requirements&amp;select=req\.exact"/);
  const pinned = requirements(guaranteeBoard(), { version: HEAD });
  match(
    pinned,
    new RegExp(
      `href="/system\\?page=requirements&amp;select=chk\\.live&amp;version=${
        encodeURIComponent(HEAD)
      }"`,
    ),
  );
  doesNotMatch(
    requirements(guaranteeBoard()),
    /<aside|is-selected|has-selection/,
  );
});

Deno.test("a clause chosen opens under the requirement it is in, which is the row chosen", () => {
  const html = requirements(guaranteeBoard(), { selected: "req.exact.same" });
  equal(asides(html), 1);
  match(html, /<a class="qrow el is-selected"[^>]*data-id="req\.exact"/);
  match(
    html,
    /data-id="req\.exact".*?<\/li><li class="detail-item"><aside [^>]*data-element="req\.exact\.same"/s,
  );
  // Choosing the row again closes it, whichever of its ids was chosen.
  match(
    rowOf(html, "req.exact")!,
    /href="\/system\?page=requirements" aria-current="true"/,
  );
});

Deno.test("what the chosen element is related to stays lit with the reason, the rest steps back", () => {
  // A unit is chosen; it answers for the requirements it satisfies.
  const html = requirements(guaranteeBoard(), { selected: COORDINATOR });
  match(html, /<div class="requirements has-selection">/);
  match(rowOf(html, "req.exact")!, /^<a class="qrow el is-lit"/);
  match(
    rowOf(html, "req.exact")!,
    /<span class="el-why"><span class="chip">satisfies<\/span><\/span>/,
  );
  // The unit satisfies one requirement it is declared for and not the others.
  doesNotMatch(rowOf(html, "req.orphan")!, /is-lit|el-why/);
  match(rowOf(html, "req.orphan")!, /^<a class="qrow el"/);
  // No row carries the unit: its detail follows the title.
  equal(asides(html), 1);
  match(html, /^<div class="requirements has-selection"><aside /);
});

Deno.test("a name the board does not know opens nothing and steps nothing back", () => {
  for (const selected of ["ghost", "", "constructor"]) {
    const html = requirements(guaranteeBoard(), { selected });
    equal(asides(html), 0, JSON.stringify(selected));
    doesNotMatch(html, /has-selection|is-selected|is-lit/);
  }
});

Deno.test("a model that declares neither says so in one line; one kind alone draws only its list", () => {
  equal(
    requirements(board({})),
    '<p class="view-empty" data-code="no-requirement">No requirements yet</p>',
  );
  const only = requirements(board({
    guarantees: [constraint("c", "limit", true)],
  }));
  match(only, /data-section="constraints"/);
  doesNotMatch(only, /data-section="requirements"|>Requirements</);
  const other = requirements(board({
    guarantees: [requirement("r", "ThingHolds", { satisfiedBy: ["u"] })],
  }));
  match(other, />Requirements<\/h3>/);
  doesNotMatch(other, /data-section="constraints"/);
});
