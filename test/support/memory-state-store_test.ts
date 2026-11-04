import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { MemoryStateStore } from "./memory-state-store.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";

Deno.test("memory-tier state snapshots isolate readers and preserve create/revision CAS", async () => {
  const store = new MemoryStateStore();
  const initial: SystemRuntimeState = {
    id: "memory-fixture",
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "waiting",
    provider: "fixture",
  };
  await rejects(
    () => store.save({ ...initial, revision: 2 }, null),
    /revision/,
  );
  const pending = store.save(initial, null);
  initial.phase = "caller mutation";
  await pending;
  equal((await store.load())!.phase, "waiting");
  const read = (await store.load())!;
  read.phase = "reader mutation";
  equal((await store.load())!.phase, "waiting");
  const updates = await Promise.allSettled([
    store.save({ ...read, revision: 1, phase: "one" }, 0),
    store.save({ ...read, revision: 1, phase: "two" }, 0),
  ]);
  equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  const accepted = await store.load();
  await rejects(
    () => store.save({ ...read, id: "other", revision: 2 }, 1),
    /identity/,
  );
  deepStrictEqual(await store.load(), accepted);
  await store.close();
  await rejects(async () => await store.load(), /closed/);
});
