import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { nativeCallResult } from "../conversation/batches.ts";
import {
  assertWorkPlanGraphFits,
  WORK_PLAN_RESULT_FORMAT,
  workPlanCallCharacters,
  type WorkPlanResultView,
  workPlanResultView,
} from "./result-view.ts";
import type { WorkPlanRecord } from "../../../domain/work/entities/plans.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";

export function resultFixture() {
  const modelVersion = {
    digest: "a".repeat(64),
    repositoryVersion: "commit:" + "b".repeat(40),
  };
  const behavior = {
    id: "behavior",
    name: "Work",
    description: "Work",
    targetNativeId: "inbox",
    targetTypeId: "inbox-type",
    inputTypeId: "input",
    callerNativeId: "owner",
    inputSchema: { type: "object" },
    sourceIds: ["source"],
  };
  const request: BehaviorInvocationRequest = {
    behavior,
    caseId: "root",
    invocationId: "plan",
    callerId: "owner",
    modelVersion,
    input: {},
  };
  const source = {
    url: "https://docs.deno.com/a",
    title: "Actual title",
    text: "Actual retrieved content.",
  };
  const result = {
    caseId: "root",
    agentId: "peer",
    invocationId: "work",
    correlationId: "corr",
    status: "completed",
    revision: 5,
    modelVersion,
    candidateIds: ["candidate"],
    artifacts: [{
      id: "candidate",
      digest: "d".repeat(64),
      kind: "read_web_page",
      localStage: "active",
      tests: { passed: true },
      activationConfirmed: true,
    }],
    messages: [
      {
        id: "page",
        role: "tool",
        at: "2026-10-27T00:00:00Z",
        caseId: "root",
        text: "Recorded page",
        observation: { kind: "tool-result", value: source },
        execution: {
          digest: modelVersion.digest,
          repositoryVersion: modelVersion.repositoryVersion,
          sourceIds: Array.from(
            { length: 15000 },
            (_, i) => `native-source-${i}`,
          ),
        },
      },
      {
        id: "reply",
        role: "assistant",
        at: "2026-10-27T00:00:01Z",
        caseId: "root",
        text: "Actual retrieved content from https://docs.deno.com/a",
      },
    ],
  };
  const invocation = {
    ...request,
    invocationId: "work",
    input: { text: "Prepare and read exact assigned source" },
  };
  const receipt = {
    caseId: "root",
    behaviorId: behavior.id,
    invocationId: "work",
    targetNativeId: "inbox",
    modelVersion,
    result,
  };
  const plan = {
    id: "plan",
    caseId: "root",
    callerId: "owner",
    modelVersion,
    origin: {
      behaviorId: behavior.id,
      targetNativeId: "inbox",
      invocationId: "plan",
    },
    requestDigest: "r".repeat(64),
    revision: 3,
    status: "completed",
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:02Z",
    tasks: [{
      id: "task",
      caseId: "root",
      resourceId: "peer",
      dependsOn: [],
      inputDigest: "input",
      invocation,
      state: "completed",
      receipt,
      attempts: [{
        startedAt: "2026-10-27T00:00:00Z",
        returnedAt: "2026-10-27T00:00:02Z",
        state: "completed",
        receipt,
      }],
    }],
  } as WorkPlanRecord;
  return { request, plan, source };
}

Deno.test("bounded plan transport preserves exact graph and actual output while full receipts stay unchanged", async () => {
  const { request, plan, source } = resultFixture();
  const before = JSON.stringify(plan);
  ok(before.length > 344384);
  const envelope = await workPlanResultView(request, plan);
  const view = envelope.result as WorkPlanResultView;
  equal(view.format, WORK_PLAN_RESULT_FORMAT);
  equal(view.status, "completed");
  equal(view.id, plan.id);
  deepStrictEqual(view.graph, [{
    id: "task",
    behaviorId: "behavior",
    input: plan.tasks[0]!.invocation.input,
    dependsOn: [],
  }]);
  deepStrictEqual(
    view.tasks[0]!.outputs.find((output) => output.kind === "tool-source")!
      .value,
    source,
  );
  equal(view.tasks[0]!.contribution!.candidateIds[0], "candidate");
  equal(view.tasks[0]!.artifacts[0]!.testsPassed, true);
  equal(view.tasks[0]!.omitted.sourceElementIds, 15000);
  equal(view.tasks[0]!.omitted.attempts, 1);
  ok(!JSON.stringify(view).includes("native-source-"));
  ok(!JSON.stringify(view).includes('"receipt"'));
  equal(JSON.stringify(plan), before);
  ok(workPlanCallCharacters(envelope) < 262144);
  deepStrictEqual(await workPlanResultView(request, plan), envelope);
});

Deno.test("transport accounting matches actual native ChatCallResult details and value escaping", async () => {
  const { request, plan } = resultFixture();
  plan.tasks[0]!.invocation.input = { text: '"\\\n'.repeat(1000) };
  const envelope = await workPlanResultView(request, plan);
  const actual = nativeCallResult({
    outputs: {
      outcome: {
        succeeded: true,
        code: "BEHAVIOR_COMPLETED",
        details: JSON.stringify(envelope),
        behaviorId: envelope.behaviorId,
        behaviorResult: envelope,
      },
    },
  });
  equal(workPlanCallCharacters(envelope), JSON.stringify(actual).length);
});

Deno.test("mandatory escaped resume graph is refused before dispatch without truncation", () => {
  const { request, plan } = resultFixture();
  plan.tasks[0]!.invocation.input = { text: "\\".repeat(32700) };
  ok(JSON.stringify(plan.tasks[0]!.invocation.input).length < 65536);
  throws(() => assertWorkPlanGraphFits(request, plan), /exact resume graph/);
});

Deno.test("large output stays an explicitly incomplete preview with full-value digest and journal ref", async () => {
  const { request, plan } = resultFixture();
  const source = (plan.tasks[0]!.receipt!.result as {
    messages: Array<{ observation?: { value: { text: string } } }>;
  }).messages[0]!.observation!.value;
  source.text = "Observed page data ".repeat(10000);
  const envelope = await workPlanResultView(request, plan);
  const view = envelope.result as WorkPlanResultView;
  const output = view.tasks[0]!.outputs.find((item) =>
    item.kind === "tool-source"
  )!;
  ok(output.omittedCharacters > 0);
  equal(output.valueDigest.length, 64);
  equal(output.reference.messageId, "page");
  equal(view.journal.planId, plan.id);
  equal(view.journal.revision, plan.revision);
  ok(workPlanCallCharacters(envelope) <= 262144);
});

Deno.test("near-cap mandatory graph stays representable after real contribution metadata grows", async () => {
  const { request, plan } = resultFixture();
  request.caseId = plan.caseId = "root:" + "r".repeat(400);
  plan.tasks = Array.from({ length: 32 }, (_, index) => {
    const task = structuredClone(plan.tasks[0]!);
    task.id = `task-${index}`;
    task.caseId = plan.caseId;
    task.invocation.invocationId = `work-${index}`;
    task.invocation.caseId = plan.caseId;
    return task;
  });
  const setText = (length: number) => {
    for (const task of plan.tasks) {
      task.invocation.input = { text: "x".repeat(length) };
    }
  };
  let lower = 0, upper = 2000;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    setText(middle);
    try {
      assertWorkPlanGraphFits(request, plan);
      lower = middle;
    } catch {
      upper = middle - 1;
    }
  }
  setText(lower);
  assertWorkPlanGraphFits(request, plan);
  for (const task of plan.tasks) {
    const work = task.receipt!.result as {
      candidateIds: string[];
      revision: number;
    };
    work.candidateIds = Array.from(
      { length: 40 },
      (_, index) => `candidate-${index}-` + "c".repeat(100),
    );
    work.revision = Number.MAX_SAFE_INTEGER;
    task.error = {
      code: "OBSERVED_FAILURE",
      message: "Actual error ".repeat(300),
    };
  }
  const result = await workPlanResultView(request, plan);
  const view = result.result as WorkPlanResultView;
  ok(workPlanCallCharacters(result) <= 262144);
  ok(view.tasks.some((task) => task.omitted.contribution > 0));
  ok(view.tasks.some((task) => task.omitted.errors > 0));
  for (const task of view.tasks) {
    for (const window of task.activityWindows) {
      equal(window.candidateIds.length + window.omittedCandidateIds, 40);
    }
  }
});
