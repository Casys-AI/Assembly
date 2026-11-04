import { deepStrictEqual, equal } from "node:assert/strict";
import type { PgBoss, SendOptions, WorkOptions } from "pg-boss";
import type { OperatorExecutionDelivery } from "../../../application/work/operators/execution.ts";
import { PostgresOperatorDispatch } from "./operator-dispatch.ts";
import type {
  PostgresNativeExecutionLedger,
  PostgresOperatorJob,
} from "./postgres-ledger.ts";

/** Port calls only; saturation and restart are witnessed against PostgreSQL. */
function fixture(executionSpaceId = "main", primaryOperatorId?: string) {
  const scope = { projectId: "project", systemId: "system", executionSpaceId };
  const workers: Array<{ name: string; options: WorkOptions }> = [];
  const sent: Array<{ data: PostgresOperatorJob; options: SendOptions }> = [];
  const stopped: string[] = [];
  const tx = {
    $queryRawUnsafe: (sql: string) =>
      Promise.resolve(
        sql.includes("FOR SHARE") ? [{ operatorId: "admitted" }] : [],
      ),
  };
  const ledger = {
    client: {
      ...tx,
      $transaction: <T>(operation: (transaction: typeof tx) => Promise<T>) =>
        operation(tx),
    },
    options: {
      scope,
      queueName: "operators",
      acceptDeliveryInTransaction: () => Promise.resolve(),
    },
    table: (name: string) => `"fixture"."${name}"`,
    scope: (identity: { operatorId: string }) => ({
      ...scope,
      operatorId: identity.operatorId,
    }),
    resolveThread: (_query: unknown, _identity: unknown, pin: unknown) =>
      Promise.resolve({
        threadId: "thread",
        row: { authorizedPinJson: JSON.stringify(pin) },
      }),
  } as unknown as PostgresNativeExecutionLedger;
  const boss = {
    work(name: string, options: WorkOptions) {
      workers.push({ name, options });
      return Promise.resolve(`worker-${workers.length}`);
    },
    send(_name: string, data: PostgresOperatorJob, options: SendOptions) {
      sent.push({ data: structuredClone(data), options });
      return Promise.resolve(options.id);
    },
    offWork(name: string, options: { wait?: boolean }) {
      equal(options.wait, true);
      stopped.push(name);
      return Promise.resolve();
    },
  } as unknown as PgBoss;
  return {
    dispatch: new PostgresOperatorDispatch(ledger, boss, undefined, {
      primaryOperatorId,
    }),
    workers,
    sent,
    stopped,
  };
}

function delivery(
  operatorId: string,
  kind: OperatorExecutionDelivery["kind"],
): OperatorExecutionDelivery {
  return {
    id: crypto.randomUUID(),
    kind,
    identity: {
      operatorId,
      invocationKey: "local:turn",
      purpose: "conversation",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
    },
    modelPin: { modelDigest: "authorized-pin" },
    payload: { text: "Accepted input" },
  };
}

for (
  const scenario of [
    {
      name: "Main in main",
      space: "main",
      primary: "primary",
      target: "primary",
      priority: 1,
    },
    {
      name: "BO",
      space: "branch",
      primary: "primary",
      target: "bo",
      priority: 0,
    },
    {
      name: "sub-operator",
      space: "main",
      primary: "primary",
      target: "child",
      priority: 0,
    },
    {
      name: "Main identity outside main",
      space: "branch",
      primary: "primary",
      target: "primary",
      priority: 0,
    },
    {
      name: "unconfigured Main",
      space: "main",
      primary: undefined,
      target: "primary",
      priority: 0,
    },
  ]
) {
  Deno.test(`E7 lane: ${scenario.name}, all delivery kinds`, async () => {
    const f = fixture(scenario.space, scenario.primary);
    const kinds: OperatorExecutionDelivery["kind"][] = [
      "contribution",
      "continuation",
      "notification",
      "command",
      "schedule",
    ];
    for (const kind of kinds) {
      for (
        const scope of [
          { kind: "request" as const, scopeId: "case", rootRequestId: "case" },
          {
            kind: "designer" as const,
            scopeId: "design",
            ownerId: scenario.target,
          },
        ]
      ) {
        const input = delivery(scenario.target, kind);
        input.identity.scope = scope;
        const receipt = await f.dispatch.enqueue(input);
        const sent = f.sent.at(-1)!;
        equal(sent.options.priority, scenario.priority);
        equal(receipt.jobId, sent.options.id);
        equal(receipt.status, "queued");
        deepStrictEqual(sent.data.delivery, input);
      }
    }
  });
}

Deno.test("E7 workers: one reserved Main worker beside sixteen ordinary workers; stop both lanes", async () => {
  const f = fixture("main", "primary");
  try {
    await f.dispatch.start(() => Promise.resolve());
    deepStrictEqual(f.workers.map((worker) => worker.name), [
      "operators",
      "operators",
    ]);
    const main = f.workers.find((worker) => worker.options.minPriority === 1)!;
    const ordinary = f.workers.find((worker) =>
      worker.options.maxPriority === 0
    )!;
    equal(main.options.localConcurrency, 1);
    equal(ordinary.options.localConcurrency, 16);
    equal(main.options.batchSize, 1);
    equal(ordinary.options.batchSize, 1);
  } finally {
    await f.dispatch.stop();
  }
  deepStrictEqual(f.stopped, ["operators"]);
});
