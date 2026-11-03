import { deepStrictEqual, equal } from "node:assert/strict";
import {
  allocatedBoard,
  ANALYST,
  board,
  COORDINATOR,
  link,
  unit,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import { allocationsOf } from "./allocations.ts";

const PROMOTION = `${COORDINATOR}.promotion`;

Deno.test("the performers are columns by unit, the units in the team's order, those no unit claims last", () => {
  const { columns } = allocationsOf(allocatedBoard());
  deepStrictEqual(columns, [
    {
      unit: COORDINATOR,
      targets: [`${COORDINATOR}.operator`, `${COORDINATOR}.sandbox`],
    },
    { unit: ANALYST, targets: [`${ANALYST}.operator`] },
    { unit: null, targets: ["loose"] },
  ]);
});

Deno.test("the rows are grouped by the flow they belong to and the unit it is declared for", () => {
  const { groups } = allocationsOf(allocatedBoard());
  deepStrictEqual(
    groups.map((
      group,
    ) => [group.flow, group.unit, group.rows.map((r) => r.id)]),
    [
      [PROMOTION, COORDINATOR, [
        `${PROMOTION}.step0`,
        `${PROMOTION}.step1`,
        `${PROMOTION}.step2`,
        `${PROMOTION}.step3`,
      ]],
      // An action that is no step of a flow has no flow, only its unit.
      [null, ANALYST, [`${ANALYST}.reply`]],
      // What the board does not hold has neither.
      [null, null, ["ghost"]],
    ],
  );
});

Deno.test("a row lists the performers it has a cell in", () => {
  const { groups } = allocationsOf(allocatedBoard());
  const rows = new Map(
    groups.flatMap((group) => group.rows).map((row) => [row.id, row]),
  );
  deepStrictEqual([...rows.get(`${PROMOTION}.step1`)!.targets], [
    `${COORDINATOR}.operator`,
    "loose",
  ]);
  deepStrictEqual([...rows.get(`${PROMOTION}.step3`)!.targets], [
    `${ANALYST}.operator`,
  ]);
});

Deno.test("an allocation is a row and a cell wherever its ends are: the flow's unit and the performer's unit may differ", () => {
  const model = allocationsOf(allocatedBoard());
  // step3 is in the coordinator's flow and performed in the analyst's unit.
  const group = model.groups.find((entry) => entry.flow === PROMOTION)!;
  equal(group.unit, COORDINATOR);
  equal(
    model.columns.find((entry) =>
      entry.targets.includes(`${ANALYST}.operator`)
    )!
      .unit,
    ANALYST,
  );
  equal(model.allocations, 7);
});

Deno.test("a model that allocates nothing says so; other links are not allocations", () => {
  const empty = allocationsOf(board({ team: [unit({ id: "u", title: "u" })] }));
  deepStrictEqual(empty, { allocations: 0, columns: [], groups: [] });
  const other = withLinks(board({ team: [unit({ id: "u", title: "u" })] }), [
    link("connect", "u.sandbox", "u.catalog"),
  ]);
  equal(allocationsOf(other).allocations, 0);
});

Deno.test("the same row allocated twice to one performer is one cell", () => {
  const model = withLinks(board({ team: [unit({ id: "u", title: "u" })] }), [
    link("allocate", "u.sandbox", "u.operator", { id: "a" }),
    link("allocate", "u.sandbox", "u.operator", { id: "b" }),
  ]);
  const result = allocationsOf(model);
  equal(result.allocations, 2);
  deepStrictEqual(result.columns, [{ unit: "u", targets: ["u.operator"] }]);
  deepStrictEqual([...result.groups[0].rows[0].targets], ["u.operator"]);
});
