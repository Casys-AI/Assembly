import { deepStrictEqual } from "node:assert/strict";
import { requestOpeningBase } from "../../../../test/support/request-space-fixture.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { RequestSpaceModel } from "../request-spaces/request-space-model.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  ConversationProposalHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { submitProposal } from "./proposals.ts";

async function caseProposalHost(
  proposal: { status: "pending" | "approved" },
) {
  const base = await requestOpeningBase(),
    model = executableFixture({
      projectId: "project",
      editingContextId: "project/main",
      rootId: "root",
      systemId: "system",
      catalogId: "catalog",
      builderId: "operator",
    });
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  model.version.digest = base.manifest.operators[0].modelDigest;
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 0,
    catalogRevision: 0,
    candidates: [],
    messages: [],
    events: [],
    caseInvocation: { kind: "local", caseId: "case-a" },
    busy: false,
    phase: "idle",
    provider: "fixture",
  };
  const turn: ConversationTurnState = {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
  const unused = (): Promise<never> =>
    Promise.reject(new Error("Unexpected operation"));
  const host: ConversationProposalHost = {
    state,
    get snapshot() {
      return structuredClone(state);
    },
    ports: {
      model: new RequestSpaceModel({
        base,
        model,
        caseId: "case-a",
        executionSpaceId: "space-a",
        branchTeamSize: 0,
      }),
    },
    update(change) {
      change(state);
      return Promise.resolve();
    },
    say: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
    currentModel: () => Promise.resolve(model),
    inspectModelVersion: () => Promise.resolve(model),
    candidate: () => {
      throw new Error("No Candidate is needed");
    },
    build: unused,
    diagnosticAddresses: unused,
    proposeChange: () =>
      Promise.resolve({
        status: proposal.status,
        changeId: "actual-recorded-change",
        proposalIntentDigest: "a".repeat(64),
      }),
  };
  return { host, turn, model, state, proposal, base };
}

Deno.test("a recorded Case network proposal uses the host evidence channel while preserving admitted native outputs", async () => {
  const { host, turn, model, state } = await caseProposalHost({
    status: "pending",
  });
  const outputs = await submitProposal.call(host, turn, model, {
    choice: {
      kind: "propose_mandate_change",
      text: "Request host",
      reason: "Read the supplied page",
      requestedRights: { addNetworkHosts: ["docs.example.org"] },
    },
  });
  deepStrictEqual(turn.changeApprovalProposal, {
    changeId: "actual-recorded-change",
    proposalIntentDigest: "a".repeat(64),
  });
  deepStrictEqual(outputs, {
    outputs: {
      submission: { awaitingInput: true },
      outcome: {
        succeeded: true,
        code: "PROPOSAL_RECORDED",
        details: "Proposition enregistrée",
      },
    },
  });
  deepStrictEqual(state.candidates, []);
});

const teamChoice = {
  kind: "propose_agent_creation" as const,
  text: "Create a reader",
  name: "Reader",
  reason: "One passage needs its own reader",
  role: "operator" as const,
  operator: {
    kind: "request-team-member" as const,
    instruction: "Extract one passage.",
    provision: {
      budget: { maxAgentDecisions: 1, maxToolProposals: 1, maxFlowSteps: 8 },
      networkHosts: [],
      mayPropose: [],
      mayInvokeActiveCatalog: false,
    },
  },
};

Deno.test("4.8e E4: a pending Case team creation waits for its decision like a network request", async () => {
  const { host, turn, model } = await caseProposalHost({ status: "pending" });
  // The preflight reads the creator's grant; this fixture's model holds one.
  model.operatorCreationPolicies = [{
    id: "create",
    revision: 1,
    elementId: "create-element",
    sourceIds: ["create-element"],
    rootAuthority: {
      ...structuredClone(model.ownerAuthority!),
      ownerSource: "modeled",
    },
    holderNativeId: model.identity.builderId,
    mandateNativeId: "mandate",
    systemId: model.identity.systemId,
    enabled: true,
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 0,
    children: [],
  }];
  model.policy = {
    ...model.policy,
    maxAgentDecisions: 5,
    maxToolProposals: 5,
    maxFlowSteps: 50,
  };
  const outputs = await submitProposal.call(host, turn, model, {
    choice: teamChoice,
  });
  deepStrictEqual(turn.changeApprovalProposal, {
    changeId: "actual-recorded-change",
    proposalIntentDigest: "a".repeat(64),
  });
  deepStrictEqual(
    (outputs as { outputs: { submission: unknown } }).outputs.submission,
    { awaitingInput: true },
  );
});

Deno.test("a delegated member's granted team proposal captures its exact Request approval wait without a local Case", async () => {
  const { host, turn, model, state, base } = await caseProposalHost({
    status: "pending",
  });
  const ownerId = base.requestOwner.operatorId;
  model.identity.builderId = "member";
  model.operatorTeam = {
    parentOperatorId: ownerId,
    requestOwnerId: ownerId,
    requestId: "case-a",
  };
  model.operatorCreationPolicies = [{
    id: "member-create",
    revision: 1,
    elementId: "member-create-native",
    sourceIds: ["member-create-native"],
    rootAuthority: {
      ...structuredClone(model.ownerAuthority!),
      ownerSource: "modeled",
    },
    holderNativeId: "member",
    mandateNativeId: "member-mandate",
    systemId: model.identity.systemId,
    enabled: true,
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 0,
    children: [],
  }];
  model.policy = {
    ...model.policy,
    maxAgentDecisions: 5,
    maxToolProposals: 5,
    maxFlowSteps: 50,
  };
  state.executionModel = model;
  state.model = model.identity;
  state.configuration = { ...model.configuration, changes: [] };
  state.cases = [];
  state.caseInvocation = {
    kind: "delegated",
    work: {
      callerId: ownerId,
      correlationId: "parent-call",
      invocationId: "parent-call",
      behaviorId: "member-inbox",
      targetNativeId: "member-inbox-native",
      modelVersion: {
        digest: base.manifest.operators[0].modelDigest,
        repositoryVersion: base.manifest.source!.sourceVersion,
      },
      fingerprint: "parent-call-fingerprint",
      priorCandidateIds: [],
      caseId: "case-a",
      caseContext: {
        caseId: "case-a",
        modelPin: {
          digest: base.manifest.operators[0].modelDigest,
          repositoryVersion: base.manifest.source!.sourceVersion,
        },
        record: {
          id: "case-a",
          number: 1,
          type: "request",
          owner: ownerId,
          openedBy: "main",
          objective: "Contribute to the Request",
          modelPin: {
            digest: base.manifest.operators[0].modelDigest,
            repositoryVersion: base.manifest.source!.sourceVersion,
          },
          status: "open",
          createdAt: "2026-11-02T00:00:00.000Z",
          openedFrom: { conversationId: "main", openingId: "opening" },
        },
      },
    },
  };
  state.activeInputMessageId = "member-input";
  state.messages = [{
    id: "member-input",
    role: "tool",
    text: "Contribute to the Request",
    at: "2026-11-02T00:00:00.000Z",
    caseId: "case-a",
    work: structuredClone(state.caseInvocation.work),
  }];
  turn.inputMessageId = "member-input";
  const memberHost: ConversationProposalHost = {
    ...host,
    ports: {
      model: new RequestSpaceModel({
        base,
        model,
        caseId: "case-a",
        executionSpaceId: "space-a",
        branchTeamSize: 2,
        teamPin: {
          modelDigest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion!,
        },
      }),
    },
  };
  const outputs = await submitProposal.call(memberHost, turn, model, {
    choice: teamChoice,
  });
  deepStrictEqual(turn.changeApprovalProposal, {
    changeId: "actual-recorded-change",
    proposalIntentDigest: "a".repeat(64),
  });
  deepStrictEqual(
    (outputs as { outputs: { submission: unknown } }).outputs.submission,
    { awaitingInput: true },
  );
  deepStrictEqual(state.cases, []);
  deepStrictEqual(state.caseInvocation.kind, "delegated");
  const ownInvocation = structuredClone(state.caseInvocation);
  const ownTeam = structuredClone(model.operatorTeam);
  for (
    const mismatch of [
      "work Case",
      "work context Case",
      "member Request",
      "designer invocation",
    ]
  ) {
    delete turn.changeApprovalProposal;
    state.caseInvocation = structuredClone(ownInvocation);
    model.operatorTeam = structuredClone(ownTeam);
    if (mismatch === "work Case") {
      state.caseInvocation.work.caseId = "other-case";
    } else if (mismatch === "work context Case") {
      state.caseInvocation.work.caseContext.caseId = "other-case";
    } else if (mismatch === "member Request") {
      model.operatorTeam.requestId = "other-case";
    } else {
      state.caseInvocation = { kind: "designer", scopeId: "designer" };
    }
    await submitProposal.call(memberHost, turn, model, { choice: teamChoice });
    deepStrictEqual(turn.changeApprovalProposal, undefined, mismatch);
    deepStrictEqual(state.cases, [], mismatch);
  }
  // The same scoped capture serves a member's network proposal too.
  state.caseInvocation = ownInvocation;
  model.operatorTeam = ownTeam;
  await submitProposal.call(memberHost, turn, model, {
    choice: {
      kind: "propose_mandate_change",
      text: "Request the page host",
      reason: "Read the selected page",
      requestedRights: { addNetworkHosts: ["docs.example.org"] },
    },
  });
  deepStrictEqual(turn.changeApprovalProposal, {
    changeId: "actual-recorded-change",
    proposalIntentDigest: "a".repeat(64),
  });
});
