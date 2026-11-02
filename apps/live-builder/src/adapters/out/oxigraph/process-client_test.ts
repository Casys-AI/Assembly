import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildDescriptor,
  type BuildRecipeInputs,
} from "../../../domain/model/value-objects/build.ts";
import {
  buildRefFromDescriptor,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import { SemanticIndexError } from "../../../application/model/semantic/index-service.ts";
import {
  SemanticProjectionProcessClient,
  SemanticProjectionProcessError,
} from "./process-client.ts";
import type { SemanticProjectionPreparationInput } from "./preparation.ts";
import type {
  SemanticPreparationFailure,
  SemanticPreparationResponse,
} from "./protocol.ts";
import type {
  IsolatedWorkerEndpoint,
  IsolatedWorkerRequest,
} from "../sysml-toolkit/worker-client.ts";

type QueuedInput = { input: SemanticProjectionPreparationInput };
const recipe: BuildRecipeInputs = {
  toolkit: { version: "fixture", bundleDigest: "a".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 2,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "fixture",
};

/** The client validates structure; worker preparation tests authenticate S/R/K/A. */
function input(artifact = "d".repeat(64)): SemanticProjectionPreparationInput {
  const descriptor = buildDescriptor({
    repositoryId: "semantic-process-test",
    sourceDigest: "1".repeat(64),
    recipe,
    recipeDigest: "2".repeat(64),
    buildKey: "3".repeat(64),
    artifactDigest: artifact,
    bytes: 200,
  });
  return { build: buildRefFromDescriptor(descriptor), descriptor };
}
function projection(artifact: string): ProjectionRef {
  return {
    kind: "rdf-quads",
    projectorVersion: `ase-rdf-quads-v2:${"4".repeat(64)}`,
    artifactDigest: artifact,
    projectionDigest: "e".repeat(64),
  };
}

class FakeProcess extends EventEmitter implements IsolatedWorkerEndpoint {
  readonly requests: IsolatedWorkerRequest<QueuedInput>[] = [];
  terminationCalls = 0;
  #acknowledge!: (code: number) => void;
  readonly termination = new Promise<number>((resolve) => {
    this.#acknowledge = resolve;
  });
  #requested!: () => void;
  readonly terminationRequested = new Promise<void>((resolve) => {
    this.#requested = resolve;
  });
  postMessage(message: unknown): void {
    this.requests.push(message as IsolatedWorkerRequest<QueuedInput>);
    this.emit("message", { id: this.requests.at(-1)!.id, kind: "started" });
  }
  terminate(): Promise<number> {
    this.terminationCalls++;
    this.#requested();
    return this.termination;
  }
  acknowledgeTermination(): void {
    this.#acknowledge(0);
  }
  ref(): void {}
  unref(): void {}
  respond(response: SemanticPreparationResponse): void {
    this.emit("message", {
      id: this.requests.at(-1)!.id,
      kind: "result",
      ok: true,
      reusable: false,
      result: response,
    });
  }
  answer(): void {
    const request = this.requests.at(-1)!;
    this.respond({
      v: 1,
      id: request.id,
      ok: true,
      projection: projection(request.request.input.build.artifactDigest),
    });
  }
  refuse(error: SemanticPreparationFailure): void {
    this.respond({ v: 1, id: this.requests.at(-1)!.id, ok: false, error });
  }
}

function harness(options: { timeoutMs?: number; maxQueued?: number } = {}) {
  const workers: FakeProcess[] = [];
  const client = new SemanticProjectionProcessClient({
    cachePath: "/semantic-tests/cache.kv",
    vaultDirectory: "/semantic-tests/vault",
    timeoutMs: options.timeoutMs ?? 10_000,
    maxQueued: options.maxQueued ?? 1,
    createWorker: () => {
      const worker = new FakeProcess();
      workers.push(worker);
      return worker;
    },
  });
  const close = async () => {
    const closing = client.close();
    for (const worker of workers) worker.acknowledgeTermination();
    await closing;
  };
  return { client, workers, close };
}

async function microtasks(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
}
function failureCode(error: unknown, code: string): void {
  ok(error instanceof SemanticIndexError);
  equal(error.code, code);
}

/** Advance the scheduler's real deadlines without timing-sensitive sleeps.
 * Each test restores all three globals before another test can run. */
class ManualClock {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; run(): void }>();
  readonly #originalSetTimeout = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout",
  )!;
  readonly #originalClearTimeout = Object.getOwnPropertyDescriptor(
    globalThis,
    "clearTimeout",
  )!;
  readonly #originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  constructor() {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void, delay = 0) => {
        const id = ++this.#nextId;
        this.#timers.set(id, {
          at: this.#now + Math.max(0, delay),
          run: callback,
        });
        return id;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (id: number | undefined) => {
        if (id !== undefined) this.#timers.delete(id);
      },
    });
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => this.#now,
    });
  }
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (;;) {
      const expired = [...this.#timers.entries()].find(([, timer]) =>
        timer.at <= this.#now
      );
      if (!expired) break;
      this.#timers.delete(expired[0]);
      expired[1].run();
    }
    await microtasks();
  }
  restore(): void {
    Object.defineProperty(globalThis, "setTimeout", this.#originalSetTimeout);
    Object.defineProperty(
      globalThis,
      "clearTimeout",
      this.#originalClearTimeout,
    );
    if (this.#originalNow) {
      Object.defineProperty(performance, "now", this.#originalNow);
    } else Reflect.deleteProperty(performance, "now");
  }
}

Deno.test("semantic preparation client admits one process and a bounded descriptor queue", async () => {
  const { client, workers, close } = harness();
  const firstInput = input();
  const secondInput = input("c".repeat(64));
  const first = client.prepare(firstInput);
  const second = client.prepare(secondInput);
  try {
    deepStrictEqual(client.stats(), { active: 1, queued: 1, retiring: 0 });
    equal(workers.length, 1);
    await rejects(client.prepare(input("b".repeat(64))), {
      code: "INDEX_BUSY",
    });
    workers[0].answer();
    await workers[0].terminationRequested;
    equal(workers.length, 1);
    deepStrictEqual(client.stats(), { active: 0, queued: 1, retiring: 1 });
    workers[0].acknowledgeTermination();
    deepStrictEqual(await first, {
      projection: projection(firstInput.build.artifactDigest),
    });
    equal(workers.length, 2);
    workers[1].answer();
    await workers[1].terminationRequested;
    workers[1].acknowledgeTermination();
    deepStrictEqual(await second, {
      projection: projection(secondInput.build.artifactDigest),
    });
    equal(workers[0].requests.length, 1);
    equal(workers[1].requests.length, 1);
  } finally {
    await close();
  }
});

Deno.test("semantic preparation client retains the queue deadline after dispatch", async () => {
  const clock = new ManualClock();
  const { client, workers, close } = harness({ timeoutMs: 100 });
  const first = client.prepare(input());
  const second = client.prepare(input("c".repeat(64))).catch((error: unknown) =>
    error
  );
  try {
    await clock.advance(70);
    workers[0].answer();
    await workers[0].terminationRequested;
    workers[0].acknowledgeTermination();
    await first;
    equal(workers.length, 2);
    await clock.advance(29);
    equal(workers[1].terminationCalls, 0);
    await clock.advance(1);
    await workers[1].terminationRequested;
    failureCode(await second, "INDEX_TIMEOUT");
    equal(workers[1].terminationCalls, 1);
    workers[1].acknowledgeTermination();
  } finally {
    await close();
    clock.restore();
  }
});

Deno.test("semantic preparation close defeats a received success while retirement is pending", async () => {
  const { client, workers, close } = harness();
  const preparing = client.prepare(input()).catch((error: unknown) => error);
  try {
    workers[0].answer();
    await workers[0].terminationRequested;
    deepStrictEqual(client.stats(), { active: 0, queued: 0, retiring: 1 });
    let closed = false;
    const closing = client.close();
    equal(client.close(), closing);
    void closing.then(() => closed = true);
    await microtasks();
    equal(closed, false);
    equal(workers[0].terminationCalls, 1);
    workers[0].acknowledgeTermination();
    failureCode(await preparing, "INDEX_UNAVAILABLE");
    await closing;
    equal(closed, true);
    equal(workers[0].terminationCalls, 1);
    await rejects(() => client.prepare(input()), { code: "INDEX_UNAVAILABLE" });
  } finally {
    await close();
  }
});

Deno.test("semantic preparation timeout retires the process and refuses its late success", async () => {
  const clock = new ManualClock();
  const { client, workers, close } = harness({ timeoutMs: 100 });
  const timedOut = client.prepare(input()).catch((error: unknown) => error);
  try {
    await clock.advance(100);
    await workers[0].terminationRequested;
    failureCode(await timedOut, "INDEX_TIMEOUT");
    const retry = client.prepare(input("c".repeat(64)));
    equal(workers.length, 1);
    workers[0].answer();
    workers[0].emit("exit");
    workers[0].emit("error", new Error("late crash"));
    await microtasks();
    equal(workers.length, 1);
    deepStrictEqual(client.stats(), { active: 0, queued: 1, retiring: 1 });
    workers[0].acknowledgeTermination();
    await microtasks();
    equal(workers.length, 2);
    workers[1].answer();
    await workers[1].terminationRequested;
    workers[1].acknowledgeTermination();
    deepStrictEqual(await retry, { projection: projection("c".repeat(64)) });
  } finally {
    await close();
    clock.restore();
  }
});

Deno.test("semantic preparation close settles waiters and observes exit before resolving", async () => {
  const { client, workers, close } = harness();
  const active = client.prepare(input()).catch((error: unknown) => error);
  const queued = client.prepare(input("c".repeat(64))).catch((error: unknown) =>
    error
  );
  try {
    const closing = client.close();
    equal(client.close(), closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await workers[0].terminationRequested;
    failureCode(await active, "INDEX_UNAVAILABLE");
    failureCode(await queued, "INDEX_UNAVAILABLE");
    equal(closed, false);
    equal(workers[0].terminationCalls, 1);
    workers[0].answer();
    workers[0].emit("exit");
    await rejects(client.prepare(input()), { code: "INDEX_UNAVAILABLE" });
    equal(workers.length, 1);
    workers[0].acknowledgeTermination();
    await closing;
    equal(closed, true);
    deepStrictEqual(client.stats(), { active: 0, queued: 0, retiring: 0 });
  } finally {
    await close();
  }
});

Deno.test("semantic preparation success waits for process retirement acknowledgement", async () => {
  const { client, workers, close } = harness();
  let completed = false;
  const result = client.prepare(input()).then((value) => {
    completed = true;
    return value;
  });
  try {
    workers[0].answer();
    await workers[0].terminationRequested;
    await microtasks();
    equal(completed, false);
    deepStrictEqual(client.stats(), { active: 0, queued: 0, retiring: 1 });
    workers[0].acknowledgeTermination();
    deepStrictEqual(await result, { projection: projection("d".repeat(64)) });
    equal(completed, true);
  } finally {
    await close();
  }
});

Deno.test("semantic preparation crash releases its lane only after exit and queued work can retry", async () => {
  const { client, workers, close } = harness();
  const crashed = client.prepare(input()).catch((error: unknown) => error);
  const retry = client.prepare(input("c".repeat(64)));
  try {
    workers[0].emit("exit");
    await workers[0].terminationRequested;
    equal(workers.length, 1);
    workers[0].acknowledgeTermination();
    failureCode(await crashed, "INDEX_UNAVAILABLE");
    equal(workers.length, 2);
    workers[0].answer();
    workers[1].answer();
    await workers[1].terminationRequested;
    workers[1].acknowledgeTermination();
    deepStrictEqual(await retry, { projection: projection("c".repeat(64)) });
  } finally {
    await close();
  }
});

Deno.test("semantic preparation client snapshots small full build pins before queueing", async () => {
  const { client, workers, close } = harness();
  const first = client.prepare(input());
  const original = structuredClone(input("c".repeat(64)));
  const expected = structuredClone(original);
  const queued = client.prepare(original);
  try {
    Object.assign(original.descriptor.recipe.toolkit, {
      version: "mutated-after-admission",
    });
    Object.assign(original.descriptor.recipe, { normalizerVersion: 999 });
    Object.assign(original.descriptor, {
      bytes: 999,
      artifactDigest: "f".repeat(64),
    });
    Object.assign(original.build, { artifactDigest: "f".repeat(64) });
    workers[0].answer();
    await workers[0].terminationRequested;
    workers[0].acknowledgeTermination();
    await first;
    const admitted = workers[1].requests[0].request;
    deepStrictEqual(admitted, { input: expected });
    const wire = JSON.stringify(admitted);
    ok(new TextEncoder().encode(wire).byteLength < 4096);
    for (
      const field of [
        "quads",
        "elements",
        "sources",
        "cachePath",
        "vaultDirectory",
      ]
    ) {
      ok(
        !wire.includes(`\"${field}\"`),
        `${field} must not enter the control input`,
      );
    }
    workers[1].answer();
    await workers[1].terminationRequested;
    workers[1].acknowledgeTermination();
    deepStrictEqual(await queued, {
      projection: projection(expected.build.artifactDigest),
    });
  } finally {
    await close();
  }
});

Deno.test("semantic preparation client retains coded child failure context and recovery", async () => {
  const { client, workers, close } = harness();
  const result = client.prepare(input()).catch((error: unknown) => error);
  const original: SemanticPreparationFailure = {
    code: "BUILD_BLOB_CORRUPT",
    message: "Stored projection failed its digest",
    context: { stage: "verify", artifactDigest: "d".repeat(64) },
    recovery: "Restore the exact immutable bytes before retrying.",
  };
  try {
    workers[0].refuse(original);
    await workers[0].terminationRequested;
    workers[0].acknowledgeTermination();
    const failure = await result;
    ok(failure instanceof SemanticProjectionProcessError);
    equal(failure.code, original.code);
    equal(failure.message, original.message);
    equal(failure.recovery, original.recovery);
    deepStrictEqual(failure.context, original.context);
  } finally {
    await close();
  }
});
