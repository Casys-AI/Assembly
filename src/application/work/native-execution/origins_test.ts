import assert from "node:assert/strict";
import { assertCompletedCommandOrigin } from "./origins.ts";

// The suspended operator-command path mints a new effect key on resume, so
// the origin effect itself never completes with refused outputs; the
// completed-refusal decision is therefore witnessed here, on its owner.
Deno.test("a completed primitive whose output records refused cannot authorize a queued command", () => {
  assert.throws(
    () =>
      assertCompletedCommandOrigin({
        outputs: { outcome: { refused: true, code: "AUTHORITY_POLICY_STALE" } },
      }),
    /^Error: Refused native primitive cannot authorize a queued command$/,
  );
});

Deno.test("a completed primitive without a refused output is not rejected by the origin decision", () => {
  assertCompletedCommandOrigin({});
  assertCompletedCommandOrigin({ outputs: { outcome: { refused: false } } });
  assertCompletedCommandOrigin({ outputs: { notice: "settled" } });
});
