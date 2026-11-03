import assert from "node:assert/strict";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import {
  liftingBudgetEvent,
  recoveryMessageHistory,
} from "./candidate-recovery-opportunity.ts";

const policy = {
  id: "budget",
  revision: 1,
  unit: "agent-invocation" as const,
  limit: 2,
  onExhausted: "wait" as const,
  exhaustionRecipient: "local-control" as const,
};
const modelVersion = { digest: "model" };
const initial = { kind: "policy" as const, policy, modelVersion };
const reserve = {
  kind: "reserve" as const,
  policy,
  modelVersion,
  attemptId: "attempt",
  operation: "admit" as const,
};
const settle = {
  kind: "settle" as const,
  attemptId: "attempt",
  outcome: "returned" as const,
};
const record = (events: WorkBudgetRecord["events"]): WorkBudgetRecord => ({
  scopeId: "case",
  ownerId: "operator",
  revision: events.length,
  events,
});

Deno.test("only an exact scoped budget event that lifts the observed block opens a new opportunity", async () => {
  const baseline = {
    scopeId: "case",
    ownerId: "operator",
    eventIndex: 1,
    eventDigest: await executionDigest(reserve),
  };
  assert.equal(
    await liftingBudgetEvent(record([initial, reserve]), baseline),
    undefined,
  );
  const proof = await liftingBudgetEvent(
    record([initial, reserve, settle]),
    baseline,
  );
  assert.deepEqual(proof, {
    scopeId: "case",
    ownerId: "operator",
    eventIndex: 2,
    eventDigest: await executionDigest(settle),
  });
  assert.equal(
    await liftingBudgetEvent(record([initial, reserve, settle]), {
      ...baseline,
      ownerId: "other",
    }),
    undefined,
  );
  assert.equal(
    await liftingBudgetEvent(record([initial, reserve, settle]), {
      ...baseline,
      eventDigest: "forged",
    }),
    undefined,
  );
  const nextReserve = { ...reserve, attemptId: "next" };
  const nextSettle = { ...settle, attemptId: "next" };
  assert.deepEqual(
    await liftingBudgetEvent(
      record([initial, reserve, settle, nextReserve, nextSettle]),
      baseline,
    ),
    undefined,
  );
});

Deno.test("blocked retry and replacement retain the exact prior contribution message boundaries", () => {
  const base = {
    candidateId: "candidate-A",
    continuationDigest: "continuation-A",
    acceptedDigest: "accepted-A",
  };
  const retry = {
    ...base,
    kind: "not-started" as const,
    baseMessageEnd: 4,
    messageRanges: [{ start: 8, end: 9 }],
  };
  const unrelatedLaterBound = {
    ...base,
    kind: "blocked" as const,
    baseMessageEnd: 7,
    messageRanges: [],
  };
  assert.deepEqual(
    recoveryMessageHistory({ ...base, retry, prior: unrelatedLaterBound }),
    retry,
  );
  const predecessor = {
    ...retry,
    acceptedDigest: "old-accepted",
    replacementId: "replacement",
  };
  assert.deepEqual(
    recoveryMessageHistory({
      ...base,
      predecessor,
      prior: unrelatedLaterBound,
    }),
    predecessor,
  );
  assert.throws(() =>
    recoveryMessageHistory({
      ...base,
      retry: { ...retry, acceptedDigest: "foreign" },
    })
  );
  assert.throws(() =>
    recoveryMessageHistory({
      ...base,
      predecessor: { ...predecessor, candidateId: "candidate-B" },
    })
  );
  assert.throws(() =>
    recoveryMessageHistory({
      ...base,
      retry: { ...retry, messageRanges: undefined },
    })
  );
});
