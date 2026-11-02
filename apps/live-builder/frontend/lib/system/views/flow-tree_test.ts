import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { BoardStep } from "../../../../src/domain/model/records/board.ts";
import {
  allocatedBoard,
  ANALYST,
  board,
  COORDINATOR,
  flowBoard,
  flowEnd,
  flowGoto,
  flowStep,
  promotionSteps,
} from "../../../test/support/board-fixture.ts";
import { indexBoard } from "../board/lookup.ts";
import {
  choosable,
  flattened,
  type FlowNode,
  flowTreeOf,
} from "./flow-tree.ts";

/** The shape of a tree, as titles: a branch is `[label guard, ...its body]`. */
type Shape = string | [string, ...Shape[]];
function shape(nodes: readonly FlowNode[]): Shape[] {
  return nodes.map((node) => {
    const name = `${node.kind} ${node.step.title ?? node.step.toTitle}`;
    return node.branches.length === 0 ? name : [
      name,
      ...node.branches.map((branch): Shape => [
        `${branch.label}${branch.guard ? ` ${branch.guard}` : ""}`,
        ...shape(branch.body),
      ]),
    ];
  });
}

const alone = indexBoard(board({}));
const treeOf = (steps: readonly BoardStep[]) =>
  flowTreeOf(alone, { steps, scope: undefined });
const step = (key: string, kind: string, over: Partial<BoardStep> = {}) =>
  flowStep("f", key, kind, key, over);

Deno.test("a decision with two branches: the first step of each opens it, with its guard, and the steps after it stay in it", () => {
  const tree = treeOf([
    step("start", "action"),
    step("check", "decision"),
    step("accept", "action", { depth: 1, branch: "if", guard: "ok" }),
    step("record", "action", { depth: 1 }),
    step("reject", "action", { depth: 1, branch: "else" }),
    step("after", "action"),
  ]);
  deepStrictEqual(shape(tree), [
    "action start",
    [
      "decision check",
      ["if ok", "action accept", "action record"],
      ["else", "action reject"],
    ],
    "action after",
  ]);
  // The guard is the first step's, and the branch carries it; an else has none.
  equal(tree[1].branches[0].guard, "ok");
  equal("guard" in tree[1].branches[1], false);
});

Deno.test("the real promotion flow: nested decisions, jumps that name where they go, merges, a loop, and the end", () => {
  const tree = treeOf(promotionSteps("f"));
  deepStrictEqual(shape(tree), [
    "action propose",
    "action test",
    [
      "decision testOutcome",
      [
        "if test.result.passed",
        "action admit",
        [
          "decision admissionOutcome",
          [
            "if admit.decision.admitted",
            "action activate",
            "goto completion",
          ],
          ["else", "goto refusal"],
        ],
      ],
      ["else", "goto refusal"],
    ],
    "merge refusal",
    "action refuse",
    "merge completion",
    "end done",
  ]);
  // A jump says where it goes; a loop says where it comes back to.
  const jump = flattened(tree).find((node) => node.kind === "goto")!;
  equal(jump.step.toTitle, "completion");
  equal(jump.step.forward, true);
  const refuse = flattened(tree).find((node) => node.step.title === "refuse")!;
  deepStrictEqual(refuse.loops, [{ to: "f#propose", toTitle: "propose" }]);
  deepStrictEqual(
    flattened(tree).filter((node) => node.loops.length > 0).map((node) =>
      node.id
    ),
    ["f#refuse"],
  );
});

Deno.test("nothing is lost or reordered: every step of the board is a node of the tree, once, in the board's order", () => {
  const steps = promotionSteps("f");
  deepStrictEqual(
    flattened(treeOf(steps)).map((node) => node.id),
    steps.map((entry) => entry.id),
  );
});

Deno.test("a merge that follows its branches is back in the sequence, at the decision's own depth", () => {
  const tree = treeOf([
    step("d", "decision"),
    step("a", "action", { depth: 1, branch: "if", guard: "x" }),
    step("b", "action", { depth: 1, branch: "else" }),
    step("m", "merge"),
    step("z", "action"),
  ]);
  deepStrictEqual(shape(tree), [
    ["decision d", ["if x", "action a"], ["else", "action b"]],
    "merge m",
    "action z",
  ]);
});

Deno.test("a step that is not a decision can split the thread too: a fork's parallel branches, or several successors", () => {
  const tree = treeOf([
    step("fork", "fork"),
    step("left", "action", { depth: 1, branch: "parallel" }),
    step("right", "action", { depth: 1, branch: "parallel" }),
    step("join", "join"),
    step("busy", "action"),
    step("one", "action", { depth: 1, branch: "then" }),
    step("two", "action", { depth: 1, branch: "then" }),
  ]);
  deepStrictEqual(shape(tree), [
    [
      "fork fork",
      ["parallel", "action left"],
      ["parallel", "action right"],
    ],
    "join join",
    [
      "action busy",
      ["then", "action one"],
      ["then", "action two"],
    ],
  ]);
});

Deno.test("a branch that holds several steps ends where the next branch of its decision starts, however deep the steps in it go", () => {
  const tree = treeOf([
    step("d", "decision"),
    step("a", "action", { depth: 1, branch: "if", guard: "x" }),
    step("inner", "decision", { depth: 1 }),
    step("p", "action", { depth: 2, branch: "if", guard: "y" }),
    step("q", "action", { depth: 2, branch: "else" }),
    step("tail", "action", { depth: 1 }),
    step("b", "action", { depth: 1, branch: "else" }),
  ]);
  deepStrictEqual(shape(tree), [[
    "decision d",
    [
      "if x",
      "action a",
      ["decision inner", ["if y", "action p"], ["else", "action q"]],
      "action tail",
    ],
    ["else", "action b"],
  ]]);
});

Deno.test("a step the board puts deeper with no split to own it stays in the sequence, and a missing depth is the thread's", () => {
  const stray = treeOf([
    step("a", "action"),
    step("b", "action", { depth: 3 }),
    step("c", "action", { depth: undefined }),
  ]);
  deepStrictEqual(shape(stray), ["action a", "action b", "action c"]);
  // A branch mark where no split is open does not end the thread: nothing after it is lost.
  deepStrictEqual(
    shape(treeOf([
      step("a", "action"),
      step("b", "action", { branch: "if", guard: "x" }),
      step("c", "action"),
    ])),
    ["action a", "action b", "action c"],
  );
  // A branch that starts two levels under the step before it is no branch of it.
  deepStrictEqual(
    shape(treeOf([
      step("a", "action"),
      step("b", "action", { depth: 2, branch: "if" }),
      step("c", "action"),
    ])),
    ["action a", "action b", "action c"],
  );
  deepStrictEqual(shape(treeOf([])), []);
  deepStrictEqual(
    shape(flowTreeOf(alone, { steps: undefined, scope: undefined })),
    [],
  );
});

Deno.test("the library's start is not a step: the thread draws its own", () => {
  const tree = treeOf([
    step("begin", "start"),
    step("a", "action"),
  ]);
  deepStrictEqual(shape(tree), ["action a"]);
});

Deno.test("a step no path reaches keeps its mark, for the page to say", () => {
  const tree = treeOf([
    step("a", "action"),
    step("orphan", "action", { unreachable: true }),
  ]);
  equal(tree[0].step.unreachable, undefined);
  equal(tree[1].step.unreachable, true);
});

Deno.test("only a step, a decision and a merge can be chosen: a jump and the end are marks of the thread", () => {
  const tree = treeOf([
    ...promotionSteps("f"),
    step("legacy", "done"),
  ]);
  deepStrictEqual(
    [...new Set(flattened(tree).filter(choosable).map((node) => node.kind))],
    ["action", "decision", "merge"],
  );
  deepStrictEqual(
    [
      ...new Set(
        flattened(tree).filter((n) => !choosable(n)).map((n) => n.kind),
      ),
    ],
    ["goto", "end", "done"],
  );
  ok(!choosable(treeOf([flowEnd("f")])[0]));
  ok(!choosable(treeOf([flowGoto("f", "g", "x", 0)])[0]));
});

Deno.test("who performs a step is whoever the model allocates it to, by the step or by the element it declares", () => {
  const model = flowBoard();
  const index = indexBoard(model);
  const flow = model.columns.find((c) => c.id === "cando")!.items.find((i) =>
    i.id === `${COORDINATOR}.promotion`
  )!;
  const performers = (nodes: readonly FlowNode[], title: string) =>
    flattened(nodes).find((node) => node.step.title === title)!.performers.map(
      (p) => p.id,
    );
  const tree = flowTreeOf(index, flow);
  // By the step's own id, to an operator and to a machine.
  deepStrictEqual(performers(tree, "propose"), [`${COORDINATOR}.operator`]);
  deepStrictEqual(performers(tree, "test"), [`${COORDINATOR}.sandbox`]);
  // By the Toolkit's id of the step, which the link names instead of the card's.
  deepStrictEqual(performers(tree, "admit"), [`${COORDINATOR}.catalog`]);
  // Nothing is allocated, or the allocation ends where the board holds nothing.
  deepStrictEqual(performers(tree, "activate"), []);
  deepStrictEqual(performers(tree, "refuse"), []);
});

Deno.test("a twin is performed by its own unit's operators, never by another unit's", () => {
  const model = flowBoard();
  const index = indexBoard(model);
  const cando = model.columns.find((c) => c.id === "cando")!.items;
  const analyst = flowTreeOf(
    index,
    cando.find((i) => i.id === `${ANALYST}.promotion`)!,
  );
  const performers = (title: string) =>
    flattened(analyst).find((node) => node.step.title === title)!.performers
      .map((p) => p.id);
  deepStrictEqual(performers("propose"), [`${ANALYST}.operator`]);
  // `test` is allocated to the coordinator's sandbox by the coordinator's step alone.
  deepStrictEqual(performers("test"), []);
  // `admit` is allocated by the id both twins share, to a part of the coordinator's unit.
  deepStrictEqual(performers("admit"), []);
});

Deno.test("a step the model allocates by its own id keeps every performer, whichever unit holds it or none does", () => {
  const model = allocatedBoard();
  const promotion = model.columns.find((c) => c.id === "cando")!.items.find((
    i,
  ) => i.id === `${COORDINATOR}.promotion`)!;
  const tree = flowTreeOf(indexBoard(model), promotion);
  const performers = (key: string) =>
    flattened(tree).find((node) => node.id === `${promotion.id}.${key}`)!
      .performers.map((p) => p.id);
  // The coordinator's own step, allocated to the analyst's operator.
  deepStrictEqual(performers("step3"), [`${ANALYST}.operator`]);
  // And one allocated to a machine no unit claims, next to its own unit's operator.
  deepStrictEqual(performers("step1"), [`${COORDINATOR}.operator`, "loose"]);
  // The ones in its own unit are what they were.
  deepStrictEqual(performers("step0"), [`${COORDINATOR}.operator`]);
  deepStrictEqual(performers("step2"), [`${COORDINATOR}.sandbox`]);
});

Deno.test("what the model allocates by the element a step declares is shared by twins only within their unit, but by the step's own id it is that step's alone", () => {
  const model = flowBoard();
  const index = indexBoard(model);
  const flows = model.columns.find((c) => c.id === "cando")!.items;
  const performersOf = (flow: string, title: string) =>
    flattened(flowTreeOf(index, flows.find((i) => i.id === flow)!)).find((
      node,
    ) => node.step.title === title)!.performers.map((p) => p.id);
  // `propose` is allocated by each step's own id: neither twin borrows the other's.
  deepStrictEqual(performersOf(`${COORDINATOR}.promotion`, "propose"), [
    `${COORDINATOR}.operator`,
  ]);
  deepStrictEqual(performersOf(`${ANALYST}.promotion`, "propose"), [
    `${ANALYST}.operator`,
  ]);
  // Now the analyst's own step is allocated to the coordinator's sandbox, by its id:
  // it is the analyst's step performer, and the coordinator's twin is not given it.
  const crossed = {
    ...model,
    links: [...model.links, {
      ...model.links[0],
      id: "cross",
      kind: "allocate" as const,
      from: `${ANALYST}.promotion#propose`,
      to: `${COORDINATOR}.sandbox`,
    }],
  };
  const crossedIndex = indexBoard(crossed);
  const analystPropose = flattened(
    flowTreeOf(
      crossedIndex,
      flows.find((i) => i.id === `${ANALYST}.promotion`)!,
    ),
  ).find((node) => node.step.title === "propose")!;
  deepStrictEqual(analystPropose.performers.map((p) => p.id), [
    `${ANALYST}.operator`,
    `${COORDINATOR}.sandbox`,
  ]);
  const coordinatorPropose = flattened(
    flowTreeOf(
      crossedIndex,
      flows.find((i) => i.id === `${COORDINATOR}.promotion`)!,
    ),
  ).find((node) => node.step.title === "propose")!;
  deepStrictEqual(coordinatorPropose.performers.map((p) => p.id), [
    `${COORDINATOR}.operator`,
  ]);
});

Deno.test("a flow with no unit keeps every performer of the element it declares", () => {
  const model = flowBoard();
  const index = indexBoard(model);
  const flow = model.columns.find((c) => c.id === "cando")!.items.find((i) =>
    i.id === `${ANALYST}.promotion`
  )!;
  const open = flowTreeOf(index, { steps: flow.steps, scope: undefined });
  deepStrictEqual(
    flattened(open).find((node) => node.step.title === "admit")!.performers
      .map((p) => p.id),
    [`${COORDINATOR}.catalog`],
  );
});

Deno.test("a step several parts perform lists each once, in the order the model allocates them", () => {
  const model = flowBoard();
  const twice = {
    ...model,
    links: [
      ...model.links,
      ...model.links.filter((entry) => entry.kind === "allocate").slice(0, 1),
      {
        ...model.links[0],
        id: "extra",
        to: `${COORDINATOR}.catalog`,
        from: `${COORDINATOR}.promotion#propose`,
      },
    ],
  };
  const flow = twice.columns.find((c) => c.id === "cando")!.items.find((i) =>
    i.id === `${COORDINATOR}.promotion`
  )!;
  const tree = flowTreeOf(indexBoard(twice), flow);
  deepStrictEqual(
    tree[0].performers.map((p) => p.id),
    [`${COORDINATOR}.operator`, `${COORDINATOR}.catalog`],
  );
});
