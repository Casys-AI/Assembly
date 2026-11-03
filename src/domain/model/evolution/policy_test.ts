import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from "node:assert/strict";
import { parseEvolutionGrants } from "./policy.ts";

const instruction = {
  act: "prepare",
  targetNativeId: "native-self",
  category: "instructions",
  bounds: { maxCharacters: 1000 },
};
Deno.test("evolution permits explicit self target without inferring other acts", () => {
  const grants = parseEvolutionGrants(JSON.stringify([instruction]));
  assertEquals(grants.map((grant) => grant.act), ["prepare"]);
  assertEquals(grants[0].targetNativeId, "native-self");
});
Deno.test("evolution grants reject unknown authority, category, bound and duplicate subjects", () => {
  for (
    const grant of [
      { ...instruction, act: "publish" },
      { ...instruction, category: "all" },
      { ...instruction, inherited: true },
      { ...instruction, bounds: { maxCharacters: 1000, mayInvoke: true } },
      { ...instruction, bounds: { maxCharacters: 16001 } },
    ]
  ) assertThrows(() => parseEvolutionGrants(JSON.stringify([grant])));
  assertThrows(() =>
    parseEvolutionGrants(JSON.stringify([instruction, instruction]))
  );
});
Deno.test("memory and context envelopes cannot smuggle an unbounded field", () => {
  const make = (category: string, bounds: unknown) =>
    JSON.stringify([{ ...instruction, category, bounds }]);
  assertThrows(() =>
    parseEvolutionGrants(
      make("context", {
        fields: { maxContextCharacters: { min: 1, max: 2000000 } },
      }),
    )
  );
  assertThrows(() =>
    parseEvolutionGrants(
      make("memory", {
        fields: { allowSelfAdmission: [true], ownerId: ["peer"] },
      }),
    )
  );
  assertThrows(() =>
    parseEvolutionGrants(
      make("budgets", {
        fields: { workBudgetLimit: { min: 2, max: 1 } },
        caseTypes: [],
      }),
    )
  );
  assertThrows(() =>
    parseEvolutionGrants(
      make("contracts", {
        contractNativeIds: [],
        inputTypeNativeIds: [],
        allowedExposures: [{
          callerNativeId: "caller",
          targetNativeId: "target",
          inputTypeId: "type",
          enabled: true,
        }],
      }),
    )
  );
});
