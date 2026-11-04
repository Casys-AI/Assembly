import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority, mainExecutionSpace } from "../authority.ts";
import { SystemGovernance } from "./governance.ts";
import type { Candidate } from "../../work/records/candidates.ts";
import {
  assertCandidateDelegationReceipt,
  assertToolAdmissionPolicyRequest,
  delegatedCandidateAuthorityExercise,
  type ToolAdmissionPolicyRequest,
  toolAdmissionPreparation,
  validateToolAdmissionPolicyRequest,
} from "./tool-admission-policy.ts";
import { OperatorAuthorityError } from "../operator-authority-error.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";
function request(): ToolAdmissionPolicyRequest {
  return {
    policyId: "tools",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["operator"],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
  };
}
const main = (model: ExecutableModel) => mainExecutionSpace(model.identity);
function fixture() {
  const model = executableFixture({
    projectId: "test",
    editingContextId: "test",
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
  model.toolAdmissionPolicies = [{
    ...request(),
    id: "tools",
    revision: 1,
    elementId: "tool-policy",
    sourceIds: ["policy"],
    rootAuthority: structuredClone(model.ownerAuthority),
    holderNativeId: "main",
    mandateNativeId: "main-mandate",
    systemId: "main-system",
  }];
  const candidate: Candidate = {
    id: "candidate",
    name: "page",
    kind: "read_web_page",
    description: "Extract",
    code: "export default () => ({title:'a',text:'b'})",
    digest: "draft-digest",
    stage: "awaiting-admission",
    createdAt: "now",
    caseId: "request",
    baseCatalogRevision: 0,
    requiredAuthority: "human",
    proposedConfigurationRevision: model.configuration.revision,
    promotionModelDigest: model.version.digest,
    toolAdmissionPolicyPins: toolAdmissionPreparation(
      model,
      "read_web_page",
      main(model),
    ),
    toolAdmissionContract: structuredClone(model.contracts[0]),
    tests: {
      passed: true,
      checks: [{ name: "fixture", passed: true, detail: "ok" }],
    },
  };
  return {
    model,
    candidate,
    actor: { actorId: "main", policyId: "tools", policyRevision: 1 },
  };
}
Deno.test("tool admission request is closed, exact and separate from network authority", () => {
  const input = request();
  deepStrictEqual(validateToolAdmissionPolicyRequest(input), input);
  for (
    const patch of [
      { toolKinds: [] },
      { toolKinds: ["unknown"] },
      { toolKinds: ["read_web_page", "read_web_page"] },
      { recipients: ["*"] },
      { recipients: [" operator"] },
      { recipients: ["operator", "operator"] },
      { maxDelegationDepth: 1 },
      { acts: ["addNetworkHosts"] },
      { expectedPolicyRevision: -1 },
    ]
  ) {
    throws(() => validateToolAdmissionPolicyRequest({ ...input, ...patch }), {
      code: "INVALID_AUTHORITY_POLICY",
    });
  }
  const { model } = fixture();
  model.identity.builderId = "main";
  throws(() => assertToolAdmissionPolicyRequest(model, input), {
    code: "AUTHORITY_POLICY_STALE",
  });
  assertToolAdmissionPolicyRequest(model, {
    ...input,
    expectedPolicyRevision: 1,
  });
  throws(
    () =>
      assertToolAdmissionPolicyRequest(model, {
        ...input,
        expectedPolicyRevision: 1,
        recipients: ["main"],
      }),
    { code: "AUTHORITY_POLICY_FORBIDDEN" },
  );
});
Deno.test("preparation captures only an already adopted matching grant; late grants give no right", () => {
  const { model, candidate, actor } = fixture();
  equal(
    toolAdmissionPreparation(model, "read_web_page_outline", main(model)),
    undefined,
  );
  const old = { ...candidate, toolAdmissionPolicyPins: undefined };
  throws(
    () => delegatedCandidateAuthorityExercise(model, old, actor, main(model)),
    {
      code: "AUTHORITY_OUT_OF_BOUNDS",
    },
  );
  model.toolAdmissionPolicies![0].enabled = false;
  equal(
    toolAdmissionPreparation(model, "read_web_page", main(model)),
    undefined,
  );
  throws(
    () =>
      delegatedCandidateAuthorityExercise(model, candidate, actor, main(model)),
    {
      code: "AUTHORITY_POLICY_STALE",
    },
  );
});
Deno.test("candidate authority records exact holder, issuer, Request, tests and contract", () => {
  const { model, candidate, actor } = fixture();
  const exercise = delegatedCandidateAuthorityExercise(
    model,
    candidate,
    actor,
    main(model),
  );
  const proof = exercise.candidateDelegation!;
  equal(proof.actorId, "main");
  equal(proof.requestedBy, "operator");
  equal(proof.caseId, "request");
  equal(proof.candidateDigest, candidate.digest);
  deepStrictEqual(proof.tests, candidate.tests);
  deepStrictEqual(proof.contract, model.contracts[0]);
  deepStrictEqual(
    proof.policyIssuer,
    model.toolAdmissionPolicies![0].rootAuthority,
  );
});
Deno.test("candidate authority rejects self, stale proposal, incomplete tests and widened scope", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => f.actor.actorId = "operator",
      (f: ReturnType<typeof fixture>) =>
        f.model.toolAdmissionPolicies![0].recipients = ["other"],
      (f: ReturnType<typeof fixture>) =>
        f.model.toolAdmissionPolicies![0].toolKinds = ["read_web_page_outline"],
      (f: ReturnType<typeof fixture>) => f.candidate.caseId = undefined,
      (f: ReturnType<typeof fixture>) => f.candidate.designerScopeId = "design",
      (f: ReturnType<typeof fixture>) =>
        f.candidate.promotionModelDigest = "stale",
      (f: ReturnType<typeof fixture>) =>
        f.candidate.proposedConfigurationRevision = -1,
      (f: ReturnType<typeof fixture>) =>
        f.candidate.requiredAuthority = "builder",
      (f: ReturnType<typeof fixture>) =>
        delete f.candidate.toolAdmissionContract,
      (f: ReturnType<typeof fixture>) =>
        f.model.contracts[0].nativeId = "another-contract",
      (f: ReturnType<typeof fixture>) =>
        f.model.contracts[0].acceptanceCriteria = [
          "A different tested behavior",
        ],
      (f: ReturnType<typeof fixture>) => f.candidate.tests!.checks = [],
      (f: ReturnType<typeof fixture>) =>
        f.candidate.tests!.checks[0].passed = false,
      (f: ReturnType<typeof fixture>) =>
        f.model.contracts.push(structuredClone(f.model.contracts[0])),
    ]
  ) {
    const f = fixture();
    mutate(f);
    throws(
      () =>
        delegatedCandidateAuthorityExercise(
          f.model,
          f.candidate,
          f.actor,
          main(f.model),
        ),
      { code: "AUTHORITY_OUT_OF_BOUNDS" },
    );
  }
});
Deno.test("publication receipt binds the delegated decision and cannot become a human admission", () => {
  const { model, candidate, actor } = fixture();
  const exercise = delegatedCandidateAuthorityExercise(
    model,
    candidate,
    actor,
    main(model),
  );
  candidate.admissionDecision = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Tested",
    authorityExercise: exercise,
  };
  const governance = SystemGovernance.fromExecutable(model);
  throws(
    () => governance.admission(candidate, "human", "Tested", "now"),
    /cannot become/,
  );
  equal(
    governance.admission(candidate, "delegate", "Tested", "now").actorId,
    actor.actorId,
  );
  candidate.admission = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    authority: "delegate",
    actorId: actor.actorId,
    configurationRevision: model.configuration.revision,
    mandateRevision: model.configuration.builder.mandateRevision,
    reason: "Tested",
    at: "now",
    authorityExercise: exercise,
  };
  assertCandidateDelegationReceipt(model, candidate, main(model));
  for (
    const mutate of [
      (c: Candidate) => c.admission!.authority = "human",
      (c: Candidate) => c.admission!.actorId = "owner",
      (c: Candidate) => c.caseId = "other-request",
      (c: Candidate) => c.tests!.checks[0].detail = "changed",
      (c: Candidate) => c.admissionDecision!.verdict = "refuse",
    ]
  ) {
    const copy = structuredClone(candidate);
    mutate(copy);
    throws(() => assertCandidateDelegationReceipt(model, copy, main(model)), {
      code: "AUTHORITY_RECEIPT_MISMATCH",
    });
  }
});

Deno.test("a delegated publication receipt cannot rebind its tested contract after model adoption", () => {
  const { model, candidate, actor } = fixture();
  candidate.admissionDecision = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Exact tested contract",
    authorityExercise: delegatedCandidateAuthorityExercise(
      model,
      candidate,
      actor,
      main(model),
    ),
  };
  candidate.admission = SystemGovernance.fromExecutable(model).admission(
    candidate,
    "delegate",
    candidate.admissionDecision.reason,
    "now",
  );
  assertCandidateDelegationReceipt(model, candidate, main(model));
  model.contracts[0].acceptanceCriteria = [
    "Changed after the recorded admission",
  ];
  model.version.digest = "adopted-contract-change";
  candidate.promotionModelDigest = model.version.digest;
  throws(
    () => assertCandidateDelegationReceipt(model, candidate, main(model)),
    {
      code: "AUTHORITY_OUT_OF_BOUNDS",
    },
  );
});

// Spec 4.8c, contracts C3/C4: tool admission policies follow the same scope
// rule as operator authority policies.
Deno.test("4.8c C3: a legacy main tool policy copied into a branch is mirrored there, never outside it", () => {
  const { model, candidate, actor } = fixture();
  const space = (executionSpaceId: string) => ({
    ...main(model),
    executionSpaceId,
  });
  // Legacy content: the MO ("main") admits candidates of "operator". In a
  // branch the same content names the BO and its teammate in that branch.
  equal(
    toolAdmissionPreparation(model, "read_web_page", space("case-x"))?.length,
    1,
  );
  equal(
    toolAdmissionPreparation(model, "read_web_page", space("main"))?.length,
    1,
    "the legacy meaning in main is unchanged",
  );
  equal(
    delegatedCandidateAuthorityExercise(
      model,
      candidate,
      actor,
      space("case-x"),
    )
      .candidateDelegation?.actorId,
    "main",
  );
  // A main→BO@X delegation is inert when copied into branch Y.
  model.toolAdmissionPolicies![0].recipientExecutionSpaceId = "case-x";
  equal(
    toolAdmissionPreparation(model, "read_web_page", space("case-y")),
    undefined,
  );
  throws(
    () =>
      delegatedCandidateAuthorityExercise(
        model,
        candidate,
        actor,
        space("case-y"),
      ),
    (error: unknown) =>
      error instanceof OperatorAuthorityError &&
      error.code === "AUTHORITY_OUT_OF_BOUNDS" &&
      error.context.scope === "policy-not-effective-in-space",
  );
  // A space that is not the model's own is refused, not reinterpreted.
  throws(
    () =>
      toolAdmissionPreparation(model, "read_web_page", {
        ...space("main"),
        systemId: "other-system",
      }),
    { code: "AUTHORITY_PROVENANCE_MISMATCH" },
  );
});

Deno.test("4.8c C3: tool admission refuses composite self-admission with an explicit scope", () => {
  const { model, candidate } = fixture();
  model.toolAdmissionPolicies![0].holderNativeId = "operator";
  model.toolAdmissionPolicies![0].recipientExecutionSpaceId = "case-x";
  const branch = { ...main(model), executionSpaceId: "case-x" };
  equal(toolAdmissionPreparation(model, "read_web_page", branch), undefined);
  throws(
    () =>
      delegatedCandidateAuthorityExercise(
        model,
        {
          ...candidate,
          toolAdmissionPolicyPins: [{
            policyId: "tools",
            policyRevision: 1,
            holderNativeId: "operator",
            policyElementId: "tool-policy",
          }],
        },
        { actorId: "operator", policyId: "tools", policyRevision: 1 },
        branch,
      ),
    (error: unknown) =>
      error instanceof OperatorAuthorityError &&
      error.context.scope === "self-approval",
  );
});

Deno.test("4.8c C2: a tool admission request may name its recipients' execution space; the holder names another instance only in a branch space", () => {
  const scoped = { ...request(), recipientExecutionSpaceId: "case-x" };
  deepStrictEqual(validateToolAdmissionPolicyRequest(scoped), scoped);
  for (const bad of ["", " case-x", "*", "case\n", 7]) {
    throws(
      () =>
        validateToolAdmissionPolicyRequest({
          ...request(),
          recipientExecutionSpaceId: bad,
        }),
      { code: "INVALID_AUTHORITY_POLICY" },
    );
  }
  const { model } = fixture();
  model.identity.builderId = "main";
  model.toolAdmissionPolicies = [];
  const overBranch = { ...scoped, recipients: ["main"] };
  deepStrictEqual(
    assertToolAdmissionPolicyRequest(model, overBranch),
    overBranch,
  );
  for (const recipientSpace of [undefined, "main"]) {
    throws(
      () =>
        assertToolAdmissionPolicyRequest(model, {
          ...request(),
          recipients: ["main"],
          ...(recipientSpace
            ? { recipientExecutionSpaceId: recipientSpace }
            : {}),
        }),
      { code: "AUTHORITY_POLICY_FORBIDDEN" },
    );
  }
});
