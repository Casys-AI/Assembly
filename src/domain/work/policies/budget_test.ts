import {
  assertBudgetPolicy,
  budgetState,
  WorkBudgetError,
  type WorkBudgetPolicy,
} from "./budget.ts";
Deno.test("budget rejects unsafe limits and impossible stored settlement", () => {
  const policy: WorkBudgetPolicy = {
    id: "b",
    revision: 1,
    unit: "agent-invocation",
    limit: 1,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  for (const limit of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    let rejected = false;
    try {
      assertBudgetPolicy({ ...policy, limit });
    } catch (error) {
      rejected = error instanceof WorkBudgetError;
    }
    if (!rejected) throw new Error("Unsafe limit accepted");
  }
  try {
    budgetState({
      scopeId: "s",
      ownerId: "o",
      revision: 2,
      events: [{ kind: "policy", policy, modelVersion: { digest: "v1" } }, {
        kind: "settle",
        attemptId: "unknown",
        outcome: "returned",
      }],
    });
  } catch (error) {
    if (error instanceof WorkBudgetError) return;
    throw error;
  }
  throw new Error("Impossible history accepted");
});
