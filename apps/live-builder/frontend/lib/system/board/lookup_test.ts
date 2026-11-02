import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
  ANALYST,
  board,
  COLLECTOR,
  COORDINATOR,
  flowBoard,
  initialBoard,
  item,
  kitchenSink,
  link,
  linkedBoard,
  tool,
  unit,
  watchBoard,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import { agentUnits, indexBoard } from "./lookup.ts";

const OPERATOR = `${COORDINATOR}.operator`;
const labelsOf = (relations: readonly { label: string }[]) =>
  relations.map((relation) => relation.label);

Deno.test("every element of the board is one registry, whatever depth it is held at", () => {
  const index = indexBoard(kitchenSink());
  // An item of the team column is the home of a unit.
  const panel = index.get("panel");
  equal(panel?.kind, "scope");
  equal(panel?.home, "team");
  equal(panel?.column, "team");
  equal(panel?.parent, undefined);
  // Its port: structure, inside the panel, with the id the Toolkit gives it.
  const port = index.get("p1");
  equal(port?.kind, "port");
  equal(port?.home, "structure");
  equal(port?.parent, "panel");
  equal(port?.element, "p1");
  // The steps of a flow, and the flow that holds them.
  equal(index.get("flow")?.home, "behavior");
  const step = index.get("s2");
  equal(step?.kind, "action");
  equal(step?.parent, "flow");
  equal(step?.home, "behavior");
  equal(step?.title, "go");
  // A step with neither title nor keyword is still told by its kind.
  const bare = index.get("s1");
  equal(bare?.title, "decision");
  equal(bare?.keyword, "");
  equal(bare?.guard, "ok");
  // A lifecycle with a track is behaviour; its states are inside it.
  equal(index.get("life")?.home, "behavior");
  const state = index.get("st1");
  equal(state?.kind, "state");
  equal(state?.parent, "life");
  // A requirement and its clauses are requirements.
  equal(index.get("req")?.home, "requirements");
  const clause = index.get("c1");
  equal(clause?.kind, "clause");
  equal(clause?.parent, "req");
  equal(clause?.home, "requirements");
  equal(clause?.expression, "a < b");
  equal(index.get("nothing"), undefined);
  equal(index.get("constructor"), undefined);
});

Deno.test("an element lives where its column puts it: the team is the home of units, what they hold is explored", () => {
  const index = indexBoard(watchBoard());
  const home = (id: string) => index.get(id)?.home;
  equal(home(COORDINATOR), "team");
  // What a unit holds is its structure.
  equal(home(OPERATOR), "structure");
  equal(home(`${COORDINATOR}.sandbox`), "structure");
  equal(index.get(OPERATOR)?.parent, COORDINATOR);
  // Tools and rules are explored; a flow with steps is behaviour.
  equal(home(`${COORDINATOR}.read`), "explore");
  equal(home(`${COORDINATOR}.mandate`), "explore");
  equal(home(`${COORDINATOR}.promotion`), "behavior");
  equal(home(`${COORDINATOR}.promotion.step0`), "behavior");
  // A capability that declares no steps has no flow to read.
  const plain = board({
    cando: [item("reply", "capability", "reply")],
    information: [item("note", "information", "note")],
  });
  equal(indexBoard(plain).get("reply")?.home, "explore");
  equal(indexBoard(plain).get("note")?.home, "explore");
});

Deno.test("the first declaration of an id is the element: a repeat is a twin of it", () => {
  const twin = board({
    cando: [
      item("t", "tool", "first"),
      item("t", "tool", "second"),
    ],
  });
  equal(indexBoard(twin).get("t")?.title, "first");
});

Deno.test("an address names an element by its board id, by the id the Toolkit gives it, or by the card that holds it", () => {
  const nested = item("card", "scope", "card", {
    children: [item("card.part", "operator", "part", { element: "native-1" })],
  });
  const model = {
    ...board({ team: [nested] }),
    index: {
      "deep#id": { column: "team" as const, card: "card" },
      "lost#id": { column: "team" as const, card: "gone" },
    },
  };
  const index = indexBoard(model);
  equal(index.resolve("card.part"), "card.part");
  equal(index.resolve("native-1"), "card.part");
  // A name the board indexes by its card leads to the card.
  equal(index.resolve("deep#id"), "card");
  // The card of an index entry is one the board holds, or the entry is none.
  equal(index.resolve("lost#id"), null);
  equal(index.resolve("unknown"), null);
  equal(index.resolve(""), null);
  // Names of the language are no ids.
  for (
    const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]
  ) {
    equal(index.resolve(name), null, name);
  }
});

Deno.test("an element is within itself and within what holds it, by the chain of parents", () => {
  const index = indexBoard(linkedBoard());
  ok(index.within(OPERATOR, OPERATOR));
  ok(index.within(OPERATOR, COORDINATOR));
  ok(!index.within(COORDINATOR, OPERATOR));
  ok(!index.within(OPERATOR, ANALYST));
  // A step is inside its flow, not inside the unit the flow is declared in.
  ok(
    index.within(`${COORDINATOR}.promotion.step0`, `${COORDINATOR}.promotion`),
  );
  ok(!index.within(`${COORDINATOR}.promotion.step0`, COORDINATOR));
  // An id the board does not hold is within only itself.
  ok(index.within("ghost", "ghost"));
  ok(!index.within("ghost", COORDINATOR));
});

Deno.test("relations: the direction is told by which end is inside the element, with the host's words for each way", () => {
  const index = indexBoard(linkedBoard());
  // The operator calls the tool: forward from the operator, reverse from the tool.
  const fromOperator = index.relations(OPERATOR);
  const calls = fromOperator.find((relation) =>
    relation.link.kind === "can-call"
  );
  equal(calls?.label, "may call");
  equal(calls?.other, `${COORDINATOR}.read`);
  const fromTool = index.relations(`${COORDINATOR}.read`);
  deepStrictEqual(
    fromTool.map((relation) => [relation.label, relation.other]),
    [
      ["callable by", OPERATOR],
    ],
  );
  // The step is allocated to the operator: performed by it, from the step's side.
  deepStrictEqual(
    index.relations(`${COORDINATOR}.promotion.step0`).map((
      relation,
    ) => [relation.label, relation.other]),
    [["performed by", OPERATOR]],
  );
  // From the flow that holds the step, the same link, as the flow's.
  deepStrictEqual(
    index.relations(`${COORDINATOR}.promotion`).map((relation) =>
      relation.label
    ),
    ["performed by"],
  );
  // A role keys its own words.
  const holds = index.relations(`${COORDINATOR}.mandate`);
  deepStrictEqual(labelsOf(holds), ["mandate of"]);
  equal(holds[0].other, OPERATOR);
});

Deno.test("relations of a unit are those of the parts inside it, once, without the links that say nothing a person asked for", () => {
  const index = indexBoard(linkedBoard());
  const relations = index.relations(COORDINATOR);
  // The operator's three links lead out of the unit; the unit owning its operator,
  // performing its flow (strength scope), and its two machines joined do not.
  deepStrictEqual(
    relations.map((relation) => [relation.label, relation.other]),
    [
      ["may call", `${COORDINATOR}.read`],
      ["holds mandate", `${COORDINATOR}.mandate`],
      ["performs", `${COORDINATOR}.promotion.step0`],
    ],
  );
  ok(
    relations.every((relation) =>
      relation.link.strength !== "scope" && relation.link.kind !== "own"
    ),
  );
  // The two machines are joined, and so related, from one to the other.
  const machine = index.relations(`${COORDINATOR}.sandbox`);
  deepStrictEqual(machine.map((relation) => [relation.label, relation.other]), [
    ["connected to", `${COORDINATOR}.catalog`],
  ]);
  // The other unit has nothing to do with these.
  deepStrictEqual(
    index.relations(ANALYST).map((relation) => relation.other),
    [`${ANALYST}.read`],
  );
  equal(index.relations(COLLECTOR).length, 0);
});

Deno.test("a link between the inside of an element and itself, or wholly outside it, is no relation of it", () => {
  const index = indexBoard(linkedBoard());
  // Both machines are inside the unit: from the unit the connection is internal.
  ok(
    !index.relations(COORDINATOR).some((relation) =>
      relation.link.kind === "connect"
    ),
  );
  // Wholly outside the analyst.
  ok(
    !index.relations(ANALYST).some((relation) =>
      relation.link.kind === "connect"
    ),
  );
});

Deno.test("without the host's words for a link, its key says what it is", () => {
  const bare = withLinks(linkedBoard(), linkedBoard().links, {});
  const index = indexBoard(bare);
  deepStrictEqual(labelsOf(index.relations(OPERATOR)), [
    "can-call",
    "bind:mandate",
    "allocate",
  ]);
  // A board that gives no words at all.
  const none = { ...linkedBoard() };
  none.meta = { ...none.meta };
  delete none.meta.linkLabels;
  deepStrictEqual(labelsOf(indexBoard(none).relations(OPERATOR)), [
    "can-call",
    "bind:mandate",
    "allocate",
  ]);
});

Deno.test("links whose end is named by the id the Toolkit gives are followed to the element", () => {
  const model = withLinks(
    board({
      team: [
        item("u", "scope", "u", {
          children: [item("u.op", "operator", "op", { element: "native-op" })],
        }),
      ],
      cando: [tool("u.tool", "u", "search")],
    }),
    [link("can-call", "native-op", "u.tool")],
  );
  const relations = indexBoard(model).relations("u");
  deepStrictEqual(
    relations.map((relation) => [relation.label, relation.other]),
    [
      ["may call", "u.tool"],
    ],
  );
  // An end the board does not hold is kept as written: it can still be told apart.
  const dangling = withLinks(
    board({ team: [unit({ id: "u", title: "u" })] }),
    [link("can-call", "u.operator", "elsewhere")],
  );
  const kept = indexBoard(dangling).relations("u");
  equal(kept[0].other, "elsewhere");
});

Deno.test("relations are grouped by what they say, each element once, those the board does not hold left out", () => {
  const model = withLinks(
    board({
      team: [unit({ id: "u", title: "u" })],
      cando: [tool("t1", "u", "one"), tool("t2", "u", "two")],
    }),
    [
      link("can-call", "u.operator", "t1"),
      link("can-call", "u.operator", "t1", { id: "again" }),
      link("can-call", "u.operator", "t2"),
      link("allocate", "t1", "u.operator"),
      link("can-call", "u.operator", "gone"),
    ],
  );
  const groups = indexBoard(model).groups("u");
  deepStrictEqual(
    groups.map((group) => [group.label, group.others.map((e) => e.id)]),
    [
      ["may call", ["t1", "t2"]],
      ["performs", ["t1"]],
    ],
  );
  deepStrictEqual(indexBoard(model).groups("t2").map((g) => g.label), [
    "callable by",
  ]);
  equal(indexBoard(model).groups("nothing").length, 0);
});

Deno.test("a selection lights what it is related to, with the reason, and the ground around it", () => {
  const index = indexBoard(linkedBoard());
  const lens = index.lens(`${COORDINATOR}.read`);
  equal(lens.selected, `${COORDINATOR}.read`);
  // The operator calls the tool; so does the unit it is inside, and the machines
  // beside it are neither.
  deepStrictEqual(lens.labels(OPERATOR), ["callable by"]);
  deepStrictEqual(lens.labels(COORDINATOR), ["callable by"]);
  deepStrictEqual(lens.labels(`${COORDINATOR}.sandbox`), []);
  deepStrictEqual(lens.labels(ANALYST), []);
  // The reason where the relation ends is the operator's, not the unit's around it.
  deepStrictEqual(lens.own(OPERATOR), ["callable by"]);
  deepStrictEqual(lens.own(COORDINATOR), []);
  deepStrictEqual(lens.own(`${COORDINATOR}.sandbox`), []);
  // A card is context when it holds the selection or is held by it.
  ok(!lens.context(`${COORDINATOR}.read`));
  const inner = index.lens(OPERATOR);
  ok(inner.context(COORDINATOR));
  ok(!inner.context(ANALYST));
  ok(index.lens(COORDINATOR).context(OPERATOR));
  // Several relations of one card with the same words are said once.
  const twice = indexBoard(withLinks(
    board({ team: [unit({ id: "u", title: "u" })] }),
    [
      link("connect", "u.sandbox", "x"),
      link("connect", "u.catalog", "x", { id: "second" }),
    ],
  ));
  deepStrictEqual(twice.lens("x").labels("u"), ["connected to"]);
});

Deno.test("a board has one index: asked again it is the same, and another board has its own", () => {
  const model = initialBoard();
  equal(indexBoard(model), indexBoard(model));
  notEqual(indexBoard(model), indexBoard(initialBoard()));
});

Deno.test("a step knows the flow that holds it, an item the unit it is declared for", () => {
  const index = indexBoard(linkedBoard());
  const step = index.get(`${COORDINATOR}.promotion.step0`);
  equal(
    index.flowOf(`${COORDINATOR}.promotion.step0`),
    `${COORDINATOR}.promotion`,
  );
  equal(
    step?.parent,
    `${COORDINATOR}.promotion`,
    "one fact: the flow is the step's parent",
  );
  equal(step?.scope, undefined);
  // Only a step has a flow, only an item a scope.
  equal(index.flowOf(`${COORDINATOR}.promotion`), null);
  equal(index.get(`${COORDINATOR}.promotion`)?.scope, COORDINATOR);
  equal(index.get(OPERATOR)?.scope, undefined);
});

Deno.test("what is nested in a unit's structure is not a step, whatever it is inside of", () => {
  const index = indexBoard(linkedBoard());
  // A part has a parent, as a step does, and a state a lifecycle; neither has a flow.
  equal(index.get(OPERATOR)?.parent, COORDINATOR);
  equal(index.flowOf(OPERATOR), null);
  equal(index.flowOf("ghost"), null);
  equal(index.flowOf("constructor"), null);
});

Deno.test("the units are the items of the team column, in the board's order", () => {
  deepStrictEqual(
    indexBoard(watchBoard()).units.map((unit) => unit.id),
    [COORDINATOR, ANALYST, COLLECTOR],
  );
  const named = indexBoard(board({
    team: [unit({ id: "b", title: "b" }), unit({ id: "a", title: "a" })],
    cando: [tool("b.t", "b", "search")],
  }));
  deepStrictEqual(named.units.map((unit) => unit.id), ["b", "a"]);
  deepStrictEqual(indexBoard(board({})).units, []);
});

Deno.test("the agents are the units that are scopes: what else the team column holds is no one who acts", () => {
  const index = indexBoard(board({
    team: [
      unit({ id: "b", title: "b" }),
      item("note", "tool", "a note in the team column"),
      unit({ id: "a", title: "a" }),
    ],
  }));
  deepStrictEqual(index.units.map((one) => one.id), ["b", "note", "a"]);
  deepStrictEqual(agentUnits(index).map((one) => one.id), ["b", "a"]);
  deepStrictEqual(agentUnits(indexBoard(board({}))), []);
});

Deno.test("an element belongs to the unit it is inside, or is declared for, whatever it is called by", () => {
  const model = linkedBoard();
  const index = indexBoard(model);
  // A unit is its own.
  equal(index.unitOf(COORDINATOR), COORDINATOR);
  // What a unit holds, at any depth: by the chain of parents.
  equal(index.unitOf(OPERATOR), COORDINATOR);
  equal(index.unitOf(`${ANALYST}.sandbox`), ANALYST);
  // What it declares outside its structure: by the unit it is declared for.
  equal(index.unitOf(`${ANALYST}.read`), ANALYST);
  equal(index.unitOf(`${ANALYST}.mandate`), ANALYST);
  // A step answers to the flow it is in, and the flow to its unit.
  equal(index.unitOf(`${COORDINATOR}.promotion.step3`), COORDINATOR);
  // The Toolkit's id names the same element.
  const native = indexBoard(kitchenSink());
  equal(native.unitOf("p1"), "panel");
  equal(native.unitOf("c1"), null, "a clause of a guarantee has no unit");
  // Nothing the board does not hold, and no scope that is not a unit.
  equal(index.unitOf("ghost"), null);
  equal(index.unitOf("constructor"), null);
  const stray = indexBoard(board({
    team: [unit({ id: "u", title: "u" })],
    cando: [tool("lost", "not-a-unit", "search")],
  }));
  equal(stray.unitOf("lost"), null);
  equal(stray.unitOf("u.operator"), "u");
});

Deno.test("the links of a kind come with their ends read as the elements the board holds", () => {
  const model = withLinks(watchBoard(), [
    link("allocate", `${COORDINATOR}.promotion.step0`, OPERATOR),
    link("connect", `${COORDINATOR}.sandbox`, `${COORDINATOR}.catalog`),
    // An end the board does not hold stays as the link names it.
    link("allocate", "ghost", OPERATOR),
  ]);
  const index = indexBoard(model);
  deepStrictEqual(
    index.linked("allocate").map(({ from, to }) => [from, to]),
    [[`${COORDINATOR}.promotion.step0`, OPERATOR], ["ghost", OPERATOR]],
  );
  equal(index.linked("connect").length, 1);
  equal(index.linked("subject").length, 0);
  // The link itself is the board's own.
  equal(index.linked("connect")[0].link, model.links[1]);
});

Deno.test("only a requirement or a constraint is at home on Requirements: another guarantee is explored", () => {
  const index = indexBoard(board({
    guarantees: [
      item("r", "requirement", "r"),
      item("c", "constraint", "c"),
      item("i", "information", "i"),
      item("l", "lifecycle", "l", {
        track: { mainCount: 0, transitions: 0, states: [] },
      }),
    ],
  }));
  equal(index.get("r")?.home, "requirements");
  equal(index.get("c")?.home, "requirements");
  equal(index.get("i")?.home, "explore");
  equal(index.get("l")?.home, "behavior");
});

Deno.test("a state of a lifecycle is related to the states its transitions lead to and to those that lead to it", () => {
  const index = indexBoard(flowBoard());
  const groups = (id: string) =>
    index.groups(id).map((group) => [
      group.label,
      group.others.map((other) => other.title),
    ]);
  deepStrictEqual(groups("life#reviewing"), [
    ["leads to", ["activating", "refused"]],
    ["reached from", ["testing"]],
  ]);
  // Two states lead to the same one; each is told once, in the board's order.
  deepStrictEqual(groups("life#activating"), [
    ["leads to", ["active"]],
    ["reached from", ["reviewing", "awaiting-admission"]],
  ]);
  deepStrictEqual(groups("life#proposed"), [["leads to", ["testing"]]]);
  deepStrictEqual(groups("life#active"), [["reached from", ["activating"]]]);
  // The transitions are inside the lifecycle: it relates to nothing by them,
  // and they are not links of the board.
  deepStrictEqual(groups("life"), []);
  deepStrictEqual(index.relations("life#reviewing"), []);
  deepStrictEqual(index.lens("life").labels("life#reviewing"), []);
  // The selection lights the states around it, with the way they are related.
  const lens = index.lens("life#reviewing");
  deepStrictEqual(lens.labels("life#activating"), ["leads to"]);
  deepStrictEqual(lens.labels("life#refused"), ["leads to"]);
  deepStrictEqual(lens.labels("life#testing"), ["reached from"]);
  deepStrictEqual(lens.own("life#testing"), ["reached from"]);
  deepStrictEqual(lens.labels("life#proposed"), []);
  deepStrictEqual(lens.labels("life#awaiting-admission"), []);
  // What holds the states that are related is lit by them, as a unit is by its parts,
  // and it is the context of the selection too.
  deepStrictEqual(lens.labels("life"), ["leads to", "reached from"]);
  equal(lens.context("life"), true);
  // A transition to a state the board does not hold names nothing.
  const lost = flowBoard();
  const life = lost.columns.find((c) => c.id === "guarantees")!.items[0];
  life.track!.states[0].out[0].to = "life#gone";
  deepStrictEqual(
    indexBoard(lost).groups("life#proposed"),
    [],
  );
});
