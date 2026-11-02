import assert from "node:assert/strict";
import { QueuedModelWriter } from "./queued-writer.ts";
import type { ModelWriteWorker, WorkerOutcome } from "./write-queue.ts";
import type { ModelWriteQueuePort } from "./ports/out/model-write-queue.port.ts";
import type { ModelCompiler } from "../builds/ports/out/model-compiler.port.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";

/** Tests the actual pump with a deterministic worker; no queue/SQL effects. */
Deno.test("retryable FIFO head yields; later pump continues published and legacy outcomes", async () => {
  const realNow = Date.now;
  let now = 100_000, calls = 0;
  const outcomes: WorkerOutcome[] = [
    {
      status: "retryable",
      commandId: "a",
      error: { code: "PENDING", message: "waiting" },
    },
    { status: "published", commandId: "a", version: "commit:a", already: true },
    {
      status: "refused",
      commandId: "b",
      error: { code: "DENIED", message: "denied" },
    },
    { status: "idle" },
  ];
  const worker = {
    runOnce() {
      calls++;
      return Promise.resolve(outcomes.shift()!);
    },
  } as unknown as ModelWriteWorker;
  const writer = new QueuedModelWriter(
    "repo",
    {} as ModelWriteQueuePort,
    worker,
    {} as ModelCompiler,
    {} as { at(version: string): Promise<ModelRevision> },
  );
  Date.now = () => now;
  try {
    await writer.pump();
    assert.equal(
      calls,
      1,
      "one pump cannot immediately reclaim its retryable head",
    );
    await writer.pump();
    assert.equal(
      calls,
      1,
      "another caller cannot bypass the shared retry cadence",
    );
    now += 1000;
    await writer.pump();
    assert.equal(
      calls,
      4,
      "after retry succeeds, existing published/refused/idle processing continues",
    );
  } finally {
    Date.now = realNow;
    await writer.close();
  }
});

Deno.test("explicit v1 resume waits the same cadence for a retryable head before publishing", async () => {
  const realNow = Date.now, realTimeout = globalThis.setTimeout;
  let now = 100_000, calls = 0, state = "queued";
  const waits: number[] = [];
  const command = {
    v: 1,
    kind: "accept-proposal",
    commandId: "a",
    repositoryId: "repo",
  };
  const queue = {
    get() {
      return Promise.resolve({
        command,
        state,
        publishedVersion: state === "published" ? "commit:result" : null,
      });
    },
  } as unknown as ModelWriteQueuePort;
  const worker = {
    runOnce() {
      calls++;
      if (calls === 1) {
        state = "retryable";
        return Promise.resolve({
          status: "retryable",
          commandId: "a",
          error: { code: "PENDING", message: "waiting" },
        });
      }
      if (calls === 2) {
        state = "published";
        return Promise.resolve({
          status: "published",
          commandId: "a",
          version: "commit:result",
          already: true,
        });
      }
      return Promise.resolve({ status: "idle" });
    },
  } as unknown as ModelWriteWorker;
  const model = { version: "commit:result" } as ModelRevision;
  const writer = new QueuedModelWriter(
    "repo",
    queue,
    worker,
    {} as ModelCompiler,
    { at: () => Promise.resolve(model) },
  );
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    waits.push(Number(delay));
    now += Number(delay);
    callback();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    assert.equal(await writer.resume("a"), model);
    assert.deepEqual(waits, [1000]);
    assert.equal(calls, 3);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
    await writer.close();
  }
});

Deno.test("waiting for a later FIFO entry does not hammer an earlier retryable head", async () => {
  const realNow = Date.now, realTimeout = globalThis.setTimeout;
  let now = 200_000, calls = 0, published = false;
  const waits: number[] = [];
  const queue = {
    get() {
      return Promise.resolve({
        command: {
          v: 1,
          kind: "accept-proposal",
          commandId: "later",
          repositoryId: "repo",
        },
        state: published ? "published" : "queued",
        publishedVersion: published ? "commit:later" : null,
      });
    },
  } as unknown as ModelWriteQueuePort;
  const worker = {
    runOnce() {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          status: "retryable",
          commandId: "first",
          error: { code: "PENDING", message: "waiting" },
        });
      }
      if (calls === 2) {
        return Promise.resolve({
          status: "published",
          commandId: "first",
          version: "commit:first",
          already: true,
        });
      }
      if (calls === 3) {
        published = true;
        return Promise.resolve({
          status: "published",
          commandId: "later",
          version: "commit:later",
          already: false,
        });
      }
      return Promise.resolve({ status: "idle" });
    },
  } as unknown as ModelWriteWorker;
  const result = { version: "commit:later" } as ModelRevision;
  const writer = new QueuedModelWriter(
    "repo",
    queue,
    worker,
    {} as ModelCompiler,
    { at: () => Promise.resolve(result) },
  );
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    waits.push(Number(delay));
    now += Number(delay);
    callback();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    assert.equal(await writer.resume("later"), result);
    assert.deepEqual(waits, [1000]);
    assert.equal(calls, 4);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
    await writer.close();
  }
});
