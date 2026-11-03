import { equal, throws } from "node:assert/strict";
import {
  matchesExactRevision,
  modelCommitHash,
  parseModelRevisionId,
} from "./revision-id.ts";

Deno.test("model revision identity admits exact immutable commits and rejects mutable or ambiguous names", () => {
  equal(
    modelCommitHash(parseModelRevisionId(`commit:${"a".repeat(40)}`)),
    "a".repeat(40),
  );
  for (
    const input of [
      "HEAD",
      "admitted",
      `branch:${"a".repeat(40)}`,
      "commit:abc",
      `commit:${"A".repeat(40)}`,
      `commit:${"a".repeat(40)}~1`,
    ]
  ) {
    throws(() => parseModelRevisionId(input));
  }
});

Deno.test("revision format matching preserves coercible values and native conversion errors", () => {
  const value = [`commit:${"a".repeat(40)}`];
  equal(matchesExactRevision(value), true);
  equal(parseModelRevisionId(value as unknown as string), value);
  throws(() => matchesExactRevision(Symbol("revision")), TypeError);
  throws(
    () => parseModelRevisionId(Symbol("revision") as unknown as string),
    TypeError,
  );
});
