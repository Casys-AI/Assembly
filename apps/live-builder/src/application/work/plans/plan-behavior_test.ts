import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { BehaviorInvocationPort } from "../behaviors/invocation.ts";
import { admitBehaviorCall } from "../../../../test/support/behavior-call-admission.ts";
import { WorkPlanExecutor } from "./executor.ts";
import type { WorkPlanResultView } from "./result-view.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type {
  WorkPlanRecord,
  WorkTaskDraft,
} from "../../../domain/work/entities/plans.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { WorkPlanBehavior } from "../../../../test/support/work-plan-behavior.ts";
import { callerWorkPlanPort } from "./plan-behavior.ts";

class MemoryPlanStore {
  records = new Map<string, WorkPlanRecord>();
  load(id: string): Promise<WorkPlanRecord | null> {
    return Promise.resolve(structuredClone(this.records.get(id) ?? null));
  }
  save(record: WorkPlanRecord, expectedRevision: number | null): Promise<void> {
    const previous = this.records.get(record.id);
    if ((previous?.revision ?? null) !== expectedRevision) {
      return Promise.reject(new Error("Plan CAS conflict"));
    }
    this.records.set(record.id, structuredClone(record));
    return Promise.resolve();
  }
}

function exposure(
  id: string,
  targetNativeId: string,
  planning = false,
): NativeBehaviorContract {
  return {
    id,
    name: id,
    description: planning
      ? "Execute an admitted closed work graph."
      : "Work inbox.",
    targetNativeId,
    targetTypeId: planning ? "plan-type" : "inbox-type",
    inputTypeId: planning ? "plan-input" : "inbox-input",
    callerNativeId: "coordinator",
    inputSchema: planning
      ? {
        type: "object",
        properties: {
          tasksJson: { type: "string" },
          resume: { type: "boolean" },
          planId: { type: "string" },
        },
        required: ["tasksJson"],
        additionalProperties: false,
      }
      : {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    sourceIds: [id, targetNativeId],
  };
}

function setup(store = new MemoryPlanStore()) {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "coordinator",
  });
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = "branch:source-pin";
  const planning = exposure("plan-access", "plan-action", true);
  const first = exposure("first-access", "first-inbox");
  const second = exposure("second-access", "second-inbox");
  model.behaviors = [planning, first, second];
  const calls: BehaviorInvocationRequest[] = [];
  const invoker: BehaviorInvocationPort = {
    supports(behavior) {
      return Promise.resolve(
        behavior.targetNativeId === "first-inbox" ||
          behavior.targetNativeId === "second-inbox",
      );
    },
    invoke(request): Promise<BehaviorInvocationResult> {
      calls.push(structuredClone(request));
      return Promise.resolve({
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { status: "completed", text: request.input.text },
      });
    },
  };
  const executor = new WorkPlanExecutor({
    store,
    invokeTarget: (request) => invoker.invoke(request),
  });
  const adapter = new WorkPlanBehavior({
    executor,
    resolveCallerModel: () => Promise.resolve(structuredClone(model)),
    planTargetIds: new Set([planning.targetNativeId]),
    planTargetOwners: new Map([[planning.targetNativeId, "coordinator"]]),
    workTargetIds: new Set([first.targetNativeId, second.targetNativeId]),
    workInvoker: invoker,
    resourceId: (behavior) => behavior.targetNativeId,
    maxConcurrency: 2,
  });
  const request = (tasks: unknown): BehaviorInvocationRequest => ({
    behavior: structuredClone(planning),
    invocationId: "plan-invocation",
    callerId: "coordinator",
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: "branch:source-pin",
    },
    input: { tasksJson: JSON.stringify(tasks) },
  });
  return {
    model,
    planning,
    first,
    second,
    calls,
    store,
    invoker,
    adapter,
    request,
  };
}

const tasks = (): WorkTaskDraft[] => [{
  id: "collect",
  behaviorId: "first-access",
  input: { text: "Collect the supplied facts." },
  dependsOn: [],
}, {
  id: "inspect",
  behaviorId: "second-access",
  input: { text: "Inspect the supplied facts." },
  dependsOn: ["collect"],
}];

Deno.test("a transport graph that cannot fit the real protocol refuses before work or persistence", async () => {
  const f = setup();
  const graph = Array.from({ length: 32 }, (_, index) => ({
    ...tasks()[0]!,
    id: `task-${index}-` + "x".repeat(120),
    input: { text: "x".repeat(1620) },
  }));
  const request = f.request(graph);
  request.caseId = "root:" + "r".repeat(400);
  equal(JSON.stringify(request.input).length <= 65536, true);
  await rejects(() => f.adapter.invoke(request), /exact resume graph/);
  equal(f.calls.length, 0);
  equal(f.store.records.size, 0);
});

Deno.test("a genuine cross-unit exposure cannot execute the caller's planner while naming another owner's planning action", async () => {
  const f = setup();
  const foreign = exposure("foreign-plan-access", "foreign-plan-action", true);
  f.model.behaviors!.push(foreign);
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    planTargetIds: new Set(["plan-action", "foreign-plan-action"]),
    planTargetOwners: new Map([
      ["plan-action", "coordinator"],
      ["foreign-plan-action", "other-operator"],
    ]),
  });
  const request = { ...f.request(tasks()), behavior: foreign };
  equal(await adapter.supports(foreign, request.modelVersion), false);
  await rejects(() => adapter.invoke(request), /does not belong to its caller/);
  equal(f.calls.length, 0);
  equal(f.store.records.size, 0);
});

Deno.test("a registered planning action without qualified native ownership grants no planning execution", async () => {
  const f = setup();
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    planTargetOwners: new Map(),
  });
  const request = f.request(tasks());
  equal(await adapter.supports(request.behavior, request.modelVersion), false);
  await rejects(() => adapter.invoke(request), /does not belong to its caller/);
  equal(f.calls.length, 0);
  equal(f.store.records.size, 0);
});

Deno.test("closed-plan behavior keeps source provenance and exact target receipts", async () => {
  const f = setup();
  const before = structuredClone(f.model);
  const request = f.request(tasks());
  const receipt = await f.adapter.invoke(request);
  equal(receipt.behaviorId, request.behavior.id);
  equal(receipt.invocationId, request.invocationId);
  deepStrictEqual(receipt.modelVersion, request.modelVersion);
  const view = receipt.result as WorkPlanResultView;
  const plan = f.store.records.get(view.id)!;
  equal(view.format, "assembly-work-plan-result/v1");
  deepStrictEqual(view.graph, tasks());
  deepStrictEqual(
    view.tasks.map((task) => task.outputs[0]!.value),
    f.calls.map((call) => ({ status: "completed", text: call.input.text })),
  );
  equal(plan.status, "completed");
  equal(f.calls.length, 2);
  deepStrictEqual(f.calls.map((call) => call.behavior.targetNativeId), [
    "first-inbox",
    "second-inbox",
  ]);
  deepStrictEqual(
    plan.tasks.map((task) => task.receipt),
    f.calls.map((call) => ({
      behaviorId: call.behavior.id,
      invocationId: call.invocationId,
      targetNativeId: call.behavior.targetNativeId,
      modelVersion: call.modelVersion,
      result: { status: "completed", text: call.input.text },
    })),
  );
  deepStrictEqual(f.model, before);
});

Deno.test("a plan delegates every task within its caller's Case and rejects replay from another Case", async () => {
  const f = setup();
  const request = f.request(tasks());
  request.caseId = "central:case:1";
  request.caseContext = {
    caseId: request.caseId,
    number: 1,
    modelPin: request.modelVersion,
    budget: {
      scopeId: "central-session",
      ownerId: request.callerId,
      policy: {
        id: "budget",
        revision: 1,
        unit: "agent-invocation",
        limit: 5,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
      },
    },
  };
  const receipt = await f.adapter.invoke(request);
  const view = receipt.result as WorkPlanResultView;
  const plan = f.store.records.get(view.id)!;
  equal(receipt.caseId, request.caseId);
  equal(plan.caseId, request.caseId);
  for (const task of plan.tasks) {
    equal(task.caseId, request.caseId);
    equal(task.receipt!.caseId, request.caseId);
    deepStrictEqual(task.invocation.caseContext, request.caseContext);
  }
  for (const call of f.calls) {
    equal(call.caseId, request.caseId);
    deepStrictEqual(call.caseContext, request.caseContext);
    deepStrictEqual(Object.keys(call.input), ["text"]);
  }
  const foreign = structuredClone(request);
  foreign.caseId = "central:case:2";
  foreign.caseContext!.caseId = foreign.caseId;
  foreign.caseContext!.number = 2;
  await rejects(() => f.adapter.invoke(foreign), /different content/);
  equal(f.calls.length, 2);
});

Deno.test("a designer plan propagates its explicit scope without a Case and rejects another designer's replay", async () => {
  const f = setup();
  const request = f.request(tasks());
  request.designerContext = {
    scopeId: "central:designer",
    ownerId: request.callerId,
  };
  const receipt = await f.adapter.invoke(request);
  const view = receipt.result as WorkPlanResultView;
  const plan = f.store.records.get(view.id)!;
  equal(plan.caseId, undefined);
  for (const task of plan.tasks) {
    equal(task.caseId, undefined);
    deepStrictEqual(task.invocation.designerContext, request.designerContext);
  }
  for (const call of f.calls) {
    equal(call.caseId, undefined);
    deepStrictEqual(call.designerContext, request.designerContext);
  }
  const foreign = structuredClone(request);
  foreign.designerContext!.scopeId = "other:designer";
  await rejects(() => f.adapter.invoke(foreign), /different content/);
  equal(f.calls.length, 2);
});

Deno.test("a bad later task refuses the whole plan before any valid target is called", async () => {
  const f = setup();
  const invalid = tasks();
  invalid[1]!.input = { text: 42 };
  await rejects(() => f.adapter.invoke(f.request(invalid)), /refused/);
  equal(f.calls.length, 0);
  equal(f.store.records.size, 0);
});

Deno.test("closed-plan availability requires exact current caller exposure and semantic contract", async () => {
  const f = setup();
  const request = f.request(tasks());
  equal(await f.adapter.supports(request.behavior, request.modelVersion), true);
  const forged = { ...request.behavior, targetNativeId: "other-plan" };
  equal(await f.adapter.supports(forged, request.modelVersion), false);
  equal(
    await f.adapter.supports(
      { ...request.behavior, description: "forged" },
      request.modelVersion,
    ),
    false,
  );
  equal(
    await f.adapter.supports(request.behavior, {
      ...request.modelVersion,
      digest: "unadmitted",
    }),
    false,
  );
  await rejects(
    () => f.adapter.invoke({ ...request, callerId: "other-agent" }),
    /caller/,
  );
  f.model.behaviors = [];
  equal(
    await f.adapter.supports(request.behavior, request.modelVersion),
    false,
  );
  equal(f.calls.length, 0);
});

Deno.test("supports propagates a caller-model infrastructure failure with its code instead of answering false", async () => {
  const f = setup();
  const failure = Object.assign(new Error("toolkit exploded"), {
    code: "TOOLKIT_TIMEOUT",
  });
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    resolveCallerModel: () => Promise.reject(failure),
  });
  const request = f.request(tasks());
  await rejects(
    () => adapter.supports(request.behavior, request.modelVersion),
    (error: unknown) =>
      error === failure &&
      (error as { code?: unknown }).code === "TOOLKIT_TIMEOUT",
  );
  equal(f.calls.length, 0);
});

Deno.test("an unadmitted caller model is unsupported, and refused only when invoked", async () => {
  const f = setup();
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    resolveCallerModel: () => Promise.resolve(null),
  });
  const request = f.request(tasks());
  equal(
    await adapter.supports(request.behavior, request.modelVersion),
    false,
  );
  await rejects(
    () => adapter.invoke(request),
    /Work plan refused: the plan caller contract is not admitted/,
  );
  equal(f.calls.length, 0);
});

Deno.test("unrelated source advancement cannot replace the original invocation pin", async () => {
  const f = setup();
  const request = f.request(tasks());
  f.model.version.repositoryVersion = "branch:unrelated-commit";
  const receipt = await f.adapter.invoke(request);
  equal(receipt.modelVersion.repositoryVersion, "branch:source-pin");
  for (const call of f.calls) {
    equal(call.modelVersion.repositoryVersion, "branch:source-pin");
  }
});

Deno.test("DAG errors, unknown targets and nested plans cannot cause partial dispatch", async () => {
  for (const variant of ["cycle", "unknown", "nested"] as const) {
    const f = setup();
    const draft = tasks();
    if (variant === "cycle") draft[0]!.dependsOn = ["inspect"];
    if (variant === "unknown") draft[1]!.behaviorId = "not-exposed";
    if (variant === "nested") draft[1]!.behaviorId = "plan-access";
    await rejects(() => f.adapter.invoke(f.request(draft)));
    equal(f.calls.length, 0, variant);
    equal(f.store.records.size, 0, variant);
  }
});

Deno.test("a source-exposed work inbox on the planner's own runtime is refused", async () => {
  const f = setup();
  const self = new WorkPlanBehavior({
    ...f.adapter.options,
    resourceId: () => "coordinator",
  });
  await rejects(
    () => self.invoke(f.request(tasks())),
    /own sequential runtime/,
  );
  equal(f.calls.length, 0);
});

Deno.test("planning input remains a closed native schema without coercion", async () => {
  const f = setup();
  for (
    const input of [
      { tasksJson: "not-json" },
      { tasksJson: JSON.stringify(tasks()), resume: "true" },
      { tasksJson: JSON.stringify(tasks()), agentId: "arbitrary-target" },
      { tasksJson: JSON.stringify({ tasks: tasks() }) },
    ]
  ) {
    await rejects(() => f.adapter.invoke({ ...f.request(tasks()), input }));
  }
  equal(f.calls.length, 0);
});

Deno.test("replaying a completed invocation from persisted state never redispatches work", async () => {
  const store = new MemoryPlanStore();
  const first = setup(store);
  const request = first.request(tasks());
  const original = await first.adapter.invoke(request);
  equal(first.calls.length, 2);
  const restarted = setup(store);
  const replay = await restarted.adapter.invoke(request);
  equal(restarted.calls.length, 0);
  deepStrictEqual(replay, original);
  const changed = tasks();
  changed[0]!.input = { text: "Different task under the same identity." };
  await rejects(
    () => restarted.adapter.invoke(restarted.request(changed)),
    /different|changed|conflict|identity|content/i,
  );
  equal(restarted.calls.length, 0);
});

Deno.test("waiting work needs an explicit source-typed resume and retains its stable correlation", async () => {
  const f = setup();
  let waiting = true;
  const executor = new WorkPlanExecutor({
    store: f.store,
    invokeTarget: (request) => f.invoker.invoke(request),
    completion: () => waiting ? "waiting" : "completed",
  });
  const adapter = new WorkPlanBehavior({ ...f.adapter.options, executor });
  const request = f.request(tasks());
  const first = (await adapter.invoke(request)).result as WorkPlanResultView;
  equal(first.status, "waiting");
  equal(f.calls.length, 1);
  const initialCorrelation = f.calls[0]!.invocationId;
  const unchanged = (await adapter.invoke(request))
    .result as WorkPlanResultView;
  equal(unchanged.status, "waiting");
  equal(f.calls.length, 1);
  waiting = false;
  const resumed = (await adapter.invoke({
    ...request,
    invocationId: "new-chat-invocation",
    input: { ...request.input, resume: true, planId: first.id },
  })).result as WorkPlanResultView;
  equal(resumed.status, "completed");
  equal(f.calls.length, 3);
  equal(f.calls[1]!.invocationId, initialCorrelation);
  const raw = f.store.records.get(resumed.id)!;
  equal(raw.tasks[0]!.attempts?.length, 2);
  equal(raw.tasks[0]!.attempts?.[0]?.state, "waiting");
  equal(raw.tasks[0]!.attempts?.[1]?.state, "completed");
});

Deno.test("a later normal behavior admission resumes a persisted plan under a new chat UUID without redispatching its objective", async () => {
  const f = setup();
  let completed = false;
  const objectiveCalls = new Map<string, number>();
  const correlations: string[] = [];
  const target: BehaviorInvocationPort = {
    supports: (behavior, version) => f.invoker.supports(behavior, version),
    invoke(request) {
      const id = request.invocationId;
      correlations.push(id);
      // A target's persistent correlation returns a fresh completion receipt;
      // it does not submit the same objective a second time.
      if (!objectiveCalls.has(id)) objectiveCalls.set(id, 1);
      return Promise.resolve({
        behaviorId: request.behavior.id,
        targetNativeId: request.behavior.targetNativeId,
        invocationId: id,
        modelVersion: request.modelVersion,
        result: { status: completed ? "completed" : "waiting" },
      });
    },
  };
  const executor = new WorkPlanExecutor({
    store: f.store,
    invokeTarget: (request) => target.invoke(request),
    completion: (receipt) =>
      (receipt.result as { status: "completed" | "waiting" }).status,
  });
  const originalPin = f.model.version.repositoryVersion!;
  const resolvedPins: string[] = [];
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    executor,
    workInvoker: target,
    resolveCallerModel(_caller, pin) {
      resolvedPins.push(pin.repositoryVersion);
      return Promise.resolve(structuredClone(f.model));
    },
  });
  const drafts = [tasks()[0]!];
  const firstInput = { tasksJson: JSON.stringify(drafts) };
  const first = await admitBehaviorCall(
    {
      behaviorId: f.planning.id,
      inputJson: JSON.stringify(firstInput),
    },
    f.model,
    adapter,
    "first-real-chat-uuid",
  );
  equal(first.admitted, true);
  const firstReceipt = await adapter.invoke({
    behavior: f.planning,
    callerId: f.model.identity.builderId,
    invocationId: first.invocationId,
    modelVersion: first.modelVersion!,
    input: first.input!,
  });
  const recorded = firstReceipt.result as WorkPlanResultView;
  equal(recorded.status, "waiting");
  equal(recorded.id, first.invocationId);
  equal(recorded.origin!.invocationId, first.invocationId);

  // This is another ordinary turn and an unrelated source commit, not a
  // transport replay carrying the first turn's UUID.
  completed = true;
  f.model.version.repositoryVersion = "branch:unrelated-source-update";
  const second = await admitBehaviorCall(
    {
      behaviorId: f.planning.id,
      inputJson: JSON.stringify({
        ...firstInput,
        resume: true,
        planId: recorded.id,
      }),
    },
    f.model,
    adapter,
    "second-real-chat-uuid",
  );
  equal(second.admitted, true);
  const secondReceipt = await adapter.invoke({
    behavior: f.planning,
    callerId: f.model.identity.builderId,
    invocationId: second.invocationId,
    modelVersion: second.modelVersion!,
    input: second.input!,
  });
  const resumed = secondReceipt.result as WorkPlanResultView;
  equal(secondReceipt.invocationId, "second-real-chat-uuid");
  equal(
    secondReceipt.modelVersion.repositoryVersion,
    "branch:unrelated-source-update",
  );
  equal(resumed.id, recorded.id);
  equal(resumed.modelVersion.repositoryVersion, originalPin);
  equal(resumed.status, "completed");
  deepStrictEqual(resumed.origin, recorded.origin);
  equal(f.store.records.size, 1);
  equal(objectiveCalls.size, 1);
  deepStrictEqual([...objectiveCalls.values()], [1]);
  equal(correlations.length, 2);
  equal(correlations[0], correlations[1]);
  equal(resolvedPins.includes(originalPin), true);
});

Deno.test("resume needs an existing receipt owned by the same caller, with the unchanged DAG and planning origin", async () => {
  const f = setup();
  const original = (await f.adapter.invoke(f.request(tasks())))
    .result as WorkPlanResultView;
  const callCount = f.calls.length;
  const next = () => ({
    ...f.request(tasks()),
    invocationId: "another-chat-uuid",
    input: {
      tasksJson: JSON.stringify(tasks()),
      resume: true,
      planId: original.id,
    },
  });
  await rejects(
    () =>
      f.adapter.invoke({
        ...next(),
        input: { tasksJson: JSON.stringify(tasks()), resume: true },
      }),
    /requires the exact planId/,
  );
  await rejects(
    () =>
      f.adapter.invoke({
        ...next(),
        input: { ...next().input, planId: "absent-receipt" },
      }),
    /absent or belongs/,
  );
  await rejects(
    () =>
      f.adapter.invoke({
        ...next(),
        input: { tasksJson: JSON.stringify(tasks()), planId: original.id },
      }),
    /only for an explicit resume/,
  );
  const changed = tasks();
  changed[0]!.input = { text: "Replacement objective" };
  await rejects(
    () =>
      f.adapter.invoke({
        ...next(),
        input: { ...next().input, tasksJson: JSON.stringify(changed) },
      }),
    /cannot change/,
  );
  const changedGraph = tasks();
  changedGraph[1]!.dependsOn = [];
  await rejects(
    () =>
      f.adapter.invoke({
        ...next(),
        input: { ...next().input, tasksJson: JSON.stringify(changedGraph) },
      }),
    /cannot change/,
  );

  const row = f.store.records.get(original.id)!;
  row.callerId = "another-operator";
  await rejects(() => f.adapter.invoke(next()), /absent or belongs/);
  row.callerId = original.callerId;
  row.origin = { ...row.origin!, behaviorId: "another-planning-exposure" };
  await rejects(() => f.adapter.invoke(next()), /original planning exposure/);
  row.origin = original.origin;
  row.modelVersion.digest = "different-contract";
  await rejects(() => f.adapter.invoke(next()), /no longer admitted/);
  equal(f.calls.length, callCount);
  equal(f.store.records.size, 1);
});

Deno.test("required generic result contract refuses untrusted readers before any effect", async () => {
  const f = setup();
  const schema = {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
    additionalProperties: false,
  };
  f.model.workResultContracts = [{
    schemaVersion: "verified-effect-closure/v2",
    id: "result",
    callerNativeId: "coordinator",
    workBehaviorId: f.first.id,
    observationBehaviorId: "read",
    expected: { typeId: "expected", schema, values: { status: "saved" } },
    observed: { typeId: "observed", schema },
    condition: {
      nativeId: "condition",
      sourceIds: ["condition"],
      expression: {
        kind: "binary",
        op: "==",
        left: { kind: "path", root: "expected", path: ["status"] },
        right: { kind: "path", root: "observed", path: ["status"] },
      },
    },
    maxObservations: 2,
    sourceIds: ["result"],
  }];
  const adapter = new WorkPlanBehavior({
    ...f.adapter.options,
    observationInvoker: f
      .invoker as import("../behaviors/observation.ts").ObservationInvocationPort,
  });
  await rejects(() => adapter.invoke(f.request(tasks())), /qualified executor/);
  equal(f.calls.length, 0);
  equal(f.store.records.size, 0);
});

Deno.test("the caller planning port forwards a suspended plan's native resume", async () => {
  const calls: Array<[string, { resume?: true } | undefined]> = [];
  const planner: BehaviorInvocationPort = {
    supports: () => Promise.resolve(true),
    invoke: (request, options) => {
      calls.push([request.callerId, options]);
      return Promise.resolve({} as BehaviorInvocationResult);
    },
  };
  const port = callerWorkPlanPort({
    planTargetIds: new Set(["plan-target"]),
    isCaller: (id) => id === "owner",
    planner: () => Promise.resolve(planner),
  });
  const request = {
    callerId: "owner",
    behavior: { callerNativeId: "owner", targetNativeId: "plan-target" },
  } as unknown as BehaviorInvocationRequest;
  await port.invoke(request, { resume: true });
  await port.invoke(request);
  deepStrictEqual(calls, [["owner", { resume: true }], ["owner", undefined]]);
  await rejects(
    () =>
      port.invoke({
        ...request,
        callerId: "intruder",
        behavior: { ...request.behavior, callerNativeId: "intruder" },
      } as BehaviorInvocationRequest),
    /Unknown admitted work-plan caller/,
  );
  equal(
    await port.supports(
      { callerNativeId: "owner", targetNativeId: "other-target" } as never,
      { digest: "d", repositoryVersion: "commit:r" },
    ),
    false,
  );
});
