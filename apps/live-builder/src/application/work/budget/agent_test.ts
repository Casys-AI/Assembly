import { AgentBudgetWait, budgetedAgentCall } from "./agent.ts";
import { WorkBudgetService } from "./service.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
Deno.test("dispatch is reserved durably, failure consumes and exhaustion waits without dispatch", async () => {
  let record: WorkBudgetRecord | null = null;
  const ledger = new WorkBudgetService({
    load: () => Promise.resolve(record && structuredClone(record)),
    save: (next) => {
      record = structuredClone(next);
      return Promise.resolve();
    },
  });
  const input = {
    scopeId: "case",
    ownerId: "builder",
    operation: "decide" as const,
    attemptId: "first",
    modelVersion: { digest: "v1" },
    policy: {
      id: "budget",
      revision: 1,
      unit: "agent-invocation" as const,
      limit: 1,
      onExhausted: "wait" as const,
      exhaustionRecipient: "local-control" as const,
    },
  };
  await ledger.adopt({ ...input, previousPolicy: undefined });
  let calls = 0;
  const observe = () => Promise.resolve();
  try {
    await budgetedAgentCall(ledger, input, () => {
      calls++;
      assert(record?.events.at(-1)?.kind === "reserve");
      return Promise.reject(new Error("provider failure"));
    }, observe);
  } catch (error) {
    assert(error instanceof Error && error.message === "provider failure");
  }
  assert(
    (await ledger.snapshot("case", "builder", input.policy))?.consumed === 1,
  );
  try {
    await budgetedAgentCall(ledger, { ...input, attemptId: "second" }, () => {
      calls++;
      return Promise.resolve("unexpected");
    }, observe);
    throw new Error("Expected wait");
  } catch (error) {
    assert(error instanceof AgentBudgetWait && error.budget?.suspended);
  }
  assert(calls === 1);
});

Deno.test("a view refresh failure after settlement keeps the paid response, while a settlement failure fails the call", async () => {
  const view = {
    budgetId: "p",
    scopeId: "case",
    unit: "agent-invocation" as const,
    limit: 5,
    consumed: 0,
    reserved: 1,
    remaining: 4,
    exhausted: false,
    suspended: false,
    onExhausted: "wait" as const,
    exhaustionRecipient: "local-control" as const,
  };
  const input = {
    scopeId: "case",
    ownerId: "builder",
    operation: "review" as const,
    attemptId: "a",
    modelVersion: { digest: "v1" },
    policy: {
      id: "p",
      revision: 1,
      unit: "agent-invocation" as const,
      limit: 5,
      onExhausted: "wait" as const,
      exhaustionRecipient: "local-control" as const,
    },
  };
  const reported: unknown[] = [];
  const onRefreshError = (error: unknown) => {
    reported.push(error);
  };
  {
    // Snapshot refresh fails after a successful settlement.
    const settled: string[] = [];
    const snapshotDown = {
      adopt: () => Promise.resolve(undefined),
      snapshot: () => Promise.reject(new Error("snapshot down")),
      reserve: () => Promise.resolve({ ...view, attemptId: input.attemptId }),
      settle: () => {
        settled.push("settled");
        return Promise.resolve();
      },
    };
    const paid = await budgetedAgentCall(
      snapshotDown,
      input,
      () => Promise.resolve("paid answer"),
      () => Promise.resolve(),
      onRefreshError,
    );
    assert(paid === "paid answer" && settled.length === 1);
    // View callback fails during the refresh.
    let observedCalls = 0;
    const viewDown = {
      ...snapshotDown,
      snapshot: () => Promise.resolve(view),
    };
    const paidAgain = await budgetedAgentCall(
      viewDown,
      input,
      () => Promise.resolve("paid again"),
      () => {
        observedCalls++;
        return observedCalls > 1
          ? Promise.reject(new Error("view down"))
          : Promise.resolve();
      },
      onRefreshError,
    );
    assert(paidAgain === "paid again" && settled.slice().length === 2);
    assert(reported.length === 2);
    assert(
      reported[0] instanceof Error && reported[0].message === "snapshot down",
    );
    assert(reported[1] instanceof Error && reported[1].message === "view down");
    // Settlement itself fails: the call fails, fail-closed.
    const settleDown = {
      ...viewDown,
      settle: () => Promise.reject(new Error("settle down")),
    };
    try {
      await budgetedAgentCall(
        settleDown,
        input,
        () => Promise.resolve("unexpected"),
        () => Promise.resolve(),
      );
      throw new Error("Expected settlement failure");
    } catch (error) {
      assert(
        error instanceof AgentBudgetWait && error.reason === "unavailable" &&
          error.dispatchStarted && error.message === "settle down",
      );
    }
  }
});

Deno.test("budget persistence failure never reaches the provider", async () => {
  let calls = 0;
  let record: WorkBudgetRecord | null = null, fail = false;
  const port = new WorkBudgetService({
    load: () => Promise.resolve(structuredClone(record)),
    save: (next) => {
      if (fail) throw new Error("disk full");
      record = structuredClone(next);
      return Promise.resolve();
    },
  });
  await port.adopt({
    scopeId: "case",
    ownerId: "builder",
    previousPolicy: undefined,
    policy: {
      id: "p",
      revision: 1,
      unit: "agent-invocation",
      limit: 1,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
    },
    modelVersion: { digest: "v1" },
  });
  fail = true;
  try {
    await budgetedAgentCall(port, {
      scopeId: "case",
      ownerId: "builder",
      operation: "review",
      attemptId: "a",
      modelVersion: { digest: "v1" },
      policy: {
        id: "p",
        revision: 1,
        unit: "agent-invocation",
        limit: 1,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
      },
    }, () => {
      calls++;
      return Promise.resolve("unexpected");
    }, () => Promise.resolve());
    throw new Error("Expected wait");
  } catch (error) {
    assert(
      error instanceof AgentBudgetWait && error.reason === "unavailable" &&
        !error.dispatchStarted && error.message === "disk full",
    );
  }
  assert(calls === 0);
});
