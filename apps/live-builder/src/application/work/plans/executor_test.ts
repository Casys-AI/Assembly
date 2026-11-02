// deno-lint-ignore-file require-await
import {
  instantiateWorkResultContract,
  type WorkResultContract,
} from "../../../domain/work/policies/verified-effect-closure.ts";
// Async fakes preserve the production ports' contracts.
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  AdmittedWorkTask,
  WorkPlanRecord,
} from "../../../domain/work/entities/plans.ts";
import type { WorkPlanExecution } from "./commands/inputs.ts";
import { WorkPlanExecutor, workTaskInvocationId } from "./executor.ts";
import type { WorkPlanStorePort } from "./ports.ts";

class MemoryPlans implements WorkPlanStorePort {
  rows = new Map<string, WorkPlanRecord>();
  writes: WorkPlanRecord[] = [];
  failRevision?: number;
  async load(id: string) {
    return structuredClone(this.rows.get(id) ?? null);
  }
  async save(record: WorkPlanRecord, expected: number | null) {
    const previous = this.rows.get(record.id);
    if (
      (expected === null
        ? previous !== undefined
        : previous?.revision !== expected) ||
      record.revision === this.failRevision
    ) throw new Error("STALE_PLAN");
    this.rows.set(record.id, structuredClone(record));
    this.writes.push(structuredClone(record));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const version = {
  digest: "admitted-contract",
  repositoryVersion: "commit:source",
};
async function task(
  planId: string,
  id: string,
  resourceId = id,
  dependsOn: string[] = [],
): Promise<AdmittedWorkTask> {
  const input = { text: id };
  return {
    id,
    resourceId,
    dependsOn,
    inputDigest: await executionDigest(input),
    invocation: {
      callerId: "coordinator",
      invocationId: workTaskInvocationId(planId, id),
      modelVersion: version,
      input,
      behavior: {
        id: "access:" + resourceId,
        name: "Work inbox",
        description: "Native request exposure",
        callerNativeId: "coordinator",
        targetNativeId: "inbox:" + resourceId,
        targetTypeId: "inbox-definition",
        inputTypeId: "request-definition",
        inputSchema: { type: "object" },
        sourceIds: ["access:" + resourceId, "inbox:" + resourceId],
      },
    },
  };
}
function plan(
  id: string,
  tasks: AdmittedWorkTask[],
  maxConcurrency = 2,
): WorkPlanExecution {
  return {
    id,
    callerId: "coordinator",
    modelVersion: version,
    tasks,
    maxConcurrency,
  };
}
function receipt(
  request: BehaviorInvocationRequest,
  result: unknown = "done",
): BehaviorInvocationResult {
  return {
    behaviorId: request.behavior.id,
    targetNativeId: request.behavior.targetNativeId,
    invocationId: request.invocationId,
    modelVersion: request.modelVersion,
    result,
  };
}

Deno.test("task case correlation is checked before dispatch and copied into provider receipts", async () => {
  const store = new MemoryPlans();
  const requests: BehaviorInvocationRequest[] = [];
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (request) => {
      requests.push(request);
      return receipt(request);
    },
  });
  const request = plan("plan", [await task("plan", "one")]);
  request.caseId = "case-1";
  await rejects(() => executor.execute(request), /case correlation/);
  equal(store.rows.size, 0);
  request.tasks[0].caseId = "case-1";
  request.tasks[0].invocation.caseId = "case-1";
  const result = await executor.execute(request);
  equal(requests[0].caseId, "case-1");
  equal(result.tasks[0].receipt?.caseId, "case-1");
});

Deno.test("a concurrent replay from another Case cannot observe the active plan", async () => {
  const started = deferred<void>();
  const gate = deferred<BehaviorInvocationResult>();
  let dispatched!: BehaviorInvocationRequest;
  const executor = new WorkPlanExecutor({
    store: new MemoryPlans(),
    invokeTarget: (request) => {
      dispatched = request;
      started.resolve();
      return gate.promise;
    },
  });
  const request = plan("active-plan", [await task("active-plan", "one")]);
  request.caseId = "case-1";
  request.tasks[0].caseId = request.caseId;
  request.tasks[0].invocation.caseId = request.caseId;
  const pending = executor.execute(request);
  await started.promise;
  const other = structuredClone(request);
  other.caseId = "case-2";
  other.tasks[0].caseId = other.caseId;
  other.tasks[0].invocation.caseId = other.caseId;
  await rejects(() => executor.execute(other), /identity already in use/);
  gate.resolve(receipt(dispatched));
  equal((await pending).caseId, "case-1");
});

Deno.test("a target receipt for another Case cannot complete an admitted task", async () => {
  const executor = new WorkPlanExecutor({
    store: new MemoryPlans(),
    invokeTarget: async (request) => ({
      ...receipt(request),
      caseId: "case-2",
    }),
  });
  const request = plan("case-plan", [await task("case-plan", "one")]);
  request.caseId = "case-1";
  request.tasks[0].caseId = request.caseId;
  request.tasks[0].invocation.caseId = request.caseId;
  const result = await executor.execute(request);
  equal(result.status, "interrupted");
  equal(result.tasks[0].receipt, undefined);
  equal(result.tasks[0].error!.code, "TARGET_RECEIPT_UNCONFIRMED");
});

Deno.test("a whole graph and every admitted input are checked before storing or invoking a plan", async () => {
  const store = new MemoryPlans();
  let calls = 0;
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls++;
      return receipt(r);
    },
  });
  const first = await task("plan", "first");
  const invalid = await task("plan", "last", "other", ["missing"]);
  await rejects(
    () => executor.execute(plan("plan", [first, invalid])),
    /unknown dependency/,
  );
  invalid.dependsOn = [];
  invalid.invocation.input = { text: "changed after admission" };
  await rejects(
    () => executor.execute(plan("plan", [first, invalid])),
    /changed after/,
  );
  equal(calls, 0);
  equal(store.rows.size, 0);
});

Deno.test("independent targets run together and dependencies wait for both exact receipts", async () => {
  const store = new MemoryPlans();
  const twoStarted = deferred<void>(), thirdStarted = deferred<void>();
  const gates = new Map<
    string,
    ReturnType<typeof deferred<BehaviorInvocationResult>>
  >();
  const requests: BehaviorInvocationRequest[] = [];
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: (request) => {
      requests.push(request);
      const gate = deferred<BehaviorInvocationResult>();
      gates.set(String(request.input.text), gate);
      if (requests.length === 2) twoStarted.resolve();
      if (requests.length === 3) thirdStarted.resolve();
      return gate.promise;
    },
  });
  const tasks = [
    await task("plan", "a"),
    await task("plan", "b"),
    await task("plan", "c", "a", ["a", "b"]),
  ];
  const original = structuredClone(tasks);
  const result = executor.execute(plan("plan", tasks));
  await twoStarted.promise;
  deepStrictEqual(requests.map((r) => r.input.text), ["a", "b"]);
  gates.get("a")!.resolve(receipt(requests[0]));
  equal(requests.length, 2);
  gates.get("b")!.resolve(receipt(requests[1]));
  await thirdStarted.promise;
  const beforeThird = await store.load("plan");
  deepStrictEqual(beforeThird!.tasks.slice(0, 2).map((t) => t.state), [
    "completed",
    "completed",
  ]);
  gates.get("c")!.resolve(receipt(requests[2]));
  const completed = await result;
  equal(completed.status, "completed");
  deepStrictEqual(completed.tasks.map((t) => t.state), [
    "completed",
    "completed",
    "completed",
  ]);
  deepStrictEqual(tasks, original);
  const replay = await executor.execute(plan("plan", tasks));
  deepStrictEqual(replay, completed);
  equal(requests.length, 3);
});

Deno.test("the same native resource is sequential even between two concurrently admitted plans", async () => {
  const store = new MemoryPlans();
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const requests: BehaviorInvocationRequest[] = [];
  const gates: ReturnType<typeof deferred<BehaviorInvocationResult>>[] = [];
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: (request) => {
      requests.push(request);
      const gate = deferred<BehaviorInvocationResult>();
      gates.push(gate);
      if (requests.length === 1) firstStarted.resolve();
      else secondStarted.resolve();
      return gate.promise;
    },
  });
  const first = executor.execute(
    plan("one", [await task("one", "a", "same-agent")]),
  );
  const second = executor.execute(
    plan("two", [await task("two", "b", "same-agent")]),
  );
  await firstStarted.promise;
  equal(requests.length, 1);
  gates[0].resolve(receipt(requests[0]));
  await secondStarted.promise;
  equal(requests.length, 2);
  gates[1].resolve(receipt(requests[1]));
  deepStrictEqual((await Promise.all([first, second])).map((p) => p.status), [
    "completed",
    "completed",
  ]);
});

Deno.test("reported failures retain receipts and block their dependents without discarding independent work", async () => {
  const store = new MemoryPlans();
  const calls: string[] = [];
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls.push(String(r.input.text));
      return receipt(r, r.input.text === "bad" ? "failed" : "completed");
    },
    completion: (r) => r.result === "failed" ? "failed" : "completed",
  });
  const result = await executor.execute(
    plan("plan", [
      await task("plan", "bad"),
      await task("plan", "dependent", "other", ["bad"]),
      await task("plan", "independent", "other"),
    ]),
  );
  equal(result.status, "failed");
  deepStrictEqual(result.tasks.map((t) => t.state), [
    "failed",
    "blocked",
    "completed",
  ]);
  equal(result.tasks[0].receipt!.result, "failed");
  deepStrictEqual(calls, ["bad", "independent"]);
});

Deno.test("waiting work requires explicit reconciliation and keeps its original receipt and correlation", async () => {
  const store = new MemoryPlans();
  const calls: BehaviorInvocationRequest[] = [];
  let waiting = true;
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls.push(r);
      return receipt(r, waiting ? "waiting" : "completed");
    },
    completion: (r) => r.result === "waiting" ? "waiting" : "completed",
  });
  const request = plan("plan", [
    await task("plan", "a"),
    await task("plan", "b", "other", ["a"]),
  ]);
  const pending = await executor.execute(request);
  equal(pending.status, "waiting");
  equal(calls.length, 1);
  await executor.execute(request);
  equal(calls.length, 1);
  waiting = false;
  const completed = await executor.execute(request, { resume: true });
  equal(completed.status, "completed");
  equal(calls.length, 3);
  equal(calls[0].invocationId, calls[1].invocationId);
  equal(completed.tasks[0].attempts![0].receipt!.result, "waiting");
  equal(completed.tasks[0].attempts![1].receipt!.result, "completed");
});

Deno.test("one failed branch cannot prevent explicit reconciliation of independent waiting work", async () => {
  const store = new MemoryPlans();
  const calls: string[] = [];
  let waiting = true;
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      const id = String(r.input.text);
      calls.push(id);
      return receipt(
        r,
        id === "bad"
          ? "failed"
          : id === "wait" && waiting
          ? "waiting"
          : "completed",
      );
    },
    completion: (r) => r.result as "completed" | "waiting" | "failed",
  });
  const request = plan("mixed", [
    await task("mixed", "bad"),
    await task("mixed", "wait"),
    await task("mixed", "blocked", "blocked", ["bad"]),
    await task("mixed", "after-wait", "after-wait", ["wait"]),
  ]);
  const partial = await executor.execute(request);
  equal(partial.status, "waiting");
  deepStrictEqual(partial.tasks.map((t) => t.state), [
    "failed",
    "waiting",
    "blocked",
    "pending",
  ]);
  waiting = false;
  const result = await executor.execute(request, { resume: true });
  equal(result.status, "failed");
  deepStrictEqual(result.tasks.map((t) => t.state), [
    "failed",
    "completed",
    "blocked",
    "completed",
  ]);
  deepStrictEqual(calls, ["bad", "wait", "wait", "after-wait"]);
});

Deno.test("restart marks unknown in-flight work and rejects a stale writer; completed calls are never reissued", async () => {
  const store = new MemoryPlans();
  const started = deferred<void>(),
    uncertain = deferred<BehaviorInvocationResult>();
  const calls: BehaviorInvocationRequest[] = [];
  const first = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls.push(r);
      if (r.input.text === "b") {
        started.resolve();
        return await uncertain.promise;
      }
      return receipt(r);
    },
  });
  const request = plan("plan", [
    await task("plan", "a"),
    await task("plan", "b", "other", ["a"]),
  ], 1);
  const oldRun = first.execute(request);
  const oldFailure = rejects(() => oldRun, /STALE_PLAN/);
  await started.promise;
  let newCalls = 0;
  const restarted = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      newCalls++;
      return receipt(r);
    },
  });
  const interrupted = await restarted.execute(request);
  equal(interrupted.status, "interrupted");
  deepStrictEqual(interrupted.tasks.map((t) => t.state), [
    "completed",
    "interrupted",
  ]);
  equal(newCalls, 0);
  uncertain.resolve(receipt(calls[1]));
  await oldFailure;
  const resumed = await restarted.execute(request, { resume: true });
  equal(resumed.status, "completed");
  equal(newCalls, 1);
  equal(resumed.tasks[0].attempts!.length, 1);
  equal(resumed.tasks[1].attempts!.length, 2);
  equal(resumed.tasks[1].attempts![0].error!.code, "OUTCOME_UNCONFIRMED");
});

Deno.test("a failed reservation CAS prevents the first effect and foreign receipts assert no completion", async () => {
  const store = new MemoryPlans();
  store.failRevision = 2;
  let calls = 0;
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls++;
      return receipt(r);
    },
  });
  const request = plan("plan", [await task("plan", "a")]);
  await rejects(() => executor.execute(request), /STALE_PLAN/);
  equal(calls, 0);
  const foreignStore = new MemoryPlans();
  const foreign = new WorkPlanExecutor({
    store: foreignStore,
    invokeTarget: async (r) => ({
      ...receipt(r),
      invocationId: "someone-else",
    }),
  });
  const result = await foreign.execute(request);
  equal(result.status, "interrupted");
  equal(result.tasks[0].error!.code, "TARGET_RECEIPT_UNCONFIRMED");
  equal(result.tasks[0].receipt, undefined);
});

Deno.test("plan identity replays cannot replace another payload or create delimiter collisions", async () => {
  const store = new MemoryPlans();
  let calls = 0;
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: async (r) => {
      calls++;
      return receipt(r);
    },
  });
  const request = plan("plan", [await task("plan", "a")]);
  await executor.execute(request);
  await rejects(
    async () => executor.execute(plan("plan", [await task("plan", "b")])),
    /different content/,
  );
  equal(calls, 1);
  equal(
    workTaskInvocationId("a", "b:task:c") ===
      workTaskInvocationId("a:task:b", "c"),
    false,
  );
});

async function verifiedTask(planId: string, maxObservations = 3) {
  const work = await task(planId, "a");
  work.resultContract = {
    id: "result",
    callerNativeId: "coordinator",
    workBehaviorId: work.invocation.behavior.id,
    observationBehaviorId: "inspect",
    schemaVersion: "verified-effect-closure/v2",
    expected: {
      typeId: "expected",
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      values: { status: "published" },
    },
    observed: {
      typeId: "observed",
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
    condition: {
      nativeId: "condition",
      expression: {
        kind: "binary",
        op: "==",
        left: { kind: "path", root: "observed", path: ["status"] },
        right: { kind: "path", root: "expected", path: ["status"] },
      },
      sourceIds: ["condition"],
    },
    maxObservations,
    sourceIds: ["artifact"],
  };
  const input = {
    workInvocationId: work.invocation.invocationId,
    workBehaviorId: work.invocation.behavior.id,
    workInputDigest: work.inputDigest,
  };
  work.observationInvocation = {
    ...structuredClone(work.invocation),
    invocationId: work.invocation.invocationId + ":observe",
    behavior: { ...structuredClone(work.invocation.behavior), id: "inspect" },
    input,
  };
  work.observationInputDigest = await executionDigest(input);
  return work;
}
function observed(work: AdmittedWorkTask, available = true, patch = {}) {
  return {
    callerId: "coordinator",
    workInvocationId: work.invocation.invocationId,
    workBehaviorId: work.invocation.behavior.id,
    workInputDigest: work.inputDigest,
    modelVersion: version,
    available,
    source: {
      id: "record",
      revision: "snapshot:4",
    },
    values: available ? { status: "published" } : undefined,
    ...patch,
  };
}
Deno.test("result read blocks dependencies then explicit read-only continuation unlocks", async () => {
  const store = new MemoryPlans();
  const work = await verifiedTask("verified");
  const request = plan("verified", [
    work,
    await task("verified", "b", "b", ["a"]),
  ]);
  const effects: string[] = [];
  let available = false;
  const ports = {
    store,
    invokeTarget: async (r: BehaviorInvocationRequest) => {
      effects.push(r.behavior.id);
      return receipt(r);
    },
    observeTarget: async (r: BehaviorInvocationRequest) =>
      receipt(r, observed(work, available)),
  };
  const first = await new WorkPlanExecutor(ports).execute(request);
  equal(first.status, "waiting");
  equal(first.tasks[0]!.state, "completed");
  equal(first.tasks[1]!.state, "pending");
  equal(effects.length, 1);
  available = true;
  const resumed = await new WorkPlanExecutor(ports).execute(request, {
    resume: true,
  });
  equal(resumed.status, "completed");
  equal(effects.length, 2);
  equal(resumed.tasks[0]!.attempts!.length, 1);
});
Deno.test("wrong observation correlations and exhausted budget never release dependencies", async () => {
  for (
    const patch of [{ callerId: "another" }, { workInvocationId: "another" }, {
      workBehaviorId: "another",
    }, { modelVersion: { ...version, digest: "another" } }]
  ) {
    const work = await verifiedTask("wrong", 1);
    let writes = 0;
    let reads = 0;
    const executor = new WorkPlanExecutor({
      store: new MemoryPlans(),
      invokeTarget: async (r) => {
        writes++;
        return receipt(r);
      },
      observeTarget: async (r) => {
        reads++;
        return receipt(r, observed(work, true, patch));
      },
    });
    const request = plan("wrong", [work, await task("wrong", "b", "b", ["a"])]);
    const first = await executor.execute(request);
    equal(first.tasks[0]!.resultVerification!.status, "exhausted");
    equal(writes, 1);
    await executor.execute(request, { resume: true });
    equal(writes, 1);
    equal(reads, 1);
  }
});
Deno.test("required observation executor preflight refuses effects", async () => {
  let effects = 0;
  const executor = new WorkPlanExecutor({
    store: new MemoryPlans(),
    invokeTarget: async (r) => {
      effects++;
      return receipt(r);
    },
  });
  await rejects(() => executor.execute(plan("missing", [])));
  equal(effects, 0);
  const work = await verifiedTask("missing");
  await rejects(() => executor.execute(plan("missing", [work])));
  equal(effects, 0);
});

Deno.test("lost acknowledgement recovers by correlated source read without a repeated effect or invented receipt", async () => {
  const store = new MemoryPlans();
  const work = await verifiedTask("lost");
  const request = plan("lost", [work, await task("lost", "b", "b", ["a"])]);
  let effects = 0;
  const ports = {
    store,
    invokeTarget: async (r: BehaviorInvocationRequest) => {
      effects++;
      if (r.behavior.id === work.invocation.behavior.id) {
        throw new Error("lost acknowledgement");
      }
      return receipt(r);
    },
    observeTarget: async (r: BehaviorInvocationRequest) =>
      receipt(r, observed(work)),
  };
  const first = await new WorkPlanExecutor(ports).execute(request);
  equal(first.status, "interrupted");
  equal(effects, 1);
  const resumed = await new WorkPlanExecutor(ports).execute(request, {
    resume: true,
  });
  equal(resumed.status, "completed");
  equal(effects, 2);
  equal(resumed.tasks[0]!.state, "interrupted");
  equal(resumed.tasks[0]!.receipt, undefined);
  equal(resumed.tasks[0]!.attempts!.length, 1);
});

Deno.test("persisted observation reservation consumes budget after a failed result CAS", async () => {
  const store = new MemoryPlans();
  const work = await verifiedTask("crashed-read", 1);
  let effects = 0;
  let reads = 0;
  const request = plan("crashed-read", [
    work,
    await task("crashed-read", "b", "b", ["a"]),
  ]);
  const ports = {
    store,
    invokeTarget: async (r: BehaviorInvocationRequest) => {
      effects++;
      return receipt(r);
    },
    observeTarget: async (r: BehaviorInvocationRequest) => {
      reads++;
      store.failRevision = store.rows.get(request.id)!.revision + 1;
      return receipt(r, observed(work));
    },
  };
  await rejects(
    () => new WorkPlanExecutor(ports).execute(request),
    /STALE_PLAN/,
  );
  const persisted = store.rows.get(request.id)!;
  equal(persisted.tasks[0]!.state, "completed");
  equal(persisted.tasks[0]!.resultVerification!.attempts, 1);
  equal(persisted.tasks[0]!.resultVerification!.status, "pending");
  store.failRevision = undefined;
  const resumed = await new WorkPlanExecutor(ports).execute(request, {
    resume: true,
  });
  equal(resumed.tasks[0]!.resultVerification!.status, "exhausted");
  equal(resumed.tasks[1]!.state, "pending");
  equal(effects, 1);
  equal(reads, 1);
});

Deno.test("native query literal fields remain pinned to admitted observation and legacy policies cannot execute", async () => {
  const work = await verifiedTask("query");
  work.resultContract!.query = {
    typeId: "query",
    schema: {
      type: "object",
      properties: { recordKey: { type: "string" } },
      required: ["recordKey"],
      additionalProperties: false,
    },
    values: { recordKey: "saved-record" },
  };
  work.observationInvocation!.input.recordKey = "saved-record";
  work.observationInputDigest = await executionDigest(
    work.observationInvocation!.input,
  );
  let effects = 0;
  const executor = new WorkPlanExecutor({
    store: new MemoryPlans(),
    invokeTarget: async (r) => {
      effects++;
      return receipt(r);
    },
    observeTarget: async (r) => receipt(r, observed(work)),
  });
  equal((await executor.execute(plan("query", [work]))).status, "completed");
  const changed = structuredClone(work);
  changed.observationInvocation!.input.recordKey = "another";
  changed.observationInputDigest = await executionDigest(
    changed.observationInvocation!.input,
  );
  await rejects(
    () => executor.execute(plan("query", [changed])),
    /admitted result observation/,
  );
  const legacy = await verifiedTask("legacy-result");
  delete (legacy.resultContract as unknown as Record<string, unknown>)
    .schemaVersion;
  await rejects(
    () => executor.execute(plan("legacy-result", [legacy])),
    /Legacy.*readmission/,
  );
  equal(effects, 1);
});

Deno.test("resolved native record input bindings are checked before effects and immutable on resume", async () => {
  const work = await verifiedTask("bound-record");
  const scalarSchema = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const inputSchema = scalarSchema({
    amount: { type: "number" },
    recordId: { type: "string" },
  });
  work.invocation.input = { amount: 50, recordId: "invoice:17" };
  work.invocation.behavior.inputSchema = inputSchema;
  work.inputDigest = await executionDigest(work.invocation.input);
  const template: WorkResultContract = {
    ...work.resultContract!,
    input: {
      typeId: work.invocation.behavior.inputTypeId,
      schema: inputSchema,
      sourceIds: ["input"],
    },
    expected: {
      typeId: "expected",
      schema: scalarSchema({ amount: { type: "number" } }),
      values: {},
    },
    observed: {
      typeId: "observed",
      schema: scalarSchema({ amount: { type: "number" } }),
    },
    query: {
      typeId: "query",
      schema: scalarSchema({ recordId: { type: "string" } }),
      values: {},
    },
    valueBindings: [{
      target: "expected",
      targetField: "amount",
      inputField: "amount",
      sourceIds: ["bindAmount"],
    }, {
      target: "query",
      targetField: "recordId",
      inputField: "recordId",
      sourceIds: ["bindRecord"],
    }],
    condition: {
      nativeId: "condition",
      sourceIds: ["condition"],
      expression: {
        kind: "binary",
        op: ">=",
        left: { kind: "path", root: "observed", path: ["amount"] },
        right: { kind: "path", root: "expected", path: ["amount"] },
      },
    },
  };
  work.resultContract = instantiateWorkResultContract(
    template,
    work.invocation.input,
  );
  work.observationInvocation!.input = {
    recordId: "invoice:17",
    workInvocationId: work.invocation.invocationId,
    workBehaviorId: work.invocation.behavior.id,
    workInputDigest: work.inputDigest,
  };
  work.observationInputDigest = await executionDigest(
    work.observationInvocation!.input,
  );
  let effects = 0;
  const executor = new WorkPlanExecutor({
    store: new MemoryPlans(),
    invokeTarget: async (r) => {
      effects++;
      return receipt(r);
    },
    observeTarget: async (r) =>
      receipt(r, { ...observed(work), values: { amount: 49 } }),
  });
  const tampered = structuredClone(work);
  tampered.resultContract!.expected.values.amount = 0;
  await rejects(
    () => executor.execute(plan("bound-record", [tampered])),
    /differs/,
  );
  equal(effects, 0);
  const first = await executor.execute(plan("bound-record", [work]));
  equal(first.status, "waiting");
  equal(effects, 1);
  const changed = structuredClone(work);
  changed.invocation.input.amount = 100;
  changed.inputDigest = await executionDigest(changed.invocation.input);
  await rejects(
    () => executor.execute(plan("bound-record", [changed]), { resume: true }),
    /differs/,
  );
  equal(effects, 1);
});
