import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  createIsolatedWorkerRunner,
  SysmlToolkitTimeoutError,
  type ToolkitWorkerOperation,
} from "../../src/adapters/out/sysml-toolkit/worker-client.ts";

const fixture = new URL(
  "../fixtures/sysml-toolkit-worker-fixture.ts",
  import.meta.url,
);
const sources = { "model.sysml": "package Initial;" };
const request: ToolkitWorkerOperation = {
  operation: "query",
  sources,
  expression: "state",
};
interface WorkerState {
  calls: number;
  operations: string[];
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Retirement did not respect the response deadline"),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("recycling response expires while termination acknowledgment blocks queued work", async () => {
  // Prepare the fixture before intercepting termination, outside measured waits.
  const warmup = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => true,
    maxOperationsPerWorker: 1,
  });
  await warmup(crypto.randomUUID(), request, 4000, fixture);

  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => true,
    maxOperationsPerWorker: 1,
  });
  const key = crypto.randomUUID();
  const originalTerminate = Worker.prototype.terminate;
  let releaseAck!: () => void;
  const acknowledgment = new Promise<void>((resolve) => releaseAck = resolve);
  let terminationRequested!: () => void;
  const requested = new Promise<void>((resolve) =>
    terminationRequested = resolve
  );
  const actualTerminations: Promise<number>[] = [];
  let terminationCalls = 0;
  let assertions: Promise<unknown> | undefined;

  Worker.prototype.terminate = function (this: Worker): Promise<number> {
    terminationCalls++;
    const stopped = originalTerminate.call(this);
    actualTerminations.push(stopped);
    terminationRequested();
    return stopped.then(async (code) => {
      await acknowledgment;
      return code;
    });
  };
  try {
    const first = assert.rejects(run(key, request, 1500, fixture), (error) => {
      assert.ok(error instanceof SysmlToolkitTimeoutError);
      assert.equal(error.timeoutMs, 1500);
      assert.equal(error.started, true);
      return true;
    });
    // Attach a handler immediately even if fixture startup unexpectedly fails.
    assertions = first;
    void first.catch(() => undefined);
    await within(requested, 3000);
    const queued = assert.rejects(run(key, request, 250, fixture), (error) => {
      assert.ok(error instanceof SysmlToolkitTimeoutError);
      assert.equal(error.timeoutMs, 250);
      assert.equal(error.started, false);
      return true;
    });
    assertions = Promise.all([first, queued]);
    await within(assertions, 3000);
    assert.equal(
      terminationCalls,
      1,
      "the expired queued request starts no worker while acknowledgment is held",
    );
  } finally {
    // Release delayed acknowledgment even when checking the unfixed behavior.
    releaseAck();
    Worker.prototype.terminate = originalTerminate;
    await Promise.all(actualTerminations);
    await assertions?.catch(() => undefined);
  }

  const next = await run<WorkerState>(key, request, 1500, fixture);
  assert.equal(next.calls, 1);
  assert.deepEqual(next.operations, ["query"]);
});
