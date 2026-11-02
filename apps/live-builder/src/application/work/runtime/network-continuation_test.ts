import assert from "node:assert/strict";
import {
  parseRequestNetworkContinuation,
  parseRequestNetworkRefusalContinuation,
} from "./execution.ts";

Deno.test("network continuation accepts only the closed receipt-bound shape", () => {
  const intent = {
    commandId: "request-adoption:one",
    receiptDigest: "a".repeat(64),
    changeId: "change",
    proposalIntentDigest: "b".repeat(64),
    predecessorThreadId: "execution:old",
    checkpointId: "checkpoint",
    successorThreadId: "execution:new",
    originalInputMessageId: "message",
  };
  assert.deepEqual(parseRequestNetworkContinuation(intent), intent);
  for (
    const invalid of [
      { ...intent, extra: "foreign" },
      { ...intent, receiptDigest: "short" },
      { ...intent, successorThreadId: intent.predecessorThreadId },
      { ...intent, originalInputMessageId: "" },
    ]
  ) assert.throws(() => parseRequestNetworkContinuation(invalid));
});

Deno.test("network refusal continuation accepts only its exact durable decision and wait", () => {
  const proof = {
    changeId: "change",
    proposalIntentDigest: "a".repeat(64),
    decisionDigest: "b".repeat(64),
    threadId: "thread",
    checkpointId: "checkpoint",
    originalInputMessageId: "input",
  };
  assert.deepEqual(parseRequestNetworkRefusalContinuation(proof), proof);
  for (
    const invalid of [{ ...proof, extra: true }, {
      ...proof,
      decisionDigest: "short",
    }, { ...proof, checkpointId: "" }]
  ) {
    assert.throws(() => parseRequestNetworkRefusalContinuation(invalid));
  }
});
