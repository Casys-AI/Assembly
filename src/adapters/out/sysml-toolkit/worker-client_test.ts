import { deepEqual, equal, rejects } from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  closeSysmlToolkitWorkers,
  createIsolatedWorkerRunner,
  type IsolatedWorkerEndpoint,
  type IsolatedWorkerRequest,
  runSysmlToolkitWorker,
  SysmlToolkitWorkerClosedError,
} from "./worker-client.ts";

type Operation = { operation: "check" | "board" };
const workerUrl = new URL("file:///fake/toolkit-worker.ts");
const request: Operation = { operation: "check" };

class FakeWorker extends EventEmitter implements IsolatedWorkerEndpoint {
  readonly requests: IsolatedWorkerRequest<Operation>[] = [];
  terminationCalls = 0;
  #acknowledge!: (code: number) => void;
  #refuse!: (error: Error) => void;
  readonly termination = new Promise<number>((resolve, reject) => {
    this.#acknowledge = resolve;
    this.#refuse = reject;
  });
  #requested!: () => void;
  readonly terminationRequested = new Promise<void>((resolve) => {
    this.#requested = resolve;
  });

  postMessage(message: unknown): void {
    this.requests.push(message as IsolatedWorkerRequest<Operation>);
  }
  terminate(): Promise<number> {
    this.terminationCalls++;
    this.#requested();
    return this.termination;
  }
  acknowledgeTermination(): void {
    this.#acknowledge(0);
  }
  refuseTermination(error: Error): void {
    this.#refuse(error);
  }
  ref(): void {}
  unref(): void {}
  answer(result: unknown): void {
    this.emit("message", {
      id: this.requests.at(-1)!.id,
      kind: "result",
      ok: true,
      result,
      reusable: true,
    });
  }
}

function harness(maxOperationsPerWorker?: number) {
  const workers: FakeWorker[] = [];
  const run = createIsolatedWorkerRunner<Operation>({
    isProjection: (operation) => operation.operation === "board",
    maxOperationsPerWorker,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { run, workers };
}

Deno.test("scheduler close rejects active and queued work and waits for termination acknowledgement", async () => {
  const { run, workers } = harness();
  const active = rejects(run("/package", request, 10_000, workerUrl), {
    code: "TOOLKIT_WORKER_CLOSED",
  });
  const queued = rejects(
    run("/package", { operation: "board" }, 10_000, workerUrl),
    {
      code: "TOOLKIT_WORKER_CLOSED",
    },
  );
  deepEqual(run.stats(), { active: 1, queued: 1, retiring: 0 });
  const closing = run.close();
  equal(run.close(), closing);
  let closed = false;
  void closing.then(() => closed = true);
  await workers[0].terminationRequested;
  await Promise.all([active, queued]);
  deepEqual(run.stats(), { active: 0, queued: 0, retiring: 1 });
  equal(closed, false);
  equal(workers[0].terminationCalls, 1);

  // Late native responses, exit and errors belong to the retired instance.
  workers[0].answer("late result");
  workers[0].emit("exit");
  workers[0].emit("error", new Error("late error"));
  await rejects(
    run("/package", request, 10_000, workerUrl),
    SysmlToolkitWorkerClosedError,
  );
  equal(workers.length, 1);
  equal(workers[0].requests.length, 1);
  workers[0].acknowledgeTermination();
  await closing;
  deepEqual(run.stats(), { active: 0, queued: 0, retiring: 0 });
  equal(run.close(), closing);
});

Deno.test("close during recycling prevents queued dispatch after the retirement finally", async () => {
  const { run, workers } = harness(1);
  const completed = run("/package", request, 10_000, workerUrl);
  workers[0].answer("completed before close");
  await workers[0].terminationRequested;
  const queued = rejects(run("/package", request, 10_000, workerUrl), {
    code: "TOOLKIT_WORKER_CLOSED",
  });
  const closing = run.close();
  await queued;
  deepEqual(run.stats(), { active: 0, queued: 0, retiring: 1 });
  workers[0].acknowledgeTermination();
  await closing;
  equal(await completed, "completed before close");
  await Promise.resolve();
  equal(workers.length, 1);
  equal(workers[0].terminationCalls, 1);
  deepEqual(run.stats(), { active: 0, queued: 0, retiring: 0 });
});

Deno.test("idle and never-started schedulers close without creating replacement workers", async () => {
  const idle = harness();
  const completed = idle.run("/package", request, 10_000, workerUrl);
  idle.workers[0].answer("done");
  equal(await completed, "done");
  const closingIdle = idle.run.close();
  await idle.workers[0].terminationRequested;
  idle.workers[0].acknowledgeTermination();
  await closingIdle;
  equal(idle.workers.length, 1);
  equal(idle.workers[0].terminationCalls, 1);

  const unused = harness();
  const closingUnused = unused.run.close();
  equal(unused.run.close(), closingUnused);
  await closingUnused;
  await rejects(unused.run("/package", request, 10_000, workerUrl), {
    code: "TOOLKIT_WORKER_CLOSED",
  });
  equal(unused.workers.length, 0);
  deepEqual(unused.run.stats(), { active: 0, queued: 0, retiring: 0 });
});

Deno.test("scheduler close reports a failed termination instead of claiming shutdown", async () => {
  const { run, workers } = harness();
  const active = rejects(run("/package", request, 10_000, workerUrl), {
    code: "TOOLKIT_WORKER_CLOSED",
  });
  const closing = run.close();
  const rejected = rejects(closing, /termination acknowledgement unavailable/);
  await workers[0].terminationRequested;
  workers[0].refuseTermination(
    new Error("termination acknowledgement unavailable"),
  );
  await Promise.all([active, rejected]);
  equal(run.close(), closing);
  equal(workers[0].terminationCalls, 1);
  await rejects(run("/package", request, 10_000, workerUrl), {
    code: "TOOLKIT_WORKER_CLOSED",
  });
});

Deno.test("global Toolkit shutdown is final and rejects pin, provenance and fixture calls", async () => {
  const closing = closeSysmlToolkitWorkers();
  equal(closeSysmlToolkitWorkers(), closing);
  await closing;
  for (const operation of ["pin", "provenance"] as const) {
    await rejects(runSysmlToolkitWorker("/package", { operation }), {
      code: "TOOLKIT_WORKER_CLOSED",
    });
  }
  await rejects(
    runSysmlToolkitWorker("/package", { operation: "pin" }, 10_000, workerUrl),
    {
      code: "TOOLKIT_WORKER_CLOSED",
    },
  );
});
