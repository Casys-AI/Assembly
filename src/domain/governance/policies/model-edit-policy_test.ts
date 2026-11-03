import assert from "node:assert/strict";
import {
  modelEditRootContains,
  parseModelEditGrants,
  parseModelEditOperations,
  validateModelEditPolicyIdentity,
} from "./model-edit-policy.ts";
Deno.test("model edit grants preserve exact file-root pairs and name segments", () => {
  assert.deepEqual(parseModelEditOperations('["rename"]'), ["rename"]);
  assert.deepEqual(parseModelEditOperations('["set-type"]'), ["set-type"]);
  assert.deepEqual(parseModelEditOperations('["remove","set-type"]'), [
    "remove",
    "set-type",
  ]);
  for (
    const value of [
      '["rename","rename"]',
      '[ "rename" ]',
      '["all"]',
      '["replace-member"]',
      '["set-type","set-type"]',
      "[]",
    ]
  ) assert.throws(() => parseModelEditOperations(value));
  const grants =
    '[{"file":"a.sysml","qualifiedRoots":["A::B"]},{"file":"b.sysml","qualifiedRoots":["C"]}]';
  assert.equal(parseModelEditGrants(grants).length, 2);
  for (
    const value of [
      '[{"file":"../a.sysml","qualifiedRoots":["A"]}]',
      '[{"file":"a.sysml","qualifiedRoots":["A::*"]}]',
      '[{"file":"a.sysml","qualifiedRoots":["A","\'A\'"]}]',
      '[{"file":"a.sysml","qualifiedRoots":["A"]},{"file":"a.sysml","qualifiedRoots":["B"]}]',
      '[{"file":"a.sysml","qualifiedRoots":["A"],"extra":true}]',
    ]
  ) assert.throws(() => parseModelEditGrants(value));
  assert(modelEditRootContains("A::B", "A::B::c"));
  assert(!modelEditRootContains("A::B", "A::Bad"));
  assert(!modelEditRootContains("'A::B'", "A::B"));
  assert(modelEditRootContains("'A::B'", "'A::B'::c"));
  assert.throws(() => validateModelEditPolicyIdentity("id", 0));
});
