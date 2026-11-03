import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type {
  ConversationBatchExecution,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { closeCaseById, createRequestCase } from "../cases/runtime.ts";
import { evolutionCheckpoint } from "./evolution.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
} from "./execution.ts";

function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 1,
    catalogRevision: 1,
    executionModel: model,
    messages: [],
    events: [],
    candidates: [],
    busy: false,
    phase: "ready",
    provider: "test",
    cases: [],
  };
  const clock = { now: () => "2026-10-29T00:00:00.000Z" };
  createRequestCase(
    state,
    {
      id: "request",
      objective: "Inspect exact pinned sources",
      messageId: "input",
    },
    clock,
    1,
  );
  const batch: ConversationBatchExecution = {
    id: "batch",
    caseId: "request",
    modelDigest: model.version.digest,
    createdAt: clock.now(),
    sourceDecision: {},
    calls: [{
      id: "call",
      decision: { kind: "consult_model", text: "Inspect", inputJson: "{}" },
      status: "completed",
      result: {
        status: "succeeded",
        code: "READ",
        details: "retained receipt",
      },
    }],
  };
  state.conversationBatches = [batch];
  return { state, batch, model, clock };
}

Deno.test("unpublished immutable join blocks evolution even when every read receipt is complete", () => {
  const f = fixture();
  assert.equal(evolutionCheckpoint(f.state).safe, true);
  f.batch.immutableGroup = { groupId: "group", manifestDigest: "digest" };
  const blocked = evolutionCheckpoint(f.state);
  assert.equal(blocked.safe, false);
  assert(
    blocked.blockers.some((item) => item.code === "EVOLUTION_BATCH_UNSETTLED"),
  );
  f.batch.immutableGroup.publication = {
    publicationDigest: "published",
    revision: 1,
  };
  assert.equal(evolutionCheckpoint(f.state).safe, true);
  const execution: NativeExecutionSnapshot = {
    contributionId: "input",
    identity: nativeExecutionIdentity(f.state, "conversation", "input"),
    threadId: "thread",
    modelDigest: f.model.version.digest,
    flowRootId: f.model.flows.conversation.rootNativeId,
    status: "completed",
    unsettledEffects: [],
    pendingContributions: [],
    waits: [],
    openImmutableConsultationGroups: ["group"],
  };
  assert.equal(evolutionCheckpoint(f.state, [execution]).safe, false);
  execution.openImmutableConsultationGroups = [];
  assert.equal(evolutionCheckpoint(f.state, [execution]).safe, true);
});

Deno.test("Case completion refuses pending publication while abandonment preserves known receipts and cancels queued work", () => {
  const f = fixture();
  f.batch.immutableGroup = { groupId: "group", manifestDigest: "digest" };
  assert.throws(
    () => closeCaseById(f.state, "request", "done", f.clock),
    /awaits publication/,
  );
  assert.equal(f.state.cases![0]!.status, "open");
  const known = structuredClone(f.batch.calls[0]!.result);
  f.batch.calls.push({
    id: "unstarted",
    decision: { kind: "consult_model", text: "Later", inputJson: "{}" },
    status: "queued",
  });
  closeCaseById(f.state, "request", "abandoned", f.clock);
  assert.equal(f.state.cases![0]!.status, "closed-abandoned");
  assert.deepEqual(f.batch.calls[0]!.result, known);
  assert.equal(f.batch.calls[1]!.status, "cancelled");
  assert.equal(f.batch.calls[1]!.result?.code, "CASE_CLOSED");
});
