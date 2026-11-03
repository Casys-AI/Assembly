import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../domain/governance/authority.ts";
import type { Candidate } from "../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import { toolAdmissionPreparation } from "../../domain/governance/policies/tool-admission-policy.ts";
import { mainExecutionSpace } from "../../domain/governance/operator-authority.ts";
import { toolAdmissionDecisionContext } from "./operator-tool-admission-context.ts";

function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "catalog",
    builderId: "worker",
  });
  model.version.digest = "model-digest";
  model.toolAdmissionPolicies = [{
    id: "tool-admission",
    revision: 1,
    enabled: true,
    recipients: ["worker"],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
    holderNativeId: "main",
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    elementId: "tool-policy",
    sourceIds: ["tool-policy"],
    rootAuthority: legacyOwnerAuthority("main-system"),
  }];
  const candidate: Candidate = {
    id: "candidate",
    digest: "candidate-digest",
    name: "Page reader",
    description: "Tested reader",
    kind: "read_web_page",
    code: "Untrusted candidate code",
    stage: "awaiting-admission",
    createdAt: "2026-10-26T00:00:00Z",
    caseId: "request",
    baseCatalogRevision: 0,
    requiredAuthority: "human",
    proposedConfigurationRevision: model.configuration.revision,
    promotionModelDigest: model.version.digest,
    toolAdmissionPolicyPins: toolAdmissionPreparation(
      model,
      "read_web_page",
      mainExecutionSpace(model.identity),
    ),
    toolAdmissionContract: structuredClone(model.contracts[0]),
    tests: {
      passed: true,
      checks: [{ name: "fixture", passed: true, detail: "Passed" }],
    },
  };
  const state: SystemRuntimeState = {
    id: "worker-conversation",
    revision: 7,
    catalogRevision: 0,
    candidates: [candidate],
    messages: [],
    events: [],
    busy: false,
    phase: "Waiting",
    provider: "fixture",
    executionModel: model,
    cases: [{
      id: "request",
      number: 1,
      type: "request",
      owner: "worker",
      objective: "Read page",
      openedBy: "human",
      openedFrom: { conversationId: "worker-conversation" },
      modelPin: { digest: model.version.digest },
      status: "waiting",
      createdAt: "2026-10-26T00:00:00Z",
    }],
  };
  const main = structuredClone(model);
  main.identity.builderId = "main";
  return { main, state, candidate };
}

Deno.test("Main candidate discovery exposes exact lightweight references only for prior adopted grants", () => {
  const { main, state } = fixture();
  const context = toolAdmissionDecisionContext(main, [state]);
  deepStrictEqual(context.candidates, [{
    operatorId: "worker",
    candidateId: "candidate",
    candidateDigest: "candidate-digest",
    expectedRevision: 7,
    caseId: "request",
    name: "Page reader",
    kind: "read_web_page",
    policyId: "tool-admission",
    policyRevision: 1,
  }]);
  equal(JSON.stringify(context).includes("Untrusted candidate code"), false);
  equal(JSON.stringify(context).includes("checks"), false);
});

Deno.test("Main candidate discovery omits retroactive, stale, untested and closed-Request candidates", () => {
  const mutations: Array<(state: SystemRuntimeState) => void> = [
    (s) => {
      s.candidates[0].admissionDecision = {
        candidateDigest: s.candidates[0].digest,
        verdict: "approve",
        reason: "Already recorded for native recovery",
      };
    },
    (s) => {
      delete s.candidates[0].toolAdmissionPolicyPins;
    },
    (s) => {
      delete s.candidates[0].toolAdmissionContract;
    },
    (s) => {
      s.executionModel!.contracts[0].acceptanceCriteria = ["Changed contract"];
    },
    (s) => {
      s.candidates[0].toolAdmissionPolicyPins![0].policyRevision++;
    },
    (s) => {
      s.candidates[0].promotionModelDigest = "previous-model";
    },
    (s) => {
      s.candidates[0].tests!.checks = [];
    },
    (s) => {
      s.candidates[0].tests!.checks[0].passed = false;
    },
    (s) => {
      s.candidates[0].baseCatalogRevision++;
    },
    (s) => {
      s.cases![0].status = "closed-done";
    },
    (s) => {
      s.executionModel!.toolAdmissionPolicies![0].enabled = false;
    },
  ];
  for (const mutate of mutations) {
    const { main, state } = fixture();
    mutate(state);
    equal(toolAdmissionDecisionContext(main, [state]).candidates.length, 0);
  }
});
