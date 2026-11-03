import { deepStrictEqual, notStrictEqual, throws } from "node:assert/strict";
import {
  type DecisionContextPolicy,
  validateContextPolicy,
} from "./context-separation.ts";

const policy: DecisionContextPolicy = {
  kind: "separated-context",
  pattern: "5.1",
  recentMessages: 8,
  maxMessageCharacters: 2048,
  maxCollectionItems: 8,
  maxContextCharacters: 100000,
};

Deno.test("context policy validates its representation contract without adding rights", () => {
  const validated = validateContextPolicy(policy);
  deepStrictEqual(validated, policy);
  notStrictEqual(validated, policy);
  throws(() => validateContextPolicy({ ...policy, mayInvoke: true }));
  throws(() => validateContextPolicy({ ...policy, pattern: "5.2" }));
  throws(() => validateContextPolicy({ ...policy, kind: "instructions" }));
});

Deno.test("context policy rejects missing, non-integer and excessive bounds", () => {
  const { maxContextCharacters: _, ...missing } = policy;
  throws(() => validateContextPolicy(missing));
  for (
    const [field, values] of [
      ["recentMessages", [0, 101, 1.5, NaN]],
      ["maxMessageCharacters", [255, 100001, Infinity]],
      ["maxCollectionItems", [0, 129, "4"]],
      ["maxContextCharacters", [4095, 2000001, 5000.5]],
    ] as const
  ) {
    for (const value of values) {
      throws(() => validateContextPolicy({ ...policy, [field]: value }));
    }
  }
  throws(() => validateContextPolicy(null));
  throws(() => validateContextPolicy([]));
});
