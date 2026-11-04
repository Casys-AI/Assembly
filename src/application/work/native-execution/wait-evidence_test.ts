import assert from "node:assert/strict";
import type { NativeExecutionRequest } from "./contract.ts";
import { nativeFrameworkNodeName } from "./framework-node-name.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  budgetSourceFromWait,
  effectResultDigest,
  type NativeWaitEvidence,
  parseNativeWaitEvidence,
} from "./wait-evidence.ts";

function fixture() {
  const model = artifactModel("typed-wait-evidence");
  const request: NativeExecutionRequest = {
    model,
    flow: model.flows.conversation,
    maxSteps: 32,
    identity: {
      operatorId: "operator-wait",
      invocationKey: "request:wait",
      purpose: "conversation",
      scope: {
        kind: "request",
        scopeId: "request-wait",
        rootRequestId: "request-wait",
      },
    },
    contribution: { id: "contribution-input", kind: "input" },
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: model.identity.systemId,
        operatorId: "operator-wait",
        revision: 1,
        modelDigest: model.version.digest,
      },
    },
  };
  const node = request.flow.nodes.find((node) =>
    node.mechanism === "await_input"
  )!;
  assert.ok(node, "the compiled fixture retains an input acceptance node");
  const wait: NativeWaitEvidence = {
    version: 1,
    kind: "input",
    nodeId: node.id,
    actionId: node.nativeId,
    preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
    effectKey: "effect-before-wait",
    resultDigest: "a".repeat(64),
    modelPin: {
      identity: structuredClone(model.identity),
      version: structuredClone(model.version),
      rootNativeId: request.flow.rootNativeId,
      rootOccurrenceId: request.flow.rootOccurrenceId,
    },
    executionScope: structuredClone(request.identity.scope),
    operatorId: request.identity.operatorId,
    rootRequestId: "request-wait",
    inputs: { message: { text: "Retain exact input bytes: é / e\u0301" } },
  };
  return { request, node, wait };
}

Deno.test("typed wait parser refuses malformed identities, digest and prepared node proof", () => {
  const { wait } = fixture();
  const invalid: unknown[] = [
    null,
    [],
    { ...wait, version: 2 },
    { ...wait, kind: "legacy" },
    { ...wait, nodeId: "" },
    { ...wait, actionId: "" },
    { ...wait, effectKey: "" },
    { ...wait, operatorId: "" },
    { ...wait, preparedNodeId: "native_wait_another-occurrence" },
    { ...wait, resultDigest: "not-a-result-digest" },
    { ...wait, inputs: [] },
    { ...wait, modelPin: null },
    { ...wait, executionScope: null },
    { ...wait, kind: "technical-advance" },
    { ...wait, evidence: {} },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseNativeWaitEvidence(value),
      /NATIVE_WAIT_EVIDENCE_INVALID/,
    );
  }
});

Deno.test("effect-result wait digest excludes handler transport fields while retaining result semantics", async () => {
  const prepared = {
    suspend: true,
    suspensionKind: "decision",
    outputs: { approved: false },
  };
  const extended = {
    ...prepared,
    localState: { promotionId: "handler-owned" },
    messages: [{ content: "a message" }],
    journal: [{ event: "a journal entry" }],
    operatorData: { state: "handler-owned" },
    asyncTasks: { task: { state: "pending" } },
  };
  assert.equal(
    await effectResultDigest(extended),
    await executionDigest(prepared),
  );
  assert.notEqual(
    await effectResultDigest({ ...extended, suspensionKind: "budget" }),
    await effectResultDigest(extended),
  );
  for (const invalid of [null, [], "an untyped result"]) {
    await assert.rejects(
      () => effectResultDigest(invalid),
      /NATIVE_WAIT_EFFECT_INVALID/,
    );
  }
});

Deno.test("budget continuation projection distinguishes unconsumed input and settled budget waits", () => {
  const { wait } = fixture();
  const source = {
    occurrenceId: wait.nodeId,
    preparedNodeId: wait.preparedNodeId,
    settledEffectKey: wait.effectKey,
  };
  assert.deepEqual(budgetSourceFromWait(wait), {
    ...source,
    sourceKind: "unconsumed-input-wait",
  });
  assert.deepEqual(budgetSourceFromWait({ ...wait, kind: "budget" }), {
    ...source,
    sourceKind: "settled-budget-wait",
  });
  for (
    const kind of ["decision", "contribution", "technical-advance"] as const
  ) {
    assert.equal(budgetSourceFromWait({ ...wait, kind }), undefined);
  }
});
