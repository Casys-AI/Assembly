import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
  normalizeProviderCallObservation,
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../src/application/telemetry/provider-call.ts";
import { budgetedAgentCall } from "../../src/application/work/budget/agent.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type { WorkBudgetRecord } from "../../src/domain/work/policies/budget.ts";
import { LangChainAgents } from "../../src/adapters/out/llm-providers/langchain-agents.ts";
import { providerCallContext } from "../../src/adapters/out/llm-providers/provider-call-context.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";

const context = { messages: [], activeTools: [], candidates: [] };

async function budget(scopeId: string) {
  let record: WorkBudgetRecord | null = null;
  const ledger = new WorkBudgetService({
    load: () => Promise.resolve(record && structuredClone(record)),
    save: (next) => {
      record = structuredClone(next);
      return Promise.resolve();
    },
  });
  const input = {
    scopeId,
    ownerId: `operator-${scopeId}`,
    operation: "decide" as const,
    attemptId: `attempt-${scopeId}`,
    modelVersion: {
      digest: `executed-${scopeId}`,
      repositoryVersion: "executed-source",
    },
    policy: {
      id: `budget-${scopeId}`,
      revision: 1,
      unit: "agent-invocation" as const,
      limit: 3,
      onExhausted: "wait" as const,
      exhaustionRecipient: "local-control" as const,
    },
  };
  await ledger.adopt({ ...input, previousPolicy: undefined });
  return { ledger, input };
}

Deno.test("schema repair retains two physical IDs under one actual reserved attempt and exact captured execution pin", async () => {
  const { ledger, input } = await budget("case-a");
  const seen: ProviderCallObservation[] = [];
  const execution = {
    executionScope: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "request-space",
    },
    scopeKind: "request" as const,
    scopeId: "case-a",
    caseId: "case-a",
    operatorId: input.ownerId,
    threadId: "thread-a",
    runId: "run-a",
    effectId: "effect-a",
    nodeId: "choose-node",
    modelDigest: input.modelVersion.digest,
    repositoryVersion: input.modelVersion.repositoryVersion,
  };
  const fake = createClaudeToolsFake((view) => {
    // An unrelated source advance cannot rewrite the already captured execution.
    execution.modelDigest = "current-source";
    return view.callIndex === 0
      ? {
        toolUse: {
          name: "reply",
          input: { text: "bad", caseClosure: "invented" },
        },
      }
      : { decision: { kind: "reply", text: "valid" } };
  });
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: (value) =>
      void seen.push(normalizeProviderCallObservation(value)),
  });
  await providerCallContext.run(execution, () =>
    budgetedAgentCall(
      ledger,
      input,
      () => agent.decide(context),
      () => Promise.resolve(),
      undefined,
      providerCallContext,
    ));
  await agent.completionObservation.close();
  equal(fake.requests.length, 2);
  equal(seen.length, 2);
  notEqual(seen[0].observationId, seen[1].observationId);
  for (const observation of seen) {
    equal(observation.correlation.budgetAttemptId, input.attemptId);
    equal(observation.correlation.modelDigest, "executed-case-a");
    equal(observation.correlation.repositoryVersion, "executed-source");
    equal(observation.correlation.effectId, "effect-a");
    equal(observation.correlation.runId, "run-a");
    equal(observation.outcome, "returned");
    ok(observation.elapsedMs >= 0);
  }
  equal(
    (await ledger.snapshot(input.scopeId, input.ownerId, input.policy))
      ?.consumed,
    1,
  );
});

Deno.test("concurrent real SDK calls retain separate Case native and budget identities through deferred sinks", async () => {
  const seen: ProviderCallObservation[] = [];
  const fake = createClaudeToolsFake(() =>
    Promise.resolve({ decision: { kind: "reply", text: "valid" } })
  );
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: async (value) => {
      await Promise.resolve();
      seen.push(normalizeProviderCallObservation(value));
    },
  });
  await Promise.all(["a", "b"].map(async (id) => {
    const { ledger, input } = await budget(`case-${id}`);
    return await providerCallContext.run({
      executionScope: {
        projectId: "p",
        systemId: "s",
        executionSpaceId: `space-${id}`,
      },
      scopeKind: "request",
      scopeId: input.scopeId,
      caseId: input.scopeId,
      operatorId: input.ownerId,
      threadId: `thread-${id}`,
      runId: `run-${id}`,
      effectId: `effect-${id}`,
      nodeId: "choose",
      modelDigest: input.modelVersion.digest,
    }, () =>
      budgetedAgentCall(
        ledger,
        input,
        () => agent.decide(context),
        () => Promise.resolve(),
        undefined,
        providerCallContext,
      ));
  }));
  await agent.completionObservation.close();
  equal(fake.requests.length, 2);
  equal(seen.length, 2);
  for (const id of ["a", "b"]) {
    const call = seen.find((item) => item.correlation.caseId === `case-${id}`)!;
    equal(call.correlation.threadId, `thread-${id}`);
    equal(call.correlation.runId, `run-${id}`);
    equal(call.correlation.effectId, `effect-${id}`);
    equal(call.correlation.budgetAttemptId, `attempt-case-${id}`);
    equal(call.correlation.executionScope?.executionSpaceId, `space-${id}`);
  }
});

Deno.test("an unbudgeted call without explicit execution context keeps every native join unknown", async () => {
  const seen: ProviderCallObservation[] = [];
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "valid" },
  }));
  const agent = new LangChainAgents({
    apiKey: "fixture",
    model: "sonnet",
    fetch: fake.fetch,
    onCompletion: (value) =>
      void seen.push(normalizeProviderCallObservation(value)),
  });
  await agent.decide(context);
  await agent.completionObservation.close();
  deepStrictEqual(seen[0].correlation, UNKNOWN_PROVIDER_CALL_CORRELATION);
});
