import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  executeScheduledCase,
  materializeScheduledCases,
  type ScheduledExecutionHost,
} from "./scheduling.ts";

function fixture() {
  let now = "2026-10-27T08:00:00.000Z";
  const clock = { now: () => now };
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "owner",
  });
  model.caseTypes = [{
    id: "job-type",
    name: "Summary",
    type: "job",
    envelope: "deterministic",
    ownerId: "owner",
    behaviorId: model.flows.conversation.rootNativeId,
    schedule: { kind: "every", count: 1, unit: "hour" },
    sourceIds: ["job-type"],
  }];
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
  materializeScheduledCases(state, model, [1], clock);
  const previous = {
    kind: "designer" as const,
    scopeId: "design",
    ownerId: "owner",
  };
  state.caseInvocation = previous;
  state.activeInputMessageId = "human-input";
  let executions = 0;
  const host: ScheduledExecutionHost = {
    state,
    ports: { clock },
    update(change) {
      change(state);
      return Promise.resolve();
    },
    currentModel() {
      return Promise.resolve(model);
    },
    assertEvolutionWorkAdmission() {
      return Promise.resolve();
    },
    runTurn(reply, contribution) {
      executions++;
      assert.equal(contribution.id, "scheduled-receipt");
      assert.equal(state.activeInputMessageId, contribution.inputMessageId);
      assert.equal(state.caseInvocation!.kind, "local");
      reply({ kind: "reply", text: "Summary completed" });
      return Promise.resolve();
    },
    flushWatchNotifications() {
      return Promise.resolve();
    },
  };
  return {
    state,
    host,
    previous,
    executions: () => executions,
    advance() {
      now = "2026-10-27T09:00:00.000Z";
    },
  };
}

Deno.test("scheduled receipt executes once with its own native input and restores the original human subject", async () => {
  const f = fixture();
  f.advance();
  const input = {
    id: "scheduled-receipt",
    caseId: f.state.cases![0].id,
    trigger: {
      kind: "due" as const,
      scheduledAt: f.state.cases![0].scheduling!.nextAt!,
    },
  };
  await executeScheduledCase.call(f.host, input);
  await executeScheduledCase.call(f.host, input);
  assert.equal(f.executions(), 1);
  assert.equal(f.state.cases![0].job!.runs[0].id, input.id);
  assert.equal(
    f.state.messages.filter((message) => message.id === input.id).length,
    1,
  );
  assert.deepEqual(f.state.caseInvocation, f.previous);
  assert.equal(f.state.activeInputMessageId, "human-input");
});

Deno.test("an obsolete due receipt cannot start another occurrence", async () => {
  const f = fixture();
  await executeScheduledCase.call(f.host, {
    id: "obsolete",
    caseId: f.state.cases![0].id,
    trigger: { kind: "due", scheduledAt: "2026-10-26T09:00:00.000Z" },
  });
  assert.equal(f.executions(), 0);
  assert.equal(f.state.cases![0].job!.runs.length, 0);
  assert.equal(f.state.activeInputMessageId, "human-input");
});
