import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { NativeBehaviorContract } from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";
import type { WorkPlanRecord } from "../../../domain/work/entities/plans.ts";
import type { BehaviorInvocationPort } from "../behaviors/invocation.ts";
import { ObservationInvocationRegistry } from "../behaviors/observation.ts";
import { createWorkspacePlans } from "./workspace-plans.ts";

function setup() {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "caller",
  });
  const version = {
    digest: model.version.digest,
    repositoryVersion: "source-pin",
  };
  model.version.repositoryVersion = version.repositoryVersion;
  const planning: NativeBehaviorContract = {
    id: "planning",
    name: "planning",
    description: "Plan work",
    targetNativeId: "plan",
    targetTypeId: "plan-type",
    inputTypeId: "plan-input",
    callerNativeId: "caller",
    sourceIds: ["planning", "plan"],
    inputSchema: {
      type: "object",
      properties: { tasksJson: { type: "string" } },
      required: ["tasksJson"],
      additionalProperties: false,
    },
  };
  const work: NativeBehaviorContract = {
    ...planning,
    id: "work",
    targetNativeId: "inbox",
    inputTypeId: "work-input",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
  model.behaviors = [planning, work];
  const records = new Map<string, WorkPlanRecord>();
  const loaded: string[] = [];
  let loadFailure = false;
  let status: unknown = "completed";
  const invoker: BehaviorInvocationPort = {
    supports: () => Promise.resolve(true),
    invoke: (request) =>
      Promise.resolve({
        behaviorId: request.behavior.id,
        invocationId: request.invocationId,
        targetNativeId: request.behavior.targetNativeId,
        modelVersion: request.modelVersion,
        result: { status },
      }),
  };
  const planOwners = new Map<string, string>();
  const planTargets = new Set<string>();
  const targets = new Map([["inbox", "worker"]]);
  const plans = createWorkspacePlans({
    now: () => "2026-11-04T00:00:00.000Z",
    schemaValidator: { validate: () => ({ valid: true }) },
    loadStore(callerId) {
      loaded.push(callerId);
      return loadFailure
        ? Promise.reject(new Error("store unavailable"))
        : Promise.resolve({
          load: (id) => Promise.resolve(records.get(id) ?? null),
          save: (record) => {
            records.set(record.id, record);
            return Promise.resolve();
          },
        });
    },
    resolveCallerModel: () => Promise.resolve(model),
    isCaller: (id) => id === "caller",
    planOwners,
    planTargets,
    targets,
    workTargets: new Set(["inbox"]),
    workInvoker: invoker,
    observationInvoker: new ObservationInvocationRegistry([]),
  });
  const register = () => {
    planOwners.set("plan", "caller");
    planTargets.add("plan");
    return plans.ensure()!;
  };
  const request = (id: string): BehaviorInvocationRequest => ({
    behavior: planning,
    callerId: "caller",
    invocationId: id,
    modelVersion: version,
    input: {
      tasksJson: JSON.stringify([{
        id: "task",
        behaviorId: "work",
        input: { text: "do it" },
        dependsOn: [],
      }]),
    },
  });
  return {
    plans,
    register,
    planning,
    model,
    version,
    loaded,
    records,
    planOwners,
    planTargets,
    targets,
    request,
    failLoad: (fail: boolean) => loadFailure = fail,
    status: (value: unknown) => status = value,
  };
}

Deno.test("workspace plans register once and share lazy caller loads while observing registry updates", async () => {
  const h = setup();
  equal(h.plans.ensure(), undefined);
  const port = h.register();
  equal(h.plans.ensure(), undefined);
  deepStrictEqual(h.loaded, []);
  deepStrictEqual(
    await Promise.all([
      port.supports(h.planning, h.version),
      port.supports(h.planning, h.version),
    ]),
    [true, true],
  );
  deepStrictEqual(h.loaded, ["caller"]);
  h.planOwners.clear();
  equal(await port.supports(h.planning, h.version), false);
  h.planOwners.set("plan", "caller");
  h.planTargets.clear();
  equal(await port.supports(h.planning, h.version), false);
  h.planTargets.add("plan");
  equal(await port.supports(h.planning, h.version), true);
});

Deno.test("workspace plans evict rejected caller loads for a later retry", async () => {
  const h = setup();
  const port = h.register();
  h.failLoad(true);
  await rejects(
    port.supports(h.planning, h.version),
    /store unavailable/,
  );
  h.failLoad(false);
  equal(await port.supports(h.planning, h.version), true);
  deepStrictEqual(h.loaded, ["caller", "caller"]);
});

Deno.test("workspace plans preserve completion classification and current owning resources", async () => {
  const h = setup();
  const port = h.register();
  for (
    const status of ["completed", "waiting", "failed", "unexpected", undefined]
  ) {
    h.status(status);
    h.targets.set("inbox", "new-worker");
    const id = "plan-" + status;
    await port.invoke(h.request(id));
    const plan = h.records.get(id)!;
    equal(
      plan.tasks[0].state,
      status === "completed" || status === "waiting" ? status : "failed",
    );
    equal(plan.tasks[0].resourceId, "new-worker");
  }
});
