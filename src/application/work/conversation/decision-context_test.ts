import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type {
  ConversationDecisionHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { selectDesignerInvocation } from "../cases/runtime.ts";
import { buildDecisionContext } from "./decision-context.ts";
import { ensureRequestCase } from "../cases/runtime.ts";
import { operatorCreationContext } from "./decision-context.ts";
import type { ModelPort } from "../runtime/ports.ts";
import { mainCreationScope } from "../../../domain/governance/policies/operator-creation-policy.ts";

Deno.test("creation context exposes exact current actor grants only within an active Request", () => {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  const policy = {
    id: "create",
    revision: 3,
    enabled: true,
    elementId: "native-create",
    sourceIds: ["native-create"],
    holderNativeId: "operator",
    mandateNativeId: "mandate",
    systemId: "system",
    children: ["existing"],
    networkHosts: ["example.org"],
    maxChildren: 3,
    maxDelegationDepth: 2,
    rootAuthority: {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled" as const,
    },
  };
  model.operatorCreationPolicies = [policy, {
    ...policy,
    holderNativeId: "another",
  }];
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
  ensureRequestCase(state, { objective: "Research" }, {
    now: () => "2026-10-27T03:00:00Z",
  }, 1);
  const context = operatorCreationContext(
    model,
    state,
    mainCreationScope(model.identity),
  )!;
  deepStrictEqual(context.policies, [policy]);
  equal(context.provisionBounds.mayConsultModel, false);
  equal(context.provisionBounds.mayProposeSysmlRevision, false);
  model.policy.mayConsultModel = true;
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity))!
      .provisionBounds.mayConsultModel,
    true,
  );
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity))!
      .provisionBounds.mayProposeSysmlRevision,
    false,
  );
  equal(
    context.provisionBounds.mayAddNetworkHosts,
    model.policy.mayAddNetworkHosts,
  );
  context.policies[0]!.networkHosts.push("untrusted.org");
  deepStrictEqual(policy.networkHosts, ["example.org"]);
  policy.enabled = false;
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
  policy.enabled = true;
  policy.children = ["a", "b", "c"];
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
  policy.children = [];
  state.cases![0]!.status = "closed-done";
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
  state.cases![0]!.status = "open";
  state.cases![0]!.type = "job";
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
});

Deno.test("creation context in a branch counts the whole team, inherited children inert", () => {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.operatorCreationPolicies = [{
    id: "create",
    revision: 1,
    enabled: true,
    elementId: "native-create",
    sourceIds: ["native-create"],
    holderNativeId: "operator",
    mandateNativeId: "mandate",
    systemId: "system",
    children: ["inherited-1", "inherited-2", "inherited-3", "inherited-4"],
    networkHosts: [],
    maxChildren: 4,
    maxDelegationDepth: 1,
    rootAuthority: {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled" as const,
    },
  }];
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  ensureRequestCase(state, { objective: "Research" }, {
    now: () => "2026-10-27T03:00:00Z",
  }, 1);
  const branch = (branchTeamSize: number) => ({
    space: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "space-x",
    },
    branchTeamSize,
    currentCaseId: state.cases![0].id,
  });
  // Main reading stays exhausted by its native children list.
  equal(
    operatorCreationContext(model, state, mainCreationScope(model.identity)),
    undefined,
  );
  // Branch reading ignores inherited children and counts the team of 3.
  equal(operatorCreationContext(model, state, branch(2))?.policies.length, 1);
  equal(operatorCreationContext(model, state, branch(3)), undefined);
});

function decisionFixture(read: boolean | undefined, revision: boolean) {
  const model = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    catalogId: "c",
    builderId: "operator",
  });
  model.policy.mayProposeSysmlRevision = revision;
  if (read !== undefined) model.policy.mayConsultModel = read;
  else delete model.policy.mayConsultModel;
  model.modelEditPolicy = {
    id: "edit",
    revision: 1,
    elementId: "edit",
    sourceIds: [],
    holderNativeId: "operator",
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    operations: ["rename", "replace-source"],
    grants: [],
  };
  model.modelAdministration = {
    kind: "root",
    digest: "authority",
  } as NonNullable<typeof model.modelAdministration>;
  model.operatorCreationPolicies = [{
    id: "create",
    revision: 1,
    enabled: true,
    elementId: "create",
    sourceIds: [],
    holderNativeId: "operator",
    mandateNativeId: "mandate",
    systemId: "s",
    children: [],
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 1,
    rootAuthority: { ...legacyOwnerAuthority("s"), ownerSource: "modeled" },
  }];
  const state: SystemRuntimeState = {
    id: "session",
    revision: 1,
    catalogRevision: 0,
    executionModel: model,
    model: model.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "test",
  };
  selectDesignerInvocation(state);
  let informationReads = 0, fullReads = 0;
  const modelPort = {
    proposeRevision: () => Promise.resolve(),
    proposeDelegation: () => Promise.resolve(),
    requestChangeScope: undefined as ModelPort["requestChangeScope"],
    readSourceRevision: () => {
      fullReads++;
      return Promise.resolve({
        version: "commit:source",
        sources: { "system.sysml": "package Source {}" },
      });
    },
  };
  const host = {
    state,
    ports: {
      model: modelPort,
      information: {
        read: () => {
          informationReads++;
          return Promise.resolve({
            memoryGuidance: [],
            modelContext: { version: "commit:source" },
            modelSources: { version: "commit:source", sources: {} },
          });
        },
        consultModel: () => Promise.resolve({}),
      },
    },
    currentModel: () => Promise.resolve(model),
    budgetView: () => Promise.resolve(undefined),
    operatorAuthorityContext: () => Promise.resolve(undefined),
    operatorToolAdmissionContext: () => undefined,
  } as unknown as ConversationDecisionHost;
  const turn: ConversationTurnState = {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
  return {
    model,
    state,
    host,
    modelPort,
    build: async () =>
      (await buildDecisionContext.call(host, turn, model, state))
        .decisionContext,
    informationReads: () => informationReads,
    fullReads: () => fullReads,
  };
}

Deno.test("only a grantless BO in its own open branch can discover a creation grant request", async () => {
  const f = decisionFixture(false, false);
  f.model.ownerAuthority = {
    ...legacyOwnerAuthority("s"),
    ownerSource: "modeled",
  };
  const existing = f.model.operatorCreationPolicies![0]!;
  f.model.operatorCreationPolicies = [];
  ensureRequestCase(f.state, { objective: "Research" }, {
    now: () => "2026-11-02T00:00:00Z",
  }, 1);
  const record = f.state.cases![0]!;
  const available = async () =>
    (await f.build()).mandate!.supportedChanges.some((change) =>
      change.requestedRights === "operatorCreation"
    );
  equal(await available(), false, "Main has no branch grant path");
  f.modelPort.requestChangeScope = {
    caseId: record.id,
    operatorId: f.model.identity.builderId,
    executionSpaceId: "branch",
    branchTeamSize: 0,
    memberIds: [],
  };
  equal(await available(), true);
  f.model.operatorCreationPolicies = [existing];
  existing.children = ["one", "two", "three"];
  f.modelPort.requestChangeScope = {
    ...f.modelPort.requestChangeScope,
    branchTeamSize: 3,
  };
  equal(
    await available(),
    false,
    "capacity exhaustion is not absence of a grant",
  );
  existing.enabled = false;
  equal(await available(), true, "a withdrawn grant permits a fresh request");
  f.model.operatorTeam = {
    parentOperatorId: "parent",
    requestOwnerId: record.owner,
    requestId: record.id,
  };
  equal(await available(), false, "a member cannot ask for the BO's right");
  delete f.model.operatorTeam;
  record.owner = "another";
  equal(await available(), false);
  record.owner = f.model.identity.builderId;
  record.status = "closed-done";
  equal(await available(), false);
});

Deno.test("pin creation capability survives closed Requests and exhausted live capacity", async () => {
  const f = decisionFixture(false, false);
  ensureRequestCase(f.state, { objective: "Research" }, {
    now: () => "2026-11-02T00:00:00Z",
  }, 1);
  const initial = await f.build();
  equal(initial.pinCapabilities?.teamCreation, true);
  f.model.operatorCreationPolicies![0]!.children = ["a", "b", "c"];
  f.state.cases![0]!.status = "closed-done";
  const next = await f.build();
  equal(next.operatorCreation, undefined);
  deepStrictEqual(next.pinCapabilities, initial.pinCapabilities);
});

Deno.test("delegated contribution keeps its originating Case in the decision context", async () => {
  const f = decisionFixture(false, false);
  ensureRequestCase(f.state, { objective: "Delegated research" }, {
    now: () => "2026-11-02T00:00:00Z",
  }, 1);
  const record = f.state.cases![0]!;
  f.state.caseInvocation = {
    kind: "delegated",
    work: {
      correlationId: "correlation",
      callerId: "parent",
      invocationId: "invocation",
      targetNativeId: "operator",
      fingerprint: "fingerprint",
      priorCandidateIds: [],
      modelVersion: {
        digest: f.model.version.digest,
        repositoryVersion: "commit:source",
      },
      caseContext: {
        caseId: record.id,
        number: record.number,
        modelPin: record.modelPin,
        record,
      },
    },
  };
  const context = await f.build();
  deepStrictEqual(context.case, record);
  equal(context.pinCapabilities?.teamCreation, true);
});

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`decision context read=${read}, revision=${revision} projects admitted read and revision rights`, async () => {
    const f = decisionFixture(read, revision);
    const context = await f.build();
    equal(!!context.modelTools?.length, allowed);
    equal(context.modelContext !== undefined, allowed);
    equal(f.informationReads(), allowed ? 1 : 0);
    equal(context.modelEditing?.targetedEdits, revision);
    equal(context.modelEditing?.rawRevision, revision);
  });
}

Deno.test("admitted revision rights stay identical across execution spaces without changing the model or digest", async () => {
  for (const revision of [false, true]) {
    const f = decisionFixture(true, revision);
    const before = structuredClone(f.model);
    const main = await f.build();
    equal(main.executionPolicy!.mayConsultModel, true);
    equal(main.executionPolicy!.mayProposeSysmlRevision, revision);
    equal(main.modelEditing!.targetedEdits, revision);
    equal(main.modelEditing!.rawRevision, revision);
    equal(main.modelAdministration !== undefined, revision);
    ensureRequestCase(f.state, { objective: "Scoped Request" }, {
      now: () => "2026-11-02T00:00:00Z",
    }, 1);
    equal(
      operatorCreationContext(
        f.model,
        f.state,
        mainCreationScope(f.model.identity),
      )!.provisionBounds.mayProposeSysmlRevision,
      revision,
    );
    f.modelPort.requestChangeScope = {
      caseId: f.state.cases![0].id,
      operatorId: "operator",
      executionSpaceId: "request-branch",
      branchTeamSize: 1,
      memberIds: [],
    };
    const request = await f.build();
    equal(request.executionPolicy!.mayConsultModel, true);
    equal(request.executionPolicy!.mayProposeSysmlRevision, revision);
    equal(request.modelEditing!.targetedEdits, revision);
    equal(request.modelEditing!.rawRevision, revision);
    equal(request.modelAdministration !== undefined, revision);
    equal(request.operatorCreation!.provisionBounds.mayConsultModel, true);
    equal(
      request.operatorCreation!.provisionBounds.mayProposeSysmlRevision,
      revision,
    );
    equal(request.modelTools!.length > 0, true);
    deepStrictEqual(request.admittedModelVersion, main.admittedModelVersion);
    delete f.host.ports.information;
    const legacySources = await f.build();
    equal(legacySources.modelSources !== undefined, revision);
    equal(f.fullReads(), revision ? 1 : 0);
    deepStrictEqual(f.model, before);
  }
});

Deno.test("decision context carries host observations independently of compacted journal excerpts", async () => {
  const f = decisionFixture(false, false);
  f.model.contextPolicy = {
    kind: "separated-context",
    pattern: "5.1",
    id: "context",
    revision: 1,
    elementId: "context-policy",
    sourceIds: [],
    recentMessages: 1,
    maxMessageCharacters: 256,
    maxCollectionItems: 1,
    maxContextCharacters: 16000,
  };
  const value = {
    kind: "request-creation-policy-outcome",
    verdict: "approved",
  };
  f.state.messages.push({
    id: "request-network-outcome:decision",
    role: "tool",
    text: "Recorded",
    at: "now",
    observation: { kind: "tool-result", value },
  }, { id: "later", role: "tool", text: "Later observation", at: "later" });
  const context = await f.build();
  equal(
    context.messages.some(({ id }) =>
      id === "request-network-outcome:decision"
    ),
    false,
  );
  deepStrictEqual(context.hostObservations, [{
    messageId: "request-network-outcome:decision",
    value,
  }]);
});
