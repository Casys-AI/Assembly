import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  assertCasesState,
  closeCase,
} from "../../../domain/work/entities/cases.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import {
  beginScheduledExecution,
  CaseScheduler,
  changeWatchState,
  completeScheduledExecution,
  materializeScheduledCases,
  missingScheduledTypes,
} from "./scheduling.ts";

function fixture() {
  let now = "2026-10-24T08:00:00.000Z";
  const clock = { now: () => now };
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "owner",
  });
  model.version.repositoryVersion = "source-1";
  model.caseTypes = [
    {
      id: "job-type",
      name: "Morning summary",
      type: "job",
      envelope: "deterministic",
      ownerId: "owner",
      behaviorId: model.flows.conversation.rootNativeId,
      schedule: { kind: "every", count: 1, unit: "hour" },
      maxInvocations: 2,
      sourceIds: ["job-type"],
    },
    {
      id: "watch-type",
      name: "Offer monitoring",
      type: "watch",
      envelope: "reassessment",
      ownerId: "owner",
      behaviorId: model.flows.conversation.rootNativeId,
      schedule: { kind: "every", count: 1, unit: "hour" },
      maxInvocations: 1,
      sourceIds: ["watch-type"],
    },
  ];
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    model: model.identity,
    executionModel: model,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
    cases: [],
  };
  return {
    state,
    model,
    clock,
    advance: (at: string) => {
      now = at;
    },
  };
}

Deno.test("scheduled declarations create one durable Case each with immutable birth pin", () => {
  const f = fixture();
  f.model.caseTypes!.push({
    ...f.model.caseTypes![0],
    id: "foreign",
    ownerId: "other",
  }, { ...f.model.caseTypes![0], id: "unscheduled", schedule: undefined });
  assert.deepEqual(
    missingScheduledTypes(f.state, f.model).map((type) => type.id),
    ["job-type", "watch-type"],
  );
  materializeScheduledCases(f.state, f.model, [1, 2], f.clock);
  assertCasesState(f.state);
  assert.equal(f.state.cases!.length, 2);
  assert.equal(f.state.cases![0].objective, "Morning summary");
  assert.equal(f.state.cases![0].job!.runs.length, 0);
  assert.equal(f.state.cases![1].watch!.state, "watching");
  assert.equal(f.state.cases![1].watch!.nextWakeAt, "2026-10-24T09:00:00.000Z");
  const pin = structuredClone(f.state.cases![0].modelPin);
  f.model.version.digest = "next";
  materializeScheduledCases(f.state, f.model, [], f.clock);
  assert.equal(f.state.cases!.length, 2);
  assert.deepEqual(f.state.cases![0].modelPin, pin);
  assert.throws(
    () => materializeScheduledCases(f.state, f.model, [3], f.clock),
    { code: "CASE_CONFLICT" },
  );
});

Deno.test("scheduler waits for due time and coalesces all missed intervals into one execution", async () => {
  const f = fixture();
  materializeScheduledCases(f.state, f.model, [1, 2], f.clock);
  const executed: string[] = [];
  const runtime = {
    get cases() {
      return { cases: f.state.cases! };
    },
    runScheduledCase(id: string) {
      executed.push(id);
      beginScheduledExecution(f.state, id, f.clock);
      completeScheduledExecution(f.state, "done", "Done", {
        changed: false,
        summary: "Unchanged",
      });
      return Promise.resolve();
    },
  };
  const scheduler = new CaseScheduler({
    clock: f.clock,
    runtimes: () => [runtime],
  });
  await scheduler.tick();
  assert.equal(executed.length, 0);
  f.advance("2026-10-24T09:00:00.000Z");
  await scheduler.tick();
  assert.equal(executed.length, 2);
  await scheduler.tick();
  assert.equal(executed.length, 2);
  f.advance("2026-11-02T12:15:00.000Z");
  await scheduler.tick();
  assert.equal(executed.length, 4);
  assert.equal(
    f.state.cases![0].scheduling!.nextAt,
    "2026-11-02T13:00:00.000Z",
  );
  await scheduler.tick();
  assert.equal(executed.length, 4);
  assert.equal(f.state.cases![0].job!.runs.length, 2);
  assert.equal(f.state.cases![1].watch!.wakes.length, 2);
});

Deno.test("overlapping scheduler ticks share a flight and never overlap a Case", async () => {
  const f = fixture();
  f.model.caseTypes = [f.model.caseTypes![0]];
  materializeScheduledCases(f.state, f.model, [1], f.clock);
  f.advance("2026-10-24T09:00:00.000Z");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const runtime = {
    get cases() {
      return { cases: f.state.cases! };
    },
    async runScheduledCase(id: string) {
      calls++;
      beginScheduledExecution(f.state, id, f.clock);
      entered();
      await gate;
      completeScheduledExecution(f.state, "done");
    },
  };
  const scheduler = new CaseScheduler({
    clock: f.clock,
    runtimes: () => [runtime],
  });
  const first = scheduler.tick();
  await started;
  const concurrent = scheduler.tick();
  assert.equal(first, concurrent);
  assert.equal(calls, 1);
  assert.throws(
    () => beginScheduledExecution(f.state, f.state.cases![0].id, f.clock),
    { code: "CASE_BUSY" },
  );
  release();
  await first;
  assert.equal(f.state.cases![0].job!.runs[0].outcome, "done");
});

Deno.test("Watch pause resume stop and Close remove execution opportunities", () => {
  const f = fixture();
  materializeScheduledCases(f.state, f.model, [1, 2], f.clock);
  const [job, watch] = f.state.cases!;
  changeWatchState(f.state, watch.id, "pause", f.clock);
  assert.equal(watch.watch!.state, "paused");
  assert.equal(watch.scheduling!.nextAt, undefined);
  assert.equal(watch.watch!.nextWakeAt, undefined);
  assert.throws(() => beginScheduledExecution(f.state, watch.id, f.clock), {
    code: "INVALID_CASE_ACTION",
  });
  f.advance("2026-10-25T11:30:00.000Z");
  changeWatchState(f.state, watch.id, "resume", f.clock);
  assert.equal(watch.watch!.state, "watching");
  assert.equal(watch.watch!.nextWakeAt, "2026-10-25T12:00:00.000Z");
  changeWatchState(f.state, watch.id, "stop", f.clock);
  assert.equal(watch.watch!.state, "stopped");
  assert.equal(watch.scheduling!.nextAt, undefined);
  for (const action of ["resume", "pause", "stop"] as const) {
    assert.throws(
      () => changeWatchState(f.state, watch.id, action, f.clock),
      (error) =>
        error instanceof CaseError && error.code === "INVALID_CASE_ACTION" &&
        !!error.context && !!error.recovery,
    );
  }
  assert.throws(() => changeWatchState(f.state, job.id, "pause", f.clock), {
    code: "INVALID_CASE_ACTION",
  });
  f.state.cases = f.state.cases!.map((record) =>
    closeCase(record, "done", f.clock.now())
  );
  for (const record of f.state.cases) {
    assert.equal(record.scheduling!.nextAt, undefined);
    assert.throws(() => beginScheduledExecution(f.state, record.id, f.clock), {
      code: "CASE_CLOSED",
    });
  }
});

Deno.test("each execution gets a fresh budget scope and restores the previous continuation", () => {
  const f = fixture();
  materializeScheduledCases(f.state, f.model, [1, 2], f.clock);
  f.state.conversationCursor = { nodeId: "saved-request-node" };
  f.state.conversationContext = { goal: "Unrelated request" };
  f.state.workBudgetBinding = {
    budgetId: "request-budget",
    scopeId: "request-scope",
  };
  const before = {
    conversationCursor: structuredClone(f.state.conversationCursor),
    conversationContext: structuredClone(f.state.conversationContext),
    workBudgetBinding: structuredClone(f.state.workBudgetBinding),
  };
  const job = f.state.cases![0];
  beginScheduledExecution(f.state, job.id, f.clock);
  assert.deepEqual(f.state.caseInvocation, { kind: "local", caseId: job.id });
  assert.equal(f.state.conversationCursor, undefined);
  assert.equal(f.state.caseBudgetPending, true);
  const scope = job.budget!.scopeId;
  assert.equal(f.state.workBudgetBinding!.scopeId, scope);
  completeScheduledExecution(f.state, "failed", "Simulated failure");
  assert.equal(job.job!.runs[0].outcome, "failed");
  assert.equal(f.state.scheduledExecution, undefined);
  for (
    const key of [
      "conversationCursor",
      "conversationContext",
      "workBudgetBinding",
    ] as const
  ) {
    assert.deepEqual(f.state[key], before[key]);
  }
  beginScheduledExecution(f.state, job.id, f.clock);
  assert.notEqual(job.budget!.scopeId, scope);
  completeScheduledExecution(f.state, "abandoned");
  assert.deepEqual(job.job!.runs.map((run) => run.outcome), [
    "failed",
    "abandoned",
  ]);
  const watch = f.state.cases![1];
  beginScheduledExecution(f.state, watch.id, f.clock);
  completeScheduledExecution(f.state, "done", undefined, {
    changed: true,
    summary: "New offer",
  });
  assert.deepEqual(watch.watch!.wakes, [{
    at: f.clock.now(),
    changed: true,
    summary: "New offer",
  }]);
});
