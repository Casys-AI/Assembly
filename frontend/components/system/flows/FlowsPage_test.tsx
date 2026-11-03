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
  capability,
  COORDINATOR,
  flowBoard,
  flowEnd,
  flowStep,
  HEAD,
  item,
  unit,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { asides } from "../../../test/support/markup.ts";
import {
  type PageOptions,
  renderSystemPage,
} from "../../../test/support/system-page.ts";
import { FlowsPage } from "./FlowsPage.tsx";

const PROMOTION = `${COORDINATOR}.promotion`;
const ANALYST_PROMOTION = `${ANALYST}.promotion`;
const CONVERSATION = `${COORDINATOR}.conversation`;
const step = (key: string, flow = PROMOTION) => `${flow}#${key}`;

const flows = (
  model: ModelBoard,
  over: PageOptions & { flow?: string | null } = {},
) =>
  renderSystemPage(FlowsPage, "flows", model, over, {
    flow: over.flow ?? null,
  });

/** The markup of the `<li>` that holds a step of the thread, nested ones included. */
function stepOf(html: string, id: string): string {
  const open = html.indexOf(`data-step="${id}"`);
  ok(open >= 0, `no step ${id}`);
  const start = html.lastIndexOf("<li", open);
  let depth = 0;
  for (const tag of html.slice(start).matchAll(/<(\/?)li\b/g)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) {
      const end = html.indexOf(">", start + tag.index! + 1) + 1;
      return html.slice(start, end);
    }
  }
  throw new Error(`unclosed step ${id}`);
}
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href);

Deno.test("the flows and the lifecycles are a list at the left, each under its heading, and the first entry is read", () => {
  const html = flows(flowBoard());
  deepStrictEqual(
    [...html.matchAll(/<div class="flows-group">([^<]*)<\/div>/g)].map((
      [, name],
    ) => name),
    ["Flows", "Lifecycles"],
  );
  deepStrictEqual(
    [
      ...html.matchAll(
        /<a class="flows-pick" href="([^"]*)" aria-current="(\w+)"[^>]*><span class="flows-pick-name">([^<]*)<\/span>/g,
      ),
    ].map(([, href, current, name]) => [name, current, href]),
    [
      [
        "Promotion",
        "true",
        `/system?page=flows&amp;flow=${PROMOTION}`,
      ],
      ["Conversation", "false", `/system?page=flows&amp;flow=${CONVERSATION}`],
      [
        "Admission candidate lifecycle",
        "false",
        "/system?page=flows&amp;flow=life",
      ],
    ],
  );
  // The entry read is the first: its thread is on the page, the others' are not.
  match(
    html,
    new RegExp(`class="flows-stage" data-kind="flow" data-flow="${PROMOTION}"`),
  );
  doesNotMatch(html, /resumeCase|Wait for input|life-state/);
  // What an entry is: its summary, on hover.
  match(html, /title="Propose a candidate, test it, admit it, activate it\."/);
});

Deno.test("the same flow declared in several units is one entry marked with how many, and says which", () => {
  const html = flows(flowBoard());
  equal((html.match(/class="flows-pick"/g) ?? []).length, 3);
  match(
    html,
    /<span class="flows-times" title="one per system: Coordinateur and Analyste">×2<\/span>/,
  );
  // A flow of one unit has no mark.
  doesNotMatch(
    html.slice(html.indexOf("Conversation</span>")).split("</a>")[0],
    /flows-times/,
  );
});

Deno.test("the flow the address asks for is read; the entry on show is the current one, and the twin on show stays on show", () => {
  const second = flows(flowBoard(), { flow: CONVERSATION });
  match(second, new RegExp(`data-flow="${CONVERSATION}"`));
  match(
    second,
    /aria-current="true" data-flow="[^"]*conversation"[^>]*><span class="flows-pick-name">Conversation/,
  );
  doesNotMatch(second, /vdecision/);
  // The analyst's promotion is the twin asked for: the entry is the same, and the link keeps the twin.
  const twin = flows(flowBoard(), { flow: ANALYST_PROMOTION });
  match(
    twin,
    new RegExp(
      `class="flows-stage" data-kind="flow" data-flow="${ANALYST_PROMOTION}"`,
    ),
  );
  match(
    twin,
    new RegExp(
      `href="/system\\?page=flows&amp;flow=${ANALYST_PROMOTION}" aria-current="true"`,
    ),
  );
  // A flow that is none leaves the first.
  match(
    flows(flowBoard(), { flow: "ghost" }),
    new RegExp(`class="flows-stage" data-kind="flow" data-flow="${PROMOTION}"`),
  );
});

Deno.test("a model that describes no behavior says so in one line", () => {
  equal(
    flows(board({})),
    '<p class="view-empty" data-code="no-flow">No flows yet</p>',
  );
  // An action without steps is not a flow.
  equal(
    flows(board({
      team: [unit({ id: COORDINATOR, title: "liveBuilder" })],
      cando: [capability("a", COORDINATOR, "reply")],
    })),
    '<p class="view-empty" data-code="no-flow">No flows yet</p>',
  );
});

Deno.test("a model with only a lifecycle lists it alone and reads it", () => {
  const model = flowBoard();
  const only = {
    ...model,
    columns: model.columns.map((column) =>
      column.id === "cando" ? { ...column, items: [] } : column
    ),
  };
  const html = flows(only);
  deepStrictEqual(
    [...html.matchAll(/<div class="flows-group">([^<]*)<\/div>/g)].map((
      [, name],
    ) => name),
    ["Lifecycles"],
  );
  match(html, /class="flows-stage" data-kind="lifecycle" data-flow="life"/);
  match(html, /aria-current="true" data-flow="life"/);
});

Deno.test("a flow is a thread: the start, its steps one after the other as cards, and the end", () => {
  const html = flows(flowBoard());
  deepStrictEqual(
    [...html.matchAll(
      /<li class="(v\w+)"[^>]*?(?:data-step="([^"]*)"|aria-hidden)/g,
    )]
      .map(([, kind, id]) => [kind, id?.split("#")[1] ?? ""]),
    [
      ["vstart", ""],
      ["vstep", "propose"],
      ["vstep", "test"],
      ["vdecision", "testOutcome"],
      ["vstep", "admit"],
      ["vdecision", "admissionOutcome"],
      ["vstep", "activate"],
      ["vgoto", "goto:afterActivate"],
      ["vgoto", "goto:afterRefusedAdmission"],
      ["vgoto", "goto:afterRefusedTests"],
      ["vmerge", "refusal"],
      ["vstep", "refuse"],
      ["vmerge", "completion"],
      ["vend", "@done"],
    ],
  );
  // Steps are named as a person says them; the model's identifier is for SysML.
  match(html, /<b>Propose<\/b>/);
  doesNotMatch(html, /<b>propose<\/b>/);
  equal(asides(html), 0);
});

Deno.test("a decision is a diamond whose branches stand side by side, each under what opens it, and the guard on hover", () => {
  const html = flows(flowBoard());
  const decision = stepOf(html, step("testOutcome"));
  match(
    decision,
    /^<li class="vdecision"[^>]*><a class="vpick el"[^>]*aria-label="Test outcome"[^>]*><span class="vdiamond"><\/span><\/a><div class="vbranches">/,
  );
  // Two branches under the one diamond.
  deepStrictEqual(
    [...decision.matchAll(
      /<div class="vbranch" data-branch="(\w+)"><span class="vlabel" title="([^"]*)">([^<]*)<\/span>/g,
    )]
      .map(([, branch, hover, label]) => [branch, hover, label])
      .slice(0, 1),
    [["if", "test.result.passed", "if"]],
  );
  // The branch of the nested decision is inside the first branch, not beside the outer ones.
  const outer = decision.slice(decision.indexOf('class="vbranches"'));
  equal((outer.match(/class="vbranches"/g) ?? []).length, 2);
  deepStrictEqual(
    [...outer.matchAll(/data-branch="(\w+)"/g)].map(([, branch]) => branch),
    ["if", "if", "else", "else"],
  );
  // An else has no guard: the label says it.
  match(decision, /<span class="vlabel" title="else">else<\/span>/);
  // A step in a branch is in it.
  const first = decision.slice(
    decision.indexOf('data-branch="if"'),
    decision.indexOf('data-branch="else"'),
  );
  match(first, /data-step="[^"]*#admit"/);
  doesNotMatch(first, /data-step="[^"]*#refuse"/);
});

Deno.test("a jump says where it goes, a merge is named, a loop says where it comes back to", () => {
  const html = flows(flowBoard());
  match(html, /<li class="vgoto"[^>]*>→ Completion<\/li>/);
  match(html, /<li class="vgoto"[^>]*>→ Refusal<\/li>/);
  match(html, /<a class="vname el"[^>]*>Refusal<\/a>/);
  match(
    stepOf(html, step("refuse")),
    /<span class="vloop">↺ back to Propose<\/span>/,
  );
  match(html, /<li class="vend" title="done" data-step="[^"]*#@done"><\/li>/);
  // A jump and the end are marks of the thread: nothing to choose.
  doesNotMatch(stepOf(html, step("goto:afterActivate")), /<a /);
  doesNotMatch(stepOf(html, step("@done")), /<a /);
});

Deno.test("who performs a step is on its card: the unit's name for an operator, a ring for what is not one", () => {
  const html = flows(flowBoard());
  const propose = stepOf(html, step("propose"));
  match(
    propose,
    new RegExp(
      `<span class="who" data-performer="${COORDINATOR}.operator">`,
    ),
  );
  match(propose, /<i><\/i>Coordinateur<\/span>/);
  match(
    stepOf(html, step("test")),
    /<span class="who is-platform"[^>]*><i><\/i>Test sandbox<\/span>/,
  );
  // A step nothing is allocated to says nothing.
  doesNotMatch(stepOf(html, step("activate")), /who/);
  // The twin of another unit is performed by that unit's operator.
  const twin = flows(flowBoard(), { flow: ANALYST_PROMOTION });
  match(
    stepOf(twin, step("propose", ANALYST_PROMOTION)),
    /<i><\/i>Analyste<\/span>/,
  );
  doesNotMatch(stepOf(twin, step("test", ANALYST_PROMOTION)), /who/);
});

Deno.test("a step the address selects shows its detail right under it, and nowhere else", () => {
  const html = flows(flowBoard(), { selected: step("test") });
  equal(asides(html), 1);
  const test = stepOf(html, step("test"));
  match(
    test,
    /^<li class="vstep" data-step="[^"]*#test"><a class="vcard el is-selected"[^>]*aria-current="true"[^>]*>.*?<\/a><aside class="detail" aria-label="Detail" data-element="[^"]*#test">/s,
  );
  // Its words: what it is, its name, what performs it, where it is declared.
  match(test, /<div class="kind-kw">step<\/div>/);
  match(test, /<h5>performed by<\/h5>/);
  match(test, /data-action="source"/);
  // The card is the way to close it: the same page, the same flow, nothing selected.
  match(
    test,
    new RegExp(
      `class="vcard el is-selected" href="/system\\?page=flows&amp;flow=${PROMOTION}"`,
    ),
  );
  match(
    test,
    new RegExp(
      `class="detail-x" href="/system\\?page=flows&amp;flow=${PROMOTION}"`,
    ),
  );
  // Nothing opens under the title: the page carries the step.
  ok(html.indexOf("<aside") > html.indexOf('class="flows-split"'));
  // The rest steps back while one is chosen.
  match(html, /class="flows-stage has-selection"/);
  doesNotMatch(flows(flowBoard()), /has-selection/);
});

Deno.test("flows that go by one name but are drawn differently are each their own entry, and the unit says which is which", () => {
  const base = flowBoard();
  const other = {
    ...base,
    columns: base.columns.map((column) =>
      column.id === "cando"
        ? {
          ...column,
          items: column.items.map((entry) =>
            entry.id === ANALYST_PROMOTION
              ? {
                ...entry,
                steps: entry.steps!.map((one) =>
                  one.guard ? { ...one, guard: "another.guard" } : one
                ),
              }
              : entry
          ),
        }
        : column
    ),
  };
  const html = flows(other);
  const names = [...html.matchAll(
    /<span class="flows-pick-name">([^<]*)<\/span>(<span class="flows-times"[^>]*>[^<]*<\/span>)?/g,
  )].map(([, name, mark]) => [name, mark?.replace(/<[^>]*>/g, "")]);
  deepStrictEqual(names, [
    ["Promotion", "Coordinateur"],
    ["Promotion", "Analyste"],
    ["Conversation", undefined],
    ["Admission candidate lifecycle", undefined],
  ]);
  match(
    html,
    /<span class="flows-times" title="declared in Analyste">Analyste<\/span>/,
  );
  // Each is read as itself: the analyst's thread has the analyst's guard.
  const analyst = flows(other, { flow: ANALYST_PROMOTION });
  match(analyst, new RegExp(`data-flow="${ANALYST_PROMOTION}"`));
  match(analyst, /title="another\.guard"/);
  // The ones that really are twins stay one entry marked with how many.
  doesNotMatch(flows(base), /declared in/);
});

Deno.test("a step, a merge and a state go by the same name on the page and in their detail, in both views", () => {
  const name = (html: string, pattern: RegExp) => html.match(pattern)?.[1];
  for (const sysml of [false, true]) {
    const view = sysml ? "SysML" : "readable";
    // A step of the thread: the card says what the heading says.
    const test = stepOf(
      flows(flowBoard(), { selected: step("test"), sysml }),
      step("test"),
    );
    equal(
      name(
        test,
        /<a class="vcard[^"]*"[^>]*>(?:<span class="kind-kw">[^<]*<\/span>)?<b>([^<]*)/,
      ),
      name(test, /<h2 class="detail-title">([^<]*)<\/h2>/),
      view,
    );
    equal(
      name(test, /<h2 class="detail-title">([^<]*)/),
      sysml ? "test" : "Test",
    );
    // A merge is told by its name alone.
    const merge = stepOf(
      flows(flowBoard(), { selected: step("refusal"), sysml }),
      step("refusal"),
    );
    equal(
      name(
        merge,
        /<a class="vname[^"]*"[^>]*>(?:<span class="kind-kw">[^<]*<\/span>)?([^<]*)/,
      ),
      name(merge, /<h2 class="detail-title">([^<]*)<\/h2>/),
      view,
    );
    // A state of the lifecycle: the pill says what the heading says.
    const life = flows(flowBoard(), { selected: "life#reviewing", sysml });
    equal(
      name(
        life,
        /<a class="life-state[^"]*"[^>]*aria-current="true"[^>]*>(?:<span class="kind-kw">[^<]*<\/span>)?([^<]*)/,
      ),
      name(life, /<h2 class="detail-title">([^<]*)<\/h2>/),
      view,
    );
    equal(
      name(life, /<h2 class="detail-title">([^<]*)/),
      sysml ? "reviewing" : "Reviewing",
    );
  }
});

Deno.test("a step in a branch opens its detail inside the branch, a decision's under its diamond and before its branches", () => {
  const inside = flows(flowBoard(), { selected: step("admit") });
  equal(asides(inside), 1);
  const branch = inside.slice(
    inside.indexOf('data-branch="if"'),
    inside.indexOf('data-branch="else"'),
  );
  match(
    branch,
    /data-step="[^"]*#admit"><a class="vcard el is-selected".*?<\/a><aside class="detail"/s,
  );
  const decision = flows(flowBoard(), { selected: step("testOutcome") });
  match(
    stepOf(decision, step("testOutcome")),
    /^<li class="vdecision"[^>]*><a class="vpick el is-selected"[^>]*aria-current="true"[^>]*>.*?<\/a><aside class="detail"[^>]*>.*?<\/aside><div class="vbranches">/s,
  );
  const merge = flows(flowBoard(), { selected: step("refusal") });
  match(
    stepOf(merge, step("refusal")),
    /^<li class="vmerge"[^>]*><a class="vname el is-selected"[^>]*>Refusal<\/a><aside class="detail"/,
  );
});

Deno.test("choosing a step is a link that keeps the flow and the version; choosing it again closes it", () => {
  const model = flowBoard();
  const html = flows(model, { flow: CONVERSATION, version: HEAD });
  const at = `&amp;version=${encodeURIComponent(HEAD)}`;
  // Every address the page makes stays on the page, the flow and the version.
  for (const href of hrefs(html).filter((h) => h.startsWith("/system"))) {
    match(href, /^\/system\?page=flows&amp;flow=[^&]+/);
    ok(href.endsWith(at), href);
  }
  match(
    html,
    new RegExp(
      `href="/system\\?page=flows&amp;flow=${CONVERSATION}&amp;select=${CONVERSATION}%23wait${at}"`,
    ),
  );
  // Opened, the card leads back to the page with nothing selected, in the same flow.
  const open = flows(model, {
    flow: CONVERSATION,
    version: HEAD,
    selected: step("wait", CONVERSATION),
  });
  match(
    stepOf(open, step("wait", CONVERSATION)),
    new RegExp(
      `class="vcard el is-selected" href="/system\\?page=flows&amp;flow=${CONVERSATION}${at}"`,
    ),
  );
});

Deno.test("what the address selects is read where it is, whatever flow the address asks for", () => {
  const html = flows(flowBoard(), {
    flow: PROMOTION,
    selected: step("wait", CONVERSATION),
  });
  match(
    html,
    new RegExp(
      `class="flows-stage has-selection" data-kind="flow" data-flow="${CONVERSATION}"`,
    ),
  );
  match(html, /aria-current="true" data-flow="[^"]*conversation"/);
  equal(asides(html), 1);
  // Closing it stays in the flow it was found in.
  match(
    html,
    new RegExp(
      `class="detail-x" href="/system\\?page=flows&amp;flow=${CONVERSATION}"`,
    ),
  );
  // A step of the twin is read in the twin.
  const twin = flows(flowBoard(), {
    selected: step("propose", ANALYST_PROMOTION),
  });
  match(twin, new RegExp(`data-flow="${ANALYST_PROMOTION}"`));
  match(
    stepOf(twin, step("propose", ANALYST_PROMOTION)),
    /<aside class="detail"/,
  );
});

Deno.test("a selection the thread has no element for opens under the title: a jump, a part, a unit", () => {
  for (
    const selected of [
      step("goto:afterActivate"),
      `${COORDINATOR}.operator`,
      COORDINATOR,
    ]
  ) {
    const html = flows(flowBoard(), { selected });
    equal(asides(html), 1, selected);
    ok(html.indexOf("<aside") < html.indexOf('class="flows-split"'), selected);
    match(html, /class="flows-stage has-selection"/);
  }
});

Deno.test("what the selection is related to stays lit in the thread, with the reason, and the rest steps back", () => {
  const html = flows(flowBoard(), { selected: `${COORDINATOR}.sandbox` });
  const lit = stepOf(html, step("test"));
  match(lit, /<a class="vcard el is-lit"/);
  match(
    lit,
    /<span class="el-why"><span class="chip">performs<\/span><\/span>/,
  );
  // Another step is not related to the sandbox: it is left to step back.
  match(stepOf(html, step("propose")), /<a class="vcard el"/);
});

Deno.test("a step no path reaches is drawn apart and says so", () => {
  const model = flowBoard();
  const lost = {
    ...model,
    columns: model.columns.map((column) =>
      column.id === "cando"
        ? {
          ...column,
          items: column.items.map((entry) =>
            entry.id === CONVERSATION
              ? {
                ...entry,
                steps: [
                  ...entry.steps!.slice(0, 2),
                  flowStep(CONVERSATION, "orphan", "action", "orphan", {
                    unreachable: true,
                  }),
                  flowEnd(CONVERSATION),
                ],
              }
              : entry
          ),
        }
        : column
    ),
  };
  const html = flows(lost, { flow: CONVERSATION });
  match(
    stepOf(html, step("orphan", CONVERSATION)),
    /class="vcard el is-unreachable"[^>]*title="no path from the start reaches it"/,
  );
  doesNotMatch(stepOf(html, step("wait", CONVERSATION)), /is-unreachable/);
});

Deno.test("in SysML's words the thread says how the model declares it: keywords, types, identifiers and the guard of a branch", () => {
  const html = flows(flowBoard(), { sysml: true });
  const propose = stepOf(html, step("propose"));
  match(
    propose,
    /<span class="kind-kw">action<\/span><b>propose<span class="vty">: ProposeCandidate<\/span><\/b>/,
  );
  // The operator is the one the model declares, not the name the team gives its unit.
  match(propose, /<i><\/i>builder<\/span>/);
  doesNotMatch(propose, /Coordinateur/);
  // The branch says its guard; the entries are the model's identifiers.
  match(
    html,
    /<span class="vlabel" title="test\.result\.passed">if test\.result\.passed<\/span>/,
  );
  match(html, /<span class="flows-pick-name">promotion<\/span>/);
  match(html, /<li class="vgoto"[^>]*>→ completion<\/li>/);
  match(stepOf(html, step("refuse")), /↺ back to propose/);
  // The hover is the model's too.
  match(propose, /^<li class="vstep"[^>]*><a class="vcard el"[^>]*>/);
  doesNotMatch(propose, /title="ProposeCandidate"/);
});

Deno.test("a lifecycle is a track: states in columns by rank, the first outlined, the ends last and dashed, inherited ones quieter", () => {
  const html = flows(flowBoard(), { flow: "life" });
  deepStrictEqual(
    [...html.matchAll(
      /<div class="life-col" data-column="(\w+)">(.*?)(?=<div class="life-col"|<\/div><\/div><\/div>$)/gs,
    )]
      .map(([, kind, column]) => [
        kind,
        [...column.matchAll(/data-state="[^"]*#([^"]+)"/g)].map(([, name]) =>
          name
        ),
      ]),
    [
      ["rank", ["proposed"]],
      ["rank", ["testing"]],
      ["rank", ["reviewing", "awaiting-admission"]],
      ["rank", ["activating"]],
      ["end", ["active", "refused"]],
    ],
  );
  // The state's classes and what it says on hover, by its name.
  const state = (name: string) =>
    html.match(
      new RegExp(
        `<a class="life-state([^"]*)" href="[^"]*%23${name}"[^>]* title="([^"]*)">`,
      ),
    )!;
  match(state("proposed")[1], / el is-initial is-inherited/);
  match(state("active")[1], / el is-terminal is-inherited/);
  // What this model adds is not inherited.
  doesNotMatch(state("awaiting-admission")[1], /is-inherited/);
  // Each state says where it leads when pointed at, and where it comes from.
  equal(
    state("reviewing")[2],
    "Admission accepted → Activating\nReview refused → Refused\nfrom Candidate lifecycle",
  );
  equal(
    state("awaiting-admission")[2],
    "Human admission accepted [owner.present] → Activating",
  );
  equal(state("active")[2], "Active\nfrom Candidate lifecycle");
  // No thread, no start dot.
  doesNotMatch(html, /vflow|vstart/);
});

Deno.test("a state the address selects shows its detail right under it, with the states it leads to and is reached from", () => {
  const html = flows(flowBoard(), { selected: "life#reviewing" });
  equal(asides(html), 1);
  match(
    html,
    /class="flows-stage has-selection" data-kind="lifecycle" data-flow="life"/,
  );
  const cell = html.slice(html.indexOf('data-state="life#reviewing"'));
  match(
    cell,
    /^data-state="life#reviewing"><a class="life-state el is-selected is-inherited"[^>]*aria-current="true"[^>]*>Reviewing<\/a><aside class="detail"/,
  );
  const detail = cell.slice(cell.indexOf("<aside"), cell.indexOf("</aside>"));
  match(
    detail,
    /<h5>leads to<\/h5><div class="detail-chips"><a class="chip" href="[^"]*select=life%23activating"[^>]*>Activating<\/a><a class="chip" href="[^"]*select=life%23refused"[^>]*>Refused<\/a>/,
  );
  match(
    detail,
    /<h5>reached from<\/h5><div class="detail-chips"><a class="chip" href="[^"]*select=life%23testing"[^>]*>Testing<\/a>/,
  );
  // A chip leads to the other state on this page, in this lifecycle.
  match(detail, /href="\/system\?page=flows&amp;select=life%23activating"/);
  // The states around it stay lit, with the way they are related; the others step back.
  const lit = (name: string) =>
    html.match(
      new RegExp(
        `<a class="life-state el([^"]*)" href="[^"]*%23${name}"[^>]*>.*?</a>`,
      ),
    )![0];
  match(
    lit("activating"),
    /^<a class="life-state el is-lit is-inherited".*<span class="chip">leads to<\/span>/s,
  );
  match(lit("refused"), /is-lit.*<span class="chip">leads to<\/span>/s);
  match(lit("testing"), /is-lit.*<span class="chip">reached from<\/span>/s);
  doesNotMatch(lit("proposed"), /is-lit|el-why/);
  doesNotMatch(lit("awaiting-admission"), /is-lit|el-why/);
  // Closing keeps the lifecycle on show.
  match(detail, /class="detail-x" href="\/system\?page=flows&amp;flow=life"/);
});

Deno.test("a lifecycle that declares no state says so", () => {
  const model = flowBoard();
  const bare = {
    ...model,
    columns: model.columns.map((column) =>
      column.id === "guarantees"
        ? {
          ...column,
          items: [
            item("life", "lifecycle", "Empty", {
              track: { mainCount: 0, transitions: 0, states: [] },
            }),
          ],
        }
        : column
    ),
  };
  const html = flows(bare, { flow: "life" });
  match(html, /<p class="view-empty" data-code="no-state">No states yet<\/p>/);
  doesNotMatch(html, /life-state/);
});

Deno.test("a model of one unit with a plain flow draws it with no mark of twins", () => {
  const html = flows(watchBoard());
  doesNotMatch(html, /flows-times|Lifecycles/);
  equal((html.match(/class="vcard/g) ?? []).length, 4);
});
