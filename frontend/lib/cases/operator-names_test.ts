import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import { monogram } from "../workbench/desk.ts";
import { caseTitle } from "./cases.ts";
import {
  branchOperatorName,
  caseOperatorName,
  OPERATOR_NAMES,
} from "./operator-names.ts";

const ID = "6f1c2a7e-0d4b-4c39-9a51-3e8f7b2d1c60";

Deno.test("each initial A to Z has ten invented one-word names of its own", () => {
  deepStrictEqual(
    Object.keys(OPERATOR_NAMES),
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  );
  for (const [initial, names] of Object.entries(OPERATOR_NAMES)) {
    equal(names.length, 10, initial);
    equal(new Set(names).size, names.length, initial);
    // Letters only: a two-word name's monogram is its two initials.
    for (const name of names) ok(/^[A-Z][a-z]+$/.test(name), name);
    ok(names.every((name) => name[0] === initial), initial);
  }
});

Deno.test("a Case's Branch Operator is named on the Case's initials, the same each time", () => {
  const record = { id: ID, objective: "Qualification MVP checkpoint" };
  const name = branchOperatorName(record);
  equal(name, branchOperatorName({ ...record }));
  ok(/^Q[a-z]+ M[a-z]+$/.test(name), name);
  // Its avatar stays the initials the Case's Dock tile shows.
  equal(monogram(name), monogram(caseTitle(record)));
  // The id draws the words: other Cases on the same initials vary.
  const names = new Set(
    Array.from(
      { length: 40 },
      (_, n) => branchOperatorName({ ...record, id: `case-${n}` }),
    ),
  );
  ok(names.size >= 25, `${names.size} names for 40 Cases`);
});

Deno.test("doubled, accented and one-word initials still give two words; others stay initials", () => {
  for (let n = 0; n < 20; n++) {
    const [first, second] = branchOperatorName({
      id: `case-${n}`,
      objective: "Model migration",
    }).split(" ");
    ok(first[0] === "M" && second[0] === "M");
    notEqual(first, second);
  }
  ok(/^E[a-z]+ L[a-z]+$/.test(
    branchOperatorName({ id: ID, objective: "Écrire le plan" }),
  ));
  // One word reads "De" on its tile: the name keeps both letters.
  ok(
    /^D[a-z]+ E[a-z]+$/.test(
      branchOperatorName({ id: ID, objective: "Deploy" }),
    ),
  );
  equal(branchOperatorName({ id: ID, objective: "3D printing" }), "3P");
  equal(branchOperatorName({ id: ID, objective: "修复登录" }), "修复");
});

Deno.test("a Request's conversation gives its generic operator the Branch Operator's name, never a custom one's", () => {
  const record = { id: ID, objective: "Qualification MVP checkpoint" };
  equal(
    caseOperatorName("Branch Operator", record),
    branchOperatorName(record),
  );
  equal(caseOperatorName("Researcher", record), "Researcher");
  // Before its Case is read, the generic name stays.
  equal(caseOperatorName("Branch Operator", undefined), "Branch Operator");
});
