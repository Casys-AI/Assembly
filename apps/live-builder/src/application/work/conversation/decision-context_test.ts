import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
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
