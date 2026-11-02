import { deepStrictEqual, equal } from "node:assert/strict";
import type {
  BoardColumnId,
  BoardItem,
  BoardStep,
  BoardTrackState,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import {
  admissionStates,
  ANALYST,
  board,
  capability,
  COORDINATOR,
  flowBoard,
  initialBoard,
  item,
  unit,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { indexBoard } from "../board/lookup.ts";
import { flowsOf, lifecycleColumns, shownFlow } from "./flows.ts";

const PROMOTION = `${COORDINATOR}.promotion`;
const ANALYST_PROMOTION = `${ANALYST}.promotion`;
const CONVERSATION = `${COORDINATOR}.conversation`;

const entries = (model: ReturnType<typeof flowsOf>) => ({
  flows: model.flows.map((entry) => entry.items.map((i) => i.id)),
  lifecycles: model.lifecycles.map((entry) => entry.items.map((i) => i.id)),
});

Deno.test("the flows are the items with steps, the lifecycles the items with states; the same flow in several units is one entry", () => {
  deepStrictEqual(entries(flowsOf(flowBoard())), {
    // The promotion of both units is one entry, the coordinator's first.
    flows: [[PROMOTION, ANALYST_PROMOTION], [CONVERSATION]],
    lifecycles: [["life"]],
  });
  equal(flowsOf(flowBoard()).flows[0].kind, "flow");
  equal(flowsOf(flowBoard()).lifecycles[0].kind, "lifecycle");
});

Deno.test("only what the index puts at home on this page is behavior: no tool, no empty flow, no lifecycle without states shown as a flow", () => {
  // A capability without steps is an action, not a flow: Explore holds it.
  const plain = board({
    team: [unit({ id: COORDINATOR, title: "liveBuilder" })],
    cando: [capability("a", COORDINATOR, "reply"), item("t", "tool", "read")],
  });
  deepStrictEqual(entries(flowsOf(plain)), { flows: [], lifecycles: [] });
  deepStrictEqual(entries(flowsOf(board({}))), { flows: [], lifecycles: [] });
  // Steps in a column that is not the model's behavior are explored, not drawn as a flow.
  const elsewhere = board({
    team: [unit({ id: COORDINATOR, title: "liveBuilder" })],
    rules: [capability("odd", COORDINATOR, "odd", 2)],
  });
  deepStrictEqual(entries(flowsOf(elsewhere)), { flows: [], lifecycles: [] });
  // A model with flows and no lifecycle has no lifecycles.
  deepStrictEqual(entries(flowsOf(initialBoard())).lifecycles, []);
  deepStrictEqual(entries(flowsOf(watchBoard())), {
    flows: [[`${COORDINATOR}.promotion`]],
    lifecycles: [],
  });
});

Deno.test("flows that differ in what a person reads are not twins", () => {
  const base = flowBoard();
  const other = {
    ...base,
    columns: base.columns.map((column) =>
      column.id === "cando"
        ? {
          ...column,
          items: column.items.map((entry) =>
            entry.id === ANALYST_PROMOTION
              ? { ...entry, summary: "Another way to promote." }
              : entry
          ),
        }
        : column
    ),
  };
  deepStrictEqual(entries(flowsOf(other)).flows, [
    [PROMOTION],
    [ANALYST_PROMOTION],
    [CONVERSATION],
  ]);
});

/** The board with the items of one column changed. */
const withItems = (
  model: ModelBoard,
  column: BoardColumnId,
  update: (items: readonly BoardItem[]) => BoardItem[],
): ModelBoard => ({
  ...model,
  columns: model.columns.map((entry) =>
    entry.id === column ? { ...entry, items: update(entry.items) } : entry
  ),
});

Deno.test("twins are one entry only when the page draws them alike: lifecycles with other states are each their own entry", () => {
  const base = flowBoard();
  const life = base.columns.find((column) => column.id === "guarantees")!
    .items[0];
  const copy = (id: string, states: BoardTrackState[]): BoardItem => ({
    ...life,
    id,
    scope: ANALYST,
    track: { ...life.track!, states },
  });
  const states = (id: string) => admissionStates(id);
  // Same name and note, seven states and three: two behaviors, not one marked x2.
  const shorter = withItems(base, "guarantees", (items) => [
    ...items,
    copy("life2", states("life2").slice(0, 3)),
  ]);
  deepStrictEqual(entries(flowsOf(shorter)).lifecycles, [["life"], ["life2"]]);
  // The same lifecycle declared again is the same entry.
  const same = withItems(base, "guarantees", (items) => [
    ...items,
    copy("life3", states("life3")),
  ]);
  deepStrictEqual(entries(flowsOf(same)).lifecycles, [["life", "life3"]]);
  // The track is drawn to its ranks, ends and transitions: each tells twins apart.
  const changed = (over: (state: BoardTrackState) => BoardTrackState) =>
    entries(flowsOf(withItems(base, "guarantees", (items) => [
      ...items,
      copy("lifeX", states("lifeX").map(over)),
    ]))).lifecycles.length;
  equal(changed((state) => state), 1, "an exact copy");
  equal(changed((state) => ({ ...state, rank: 9 })), 2, "another rank");
  equal(
    changed((state) => ({ ...state, terminal: !state.terminal })),
    2,
    "another end",
  );
  equal(
    changed((state) => ({
      ...state,
      out: state.out.map((out) => ({ ...out, guard: "g" })),
    })),
    2,
    "another guard",
  );
  equal(
    changed((state) => ({
      ...state,
      out: state.out.map((out) => ({ ...out, toTitle: "elsewhere" })),
    })),
    2,
    "another target",
  );
});

Deno.test("twins are one entry only when the page draws them alike: flows with another thread are each their own entry", () => {
  const base = flowBoard();
  const analyst = base.columns.find((column) => column.id === "cando")!.items
    .find((entry) => entry.id === ANALYST_PROMOTION)!;
  const changed = (over: (step: BoardStep) => BoardStep) =>
    entries(
      flowsOf(withItems(base, "cando", (items) =>
        items.map((entry) =>
          entry.id === ANALYST_PROMOTION
            ? { ...analyst, steps: analyst.steps!.map(over) }
            : entry
        ))),
    ).flows;
  // The same kinds and titles in the same order, drawn differently.
  deepStrictEqual(
    changed((step) => step),
    [[PROMOTION, ANALYST_PROMOTION], [CONVERSATION]],
    "an exact copy",
  );
  for (
    const [what, over] of [
      [
        "another guard",
        (step: BoardStep) => step.guard ? { ...step, guard: "other" } : step,
      ],
      [
        "another branch",
        (step: BoardStep) =>
          step.branch === "if" ? { ...step, branch: "when" } : step,
      ],
      [
        "another depth",
        (step: BoardStep) =>
          step.branch === "else" ? { ...step, depth: 0 } : step,
      ],
      [
        "another jump",
        (step: BoardStep) =>
          step.toTitle ? { ...step, toTitle: "elsewhere" } : step,
      ],
      [
        "another loop",
        (step: BoardStep) =>
          step.loops
            ? { ...step, loops: [{ to: "x", toTitle: "again" }] }
            : step,
      ],
    ] as const
  ) {
    deepStrictEqual(
      changed(over).map((entry) => entry.length),
      [1, 1, 1],
      what,
    );
  }
});

const model = flowsOf(flowBoard());
const element = (id: string) => indexBoard(flowBoard()).get(id);
const read = (over: { selected?: string; flow?: string | null } = {}) => {
  const shown = shownFlow(model, {
    selected: over.selected ? element(over.selected) : undefined,
    flow: over.flow ?? null,
  });
  return shown && [shown.item.id, shown.entry.kind];
};

Deno.test("the first entry is read by default, and a lifecycle only when there is no flow", () => {
  deepStrictEqual(read(), [PROMOTION, "flow"]);
  deepStrictEqual(
    shownFlow(
      { flows: [], lifecycles: model.lifecycles },
      { selected: undefined, flow: null },
    )?.item.id,
    "life",
  );
  equal(
    shownFlow({ flows: [], lifecycles: [] }, {
      selected: undefined,
      flow: null,
    }),
    undefined,
  );
});

Deno.test("the flow the address asks for is read, a twin by its own id; one that is none leaves the first", () => {
  deepStrictEqual(read({ flow: CONVERSATION }), [CONVERSATION, "flow"]);
  deepStrictEqual(read({ flow: "life" }), ["life", "lifecycle"]);
  // The twin asked for is the one read, and it is the same entry.
  deepStrictEqual(read({ flow: ANALYST_PROMOTION }), [
    ANALYST_PROMOTION,
    "flow",
  ]);
  equal(
    shownFlow(model, { selected: undefined, flow: ANALYST_PROMOTION })?.entry,
    model.flows[0],
  );
  deepStrictEqual(read({ flow: "ghost" }), [PROMOTION, "flow"]);
  deepStrictEqual(read({ flow: "" }), [PROMOTION, "flow"]);
});

Deno.test("what the address selects wins over the flow it asks for: a step or a state is read in its own flow, a flow is read itself", () => {
  deepStrictEqual(
    read({ selected: `${CONVERSATION}#wait`, flow: PROMOTION }),
    [CONVERSATION, "flow"],
  );
  // A step of a twin is read in that twin.
  deepStrictEqual(read({ selected: `${ANALYST_PROMOTION}#test` }), [
    ANALYST_PROMOTION,
    "flow",
  ]);
  deepStrictEqual(read({ selected: "life#testing", flow: PROMOTION }), [
    "life",
    "lifecycle",
  ]);
  deepStrictEqual(read({ selected: CONVERSATION, flow: PROMOTION }), [
    CONVERSATION,
    "flow",
  ]);
  // What is no flow's leaves the flow asked for.
  deepStrictEqual(read({ selected: COORDINATOR, flow: CONVERSATION }), [
    CONVERSATION,
    "flow",
  ]);
  deepStrictEqual(read({ selected: `${COORDINATOR}.read` }), [
    PROMOTION,
    "flow",
  ]);
});

Deno.test("a lifecycle's states stand in columns by rank, those no path reaches next, the ends last", () => {
  const states = admissionStates("life");
  deepStrictEqual(
    lifecycleColumns(states).map((c) => [
      c.kind,
      c.rank,
      c.states.map((s) => s.title),
    ]),
    [
      ["rank", 0, ["proposed"]],
      ["rank", 1, ["testing"]],
      // The states at one rank keep the board's order.
      ["rank", 2, ["reviewing", "awaiting-admission"]],
      ["rank", 3, ["activating"]],
      // A state that ends the lifecycle is in the last column, whatever its rank.
      ["end", null, ["active", "refused"]],
    ],
  );
  const unreached = [
    ...states,
    { ...states[1], id: "x", title: "orphan", rank: null },
  ];
  deepStrictEqual(
    lifecycleColumns(unreached).map((c) => c.kind),
    ["rank", "rank", "rank", "rank", "unreached", "end"],
  );
  deepStrictEqual(lifecycleColumns([]), []);
});

Deno.test("ranks are ordered as numbers: 10 comes after 9", () => {
  const states = admissionStates("life");
  const ranked = [10, 9, 2].map((rank, at) => ({
    ...states[1],
    id: `s${at}`,
    title: `s${rank}`,
    rank,
  }));
  deepStrictEqual(
    lifecycleColumns(ranked).map((c) => c.rank),
    [2, 9, 10],
  );
});
