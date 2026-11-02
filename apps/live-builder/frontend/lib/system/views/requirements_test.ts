import { deepStrictEqual, equal } from "node:assert/strict";
import {
  board,
  constraint,
  guaranteeBoard,
  item,
  requirement,
} from "../../../test/support/board-fixture.ts";
import { markWords, requirementsOf } from "./requirements.ts";

Deno.test("requirements and constraints are told apart, in the board's order, and a lifecycle is neither", () => {
  const { requirements, constraints } = requirementsOf(guaranteeBoard());
  deepStrictEqual(requirements.map((row) => row.item.id), [
    "req.exact",
    "req.fail",
    "req.orphan",
    "req.plain",
  ]);
  deepStrictEqual(constraints.map((row) => row.item.id), [
    "chk.live",
    "chk.idle",
  ]);
});

Deno.test("a requirement is on when some unit answers for it, off when none does", () => {
  const rows = requirementsOf(guaranteeBoard()).requirements;
  const byId = Object.fromEntries(rows.map((row) => [row.item.id, row]));
  equal(byId["req.exact"].mark, "on");
  equal(byId["req.exact"].owners, 2);
  equal(byId["req.fail"].mark, "on");
  equal(byId["req.fail"].owners, 1);
  // An empty list of owners is no owner, not "some".
  equal(byId["req.orphan"].mark, "off");
  equal(byId["req.orphan"].owners, 0);
  // A requirement that says nothing of its owners has none.
  equal(byId["req.plain"].mark, "off");
  equal(byId["req.plain"].owners, 0);
});

Deno.test("a constraint is on when a performed step makes it hold, idle otherwise, and unknown is idle", () => {
  const model = board({
    guarantees: [
      constraint("in", "in", true),
      constraint("out", "out", false),
      { ...constraint("unknown", "unknown", true), inForce: undefined },
    ],
  });
  deepStrictEqual(
    requirementsOf(model).constraints.map((row) => row.mark),
    ["on", "idle", "idle"],
  );
});

Deno.test("a row goes by its own id and those of its clauses", () => {
  const rows = requirementsOf(guaranteeBoard()).requirements;
  deepStrictEqual(rows[0].ids, [
    "req.exact",
    "req.exact.same",
    "req.exact.fresh",
  ]);
  deepStrictEqual(rows[1].ids, ["req.fail"]);
  equal(rows[0].clauses.length, 2);
});

Deno.test("the words of a state never claim a test: they count owners, or say there is none", () => {
  const [exact, fail, orphan] = requirementsOf(guaranteeBoard()).requirements;
  equal(markWords(exact), "2 owners");
  equal(markWords(fail), "1 owner");
  equal(markWords(orphan), "no owner: nothing is declared to satisfy it");
  const [live, idle] = requirementsOf(guaranteeBoard()).constraints;
  equal(markWords(live), "used by a performed step");
  equal(markWords(idle), "used by no performed step");
  for (const row of requirementsOf(guaranteeBoard()).requirements) {
    equal(/test/i.test(markWords(row)), false);
  }
});

Deno.test("a model without guarantees has nothing to lay out; items elsewhere are not guarantees", () => {
  deepStrictEqual(requirementsOf(board({})), {
    requirements: [],
    constraints: [],
  });
  const elsewhere = board({ rules: [requirement("r", "r")] });
  equal(requirementsOf(elsewhere).requirements.length, 0);
  // Another kind of item in the column is left to Explore.
  const other = board({ guarantees: [item("i", "information", "i")] });
  equal(requirementsOf(other).requirements.length, 0);
  equal(requirementsOf(other).constraints.length, 0);
});
