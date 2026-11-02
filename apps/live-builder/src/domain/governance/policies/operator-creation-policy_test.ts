import assert from "node:assert/strict";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";
import { exerciseOwnerAuthority, legacyOwnerAuthority } from "../authority.ts";
import {
  type TeamOperatorSpec,
  validateOperatorCreationSpec,
} from "../operator-authority.ts";
import {
  assertCreationAuthorityReceipt,
  assertCreationWithinPolicy,
  assertOperatorCreationCapacity,
  creationAuthorityExercise,
  creationMode,
  creationPreviewExercise,
  creationReceiptVerifies,
  exactChildCreationGrant,
  mainCreationScope,
  matchesTeamProvision,
  type OperatorCreationPolicy,
} from "./operator-creation-policy.ts";
import type { ExecutionSpaceRef } from "../authority.ts";
import type { PendingChange } from "../records/pending-change.ts";
import { SystemGovernance } from "./governance.ts";
import {
  branchTeam,
  conversationPermissions,
} from "../../work/request-spaces.ts";
import { requestOpeningBase } from "../../../../test/support/request-space-fixture.ts";

function fixture() {
  const root = {
    ...legacyOwnerAuthority("worker-system"),
    ownerSource: "modeled" as const,
  };
  const policy: OperatorCreationPolicy = {
    id: "create-research",
    revision: 1,
    elementId: "grant-element",
    sourceIds: ["grant-element"],
    holderNativeId: "request-owner",
    mandateNativeId: "worker-mandate",
    systemId: "worker-system",
    enabled: true,
    rootAuthority: root,
    networkHosts: ["example.org"],
    maxChildren: 2,
    maxDelegationDepth: 1,
    children: [],
  };
  const model = {
    identity: { builderId: "request-owner", systemId: "worker-system" },
    version: { digest: "base" },
    ownerAuthority: root,
    operatorCreationPolicies: [policy],
    policy: { maxAgentDecisions: 10, maxToolProposals: 4, maxFlowSteps: 100 },
    mandate: {
      mayPropose: ["read_web_page", "read_web_page_outline"],
      mayInvoke: "active-catalog-only",
    },
    configuration: { network: { allowedHosts: ["example.org"] } },
  } as unknown as ExecutableModel;
  const spec: TeamOperatorSpec = {
    kind: "request-team-member",
    instruction: "Extract one referenced passage.",
    provision: {
      budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
      networkHosts: ["example.org"],
      mayPropose: ["read_web_page"],
      mayInvokeActiveCatalog: true,
    },
    creationGrant: { networkHosts: [], maxChildren: 1, maxDelegationDepth: 0 },
  };
  return { model, policy, spec };
}

Deno.test("a non-Main Request operator creates with an explicit attenuated grant and no child Request", () => {
  const { model, policy, spec } = fixture();
  assert.deepEqual(validateOperatorCreationSpec(spec), spec);
  assert.equal(
    assertCreationWithinPolicy(
      model,
      spec,
      undefined,
      mainCreationScope(model.identity),
    ).id,
    policy.id,
  );
  assert.equal("requestType" in spec, false);
  assert.equal("firstRequest" in spec, false);
  const change: PendingChange = {
    id: "create-child",
    kind: "operator-creation",
    role: "operator",
    name: "Reader",
    status: "approved",
    requestedBy: model.identity.builderId,
    caseId: "originating-request",
    teamOrigin: {
      operatorId: model.identity.builderId,
      requestId: "originating-request",
    },
    baseRevision: 0,
    requestedAt: "now",
    reason: "Read the referenced page",
    operator: spec,
    authority: "builder",
    decidedAt: "now",
  };
  const actor = {
    actorId: model.identity.builderId,
    policyId: policy.id,
    policyRevision: policy.revision,
  };
  change.authorityExercise = creationAuthorityExercise(
    model,
    change,
    actor,
    mainCreationScope(model.identity),
  );
  assert.doesNotThrow(() =>
    assertCreationAuthorityReceipt(
      model,
      change,
      mainCreationScope(model.identity),
    )
  );
  assert.equal(change.authorityExercise.systemId, model.identity.systemId);
  assert.equal(
    change.authorityExercise.creationDelegation?.actorId,
    model.identity.builderId,
  );
  const altered = structuredClone(change);
  altered.operator = { ...spec, instruction: "Read a different request" };
  assert.throws(
    () =>
      assertCreationAuthorityReceipt(
        model,
        altered,
        mainCreationScope(model.identity),
      ),
    /receipt/,
  );
  policy.enabled = false;
  assert.throws(() =>
    assertCreationAuthorityReceipt(
      model,
      change,
      mainCreationScope(model.identity),
    )
  );
});

Deno.test("technical operator headroom bounds creation independently of per-holder grants", () => {
  assert.doesNotThrow(() => assertOperatorCreationCapacity(63, 64));
  for (
    const [before, after] of [[64, 65], [63, 65], [63, 63], [0, 1], [65, 66]]
  ) {
    assert.throws(() => assertOperatorCreationCapacity(before!, after!), {
      code: "OPERATOR_CAPACITY_EXCEEDED",
    });
  }
  const { spec } = fixture();
  assert.doesNotThrow(() =>
    validateOperatorCreationSpec({
      ...spec,
      creationGrant: {
        networkHosts: [],
        maxChildren: 64,
        maxDelegationDepth: 63,
      },
    })
  );
  for (
    const grant of [
      { networkHosts: [], maxChildren: 65, maxDelegationDepth: 0 },
      { networkHosts: [], maxChildren: 1, maxDelegationDepth: 64 },
      {
        networkHosts: [],
        maxChildren: Number.MAX_SAFE_INTEGER,
        maxDelegationDepth: Number.MAX_SAFE_INTEGER,
      },
    ]
  ) {
    assert.throws(() =>
      validateOperatorCreationSpec({ ...spec, creationGrant: grant })
    );
  }
});

Deno.test("publication compares the entire child's holder-grant set and refuses hidden additional authority", () => {
  const { model, policy } = fixture();
  const requested = {
    networkHosts: [...policy.networkHosts],
    maxChildren: policy.maxChildren,
    maxDelegationDepth: policy.maxDelegationDepth,
  };
  assert.equal(exactChildCreationGrant(model, requested), true);
  const extra = {
    ...structuredClone(policy),
    id: "extra-grant",
    elementId: "extra-native-policy",
    networkHosts: ["outside.example"],
  };
  for (const grants of [[policy, extra], [extra, policy]]) {
    model.operatorCreationPolicies = grants;
    assert.equal(exactChildCreationGrant(model, requested), false);
    assert.equal(exactChildCreationGrant(model, undefined), false);
  }
  model.operatorCreationPolicies = [];
  assert.equal(exactChildCreationGrant(model, undefined), true);
  assert.equal(exactChildCreationGrant(model, requested), false);
  model.operatorCreationPolicies = [policy];
  assert.equal(
    exactChildCreationGrant(model, requested, "parent-grant"),
    false,
  );
  policy.parentPolicyElementId = "parent-grant";
  assert.equal(exactChildCreationGrant(model, requested, "parent-grant"), true);
  policy.enabled = false;
  assert.equal(
    exactChildCreationGrant(model, requested, "parent-grant"),
    false,
  );
});

Deno.test("creation refuses absent, revoked, stale, exhausted and expanding grants before an effect", () => {
  const { model, policy, spec } = fixture();
  for (
    const mutation of [
      () => {
        model.operatorCreationPolicies = [];
      },
      () => {
        policy.enabled = false;
      },
      () => {
        policy.children = ["first", "second"];
      },
      () => {
        spec.provision.networkHosts = ["outside.example"];
      },
      () => {
        spec.creationGrant!.networkHosts = ["outside.example"];
      },
      () => {
        spec.creationGrant!.maxDelegationDepth = 1;
      },
      () => {
        spec.creationGrant!.maxChildren = 3;
      },
      () => {
        policy.rootAuthority = undefined;
      },
    ]
  ) {
    const saved = structuredClone({ model, policy, spec });
    mutation();
    assert.throws(() =>
      assertCreationWithinPolicy(
        model,
        spec,
        undefined,
        mainCreationScope(model.identity),
      )
    );
    Object.assign(policy, saved.policy);
    Object.assign(spec, saved.spec);
    Object.assign(model, saved.model, { operatorCreationPolicies: [policy] });
  }
  assert.throws(() =>
    assertCreationWithinPolicy(model, spec, {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: 2,
    }, mainCreationScope(model.identity))
  );
  assert.throws(() =>
    assertCreationWithinPolicy(model, spec, {
      actorId: "Main",
      policyId: policy.id,
      policyRevision: 1,
    }, mainCreationScope(model.identity))
  );
  const leaf = { ...spec };
  delete leaf.creationGrant;
  policy.maxDelegationDepth = 0;
  assert.doesNotThrow(() =>
    assertCreationWithinPolicy(
      model,
      leaf,
      undefined,
      mainCreationScope(model.identity),
    )
  );
  assert.throws(() =>
    assertCreationWithinPolicy(
      model,
      spec,
      undefined,
      mainCreationScope(model.identity),
    )
  );
});

Deno.test("closed team authoring input rejects hidden Requests and unbounded authority", () => {
  const { spec } = fixture();
  for (
    const bad of [
      { ...spec, firstRequest: { objective: "An unwanted child Request" } },
      { ...spec, requestType: { name: "Unwanted", maxInvocations: 1 } },
      { ...spec, creationGrant: { ...spec.creationGrant, maxChildren: 0 } },
      {
        ...spec,
        creationGrant: { ...spec.creationGrant, maxDelegationDepth: -1 },
      },
      { ...spec, creationGrant: { ...spec.creationGrant, mayAdmit: true } },
      { ...spec, networkHosts: ["*"] },
      {
        ...spec,
        provision: { ...spec.provision, networkHosts: ["*"] },
      },
    ]
  ) assert.throws(() => validateOperatorCreationSpec(bad));
});

Deno.test("an independent Request owner receives creation rights only when explicitly included for human admission", () => {
  const { model, policy, spec } = fixture();
  const independent = {
    instruction: "Own a bounded Request.",
    networkHosts: [],
    requestType: { name: "Research", maxInvocations: 4 },
    firstRequest: { objective: "Produce an answer." },
  };
  assert.deepEqual(validateOperatorCreationSpec(independent), independent);
  assert.equal(
    Object.hasOwn(validateOperatorCreationSpec(independent), "creationGrant"),
    false,
  );
  const initial = { ...independent, creationGrant: spec.creationGrant };
  assert.deepEqual(validateOperatorCreationSpec(initial), initial);
  assert.throws(() =>
    validateOperatorCreationSpec({ ...independent, creationGrant: undefined })
  );
  assert.throws(() =>
    validateOperatorCreationSpec({
      ...independent,
      creationGrant: { ...spec.creationGrant, maxChildren: 0 },
    })
  );
  const pending: PendingChange = {
    id: "initial-owner",
    kind: "operator-creation",
    role: "operator",
    name: "Owner",
    status: "pending",
    requestedBy: model.identity.builderId,
    designerScopeId: "main",
    baseRevision: 0,
    requestedAt: "now",
    reason: "Explicit initial rights",
    operator: initial,
  };
  assert.throws(() =>
    creationAuthorityExercise(model, pending, {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    }, mainCreationScope(model.identity))
  );
});

function branchSpace(): ExecutionSpaceRef {
  return {
    projectId: "unit",
    systemId: "worker-system",
    executionSpaceId: "space-x",
  };
}

function creationChange(
  model: ExecutableModel,
  spec: TeamOperatorSpec,
): PendingChange {
  return {
    id: "create-child",
    kind: "operator-creation",
    role: "operator",
    name: "Reader",
    status: "pending",
    requestedBy: model.identity.builderId,
    caseId: "originating-request",
    teamOrigin: {
      operatorId: model.identity.builderId,
      requestId: "originating-request",
    },
    baseRevision: 0,
    requestedAt: "now",
    reason: "Read the referenced page",
    operator: spec,
  };
}

Deno.test("creation mode defaults to autonomous and validates the closed grant field", () => {
  const { policy, spec } = fixture();
  assert.equal(creationMode(policy), "autonomous");
  assert.equal(
    creationMode({ ...policy, mode: "per-creation" }),
    "per-creation",
  );
  assert.deepEqual(
    validateOperatorCreationSpec({
      ...spec,
      creationGrant: { ...spec.creationGrant!, mode: "per-creation" },
    }),
    {
      ...spec,
      creationGrant: { ...spec.creationGrant!, mode: "per-creation" },
    },
  );
  assert.throws(() =>
    validateOperatorCreationSpec({
      ...spec,
      creationGrant: { ...spec.creationGrant!, mode: "sometimes" },
    })
  );
});

Deno.test("per-creation refuses self-approval while the proposal stays within the grant", () => {
  const { model, policy, spec: granted } = fixture();
  policy.mode = "per-creation";
  // A leaf child: the fixture's default child grant is autonomous, which a
  // per-creation parent may not transmit (tested separately below).
  const spec = { ...granted };
  delete spec.creationGrant;
  assert.equal(
    assertCreationWithinPolicy(
      model,
      spec,
      undefined,
      mainCreationScope(model.identity),
    ).id,
    policy.id,
  );
  assert.throws(
    () =>
      creationAuthorityExercise(model, creationChange(model, spec), {
        actorId: model.identity.builderId,
        policyId: policy.id,
        policyRevision: policy.revision,
      }, mainCreationScope(model.identity)),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "AUTHORITY_OUT_OF_BOUNDS" &&
      "context" in error &&
      (error.context as Record<string, unknown>).mode === "per-creation",
  );
  policy.mode = "autonomous";
  assert.doesNotThrow(() =>
    creationAuthorityExercise(model, creationChange(model, spec), {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    }, mainCreationScope(model.identity))
  );
});

Deno.test("in a branch the bound of three counts the whole team and inherited children are inert", () => {
  const { model, policy, spec } = fixture();
  policy.maxChildren = 5;
  policy.children = [
    "inherited-1",
    "inherited-2",
    "inherited-3",
    "inherited-4",
  ];
  const scope = { space: branchSpace() };
  // The branch count replaces the native children list: inherited children
  // neither count nor block, the whole branch team counts toward three.
  assert.doesNotThrow(() =>
    assertCreationWithinPolicy(model, spec, undefined, {
      ...scope,
      branchTeamSize: 2,
    })
  );
  assert.throws(
    () =>
      assertCreationWithinPolicy(model, spec, undefined, {
        ...scope,
        branchTeamSize: 3,
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  // A branch read without the team count fails closed.
  assert.throws(
    () => assertCreationWithinPolicy(model, spec, undefined, scope),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  // A narrower policy bound still wins inside the branch.
  policy.maxChildren = 1;
  assert.throws(() =>
    assertCreationWithinPolicy(model, spec, undefined, {
      ...scope,
      branchTeamSize: 1,
    })
  );
  // The space must carry this model's identity.
  assert.throws(
    () =>
      assertCreationWithinPolicy(model, spec, undefined, {
        space: { ...branchSpace(), systemId: "another-system" },
        branchTeamSize: 0,
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  // Main is unchanged: the native children list counts, the branch size is ignored.
  policy.maxChildren = 5;
  assert.doesNotThrow(() =>
    assertCreationWithinPolicy(model, spec, undefined, {
      space: { ...branchSpace(), executionSpaceId: "main" },
      branchTeamSize: 3,
    })
  );
  policy.children = ["a", "b", "c", "d", "e"];
  assert.throws(() =>
    assertCreationWithinPolicy(
      model,
      spec,
      undefined,
      mainCreationScope(model.identity),
    )
  );
});

Deno.test("a team provision is required, closed and has no default", () => {
  const { spec } = fixture();
  const { provision: _provision, ...withoutProvision } = spec;
  for (
    const bad of [
      withoutProvision,
      { ...withoutProvision, networkHosts: ["example.org"] },
      { ...spec, provision: { ...spec.provision, budget: undefined } },
      {
        ...spec,
        provision: {
          ...spec.provision,
          budget: { maxAgentDecisions: 1, maxToolProposals: 0 },
        },
      },
      {
        ...spec,
        provision: {
          ...spec.provision,
          budget: { ...spec.provision.budget, maxAgentDecisions: 0 },
        },
      },
      {
        ...spec,
        provision: {
          ...spec.provision,
          budget: { ...spec.provision.budget, maxToolProposals: -1 },
        },
      },
      {
        ...spec,
        provision: { ...spec.provision, mayPropose: ["delete_files"] },
      },
      {
        ...spec,
        provision: {
          ...spec.provision,
          mayPropose: ["read_web_page", "read_web_page"],
        },
      },
      {
        ...spec,
        provision: { ...spec.provision, mayInvokeActiveCatalog: "yes" },
      },
    ]
  ) assert.throws(() => validateOperatorCreationSpec(bad));
  assert.deepEqual(validateOperatorCreationSpec(spec), spec);
  const explicit = {
    ...spec,
    provision: { ...spec.provision, mayAddNetworkHosts: true },
  };
  assert.deepEqual(validateOperatorCreationSpec(explicit), explicit);
  assert.throws(() =>
    validateOperatorCreationSpec({
      ...spec,
      provision: { ...spec.provision, mayAddNetworkHosts: "true" },
    })
  );
});

Deno.test("each provisioned value above the creator is refused with its field; equal is accepted", () => {
  const { model, policy, spec } = fixture();
  const fieldOf = (mutate: (draft: TeamOperatorSpec) => void): string => {
    const draft = structuredClone(spec);
    mutate(draft);
    try {
      assertCreationWithinPolicy(
        model,
        draft,
        undefined,
        mainCreationScope(model.identity),
      );
    } catch (error) {
      assert(
        error instanceof Error && "code" in error &&
          error.code === "AUTHORITY_OUT_OF_BOUNDS" && "context" in error,
      );
      const context = (error as { context: Record<string, unknown> }).context;
      assert.equal(typeof context.requested, "string");
      assert.equal(typeof context.creator, "string");
      return String(context.field);
    }
    throw new Error("expected an out-of-bounds refusal");
  };
  assert.equal(
    fieldOf((draft) => draft.provision.budget.maxAgentDecisions = 11),
    "budget.maxAgentDecisions",
  );
  assert.equal(
    fieldOf((draft) => draft.provision.budget.maxToolProposals = 5),
    "budget.maxToolProposals",
  );
  assert.equal(
    fieldOf((draft) => draft.provision.budget.maxFlowSteps = 101),
    "budget.maxFlowSteps",
  );
  // A host the policy allows but the creator's own mandate does not.
  policy.networkHosts = ["example.org", "policy.example"];
  assert.equal(
    fieldOf((draft) => draft.provision.networkHosts = ["policy.example"]),
    "networkHosts",
  );
  policy.networkHosts = ["example.org"];
  model.mandate = { ...model.mandate, mayPropose: ["read_web_page"] };
  assert.equal(
    fieldOf((draft) =>
      draft.provision.mayPropose = ["read_web_page", "read_web_page_outline"]
    ),
    "mayPropose",
  );
  model.mandate = {
    ...model.mandate,
    mayPropose: ["read_web_page", "read_web_page_outline"],
    mayInvoke: false,
  };
  assert.equal(
    fieldOf((draft) => draft.provision.mayInvokeActiveCatalog = true),
    "mayInvokeActiveCatalog",
  );
  model.policy.mayAddNetworkHosts = false;
  assert.equal(
    fieldOf((draft) => draft.provision.mayAddNetworkHosts = true),
    "mayAddNetworkHosts",
  );
  model.mandate = { ...model.mandate, mayInvoke: "active-catalog-only" };
  const equal = structuredClone(spec);
  equal.provision = {
    budget: { maxAgentDecisions: 10, maxToolProposals: 4, maxFlowSteps: 100 },
    networkHosts: ["example.org"],
    mayPropose: ["read_web_page", "read_web_page_outline"],
    mayInvokeActiveCatalog: true,
  };
  assert.doesNotThrow(() =>
    assertCreationWithinPolicy(
      model,
      equal,
      undefined,
      mainCreationScope(model.identity),
    )
  );
});

Deno.test("a transmitted creation grant may only downgrade the mode and is compared exactly", () => {
  const { model, policy, spec } = fixture();
  policy.mode = "per-creation";
  const autonomousChild = {
    ...spec,
    creationGrant: { ...spec.creationGrant!, mode: "autonomous" as const },
  };
  assert.throws(() =>
    assertCreationWithinPolicy(
      model,
      autonomousChild,
      undefined,
      mainCreationScope(model.identity),
    )
  );
  const downgraded = {
    ...spec,
    creationGrant: { ...spec.creationGrant!, mode: "per-creation" as const },
  };
  assert.doesNotThrow(() =>
    assertCreationWithinPolicy(
      model,
      downgraded,
      undefined,
      mainCreationScope(model.identity),
    )
  );
  const requested = {
    networkHosts: [...policy.networkHosts],
    maxChildren: policy.maxChildren,
    maxDelegationDepth: policy.maxDelegationDepth,
  };
  assert.equal(exactChildCreationGrant(model, requested), false);
  assert.equal(
    exactChildCreationGrant(model, { ...requested, mode: "per-creation" }),
    true,
  );
  policy.mode = undefined;
  assert.equal(exactChildCreationGrant(model, requested), true);
});

Deno.test("an inherited creation grant cannot move its team to another Request", () => {
  const { model, policy, spec } = fixture();
  model.operatorTeam = {
    parentOperatorId: "parent",
    requestOwnerId: "root-owner",
    requestId: "root-request",
  };
  const change: PendingChange = {
    id: "child-create",
    kind: "operator-creation",
    role: "operator",
    name: "Child",
    status: "pending",
    requestedBy: model.identity.builderId,
    caseId: "root-request",
    teamOrigin: { operatorId: "root-owner", requestId: "root-request" },
    baseRevision: 0,
    requestedAt: "now",
    reason: "Contribute",
    operator: spec,
  };
  const actor = {
    actorId: model.identity.builderId,
    policyId: policy.id,
    policyRevision: policy.revision,
  };
  assert.doesNotThrow(() =>
    creationAuthorityExercise(
      model,
      change,
      actor,
      mainCreationScope(model.identity),
    )
  );
  change.caseId = "another-request";
  change.teamOrigin!.requestId = "another-request";
  assert.throws(
    () =>
      creationAuthorityExercise(
        model,
        change,
        actor,
        mainCreationScope(model.identity),
      ),
    /origin/,
  );
});

function verifiedTeam() {
  const { model, policy, spec } = fixture();
  const parent = structuredClone(model) as ExecutableModel;
  const change = creationChange(parent, spec);
  change.status = "approved";
  change.authority = "builder";
  change.decidedAt = "now";
  change.authorityExercise = creationAuthorityExercise(
    parent,
    change,
    {
      actorId: parent.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    },
    mainCreationScope(parent.identity),
  );
  // Post-publication parent: the policy consumed one slot for this child.
  (parent as { configuration: unknown }).configuration = {
    network: { allowedHosts: ["example.org"] },
    changes: [change],
  };
  parent.operatorCreationPolicies = [{
    ...policy,
    children: ["child-system"],
  }];
  parent.version = { ...parent.version, digest: "after-creation" } as never;
  const child = {
    identity: { builderId: "child", systemId: "child-system" },
    version: { digest: "child-digest" },
    operatorTeam: {
      parentOperatorId: parent.identity.builderId,
      requestOwnerId: parent.identity.builderId,
      requestId: "originating-request",
      creationPolicyId: policy.id,
    },
    operator: { instruction: spec.instruction },
    configuration: {
      network: { allowedHosts: [...spec.provision.networkHosts] },
    },
    policy: { ...spec.provision.budget, mayAddNetworkHosts: false },
    mandate: {
      mayPropose: [...spec.provision.mayPropose],
      mayInvoke: "active-catalog-only",
    },
  } as unknown as ExecutableModel;
  return { parent, child, change, policy, spec };
}

Deno.test("duplicate teammate proposals refuse pending and approved creations without losing the admitted member", async () => {
  for (const mode of ["autonomous", "per-creation"] as const) {
    for (
      const [status, publishedCommit] of [
        ["pending", undefined],
        ["pending", "published"],
        ["approved", "published"],
      ] as const
    ) {
      const { parent, child, change, spec } = verifiedTeam();
      parent.operatorCreationPolicies![0].mode = mode;
      parent.configuration = {
        ...SystemGovernance.fresh("team").snapshot,
        network: { allowedHosts: ["example.org"] },
        changes: [change],
      };
      const scope = {
        space: {
          projectId: "unit",
          systemId: parent.identity.systemId,
          executionSpaceId: "space-x",
        },
        branchTeamSize: 1,
      };
      const base = await requestOpeningBase();
      base.requestOwner.operatorId = parent.identity.builderId;
      base.manifest.operators[0].operatorId = parent.identity.builderId;
      const models = [parent, child];
      const permissions = () =>
        conversationPermissions(
          base,
          branchTeam(base, models, change.caseId!, (member) =>
            creationReceiptVerifies(models, member as ExecutableModel, scope)),
        );
      const admitted = permissions();
      assert.deepEqual(admitted.operatorIds, [
        parent.identity.builderId,
        "child",
      ]);
      change.status = status;
      // Even a published pending creation still reserves its mission.
      change.publishedCommit = publishedCommit;
      const governance = SystemGovernance.fromExecutable(
        parent,
        parent.configuration.changes,
        scope,
      );
      const before = governance.snapshot;
      const decision = {
        kind: "propose_agent_creation" as const,
        role: "operator" as const,
        text: "Create teammate",
        name: "Different display name",
        reason: "Contribute to this Request",
        operator: {
          kind: spec.kind,
          instruction: spec.instruction,
          provision: spec.provision,
        },
      };
      assert.throws(() =>
        governance.propose(
          decision,
          "duplicate",
          "now",
          { requestedBy: parent.identity.builderId, caseId: change.caseId! },
        ), {
        code: "OPERATOR_CREATION_DUPLICATE",
        context: { caseId: change.caseId, changeId: change.id, status },
        recovery: { action: "use-existing-or-await-creation" },
      });
      assert.deepEqual(governance.snapshot, before);
      if (status === "approved") {
        parent.configuration = governance.snapshot;
        assert.equal(creationReceiptVerifies(models, child, scope), true);
        assert.deepEqual(permissions(), admitted);
      }
    }
  }
});

Deno.test("teammate duplicate refusal preserves different missions, provisions, Cases and decided refusals", () => {
  for (
    const variant of [
      "instruction",
      "provision",
      "case",
      "refused",
      "superseded",
    ] as const
  ) {
    const { parent, change, spec } = verifiedTeam();
    parent.configuration = {
      ...SystemGovernance.fresh("team").snapshot,
      network: { allowedHosts: ["example.org"] },
      changes: [change],
    };
    const proposal = structuredClone(spec);
    if (variant === "instruction") proposal.instruction = "Another mission";
    if (variant === "provision") proposal.provision.budget.maxFlowSteps--;
    if (variant === "case") change.caseId = "another-case";
    if (variant === "refused" || variant === "superseded") {
      change.status = variant;
    }
    const governance = SystemGovernance.fromExecutable(parent, [change], {
      space: {
        projectId: "unit",
        systemId: parent.identity.systemId,
        executionSpaceId: "space-x",
      },
      branchTeamSize: 1,
    });
    assert.equal(
      governance.propose(
        {
          kind: "propose_agent_creation",
          role: "operator",
          text: "Create teammate",
          name: "Research",
          reason: "Contribute to this Request",
          operator: proposal,
        },
        "new-creation",
        "now",
        {
          requestedBy: parent.identity.builderId,
          caseId: "originating-request",
        },
      ).status,
      "pending",
    );
  }
});

Deno.test("a pinned child's creation receipt verifies against its parent model and provision", () => {
  const { parent, child } = verifiedTeam();
  const scope = mainCreationScope(parent.identity);
  assert.equal(creationReceiptVerifies([parent, child], child, scope), true);
  const tampered = structuredClone(child) as ExecutableModel;
  tampered.operator = { ...tampered.operator!, instruction: "Other work" };
  assert.equal(
    creationReceiptVerifies([parent, tampered], tampered, scope),
    false,
  );
  const wider = structuredClone(child) as ExecutableModel;
  (wider as { policy: { maxFlowSteps: number } }).policy.maxFlowSteps = 999;
  assert.equal(creationReceiptVerifies([parent, wider], wider, scope), false);
  assert.equal(creationReceiptVerifies([child], child, scope), false);
});

Deno.test("revoking the grant or lowering the parent after creation keeps the member (decision 13)", () => {
  const { parent, child } = verifiedTeam();
  const scope = mainCreationScope(parent.identity);
  const current = parent.operatorCreationPolicies![0]!;
  current.enabled = false;
  current.revision = 2;
  assert.equal(creationReceiptVerifies([parent, child], child, scope), true);
  // The parent's own budget, mandate and hosts shrank below the provision.
  (parent as { policy: unknown }).policy = {
    maxAgentDecisions: 1,
    maxToolProposals: 0,
    maxFlowSteps: 1,
  };
  parent.mandate = { ...parent.mandate, mayPropose: [], mayInvoke: false };
  (parent as { configuration: { network: unknown } }).configuration.network = {
    allowedHosts: [],
  };
  current.networkHosts = [];
  assert.equal(creationReceiptVerifies([parent, child], child, scope), true);
});

Deno.test("in a branch, inherited main children never block a legitimately created child", () => {
  const { parent, child } = verifiedTeam();
  const current = parent.operatorCreationPolicies![0]!;
  current.maxChildren = 2;
  current.children = ["inherited-1", "inherited-2", "child-system"];
  const scope = {
    space: {
      projectId: "unit",
      systemId: parent.identity.systemId,
      executionSpaceId: "space-x",
    },
    branchTeamSize: 1,
  };
  assert.equal(creationReceiptVerifies([parent, child], child, scope), true);
});

Deno.test("a forged authorityExercise does not verify", () => {
  const { parent, child, change } = verifiedTeam();
  const scope = mainCreationScope(parent.identity);
  const forgedSpec = structuredClone(parent) as ExecutableModel;
  const receiptChange = (forgedSpec as {
    configuration: { changes: PendingChange[] };
  }).configuration.changes[0]!;
  receiptChange.authorityExercise!.creationDelegation!.operator = {
    ...(change.operator as TeamOperatorSpec),
    instruction: "Forged work",
  };
  assert.equal(
    creationReceiptVerifies([forgedSpec, child], child, scope),
    false,
  );
  const forgedRevision = structuredClone(parent) as ExecutableModel;
  (forgedRevision as { configuration: { changes: PendingChange[] } })
    .configuration.changes[0]!.authorityExercise!.creationDelegation!
    .policyRevision = 99;
  assert.equal(
    creationReceiptVerifies([forgedRevision, child], child, scope),
    false,
  );
  const forgedActor = structuredClone(parent) as ExecutableModel;
  (forgedActor as { configuration: { changes: PendingChange[] } })
    .configuration.changes[0]!.authorityExercise!.creationDelegation!
    .actorId = "someone-else";
  assert.equal(
    creationReceiptVerifies([forgedActor, child], child, scope),
    false,
  );
});

Deno.test("a human-approved creation receipt verifies", () => {
  const { parent, child, change, spec } = verifiedTeam();
  const scope = mainCreationScope(parent.identity);
  const humanParent = structuredClone(parent) as ExecutableModel;
  const humanChange = (humanParent as {
    configuration: { changes: PendingChange[] };
  }).configuration.changes[0]!;
  humanChange.authority = "human";
  // The receipt was exercised against the parent as decided upon ("base").
  humanChange.authorityExercise = exerciseOwnerAuthority(
    { ...humanParent, version: { ...humanParent.version, digest: "base" } },
    "mandate-change",
  );
  humanChange.baseModelDigest = "base";
  assert.equal(humanChange.operator !== undefined, true);
  assert.equal(
    (humanChange.operator as TeamOperatorSpec).instruction,
    spec.instruction,
  );
  assert.equal(change.id, humanChange.id);
  assert.equal(
    creationReceiptVerifies([humanParent, child], child, scope),
    true,
  );
});

Deno.test("4.8e E4c: a creation preview budgets the exercise its decider will record", () => {
  const { model, policy, spec: granted } = fixture();
  const spec = { ...granted };
  delete spec.creationGrant;
  const change = creationChange(model, spec);
  const scope = mainCreationScope(model.identity);
  // Autonomous: the creator's own receipt.
  assert.deepEqual(
    creationPreviewExercise(model, change, scope),
    creationAuthorityExercise(model, change, {
      actorId: model.identity.builderId,
      policyId: policy.id,
      policyRevision: policy.revision,
    }, scope),
  );
  // Per-creation: never a self-approval receipt; the decider's exercise.
  policy.mode = "per-creation";
  const exercise = creationPreviewExercise(model, change, scope);
  assert.equal(exercise.creationDelegation, undefined);
  assert.deepEqual(exercise, exerciseOwnerAuthority(model, "mandate-change"));
  // No covering grant: refused before any preview, with its code.
  policy.enabled = false;
  assert.throws(
    () => creationPreviewExercise(model, change, scope),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "AUTHORITY_OUT_OF_BOUNDS",
  );
});

Deno.test("4.8e E8: one creation policy copied by a Release counts each branch's own team, never another's or main's", () => {
  const { model, policy, spec } = fixture();
  // The Release carries the policy with the children it had in main.
  policy.maxChildren = 5;
  policy.children = ["main-child-1", "main-child-2"];
  const at = (executionSpaceId: string, branchTeamSize: number) => ({
    space: { ...branchSpace(), executionSpaceId },
    branchTeamSize,
  });
  // X is full with its own three; Y, from the same Release, has none yet.
  assert.throws(
    () => assertCreationWithinPolicy(model, spec, undefined, at("space-x", 3)),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  assert.equal(
    assertCreationWithinPolicy(model, spec, undefined, at("space-y", 0)).id,
    policy.id,
  );
  // Main still counts its native children only.
  assert.equal(
    assertCreationWithinPolicy(
      model,
      spec,
      undefined,
      mainCreationScope(model.identity),
    ).id,
    policy.id,
  );
});

Deno.test("team model rights are optional and bounded by each creator right", () => {
  for (const field of ["mayConsultModel", "mayProposeSysmlRevision"] as const) {
    const { model, spec } = fixture();
    model.policy.mayConsultModel = false;
    model.policy.mayProposeSysmlRevision = false;
    assert.doesNotThrow(() =>
      assertCreationWithinPolicy(
        model,
        spec,
        undefined,
        mainCreationScope(model.identity),
      )
    );
    spec.provision[field] = false;
    assert.deepEqual(validateOperatorCreationSpec(spec), spec);
    spec.provision[field] = true;
    if (field === "mayProposeSysmlRevision") {
      spec.provision.mayConsultModel = true;
      model.policy.mayConsultModel = true;
    }
    assert.throws(
      () =>
        assertCreationWithinPolicy(
          model,
          spec,
          undefined,
          mainCreationScope(model.identity),
        ),
      (error: unknown) => {
        assert(
          error instanceof Error && "code" in error &&
            error.code === "AUTHORITY_OUT_OF_BOUNDS",
        );
        assert(
          "context" in error &&
            (error.context as { field: string }).field === field,
        );
        assert("recovery" in error);
        assert.deepEqual(error.recovery, { action: "refuse-and-repropose" });
        return true;
      },
    );
    model.policy[field] = true;
    assert.doesNotThrow(() =>
      assertCreationWithinPolicy(
        model,
        spec,
        undefined,
        mainCreationScope(model.identity),
      )
    );
    const granted = validateOperatorCreationSpec(spec);
    assert.deepEqual(granted, spec);
    for (const value of [null, "true", 1, {}]) {
      assert.throws(
        () =>
          validateOperatorCreationSpec({
            ...spec,
            provision: { ...spec.provision, [field]: value },
          }),
        (error: unknown) => {
          assert(
            error instanceof Error && "code" in error &&
              error.code === "INVALID_OPERATOR_REQUEST",
          );
          assert(
            "context" in error &&
              (error.context as { field: string }).field === field,
          );
          assert("recovery" in error);
          assert.deepEqual(error.recovery, { action: "refuse-and-repropose" });
          return true;
        },
      );
    }
  }
});

Deno.test("a unit provisions the same declared model rights in Main and a Request", () => {
  const { model, spec } = fixture();
  model.policy.mayConsultModel = true;
  model.policy.mayProposeSysmlRevision = true;
  spec.provision.mayConsultModel = true;
  spec.provision.mayProposeSysmlRevision = true;
  for (
    const scope of [mainCreationScope(model.identity), {
      space: {
        ...mainCreationScope(model.identity).space,
        executionSpaceId: "request-one",
      },
      branchTeamSize: 0,
    }]
  ) {
    assert.doesNotThrow(() =>
      assertCreationWithinPolicy(model, spec, undefined, scope)
    );
  }
});

Deno.test("revision provision requires an explicit read provision", () => {
  for (const read of [false, undefined]) {
    const { model, spec } = fixture();
    model.policy.mayConsultModel = true;
    model.policy.mayProposeSysmlRevision = true;
    spec.provision.mayProposeSysmlRevision = true;
    if (read !== undefined) spec.provision.mayConsultModel = read;
    assert.throws(
      () => validateOperatorCreationSpec(spec),
      {
        code: "INVALID_OPERATOR_REQUEST",
        context: { field: "mayConsultModel" },
        recovery: { action: "refuse-and-repropose" },
      },
    );
    assert.throws(
      () =>
        assertCreationWithinPolicy(
          model,
          spec,
          undefined,
          mainCreationScope(model.identity),
        ),
      {
        code: "INVALID_OPERATOR_REQUEST",
        context: { field: "mayConsultModel" },
      },
    );
  }
});

Deno.test("team publication compares each network and model right to its explicit provision", () => {
  for (
    const field of [
      "mayAddNetworkHosts",
      "mayConsultModel",
      "mayProposeSysmlRevision",
    ] as const
  ) {
    const { child, spec } = verifiedTeam();
    if (field === "mayProposeSysmlRevision") {
      child.policy.mayConsultModel = true;
      spec.provision.mayConsultModel = true;
    }
    assert.equal(matchesTeamProvision(child, spec.provision), true);
    child.policy[field] = true;
    assert.equal(matchesTeamProvision(child, spec.provision), false);
    spec.provision[field] = true;
    assert.equal(matchesTeamProvision(child, spec.provision), true);
    child.policy[field] = false;
    assert.equal(matchesTeamProvision(child, spec.provision), false);
  }
});

Deno.test("team provision preserves legacy empty-network receipt semantics without weakening publication", () => {
  const { child, spec } = verifiedTeam();
  child.configuration.network = undefined;
  spec.provision.networkHosts = [];
  assert.equal(matchesTeamProvision(child, spec.provision), false);
  assert.equal(
    matchesTeamProvision(child, spec.provision, {
      missingNetworkMeansEmpty: true,
    }),
    true,
  );
});
