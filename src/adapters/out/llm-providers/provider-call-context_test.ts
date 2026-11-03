import { deepStrictEqual, equal } from "node:assert/strict";
import { UNKNOWN_PROVIDER_CALL_CORRELATION } from "../../../application/telemetry/provider-call.ts";
import {
  currentProviderCallCorrelation,
  providerCallContext,
} from "./provider-call-context.ts";

Deno.test("concurrent async provider contexts retain their exact Case and pin", async () => {
  const results = await Promise.all(
    ["a", "b"].map((id) =>
      providerCallContext.run({
        scopeKind: "request",
        scopeId: `case-${id}`,
        caseId: `case-${id}`,
        modelDigest: `pin-${id}`,
        operatorId: `operator-${id}`,
        runId: `run-${id}`,
      }, async () => {
        await Promise.resolve();
        return currentProviderCallCorrelation();
      })
    ),
  );
  equal(results[0].caseId, "case-a");
  equal(results[1].caseId, "case-b");
  equal(results[0].modelDigest, "pin-a");
  equal(results[1].runId, "run-b");
  deepStrictEqual(
    currentProviderCallCorrelation(),
    UNKNOWN_PROVIDER_CALL_CORRELATION,
  );
});

Deno.test("same-execution budget context preserves native joins while a different execution clears them", async () => {
  await providerCallContext.run({
    executionScope: {
      projectId: "p",
      systemId: "s",
      executionSpaceId: "space",
    },
    scopeKind: "request",
    scopeId: "case-a",
    caseId: "case-a",
    operatorId: "operator-a",
    modelDigest: "pin-a",
    repositoryVersion: "old-source",
    threadId: "thread-a",
    runId: "run-a",
    effectId: "effect-a",
    nodeId: "node-a",
    budgetAttemptId: "attempt-a",
  }, async () => {
    await providerCallContext.run({
      modelDigest: undefined,
      executionScope: undefined,
      operatorId: undefined,
      budgetAttemptId: undefined,
    }, () => {
      equal(currentProviderCallCorrelation().modelDigest, "pin-a");
      equal(currentProviderCallCorrelation().operatorId, "operator-a");
      equal(currentProviderCallCorrelation().runId, "run-a");
      equal(currentProviderCallCorrelation().budgetAttemptId, "attempt-a");
      equal(
        currentProviderCallCorrelation().executionScope?.executionSpaceId,
        "space",
      );
      return Promise.resolve();
    });
    await providerCallContext.run({
      budgetAttemptId: "attempt-b",
      budgetOperation: "review",
    }, () => {
      equal(currentProviderCallCorrelation().runId, "run-a");
      equal(currentProviderCallCorrelation().budgetAttemptId, "attempt-b");
      return Promise.resolve();
    });
    for (
      const changed of [
        { caseId: "case-b" },
        { operatorId: "operator-b" },
        { modelDigest: "pin-b" },
        { repositoryVersion: "new-source" },
        { runId: "run-b" },
        { effectId: "effect-b" },
        {
          executionScope: {
            projectId: "p",
            systemId: "s",
            executionSpaceId: "other-space",
          },
        },
      ]
    ) {
      await providerCallContext.run(changed, () => {
        equal(currentProviderCallCorrelation().threadId, null);
        equal(currentProviderCallCorrelation().nodeId, null);
        equal(currentProviderCallCorrelation().budgetAttemptId, null);
        return Promise.resolve();
      });
    }
    equal(currentProviderCallCorrelation().runId, "run-a");
    equal(currentProviderCallCorrelation().budgetAttemptId, "attempt-a");
  });
});
