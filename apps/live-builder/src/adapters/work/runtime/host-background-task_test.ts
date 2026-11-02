import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EvolutionFinalizationJob } from "../../../application/work/runtime/evolution-commands.ts";
import type { Prisma, PrismaClient } from "../../out/postgres/client.ts";
import {
  currentPostgresExecutionTransaction,
  postgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "../../out/postgres/execution-transaction.ts";
import { bindHostBackgroundTask } from "./host-background-task.ts";

Deno.test("host finalization outlives a completed delivery without inheriting its claim or fence", async () => {
  const context = new AsyncLocalStorage<
    | { kind: "host" }
    | { kind: "delivery"; claimId: string; signal: AbortSignal }
  >();
  const started = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const signal = new AbortController();
  const writes: string[] = [];
  const failures: unknown[] = [];
  const client = {
    $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
      return operation({} as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;
  let passes = 0;
  const job = new EvolutionFinalizationJob(async () => {
    passes++;
    if (passes === 1) {
      started.resolve();
      await settled.promise;
    }
    assert.equal(signal.signal.aborted, true);
    assert.deepEqual(context.getStore(), { kind: "host" });
    assert.equal(currentPostgresExecutionTransaction(), undefined);
    await postgresExecutionTransaction(client, () => {
      writes.push("finalize");
      return Promise.resolve();
    });
    // A state event during finalization must still produce one drain pass.
    if (passes === 1) schedule();
  }, (error) => failures.push(error));
  const schedule = context.run(
    { kind: "host" },
    () => bindHostBackgroundTask(() => job.schedule()),
  );

  try {
    const lateDeliveryWrite = await context.run({
      kind: "delivery",
      claimId: "completed-job",
      signal: signal.signal,
    }, () =>
      withPostgresExecutionTransaction({
        client,
        session: { threadId: "origin-thread", runId: "origin-run" },
        fence: () => {
          signal.signal.throwIfAborted();
          return Promise.resolve();
        },
      }, async () => {
        schedule();
        schedule();
        await started.promise;
        // Retain an ordinary delivery callback to prove its fence survives.
        return AsyncLocalStorage.bind(() => {
          assert.equal(context.getStore()?.kind, "delivery");
          assert.deepEqual(currentPostgresExecutionTransaction()?.session, {
            threadId: "origin-thread",
            runId: "origin-run",
          });
          return postgresExecutionTransaction(client, () => {
            writes.push("late-delivery");
            return Promise.resolve();
          });
        });
      }));
    // The delivery has returned. pg-boss aborts this controller on normal
    // completion too; independent background work must now survive that abort.
    signal.abort();
    await assert.rejects(lateDeliveryWrite(), { name: "AbortError" });
  } finally {
    settled.resolve();
    await job.idle();
  }
  assert.deepEqual(failures, []);
  assert.equal(
    passes,
    2,
    "Initial triggers coalesce; an in-flight trigger drains",
  );
  assert.deepEqual(writes, ["finalize", "finalize"]);
  assert.equal(context.getStore(), undefined);
  assert.equal(currentPostgresExecutionTransaction(), undefined);
});
