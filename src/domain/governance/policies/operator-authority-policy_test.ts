import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  ok,
  throws,
} from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { type AuthorityExercise, legacyOwnerAuthority } from "../authority.ts";
import {
  mainExecutionSpace,
  OperatorAuthorityError,
} from "../operator-authority.ts";
import {
  assertDelegatedAuthorityReceipt,
  assertOperatorPolicyRequest,
  delegatedAuthorityExercise,
  type OperatorAuthorityPolicyRequest,
  validateOperatorAuthorityPolicyRequest,
} from "./operator-authority-policy.ts";
import type { PendingChange } from "../records/pending-change.ts";
import { assertChangeAuthorityReceipt } from "./change-approvability.ts";
import type { CreationScope } from "./operator-creation-policy.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";

function request(): OperatorAuthorityPolicyRequest {
  return {
    policyId: "network-policy",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["operator"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  };
}
Deno.test("a recipient identity is bounded in code points, as the transport schema counts it", () => {
  const recipient = (count: number) => ({
    ...request(),
    recipients: ["😀".repeat(count)],
  });
  equal(
    validateOperatorAuthorityPolicyRequest(recipient(512)).recipients.length,
    1,
  );
  throws(() => validateOperatorAuthorityPolicyRequest(recipient(513)), {
    code: "INVALID_AUTHORITY_POLICY",
  });
});
function fixture() {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.ownerAuthority = {
    ...legacyOwnerAuthority("system"),
    ownerSource: "modeled",
  };
  model.policy.mayProposeSysmlRevision = true;
  model.operatorAuthorityPolicies = [{
    id: "network-policy",
    revision: 2,
    elementId: "policy-native",
    sourceIds: ["source"],
    rootAuthority: structuredClone(model.ownerAuthority),
    enabled: true,
    holderNativeId: "designer",
    mandateNativeId: "designer-mandate",
    systemId: "system",
    recipients: ["operator"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org", "deno.com"],
    toolIds: [],
    maxDelegationDepth: 0,
  }];
  const change: PendingChange = {
    id: "change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "operator",
    caseId: "case",
    baseRevision: 1,
    requestedAt: "now",
    reason: "Need host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  };
  return {
    model,
    change,
    command: { policyId: "network-policy", policyRevision: 2 },
  };
}
function fails(
  action: () => unknown,
  code: OperatorAuthorityError["code"],
  scope?: string,
) {
  throws(
    action,
    (error: unknown) =>
      error instanceof OperatorAuthorityError && error.code === code &&
      (scope === undefined || error.context.scope === scope),
  );
}
/** In-space main exercise, as the host-bound main path performs it. */
function exercise(
  model: ExecutableModel,
  change: PendingChange,
  actorId: string,
  command: { policyId: string; policyRevision: number },
) {
  const space = mainExecutionSpace(model.identity);
  return delegatedAuthorityExercise({
    target: model,
    targetSpace: space,
    policyModel: model,
    space,
    change,
    command: { actorId, ...command },
  });
}
function verify(model: ExecutableModel, change: PendingChange) {
  const space = mainExecutionSpace(model.identity);
  assertDelegatedAuthorityReceipt({
    target: model,
    targetSpace: space,
    policyModel: model,
    space,
    change,
  });
}

Deno.test("operator authority request validates closed fields and returns an isolated value", () => {
  const input = request();
  const result = validateOperatorAuthorityPolicyRequest(input);
  deepStrictEqual(result, input);
  notStrictEqual(result.recipients, input.recipients);
  for (
    const patch of [
      { policyId: "../policy" },
      { expectedPolicyRevision: -1 },
      { expectedPolicyRevision: 0.5 },
      { expectedPolicyRevision: Number.MAX_SAFE_INTEGER + 1 },
      { enabled: "true" },
      { recipients: [] },
      { recipients: ["operator", "operator"] },
      { recipients: [" operator"] },
      { recipients: ["op\n"] },
      { recipients: Array.from({ length: 33 }, (_, i) => `op-${i}`) },
      { acts: [] },
      { acts: ["addNetworkHosts", "grantModelEditing"] },
      { toolIds: ["tool"] },
      { maxDelegationDepth: 1 },
      { extra: true },
    ]
  ) {
    fails(
      () => validateOperatorAuthorityPolicyRequest({ ...input, ...patch }),
      "INVALID_AUTHORITY_POLICY",
    );
  }
  const missing = { ...input } as Partial<OperatorAuthorityPolicyRequest>;
  delete missing.enabled;
  fails(
    () => validateOperatorAuthorityPolicyRequest(missing),
    "INVALID_AUTHORITY_POLICY",
  );
});

Deno.test("operator authority request rejects wildcard, private and noncanonical DNS bounds", () => {
  for (
    const hosts of [
      [],
      ["*.example.org"],
      ["localhost"],
      ["service.internal"],
      ["127.0.0.1"],
      ["EXAMPLE.org"],
      ["example.org."],
      [" example.org"],
      ["https://example.org"],
      ["example.org:443"],
      ["example.org", "example.org"],
    ]
  ) {
    fails(
      () =>
        validateOperatorAuthorityPolicyRequest({
          ...request(),
          networkHosts: hosts,
        }),
      "INVALID_AUTHORITY_POLICY",
    );
  }
});

Deno.test("an invalid network bound reports its cause to the agent", () => {
  throws(
    () =>
      validateOperatorAuthorityPolicyRequest({
        ...request(),
        networkHosts: ["EXAMPLE.org"],
      }),
    (error) => {
      ok(error instanceof OperatorAuthorityError);
      equal(error.code, "INVALID_AUTHORITY_POLICY");
      ok(error.message.includes("canoniques"), error.message);
      return true;
    },
  );
});

Deno.test("only a modeled designer may request a policy and never name itself recipient", () => {
  const { model } = fixture();
  model.identity.builderId = "designer";
  model.operatorAuthorityPolicies = [];
  deepStrictEqual(assertOperatorPolicyRequest(model, request()), request());
  fails(
    () =>
      assertOperatorPolicyRequest(model, {
        ...request(),
        recipients: ["designer"],
      }),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
  model.policy.mayProposeSysmlRevision = false;
  fails(
    () => assertOperatorPolicyRequest(model, request()),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
  model.policy.mayProposeSysmlRevision = true;
  model.ownerAuthority!.ownerSource = "implicit-legacy";
  fails(
    () => assertOperatorPolicyRequest(model, request()),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
});

Deno.test("policy updates bind exact holder and current revision; absent revocation fails", () => {
  const { model } = fixture();
  model.identity.builderId = "designer";
  deepStrictEqual(
    assertOperatorPolicyRequest(model, {
      ...request(),
      expectedPolicyRevision: 2,
    }),
    { ...request(), expectedPolicyRevision: 2 },
  );
  fails(
    () => assertOperatorPolicyRequest(model, request()),
    "AUTHORITY_POLICY_STALE",
  );
  model.operatorAuthorityPolicies![0].holderNativeId = "designer-other";
  fails(
    () =>
      assertOperatorPolicyRequest(model, {
        ...request(),
        expectedPolicyRevision: 2,
      }),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
  model.operatorAuthorityPolicies = [];
  fails(
    () => assertOperatorPolicyRequest(model, { ...request(), enabled: false }),
    "AUTHORITY_POLICY_STALE",
  );
});

Deno.test("delegated exercise records exact rights and preserves root provenance", () => {
  const { model, change, command } = fixture();
  const receipt = exercise(model, change, "designer", command);
  equal(
    receipt.rootAuthorityNativeId,
    model.ownerAuthority!.rootAuthorityNativeId,
  );
  equal(receipt.delegation!.policyRevision, 2);
  equal(receipt.delegation!.requestedBy, "operator");
  equal(receipt.delegation!.changeId, "change");
  deepStrictEqual(receipt.delegation!.requestedRights, change.requestedRights);
  notStrictEqual(receipt.delegation!.requestedRights, change.requestedRights);
});

Deno.test("delegated exercise rejects wrong holder, recipient, self decision and DNS suffix widening", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) =>
        f.model.operatorAuthorityPolicies![0].holderNativeId = "other-designer",
      (f: ReturnType<typeof fixture>) =>
        f.model.operatorAuthorityPolicies![0].recipients = ["operator-other"],
      (f: ReturnType<typeof fixture>) => f.change.requestedBy = "designer",
      (f: ReturnType<typeof fixture>) =>
        f.change.requestedBy = "other-operator",
      (f: ReturnType<typeof fixture>) =>
        f.change.requestedRights = { addNetworkHosts: ["sub.example.org"] },
      (f: ReturnType<typeof fixture>) =>
        f.change.requestedRights = {
          addNetworkHosts: ["example.org.evil.com"],
        },
      (f: ReturnType<typeof fixture>) =>
        f.change.requestedRights = {
          addNetworkHosts: ["example.org"],
          mayAdmitOwnCandidates: true,
        },
      (f: ReturnType<typeof fixture>) =>
        f.change.designerScopeId = "designer-scope",
      (f: ReturnType<typeof fixture>) => f.change.caseId = undefined,
    ]
  ) {
    const f = fixture();
    mutate(f);
    fails(
      () => exercise(f.model, f.change, "designer", f.command),
      "AUTHORITY_OUT_OF_BOUNDS",
    );
  }
});

Deno.test("delegated exercise rejects superseded and revoked policies", () => {
  const f = fixture();
  fails(
    () =>
      exercise(f.model, f.change, "designer", {
        ...f.command,
        policyRevision: 1,
      }),
    "AUTHORITY_POLICY_STALE",
  );
  f.model.operatorAuthorityPolicies![0].enabled = false;
  fails(
    () => exercise(f.model, f.change, "designer", f.command),
    "AUTHORITY_POLICY_STALE",
  );
});

Deno.test("delegated receipt requires builder provenance and matches actual change content", () => {
  const { model, change, command } = fixture();
  change.authorityExercise = exercise(model, change, "designer", command);
  change.authority = "builder";
  change.status = "approved";
  change.decidedAt = "now";
  verify(model, change);
  for (
    const patch of [
      { status: "pending" as const },
      { authority: "human" as const },
      { authority: undefined },
      { decidedAt: undefined },
      { requestedRights: { addNetworkHosts: ["deno.com"] } },
      { id: "other-change" },
      { caseId: "other-case" },
    ]
  ) {
    fails(
      () => verify(model, { ...change, ...patch }),
      "AUTHORITY_RECEIPT_MISMATCH",
    );
  }
  const noDelegation = structuredClone(change);
  delete noDelegation.authorityExercise!.delegation;
  fails(
    () => verify(model, noDelegation),
    "AUTHORITY_RECEIPT_MISMATCH",
  );
  model.operatorAuthorityPolicies![0].enabled = false;
  fails(
    () => verify(model, change),
    "AUTHORITY_POLICY_STALE",
  );
});

// ---------------------------------------------------------------------------
// Spec 4.8c, contracts C2/C4: composite policy subjects and receipts.
// ---------------------------------------------------------------------------

/** Fixture models share the BO/MO system identity: the space carries it. */
const branchHost = { projectId: "unit", systemId: "system" };
const at = (executionSpaceId: string, operatorId: string) => ({
  ...branchHost,
  executionSpaceId,
  operatorId,
});
function branchAuthorityFixture() {
  const model = (builderId: string, digest: string) => {
    const value = executableFixture({
      projectId: "unit",
      editingContextId: "unit",
      rootId: "root",
      systemId: "system",
      catalogId: "catalog",
      builderId,
    });
    value.version.digest = digest;
    value.ownerAuthority = {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled",
    };
    return value;
  };
  const policy = (
    id: string,
    recipients: string[],
    recipientExecutionSpaceId?: string,
  ) => ({
    id,
    revision: 1,
    elementId: `${id}-native`,
    sourceIds: [`${id}-native`],
    rootAuthority: {
      ...legacyOwnerAuthority("system"),
      ownerSource: "modeled" as const,
    },
    enabled: true,
    holderNativeId: "operator",
    mandateNativeId: "operator-mandate",
    systemId: "system",
    recipients,
    ...(recipientExecutionSpaceId ? { recipientExecutionSpaceId } : {}),
    acts: ["addNetworkHosts"] as ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [] as [],
    maxDelegationDepth: 0 as const,
  });
  // Main holds the MO's mandate over BO@case-x only.
  const main = model("operator", "a".repeat(64));
  const mandate = policy("bo-x-network", ["operator"], "case-x");
  main.operatorAuthorityPolicies = [mandate];
  // The branch model is a Release copy of main; this policy names main
  // operators explicitly.
  const branch = model("operator", "b".repeat(64));
  const copied = policy("main-network", ["research"], "main");
  branch.operatorAuthorityPolicies = [copied];
  const change: PendingChange = {
    id: "branch-change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "operator",
    caseId: "case-x-request",
    baseRevision: branch.configuration.revision,
    baseModelDigest: branch.version.digest,
    requestedAt: "now",
    reason: "Need host",
    requestedRights: { addNetworkHosts: ["example.org"] },
  };
  return { main, branch, change, model, policy };
}

Deno.test("4.8c C2: a policy request may name its recipients' execution space; absent is the legacy relative form", () => {
  const scoped = { ...request(), recipientExecutionSpaceId: "case-x" };
  deepStrictEqual(validateOperatorAuthorityPolicyRequest(scoped), scoped);
  deepStrictEqual(validateOperatorAuthorityPolicyRequest(request()), request());
  for (const bad of ["", " case-x", "*", "case\n", 7]) {
    fails(
      () =>
        validateOperatorAuthorityPolicyRequest({
          ...request(),
          recipientExecutionSpaceId: bad,
        }),
      "INVALID_AUTHORITY_POLICY",
    );
  }
});

Deno.test("4.8c C2: the MO may request a mandate over its BO, which shares its native ID, only in a branch space", () => {
  const { model } = fixture();
  model.operatorAuthorityPolicies = [];
  const mandate = {
    ...request(),
    recipients: [model.identity.builderId],
    recipientExecutionSpaceId: "case-x",
  };
  deepStrictEqual(assertOperatorPolicyRequest(model, mandate), mandate);
  fails(
    () =>
      assertOperatorPolicyRequest(model, {
        ...request(),
        recipients: [model.identity.builderId],
      }),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
  fails(
    () =>
      assertOperatorPolicyRequest(model, {
        ...mandate,
        recipientExecutionSpaceId: "main",
      }),
    "AUTHORITY_POLICY_FORBIDDEN",
  );
});

const inSpace = (executionSpaceId: string) => ({
  ...branchHost,
  executionSpaceId,
});
/** MO@main decides for the BO of `requesterSpace` under main's policies. */
function crossSpace(
  f: ReturnType<typeof branchAuthorityFixture>,
  requesterSpace = "case-x",
) {
  return {
    target: f.branch,
    targetSpace: inSpace(requesterSpace),
    policyModel: f.main,
    space: inSpace("main"),
    change: f.change,
    command: {
      actorId: "operator",
      policyId: "bo-x-network",
      policyRevision: 1,
    },
  };
}

Deno.test("4.8c C4: MO@main exercises its mandate for BO@case-x with a composite receipt", () => {
  const f = branchAuthorityFixture();
  const result: AuthorityExercise = delegatedAuthorityExercise(crossSpace(f));
  deepStrictEqual(result.delegation?.actor, at("main", "operator"));
  deepStrictEqual(result.delegation?.requester, at("case-x", "operator"));
  equal(result.delegation?.actorId, "operator");
  equal(result.delegation?.requestedBy, "operator");
  equal(result.baseModelDigest, f.branch.version.digest);
});

Deno.test("4.8c C4: the MO mandate for BO@case-x never covers BO@case-y", () => {
  const f = branchAuthorityFixture();
  fails(
    () => delegatedAuthorityExercise(crossSpace(f, "case-y")),
    "AUTHORITY_OUT_OF_BOUNDS",
    "requester-not-recipient",
  );
});

Deno.test("4.8c C4: a branch-read policy covers the branch's instances only, never through an explicit main subject", () => {
  const f = branchAuthorityFixture();
  const research = f.model("research", "c".repeat(64));
  const change = {
    ...f.change,
    requestedBy: "research",
    baseModelDigest: research.version.digest,
  };
  const inBranch = (policyId: string) =>
    delegatedAuthorityExercise({
      target: research,
      targetSpace: inSpace("case-x"),
      policyModel: research,
      space: inSpace("case-x"),
      change,
      command: { actorId: "operator", policyId, policyRevision: 1 },
    });
  // A policy naming main operators explicitly stays in main.
  research.operatorAuthorityPolicies = structuredClone(
    f.branch.operatorAuthorityPolicies,
  );
  fails(
    () => inBranch("main-network"),
    "AUTHORITY_OUT_OF_BOUNDS",
    "policy-not-effective-in-space",
  );
  // A legacy policy copied by the Release is mirrored on the branch.
  research.operatorAuthorityPolicies = [
    f.policy("release-network", ["research"]),
  ];
  const mirrored = inBranch("release-network").delegation;
  deepStrictEqual(mirrored?.actor, at("case-x", "operator"));
  deepStrictEqual(mirrored?.requester, at("case-x", "research"));
});

Deno.test("4.8c C4: the BO cannot decide its own change, even under a mandate copied into its branch", () => {
  const f = branchAuthorityFixture();
  f.branch.operatorAuthorityPolicies = [
    f.policy("bo-x-network", ["operator"], "case-x"),
  ];
  fails(
    () =>
      delegatedAuthorityExercise({
        ...crossSpace(f),
        policyModel: f.branch,
        space: inSpace("case-x"),
      }),
    "AUTHORITY_OUT_OF_BOUNDS",
    "self-approval",
  );
});

Deno.test("4.8c C4: a caller cannot re-legitimate a policy by naming another system, project or author", () => {
  const f = branchAuthorityFixture();
  for (const host of [{ systemId: "other-system" }, { projectId: "other" }]) {
    for (const field of ["space", "targetSpace"] as const) {
      const input = crossSpace(f);
      fails(
        () =>
          delegatedAuthorityExercise({
            ...input,
            [field]: { ...input[field], ...host },
          }),
        "AUTHORITY_PROVENANCE_MISMATCH",
      );
    }
  }
  fails(
    () =>
      delegatedAuthorityExercise({
        ...crossSpace(f),
        change: { ...f.change, requestedBy: "another-operator" },
      }),
    "AUTHORITY_OUT_OF_BOUNDS",
  );
});

Deno.test("4.8c C4: a receipt written before the composite pair still verifies in main and never in a branch", () => {
  const { model, change } = fixture();
  // Historical shape, pinned: no actor/requester pair.
  change.authorityExercise = {
    ...model.ownerAuthority!,
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: model.version.digest,
    outOfMandate: false,
    delegation: {
      actorId: "designer",
      policyId: "network-policy",
      policyRevision: 2,
      policyElementId: "policy-native",
      policyIssuer: structuredClone(model.ownerAuthority!),
      requestedBy: "operator",
      changeId: "change",
      caseId: "case",
      requestedRights: { addNetworkHosts: ["example.org"] },
    },
  };
  change.authority = "builder";
  change.status = "approved";
  change.decidedAt = "now";
  verify(model, change);
  const branch = {
    ...mainExecutionSpace(model.identity),
    executionSpaceId: "case-x",
  };
  for (
    const spaces of [
      { space: branch, targetSpace: branch },
      { space: mainExecutionSpace(model.identity), targetSpace: branch },
    ]
  ) {
    fails(
      () =>
        assertDelegatedAuthorityReceipt({
          target: model,
          policyModel: model,
          change,
          ...spaces,
        }),
      "AUTHORITY_RECEIPT_MISMATCH",
    );
  }
});

Deno.test("4.8c C4: a receipt whose recorded actor or requester was replaced is refused in main and in a branch", () => {
  const { model, change } = fixture();
  const current = exercise(model, change, "designer", {
    policyId: "network-policy",
    policyRevision: 2,
  });
  const approved = {
    ...change,
    authority: "builder" as const,
    status: "approved" as const,
    decidedAt: "now",
  };
  verify(model, { ...approved, authorityExercise: current });
  const f = branchAuthorityFixture();
  const crossReceipt = delegatedAuthorityExercise(crossSpace(f));
  const crossApproved = {
    ...f.change,
    authority: "builder" as const,
    status: "approved" as const,
    decidedAt: "now",
  };
  const { command: _command, ...crossVerification } = crossSpace(f);
  assertDelegatedAuthorityReceipt({
    ...crossVerification,
    change: { ...crossApproved, authorityExercise: crossReceipt },
  });
  const replace = (
    receipt: AuthorityExercise,
    field: "actor" | "requester",
    patch: Partial<Record<"executionSpaceId" | "operatorId", string>>,
  ) => {
    const forged = structuredClone(receipt);
    forged.delegation![field] = { ...forged.delegation![field]!, ...patch };
    return forged;
  };
  for (const field of ["actor", "requester"] as const) {
    for (
      const patch of [{ executionSpaceId: "case-y" }, {
        operatorId: "someone-else",
      }]
    ) {
      fails(
        () =>
          verify(model, {
            ...approved,
            authorityExercise: replace(current, field, patch),
          }),
        "AUTHORITY_RECEIPT_MISMATCH",
      );
      fails(
        () =>
          assertDelegatedAuthorityReceipt({
            ...crossVerification,
            change: {
              ...crossApproved,
              authorityExercise: replace(crossReceipt, field, patch),
            },
          }),
        "AUTHORITY_RECEIPT_MISMATCH",
      );
    }
  }
});

/** Where these BO models read creation: their branch, with an empty team. */
const branchScope = (model: ExecutableModel): CreationScope => ({
  space: {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: "case-x",
  },
  branchTeamSize: 0,
  currentCaseId: "case-x-request",
});

Deno.test("4.8d D1: a branch publication verifies the MO's receipt against its recorded decision, never Main's current policy", () => {
  const f = branchAuthorityFixture();
  const exercise = delegatedAuthorityExercise(crossSpace(f));
  const approved: PendingChange = {
    ...f.change,
    status: "approved",
    authority: "builder",
    decidedAt: "now",
    authorityExercise: exercise,
  };
  // The branch model alone cannot recompute it: the policy lives in main.
  fails(
    () =>
      assertChangeAuthorityReceipt(f.branch, approved, branchScope(f.branch)),
    "AUTHORITY_RECEIPT_MISMATCH",
  );
  assertChangeAuthorityReceipt(f.branch, approved, branchScope(f.branch), {
    exercise,
  });
  for (
    const forged of [
      { ...approved, authority: "human" as const },
      { ...approved, status: "pending" as const },
      {
        ...approved,
        authorityExercise: {
          ...exercise,
          delegation: { ...exercise.delegation!, policyRevision: 2 },
        },
      },
    ]
  ) {
    fails(
      () =>
        assertChangeAuthorityReceipt(f.branch, forged, branchScope(f.branch), {
          exercise,
        }),
      "AUTHORITY_RECEIPT_MISMATCH",
    );
  }
  // Another BO's model never carries this receipt.
  fails(
    () =>
      assertChangeAuthorityReceipt(
        f.model("research", "c".repeat(64)),
        approved,
        branchScope(f.model("research", "c".repeat(64))),
        {
          exercise,
        },
      ),
    "AUTHORITY_RECEIPT_MISMATCH",
  );
});

Deno.test("4.8e: Main's recorded receipt publishes to a member in its own native system", () => {
  const f = branchAuthorityFixture();
  f.branch.identity.systemId = "member-system";
  f.branch.identity.builderId = f.change.requestedBy = "member";
  f.branch.ownerAuthority!.systemId = "member-system";
  f.main.operatorAuthorityPolicies![0].recipients = ["member"];
  const exercise = delegatedAuthorityExercise({
    ...crossSpace(f),
    targetSpace: { ...inSpace("case-x"), systemId: "member-system" },
  });
  assertChangeAuthorityReceipt(
    f.branch,
    {
      ...f.change,
      status: "approved",
      authority: "builder",
      decidedAt: "now",
      authorityExercise: exercise,
    },
    branchScope(f.branch),
    { exercise },
  );
});

Deno.test("4.8d: a cross-space receipt binds its actor, change, Case, rights, base and act, even when its record agrees", () => {
  const f = branchAuthorityFixture();
  const exercise = delegatedAuthorityExercise(crossSpace(f));
  const approved: PendingChange = {
    ...f.change,
    status: "approved",
    authority: "builder",
    decidedAt: "now",
    authorityExercise: exercise,
  };
  const forge = (
    patch: (copy: AuthorityExercise) => void,
    change: Partial<PendingChange> = {},
  ) => {
    const copy = structuredClone(exercise);
    patch(copy);
    // A record that agrees with the forged receipt proves nothing by itself.
    return () =>
      assertChangeAuthorityReceipt(
        f.branch,
        {
          ...approved,
          ...change,
          authorityExercise: copy,
        },
        branchScope(f.branch),
        { exercise: copy },
      );
  };
  for (
    const [label, check] of [
      [
        "actor outside main",
        forge((e) => e.delegation!.actor!.executionSpaceId = "case-y"),
      ],
      [
        "actor of another system",
        forge((e) => e.delegation!.actor!.systemId = "other"),
      ],
      [
        "policy issuer of another system",
        forge((e) => e.delegation!.policyIssuer.systemId = "other"),
      ],
      ["another change", forge((e) => e.delegation!.changeId = "other-change")],
      ["another Case", forge((e) => e.delegation!.caseId = "other-case")],
      [
        "other rights",
        forge((e) =>
          e.delegation!.requestedRights = { addNetworkHosts: ["evil.example"] }
        ),
      ],
      ["another base", forge((e) => e.baseModelDigest = "f".repeat(64))],
      ["another act", forge((e) => e.action = "model-adoption")],
      [
        "actor named elsewhere",
        forge((e) => e.delegation!.actorId = "someone-else"),
      ],
    ] as const
  ) {
    fails(check, "AUTHORITY_RECEIPT_MISMATCH", undefined);
    void label;
  }
  assertChangeAuthorityReceipt(f.branch, approved, branchScope(f.branch), {
    exercise,
  });
});
