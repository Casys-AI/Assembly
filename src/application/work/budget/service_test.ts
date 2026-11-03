import { WorkBudgetService } from "./service.ts";
import type { WorkBudgetStorePort } from "./ports.ts";
import {
  WorkBudgetError,
  type WorkBudgetPolicy,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
const policy: WorkBudgetPolicy = {
  id: "budget",
  revision: 1,
  unit: "agent-invocation",
  limit: 0,
  onExhausted: "wait",
  exhaustionRecipient: "local-control",
};
Deno.test("refusal is persisted before exhausted response and failed writes grant no reservation", async () => {
  let record: WorkBudgetRecord | null = null;
  let failing = false;
  const port: WorkBudgetStorePort = {
    load: () => Promise.resolve(record ? structuredClone(record) : null),
    save: (next) => {
      if (failing) return Promise.reject(new Error("disk full"));
      record = structuredClone(next);
      return Promise.resolve();
    },
  };
  const service = new WorkBudgetService(port);
  const input = {
    scopeId: "scope",
    ownerId: "owner",
    policy,
    attemptId: "zero",
    operation: "admit" as const,
    modelVersion: { digest: "v1" },
  };
  await service.adopt({
    scopeId: "scope",
    ownerId: "owner",
    previousPolicy: undefined,
    policy,
    modelVersion: { digest: "v1" },
  });
  try {
    await service.reserve(input);
    throw new Error("Expected exhausted");
  } catch (error) {
    assert(error instanceof WorkBudgetError && error.code === "exhausted");
  }
  assert((await service.snapshot("scope", "owner", policy))?.suspended);
  assert((await port.load("scope"))?.events[1].kind === "refused");
  const raised = { ...policy, revision: 2, limit: 1 };
  await service.adopt({
    scopeId: "scope",
    ownerId: "owner",
    previousPolicy: policy,
    policy: raised,
    modelVersion: { digest: "v2" },
  });
  failing = true;
  try {
    await service.reserve({
      ...input,
      policy: raised,
      attemptId: "failed-write",
    });
    throw new Error("Expected write failure");
  } catch (error) {
    assert(error instanceof Error && error.message === "disk full");
  }
  assert((await service.snapshot("scope", "owner", raised))?.remaining === 1);
  assert(!(await port.load("scope"))?.events.some((e) => e.kind === "reserve"));
});

Deno.test("missing ledger cannot be reset through snapshot, reserve or prior-policy adoption", async () => {
  let writes = 0;
  const store: WorkBudgetStorePort = {
    load: () => Promise.resolve(null),
    save: () => {
      writes++;
      return Promise.resolve();
    },
  };
  const service = new WorkBudgetService(store);
  const base = {
    scopeId: "lost",
    ownerId: "owner",
    policy,
    modelVersion: { digest: "v1" },
  };
  const actions = [
    () => service.snapshot("lost", "owner", policy),
    () =>
      service.reserve({
        ...base,
        attemptId: "retry",
        operation: "decide" as const,
      }),
    () => service.adopt({ ...base, previousPolicy: policy }),
    () => service.adopt({ ...base, previousPolicy: policy, policy: undefined }),
  ];
  for (const action of actions) {
    try {
      await action();
      throw new Error("Expected missing ledger");
    } catch (error) {
      assert(
        error instanceof WorkBudgetError && error.code === "missing-state",
      );
    }
  }
  assert(writes === 0);
});
