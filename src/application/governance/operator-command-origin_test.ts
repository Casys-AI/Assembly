import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../work/operators/command-delivery.ts";
import assert from "node:assert/strict";
import {
  exactCandidateInspection,
  exactDelegatedCommandDecision,
} from "./operator-command-origin.ts";
import type { Message } from "../work/runtime/state.ts";

const reference = (candidateId: string, expectedRevision = 7) => ({
  operatorId: "recipient",
  candidateId,
  candidateDigest: `digest-${candidateId}`,
  expectedRevision,
  caseId: "root-request",
  policyId: "grant",
  policyRevision: 2,
});
const inspection = (
  id: string,
  candidateId: string,
  expectedRevision = 7,
): Message => ({
  id,
  role: "tool",
  text: "Host-recorded inspection data",
  at: "2026-10-27T00:00:00.000Z",
  designerScopeId: "design",
  execution: {
    digest: "actor-contract",
    repositoryVersion: "admitted-source",
    actionId: "native-inspect",
  },
  observation: {
    kind: "candidate-inspection",
    value: {
      candidate: { id: candidateId },
      decisionReference: reference(candidateId, expectedRevision),
    },
  },
});
const state = (
  messages: Message[],
): Parameters<typeof exactCandidateInspection>[0] => ({
  messages,
  caseInvocation: { kind: "designer", scopeId: "design" },
  executionModel: {
    version: {
      digest: "actor-contract",
      repositoryVersion: "admitted-source",
      rootId: "root",
      configurationId: "config",
      configurationRevision: 0,
      sourceIds: ["native-policy"],
    },
  },
});

Deno.test("delegated command selects A's exact recorded inspection after inspecting sibling B", () => {
  const snapshot = state([
    inspection("inspection-a", "a"),
    inspection("inspection-b", "b"),
  ]);
  assert.equal(
    exactCandidateInspection(snapshot, reference("a"))?.id,
    "inspection-a",
  );
  assert.equal(
    exactCandidateInspection(snapshot, reference("b"))?.id,
    "inspection-b",
  );
});

Deno.test("a latest refused or different revision inspection invalidates an earlier candidate proof", () => {
  const refused: Message = {
    ...inspection("refused", "a"),
    observation: {
      kind: "candidate-inspection",
      value: { status: "refused", context: { candidateId: "a" } },
    },
  };
  const siblings = state([
    inspection("old", "a"),
    inspection("sibling", "b"),
    refused,
  ]);
  assert.equal(exactCandidateInspection(siblings, reference("a")), undefined);
  assert.equal(
    exactCandidateInspection(siblings, reference("b"))?.id,
    "sibling",
  );
  assert.equal(
    exactCandidateInspection(
      state([inspection("old", "a"), inspection("new", "a", 8)]),
      reference("a"),
    ),
    undefined,
  );
});

Deno.test("inspection evidence cannot cross source Request or adopted actor contracts", () => {
  const foreign = inspection("foreign", "a");
  foreign.designerScopeId = "another-design";
  assert.equal(
    exactCandidateInspection(state([foreign]), reference("a")),
    undefined,
  );
  const snapshot = state([inspection("old-model", "a")]);
  snapshot.executionModel!.version.digest = "new-actor-contract";
  assert.equal(exactCandidateInspection(snapshot, reference("a")), undefined);
  snapshot.executionModel!.version.digest = "actor-contract";
  snapshot.executionModel!.version.repositoryVersion = "another-source";
  assert.equal(exactCandidateInspection(snapshot, reference("a")), undefined);
});

Deno.test("copied observations without host execution provenance never prove inspection", () => {
  const copied = inspection("copied", "a");
  delete copied.execution;
  assert.equal(
    exactCandidateInspection(state([copied]), reference("a")),
    undefined,
  );
  const user = inspection("user", "a");
  user.role = "user";
  assert.equal(
    exactCandidateInspection(state([user]), reference("a")),
    undefined,
  );
});

Deno.test("the recorded inspection belongs to its original source Request", () => {
  const message = inspection("request-inspection", "a");
  delete message.designerScopeId;
  message.caseId = "actor-request";
  const snapshot = state([message]);
  snapshot.caseInvocation = { kind: "local", caseId: "actor-request" };
  assert.equal(
    exactCandidateInspection(snapshot, reference("a"))?.id,
    "request-inspection",
  );
  message.caseId = "another-actor-request";
  assert.equal(exactCandidateInspection(snapshot, reference("a")), undefined);
});

Deno.test("equal local candidate IDs in two recipients keep separate inspection proofs", () => {
  const first = inspection("first-owner", "a");
  const second = inspection("second-owner", "a");
  const secondReference = { ...reference("a"), operatorId: "second-recipient" };
  second.observation = {
    kind: "candidate-inspection",
    value: { candidate: { id: "a" }, decisionReference: secondReference },
  };
  const snapshot = state([first, second]);
  assert.equal(
    exactCandidateInspection(snapshot, reference("a"))?.id,
    "first-owner",
  );
  assert.equal(
    exactCandidateInspection(snapshot, secondReference)?.id,
    "second-owner",
  );
});

function commandEvidence() {
  const origin: OperatorCommandOrigin = {
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: "runtime",
        operatorId: "actor",
        revision: 5,
        modelDigest: "actor-contract",
        invocationKey: "designer:design",
      },
    },
    effectKey: "real-effect",
    inputMessageId: "human-input",
    inspectionMessageId: "inspection-a",
  };
  const command: Extract<OperatorControlCommand, { kind: "decide-candidate" }> =
    {
      kind: "decide-candidate",
      input: {
        candidateId: "a",
        candidateDigest: "digest-a",
        caseId: "root-request",
        verdict: "approve",
        reason: "Verified exact test receipts",
      },
      delegated: { actorId: "actor", policyId: "grant", policyRevision: 2 },
    };
  const source: Parameters<typeof exactDelegatedCommandDecision>[0] = {
    activeBatchCall: { batchId: "batch", callId: "decision" },
    conversationBatches: [{
      id: "batch",
      modelDigest: "actor-contract",
      inputMessageId: "human-input",
      invocationKey: "designer:design",
      createdAt: "2026-10-27T00:00:00.000Z",
      sourceDecision: {},
      calls: [{
        id: "decision",
        status: "started",
        effectStarted: true,
        decision: {
          kind: "decide_operator_candidate",
          text: "Decide exact candidate",
          ...reference("a"),
          verdict: "approve",
          reason: "Verified exact test receipts",
        },
      }],
    }],
  };
  return { origin, command, source };
}

Deno.test("delegated origin proves the exact started canonical decision, including target and verdict", () => {
  const { source, command, origin } = commandEvidence();
  assert.equal(
    exactDelegatedCommandDecision(source, "recipient", command, origin)?.kind,
    "decide_operator_candidate",
  );
  assert.equal(
    exactDelegatedCommandDecision(source, "another-recipient", command, origin),
    undefined,
  );
  command.input.verdict = "refuse";
  assert.equal(
    exactDelegatedCommandDecision(source, "recipient", command, origin),
    undefined,
  );
});

Deno.test("copied inspection or different source input cannot authorize a delegated decision", () => {
  const { source, command, origin } = commandEvidence();
  assert.equal(
    exactDelegatedCommandDecision(source, "recipient", command, {
      ...origin,
      inputMessageId: "another-input",
    }),
    undefined,
  );
  source.conversationBatches![0].calls[0].effectStarted = false;
  assert.equal(
    exactDelegatedCommandDecision(source, "recipient", command, origin),
    undefined,
  );
  source.conversationBatches![0].calls[0].effectStarted = true;
  source.conversationBatches![0].calls[0].decision = {
    kind: "inspect_operator_candidate",
    text: "Inspect only",
    ...reference("a"),
  };
  assert.equal(
    exactDelegatedCommandDecision(source, "recipient", command, origin),
    undefined,
  );
});
